import type { Socket, SocketHandler, TLSOptions } from "bun";
import type { PgConfig, SslMode } from "./config.ts";
import {
	ConnectionClosedError,
	ConnectionNotReadyError,
	PgProtocolError,
} from "./errors.ts";
import type { BackendMessage, TransactionStatus } from "./protocol/messages.ts";
import { Parser } from "./protocol/parser.ts";
import {
	query as queryMessage,
	saslInitial,
	saslResponse,
	sslRequest,
	startup,
	terminate,
} from "./protocol/serializer.ts";
import {
	continueSession,
	finalizeSession,
	SCRAM_SHA_256,
	type ScramSession,
	startSession,
} from "./scram.ts";
import { WriteBuffer, WriteBufferClosedError } from "./write-buffer.ts";

type ConnectionState =
	| "idle"
	| "connecting"
	| "ssl-negotiating"
	| "tls-handshake"
	| "startup"
	| "authenticating"
	| "ready"
	| "closing"
	| "closed";

export type ConnectionHandlers = {
	onNotification?: (
		channel: string,
		payload: string,
		processId: number,
	) => void;
	onCommandComplete?: (tag: string) => void;
	onReadyForQuery?: (status: TransactionStatus) => void;
	onProtocolError?: (error: PgProtocolError) => void;
	onNotice?: (fields: Record<string, string>) => void;
	onClose?: (error?: Error) => void;
};

export type ConnectionOptions = {
	tls?: TLSOptions | boolean;
	connectTimeoutMs?: number;
};

const SSL_RESPONSE_YES = 0x53; // 'S'
const SSL_RESPONSE_NO = 0x4e; // 'N'
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export type BackendKeyData = { processId: number; secretKey: number };

export class Connection {
	private state: ConnectionState = "idle";
	private socket: Socket | null = null;
	private parser = new Parser();
	private scramSession?: ScramSession;
	private scramExpectedSignature?: string;
	private readyResolve?: () => void;
	private readyReject?: (error: Error) => void;
	private connectTimer?: ReturnType<typeof setTimeout>;
	private backendKey?: BackendKeyData;
	private writeBuffer = new WriteBuffer();
	private resolvedTls?: TLSOptions;

	constructor(
		private readonly config: PgConfig,
		private readonly handlers: ConnectionHandlers = {},
		private readonly options: ConnectionOptions = {},
	) {}

	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Postgres `BackendKeyData` — backend PID + secret key. Populated after
	 * the startup handshake. Needed to issue a `CancelRequest` message on a
	 * separate connection (not implemented yet, but stored for callers who
	 * want the PID for observability).
	 */
	getBackendKey(): BackendKeyData | undefined {
		return this.backendKey;
	}

