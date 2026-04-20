import type { TLSOptions } from "bun";
import { type PgConfig, type ResolveOptions, resolveConfig } from "./config.ts";
import { Connection } from "./connection.ts";
import {
	ConnectionClosedError,
	ConnectionNotReadyError,
	PayloadTooLargeError,
	PgProtocolError,
} from "./errors.ts";
import {
	defaultReconnectDelay,
	type ReconnectDelayFn,
	scheduleReconnect,
} from "./reconnect.ts";

const encoder = new TextEncoder();

export type NotifyCallback = (payload: string, channel: string) => void;

export type PgListenerOptions = Omit<ResolveOptions, "tls"> & {
	/**
	 * TLS configuration.
	 * - `true` → sslmode=require (encryption, no cert verification).
	 * - `false` → sslmode=disable.
	 * - `TLSOptions` object → enable TLS with the given options. Explicit
	 *   fields (`ca`, `cert`, `key`, `rejectUnauthorized`, ...) override the
	 *   defaults derived from `sslmode`. Setting this to an object does not
	 *   change `sslmode` — combine with `?sslmode=verify-full` in the URL or
	 *   pass `{ rejectUnauthorized: true, serverName: host }` directly.
	 */
	tls?: boolean | TLSOptions;
	reconnectDelayMs?: ReconnectDelayFn;
	/**
	 * Maximum reconnect attempts before giving up and firing `onError` with
	 * the final error. Default: `Infinity` (retry forever). Set to a finite
	 * value in production to bound audit noise / password-spray signals when
	 * credentials are misconfigured.
	 */
	maxReconnectAttempts?: number;
	connectTimeoutMs?: number;
	onConnect?: () => void;
	onReconnect?: () => void;
	onError?: (error: Error) => void;
	onNotice?: (fields: Record<string, string>) => void;
};

type ListenerState = "idle" | "connecting" | "ready" | "closing" | "closed";

type PendingOp = {
	resolve: () => void;
	reject: (error: Error) => void;
	label: string;
	errored?: Error;
};

export class PgListener {
	private readonly config: PgConfig;
	private readonly options: PgListenerOptions;
	private readonly reconnectDelayFn: ReconnectDelayFn;
	private readonly listeners = new Map<string, Set<NotifyCallback>>();
	private readonly pendingOps: PendingOp[] = [];

	private connection: Connection | null = null;
	private state: ListenerState = "idle";
	private reconnectAttempt = 0;
	private cancelReconnect?: () => void;
	private manualClose = false;

	constructor(
		urlOrOptions?: string | PgListenerOptions,
		options: PgListenerOptions = {},
	) {
		let url: string | undefined;
		let opts: PgListenerOptions;
		if (typeof urlOrOptions === "string") {
			url = urlOrOptions;
			opts = options;
		} else if (urlOrOptions != null) {
			opts = urlOrOptions;
		} else {
			opts = options;
		}
		this.options = opts;
		const tlsForResolve: boolean | undefined =
			typeof opts.tls === "object" ? true : opts.tls;
		this.config = resolveConfig(url, { ...opts, tls: tlsForResolve });
		this.reconnectDelayFn = opts.reconnectDelayMs ?? defaultReconnectDelay;
	}

	getState(): ListenerState {
		return this.state;
	}

