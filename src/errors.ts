/**
 * Structured error from Postgres ErrorResponse.
 * Preserves SQLSTATE code, severity, and detail fields.
 *
 * WARNING on logging: `fields` is the full Postgres ErrorResponse, which
 * can include `q` (internal-query text) and `W` (where — call site).
 * Postgres echoes the failing SQL there, so for a failed NOTIFY those
 * fields contain the **payload** verbatim. If the payload carries PII or
 * secrets, logging `.fields` leaks them. Prefer `.safeFields` — same
 * shape with `q` / `W` / `R` stripped — for default logging; opt into
 * `.fields` only when the caller has already sanitized or knows the
 * payload is non-sensitive.
 */
const SENSITIVE_FIELD_KEYS = new Set(["q", "W", "R", "s"]);

export class PgProtocolError extends Error {
	readonly code: string | undefined;
	readonly severity: string | undefined;
	readonly detail: string | undefined;
	readonly fields: Record<string, string>;

	constructor(fields: Record<string, string>) {
		super(fields.M ?? fields.V ?? "Postgres error");
		this.name = "PgProtocolError";
		this.code = fields.C;
		this.severity = fields.V ?? fields.S;
		this.detail = fields.D;
		this.fields = fields;
	}

	/**
	 * `fields` with the keys that can carry call-site SQL, NOTIFY payloads,
	 * or server-internal source locations stripped:
	 *   `q` — internal-query text (echoes the failing SQL incl. NOTIFY payload)
	 *   `W` — where / call-site context
	 *   `R` — routine name in Postgres source
	 *   `s` — schema name of the failing object (often leaks tenant IDs)
	 * Safe to feed into structured loggers by default.
	 */
	get safeFields(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(this.fields)) {
			if (!SENSITIVE_FIELD_KEYS.has(key)) out[key] = value;
		}
		return out;
	}
}

/**
 * The connection was closed (by us, the server, or the network) and any
 * in-flight operation cannot complete.
 */
export class ConnectionClosedError extends Error {
	constructor(message = "Connection closed", cause?: Error) {
		super(message, cause ? { cause } : undefined);
		this.name = "ConnectionClosedError";
	}
}

/**
 * NOTIFY payload exceeded Postgres's documented 8000-byte limit.
 * Thrown before anything is sent so nothing mutates on the server.
 */
export class PayloadTooLargeError extends Error {
	/** Postgres stores the payload plus a NUL terminator in an 8000-byte slot. */
	static readonly LIMIT = 8000;
	readonly size: number;
	readonly limit = PayloadTooLargeError.LIMIT;
	constructor(size: number) {
		super(
			`NOTIFY payload is ${size} bytes; Postgres limit is ${PayloadTooLargeError.LIMIT} bytes`,
		);
		this.name = "PayloadTooLargeError";
		this.size = size;
	}
}

/**
 * Connection was not ready when an operation required it (e.g. `listen`
 * called before `connect()` resolved).
 */
export class ConnectionNotReadyError extends Error {
	constructor(state: string) {
		super(`Connection not ready (state: ${state})`);
		this.name = "ConnectionNotReadyError";
	}
}