	/**
	 * Open the TCP connection, negotiate TLS if required, perform the
	 * Postgres startup handshake + SCRAM auth. Resolves when the server
	 * sends its first `ReadyForQuery`.
	 */
	async connect(): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(`Connection.connect called in state ${this.state}`);
		}
		this.state = "connecting";

		return new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;

			const timeoutMs =
				this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
			this.connectTimer = setTimeout(() => {
				this.fail(new Error(`Connect timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			Bun.connect({
				hostname: this.config.host,
				port: this.config.port,
				socket: this.plaintextHandler(),
			}).catch((error) =>
				this.fail(error instanceof Error ? error : new Error(String(error))),
			);
		});
	}

	/**
	 * Write raw protocol bytes directly to the socket. Used by PgListener
	 * for `Query('LISTEN ...')` and friends. Preserves write order across
	 * short writes by queuing the unwritten tail and flushing on `drain`
	 * — see `WriteBuffer` for the exact semantics (ordering, not backpressure).
	 */
	send(bytes: Uint8Array): void {
		if (!this.socket || this.state === "closed" || this.state === "closing") {
			throw new ConnectionNotReadyError(this.state);
		}
		const socket = this.socket;
		// `readyState` can be !== 1 (Established) even while our own state
		// is "ready" — kernel reset races ahead of the close callback.
		// Translate this into the error we want upstream instead of silently
		// queuing onto a dead socket.
		if (socket.readyState !== 1) {
			throw new ConnectionClosedError(
				`Socket is not open (readyState=${socket.readyState})`,
			);
		}
		try {
			this.writeBuffer.push(bytes, (chunk) => socket.write(chunk));
		} catch (error) {
			if (error instanceof WriteBufferClosedError) {
				throw new ConnectionClosedError(error.message, error);
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	private flushWriteBuffer(): void {
		if (!this.socket) return;
		const socket = this.socket;
		this.writeBuffer.flush((chunk) => socket.write(chunk));
	}

	query(text: string): void {
		this.send(queryMessage(text));
	}

	async close(): Promise<void> {
		if (this.state === "closed" || this.state === "closing") return;
		this.state = "closing";
		try {
			this.socket?.write(terminate());
		} catch {
			// socket may already be gone — fall through to close()
		}
		this.socket?.end();
	}

	// ---------- socket handlers ----------

	private plaintextHandler(): SocketHandler<undefined> {
		return {
			open: (socket) => {
				this.socket = socket;
				if (this.config.sslmode === "disable") {
					this.state = "startup";
					this.sendStartup();
				} else {
					this.state = "ssl-negotiating";
					socket.write(sslRequest());
				}
			},
			data: (socket, chunk) => {
				if (this.state === "ssl-negotiating") {
					this.handleSslResponse(socket, chunk);
					return;
				}
				// After `upgradeTLS`, Bun keeps delivering raw encrypted TLS
				// records to this handler alongside the decrypted stream on
				// `tlsHandler.data`. Feeding raw bytes into the Parser would
				// corrupt it — ignore them here whenever TLS is in play.
				if (this.config.sslmode !== "disable") return;
				this.onBytes(chunk);
			},
			drain: () => this.flushWriteBuffer(),
			close: (_, error) => this.handleClose(error),
			error: (_, error) => this.fail(error),
		};
	}

	private tlsHandler(): SocketHandler<undefined> {
		return {
			open: (socket) => {
				this.socket = socket;
				// Don't send Startup here. Two Bun-specific reasons:
				//  1. Writes to a freshly-upgraded TLS socket before the
				//     `handshake` callback fires can be dropped (oven-sh/bun#9365).
				//  2. Bun's `upgradeTLS` completes the handshake *regardless* of
				//     cert trust — it reports verification failures via the
				//     `handshake` callback's `authorizationError`, not by
				//     rejecting the handshake (oven-sh/bun#22870). We must
				//     inspect that argument to enforce verify-ca / verify-full.
			},
			handshake: (_, success, authError) => {
				// Bun's `upgradeTLS` completes the handshake regardless of trust;
				// verification failures arrive here as `authError`. Enforce based on
				// the *effective* `rejectUnauthorized` from the resolved options
				// rather than `sslmode` alone — a caller who passes
				// `tls: { ca, rejectUnauthorized: true }` on top of `sslmode=require`
				// has opted into verification, and we must honor it.
				if (!success && !authError) {
					this.fail(
						new Error("TLS handshake failed without an authorization error"),
					);
					return;
				}
				const enforce = this.resolvedTls?.rejectUnauthorized === true;
				if (
					authError &&
					enforce &&
					!isToleratedAuthError(this.config.sslmode, authError)
				) {
					this.fail(authError);
					return;
				}
				this.state = "startup";
				this.sendStartup();
			},
			data: (_, chunk) => this.onBytes(chunk),
			drain: () => this.flushWriteBuffer(),
			close: (_, error) => this.handleClose(error),
			error: (_, error) => this.fail(error),
		};
	}

	private handleSslResponse(socket: Socket, chunk: Uint8Array): void {
		const first = chunk[0];
		if (first === SSL_RESPONSE_YES) {
			this.state = "tls-handshake";
			const tlsConfig = buildTlsOptions(
				this.config.sslmode,
				this.config.host,
				this.options.tls,
			);
			this.resolvedTls = tlsConfig;
			socket.upgradeTLS({ tls: tlsConfig, socket: this.tlsHandler() });
			return;
		}
		if (first === SSL_RESPONSE_NO) {
			this.fail(
				new Error("Server refused SSL (sslmode=require but server sent 'N')"),
			);
			return;
		}
		this.fail(
			new Error(
				`Unexpected byte during SSL negotiation: 0x${first?.toString(16)}`,
			),
		);
	}

	private onBytes(chunk: Uint8Array): void {
		try {
			this.parser.push(chunk, (msg) => this.dispatch(msg));
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private dispatch(msg: BackendMessage): void {
		switch (msg.type) {
			case "authenticationSASL":
				this.beginScram(msg.mechanisms);
				return;
			case "authenticationSASLContinue":
				this.continueScram(msg.data);
				return;
			case "authenticationSASLFinal":
				this.finishScram(msg.data);
				return;
			case "authenticationOk":
				this.state = "startup";
				return;
			case "parameterStatus":
				return;
			case "backendKeyData":
				this.backendKey = {
					processId: msg.processId,
					secretKey: msg.secretKey,
				};
				return;
			case "notice":
				this.safely(() => this.handlers.onNotice?.(msg.fields));
				return;
			case "readyForQuery":
				this.onReadyForQuery(msg.status);
				return;
			case "notification":
				this.safely(() =>
					this.handlers.onNotification?.(
						msg.channel,
						msg.payload,
						msg.processId,
					),
				);
				return;
			case "commandComplete":
				this.safely(() => this.handlers.onCommandComplete?.(msg.tag));
				return;
			case "error":
				this.handleErrorResponse(msg.fields);
				return;
			case "unknown":
				// Silently ignore unknown message types — Postgres never sends
				// a backend message we don't recognize under our feature set,
				// but if a future server does, don't fail hard.
				return;
		}
	}

	private sendStartup(): void {
		this.socket?.write(
			startup({
				user: this.config.user,
				database: this.config.database,
				applicationName: this.config.applicationName,
			}),
		);
	}

	private beginScram(mechanisms: string[]): void {
		if (!mechanisms.includes(SCRAM_SHA_256)) {
			this.fail(
				new Error(
					`Server does not advertise SCRAM-SHA-256 (got ${mechanisms.join(", ")})`,
				),
			);
			return;
		}
		this.state = "authenticating";
		this.scramSession = startSession();
		this.socket?.write(
			saslInitial(SCRAM_SHA_256, this.scramSession.clientFirstMessage),
		);
	}

	private continueScram(data: string): void {
		if (!this.scramSession) {
			this.fail(
				new Error("Received SASLContinue without an active SCRAM session"),
			);
			return;
		}
		try {
			const { clientFinalMessage, expectedServerSignature } = continueSession(
				this.scramSession,
				this.config.password,
				data,
			);
			this.scramExpectedSignature = expectedServerSignature;
			this.socket?.write(saslResponse(clientFinalMessage));
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private finishScram(data: string): void {
		if (!this.scramExpectedSignature) {
			this.fail(
				new Error("Received SASLFinal without an expected server signature"),
			);
			return;
		}
		try {
			finalizeSession(this.scramExpectedSignature, data);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.scramSession = undefined;
			this.scramExpectedSignature = undefined;
		}
	}

	private onReadyForQuery(status: TransactionStatus): void {
		if (this.state !== "ready") {
			this.state = "ready";
			this.clearConnectTimer();
			const resolve = this.readyResolve;
			this.readyResolve = undefined;
			this.readyReject = undefined;
			resolve?.();
		}
		this.safely(() => this.handlers.onReadyForQuery?.(status));
	}

	private handleErrorResponse(fields: Record<string, string>): void {
		const error = new PgProtocolError(fields);
		if (this.state !== "ready") {
			// Startup-phase errors are fatal.
			this.fail(error);
			return;
		}
		this.safely(() => this.handlers.onProtocolError?.(error));
	}

	private handleClose(error?: Error): void {
		const wasAlreadyClosed = this.state === "closed";
		this.state = "closed";
		this.writeBuffer.clear();
		this.clearConnectTimer();
		const cause =
			error ?? (this.readyReject ? new ConnectionClosedError() : undefined);
		if (this.readyReject) {
			const reject = this.readyReject;
			this.readyReject = undefined;
			this.readyResolve = undefined;
			reject(cause ?? new ConnectionClosedError());
		}
		if (!wasAlreadyClosed) {
			this.safely(() => this.handlers.onClose?.(error));
		}
	}

	private fail(error: Error): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.writeBuffer.clear();
		this.clearConnectTimer();
		try {
			this.socket?.end();
		} catch {
			// ignore — we're tearing down
		}
		if (this.readyReject) {
			const reject = this.readyReject;
			this.readyReject = undefined;
			this.readyResolve = undefined;
			reject(error);
		}
		this.safely(() => this.handlers.onClose?.(error));
	}

	private clearConnectTimer(): void {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = undefined;
		}
	}

	private safely(fn: () => void): void {
		queueMicrotask(() => {
			try {
				fn();
			} catch (err) {
				// A user callback threw. Surface it as a protocol-style error but
				// keep the connection alive — the socket itself is fine.
				const error = err instanceof Error ? err : new Error(String(err));
				try {
					this.handlers.onProtocolError?.(
						new PgProtocolError({ M: `User callback threw: ${error.message}` }),
					);
				} catch {
					// last-resort — don't let a callback-inside-a-callback crash us
				}
			}
		});
	}
}

/**
 * Decide whether a TLS authorization error from the `handshake` callback
 * should be tolerated for the given sslmode.
 *
 * - `verify-full` → every error is fatal (full chain + hostname must match).
 * - `verify-ca`   → tolerate hostname-mismatch errors only; chain failures
 *   are still fatal. Bun's BoringSSL surfaces hostname issues as Node's
 *   `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
function isToleratedAuthError(sslmode: SslMode, err: Error): boolean {
	if (sslmode !== "verify-ca") return false;
	const code = (err as { code?: string }).code;
	return code === "ERR_TLS_CERT_ALTNAME_INVALID";
}

/**
 * Derive Bun `TLSOptions` from a Postgres `sslmode` and optional user overrides.
 *
 * - `require` → encrypt but do not verify the cert chain.
 * - `verify-ca` → verify the chain; skip hostname check (for internal DNS / CNAMEs).
 * - `verify-full` → verify the chain and the hostname.
 *
 * User-supplied fields (`ca`, `cert`, `key`, `rejectUnauthorized`, ...) override
 * the sslmode-derived defaults so callers can point at a private CA without
 * reconstructing the full options object.
 */
export function buildTlsOptions(
	sslmode: SslMode,
	host: string,
	userTls: TLSOptions | boolean | undefined,
): TLSOptions {
	// For both verify-ca and verify-full we ask the TLS layer to verify the
	// chain. Hostname-mismatch tolerance for verify-ca is enforced in exactly
	// one place — `isToleratedAuthError` in the `handshake` callback above —
	// rather than via a blanket `checkServerIdentity: () => undefined`. A
	// blanket override would silently accept *any* cert if Bun ever starts
	// honoring `rejectUnauthorized` at the TLS layer (see upstream
	// oven-sh/bun#9365). Centralising the filter makes it auditable in one
	// switch statement.
	const base =
		sslmode === "verify-full" || sslmode === "verify-ca"
			? { rejectUnauthorized: true, serverName: host }
			: { rejectUnauthorized: false, serverName: host };
	if (typeof userTls === "object" && userTls !== null) {
		return { ...base, ...userTls } as TLSOptions;
	}
	return base as TLSOptions;
}