	/** Open the connection, run the handshake, reach ready state. */
	async connect(): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(`PgListener.connect called in state ${this.state}`);
		}
		this.manualClose = false;
		await this.openConnection(false);
	}

	/**
	 * Subscribe to a channel. Resolves only after the server acknowledges the
	 * LISTEN command. Returns an async function that unsubscribes.
	 */
	async listen(
		channel: string,
		cb: NotifyCallback,
	): Promise<() => Promise<void>> {
		this.ensureReady();
		const existing = this.listeners.get(channel);

		// Register the callback BEFORE awaiting LISTEN. Postgres can pipeline
		// CommandComplete / ReadyForQuery / NotificationResponse in a single
		// TCP read, and microtasks scheduled by the parser run in FIFO order —
		// so a notification that arrives in the same batch as the ack would
		// otherwise dispatch to an empty set and be silently dropped.
		let callbacks: Set<NotifyCallback>;
		const createdSet = !existing;
		if (existing) {
			callbacks = existing;
		} else {
			callbacks = new Set();
			this.listeners.set(channel, callbacks);
		}
		callbacks.add(cb);

		if (createdSet) {
			try {
				await this.runCommand(`LISTEN ${escapeIdentifier(channel)}`);
			} catch (error) {
				callbacks.delete(cb);
				if (callbacks.size === 0) this.listeners.delete(channel);
				throw error;
			}
		}

		let unlistened = false;
		return async () => {
			if (unlistened) return;
			unlistened = true;
			const set = this.listeners.get(channel);
			if (!set) return;
			set.delete(cb);
			if (set.size === 0) {
				this.listeners.delete(channel);
				if (this.state === "ready") {
					await this.runCommand(`UNLISTEN ${escapeIdentifier(channel)}`);
				}
			}
		};
	}

	/** Force-remove all callbacks for a channel and send UNLISTEN. */
	async unlisten(channel: string): Promise<void> {
		this.listeners.delete(channel);
		if (this.state === "ready") {
			await this.runCommand(`UNLISTEN ${escapeIdentifier(channel)}`);
		}
	}

	/** Publish. Resolves after server acknowledges the NOTIFY. */
	async notify(channel: string, payload = ""): Promise<void> {
		this.ensureReady();
		const byteLength = encoder.encode(payload).byteLength;
		// 7999 bytes is the true max — Postgres stores payload + NUL in an 8000-byte slot.
		if (byteLength >= PayloadTooLargeError.LIMIT) {
			throw new PayloadTooLargeError(byteLength);
		}
		const sql =
			payload === ""
				? `NOTIFY ${escapeIdentifier(channel)}`
				: `NOTIFY ${escapeIdentifier(channel)}, ${escapeLiteral(payload)}`;
		await this.runCommand(sql);
	}

	/** Terminate the connection. Idempotent. */
	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.manualClose = true;
		this.state = "closing";
		this.cancelReconnect?.();
		this.cancelReconnect = undefined;
		this.rejectPending(new ConnectionClosedError("PgListener closed"));
		await this.connection?.close();
		this.connection = null;
		this.state = "closed";
	}

	// ---------- internals ----------

	private async openConnection(isReconnect: boolean): Promise<void> {
		this.state = "connecting";
		const conn = new Connection(
			this.config,
			{
				onNotification: (channel, payload) =>
					this.dispatchNotification(channel, payload),
				onReadyForQuery: () => this.onReadyForQuery(),
				onProtocolError: (error) => this.onRuntimeError(error),
				onNotice: (fields) => this.options.onNotice?.(fields),
				onClose: (error) => this.onConnectionClosed(error),
			},
			{
				connectTimeoutMs: this.options.connectTimeoutMs,
				tls:
					typeof this.options.tls === "object" ? this.options.tls : undefined,
			},
		);
		this.connection = conn;

		try {
			await conn.connect();
		} catch (error) {
			this.state = "idle";
			this.connection = null;
			if (isReconnect && !this.manualClose) {
				this.scheduleReconnectAttempt();
				return;
			}
			throw error;
		}

		// If close() landed while we were connecting, bail cleanly.
		if (this.manualClose || this.connection !== conn) {
			await conn.close().catch(() => {});
			return;
		}

		this.reconnectAttempt = 0;

		// Re-subscribe all active channels BEFORE firing onReconnect so the
		// caller's replay logic can assume server-side state is caught up.
		if (isReconnect && this.listeners.size > 0) {
			for (const channel of this.listeners.keys()) {
				try {
					await this.runCommandInternal(`LISTEN ${escapeIdentifier(channel)}`);
				} catch (error) {
					this.options.onError?.(normalize(error));
				}
				// Socket could have died mid-replay — detect and bail so we
				// don't stomp onConnectionClosed's state transition.
				if (this.connection !== conn) return;
			}
		}

		if (this.manualClose || this.connection !== conn) {
			await conn.close().catch(() => {});
			return;
		}

		this.state = "ready";

		if (isReconnect) {
			queueMicrotask(() => this.options.onReconnect?.());
		} else {
			queueMicrotask(() => this.options.onConnect?.());
		}
	}

	private runCommand(sql: string): Promise<void> {
		if (!this.connection || this.state !== "ready") {
			return Promise.reject(new ConnectionNotReadyError(this.state));
		}
		return this.enqueue(sql);
	}

	/** Like runCommand but skips the ready-state guard — used during reconnect. */
	private runCommandInternal(sql: string): Promise<void> {
		if (!this.connection) {
			return Promise.reject(new ConnectionNotReadyError(this.state));
		}
		return this.enqueue(sql);
	}

	private enqueue(sql: string): Promise<void> {
		const conn = this.connection;
		if (!conn) return Promise.reject(new ConnectionNotReadyError(this.state));
		return new Promise<void>((resolve, reject) => {
			const op: PendingOp = { resolve, reject, label: sql };
			this.pendingOps.push(op);
			try {
				conn.query(sql);
			} catch (error) {
				// Remove the op we just added; it never made it onto the wire.
				const idx = this.pendingOps.indexOf(op);
				if (idx !== -1) this.pendingOps.splice(idx, 1);
				reject(normalize(error));
			}
		});
	}

	private onReadyForQuery(): void {
		// ReadyForQuery fires once after the initial handshake (no pending op
		// yet) and then once per Query we send. When it arrives with a pending
		// op, that op's command cycle is complete — resolve or reject based
		// on whether ErrorResponse was seen first.
		const op = this.pendingOps.shift();
		if (!op) return;
		if (op.errored) op.reject(op.errored);
		else op.resolve();
	}

	private onRuntimeError(error: PgProtocolError): void {
		// Postgres's simple-query protocol guarantees `ErrorResponse → ReadyForQuery`
		// for the failing Query. Mark the current op as errored (peek, don't
		// shift) and let the subsequent ReadyForQuery hand over to the reject
		// path. This correlates the error with the right op even when queries
		// are pipelined.
		const op = this.pendingOps[0];
		if (op) op.errored = error;
		else this.options.onError?.(error);
	}

	private onConnectionClosed(error?: Error): void {
		this.connection = null;
		const cause = error ?? new ConnectionClosedError();
		this.rejectPending(cause);

		if (
			this.manualClose ||
			this.state === "closing" ||
			this.state === "closed"
		) {
			this.state = "closed";
			return;
		}

		// Terminal Postgres errors — retrying won't help and will look like
		// a password-spray to DB auditors. Give up and surface via onError.
		if (error && isTerminalPgError(error)) {
			this.state = "closed";
			this.options.onError?.(error);
			return;
		}

		// Give up after the configured attempt cap; callers get a single
		// terminal `onError` rather than a perpetual stream.
		const max = this.options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
		if (this.reconnectAttempt >= max) {
			this.state = "closed";
			this.options.onError?.(cause);
			return;
		}

		this.state = "idle";
		this.scheduleReconnectAttempt();
	}

	private rejectPending(error: Error): void {
		while (this.pendingOps.length > 0) {
			const op = this.pendingOps.shift();
			op?.reject(error);
		}
	}

	private scheduleReconnectAttempt(): void {
		if (this.manualClose) return;
		this.cancelReconnect = scheduleReconnect(
			this.reconnectDelayFn,
			this.reconnectAttempt++,
			() => {
				this.openConnection(true).catch((error) => {
					this.options.onError?.(normalize(error));
				});
			},
		);
	}

	private dispatchNotification(channel: string, payload: string): void {
		const callbacks = this.listeners.get(channel);
		if (!callbacks) return;
		for (const cb of callbacks) {
			try {
				cb(payload, channel);
			} catch (error) {
				this.options.onError?.(normalize(error));
			}
		}
	}

	private ensureReady(): void {
		if (this.state !== "ready") throw new ConnectionNotReadyError(this.state);
	}
}

const MAX_IDENTIFIER_BYTES = 63; // NAMEDATALEN - 1
const byteLengthEncoder = new TextEncoder();

/**
 * Quote a channel name for LISTEN/UNLISTEN/NOTIFY.
 * Rejects empty strings, embedded null bytes, and names longer than
 * Postgres's 63-byte identifier limit (which the server would otherwise
 * silently truncate, resubscribing us to a different channel).
 */
export function escapeIdentifier(name: string): string {
	if (name.length === 0) {
		throw new Error("Identifier cannot be empty");
	}
	if (name.includes("\0")) {
		throw new Error("Identifier cannot contain a null byte (U+0000)");
	}
	const byteLength = byteLengthEncoder.encode(name).byteLength;
	if (byteLength > MAX_IDENTIFIER_BYTES) {
		throw new Error(
			`Identifier is ${byteLength} bytes; Postgres limit is ${MAX_IDENTIFIER_BYTES}. ` +
				"Longer names are silently truncated server-side.",
		);
	}
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a NOTIFY payload for the SQL literal slot.
 * Uses `E'...'` and doubles both `'` and `\`, so the literal parses
 * identically under either `standard_conforming_strings` setting.
 * Rejects null bytes (Postgres can't store them in a text value).
 */
export function escapeLiteral(text: string): string {
	if (text.includes("\0")) {
		throw new Error("Literal cannot contain a null byte (U+0000)");
	}
	return `E'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function normalize(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * SQLSTATE codes for errors that won't be fixed by retrying the connection.
 *   28P01 invalid_password                         (wrong credentials)
 *   28000 invalid_authorization_specification      (role doesn't exist / not allowed)
 *   3D000 invalid_catalog_name                     (database doesn't exist)
 *   42501 insufficient_privilege                   (role lacks CONNECT / LOGIN)
 */
const TERMINAL_SQLSTATE_CODES = new Set(["28P01", "28000", "3D000", "42501"]);

function isTerminalPgError(error: Error): boolean {
	return (
		error instanceof PgProtocolError &&
		error.code !== undefined &&
		TERMINAL_SQLSTATE_CODES.has(error.code)
	);
}
