import {
	createHash,
	createHmac,
	pbkdf2Sync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

/**
 * SCRAM-SHA-256 (RFC 5802 + RFC 7677) client implementation.
 *
 * Four-step exchange with the server:
 *   1. client → server: SASLInitialResponse carrying `clientFirstMessage`
 *   2. server → client: AuthenticationSASLContinue carrying server-first-message
 *   3. client → server: SASLResponse carrying `clientFinalMessage`
 *   4. server → client: AuthenticationSASLFinal carrying server-final-message
 *
 * Usage:
 *   const session = startSession();
 *   // send session.clientFirstMessage
 *   const { clientFinalMessage, expectedServerSignature } =
 *     continueSession(session, password, serverFirstMessage);
 *   // send clientFinalMessage
 *   finalizeSession(expectedServerSignature, serverFinalMessage);
 *
 * Postgres quirk: we always send `n=*` for the SCRAM username. Postgres
 * ignores the SCRAM username and uses the `user` field from StartupMessage.
 */

export const SCRAM_SHA_256 = "SCRAM-SHA-256" as const;

/**
 * Upper bound on server-supplied PBKDF2 iteration count.
 *
 * `pbkdf2Sync` is CPU-bound and runs on the main thread. A hostile or
 * MITM-tampered server that sends `i=2147483647` would freeze the event
 * loop for minutes — combined with our unbounded reconnect loop that's a
 * permanent wedge. Real servers never exceed a few hundred thousand
 * (Postgres's default is 4096), so 1,000,000 is both safe and well above
 * anything legitimate.
 */
export const MAX_SCRAM_ITERATIONS = 1_000_000;

export type ScramSession = {
	mechanism: typeof SCRAM_SHA_256;
	clientNonce: string;
	clientFirstMessageBare: string;
	clientFirstMessage: string;
};

export type ScramContinuation = {
	clientFinalMessage: string;
	expectedServerSignature: string;
};

export function startSession(
	clientNonce = randomBytes(18).toString("base64"),
): ScramSession {
	const clientFirstMessageBare = `n=*,r=${clientNonce}`;
	return {
		mechanism: SCRAM_SHA_256,
		clientNonce,
		clientFirstMessageBare,
		clientFirstMessage: `n,,${clientFirstMessageBare}`,
	};
}

export function continueSession(
	session: ScramSession,
	password: string,
	serverFirstMessage: string,
): ScramContinuation {
	const fields = parseMessage(serverFirstMessage);
	const combinedNonce = fields.r;
	const salt = fields.s;
	const iterationsRaw = fields.i;
	if (!combinedNonce || !salt || !iterationsRaw) {
		throw new Error("SCRAM: server-first-message missing r/s/i");
	}
	if (!combinedNonce.startsWith(session.clientNonce)) {
		throw new Error("SCRAM: server nonce does not extend client nonce");
	}
	const iterations = Number.parseInt(iterationsRaw, 10);
	if (!Number.isFinite(iterations) || iterations < 1) {
		throw new Error(`SCRAM: invalid iteration count '${iterationsRaw}'`);
	}
	if (iterations > MAX_SCRAM_ITERATIONS) {
		throw new Error(
			`SCRAM: iteration count ${iterations} exceeds maximum ${MAX_SCRAM_ITERATIONS} ` +
				"(protects against a hostile server freezing the event loop via PBKDF2)",
		);
	}

	const saltedPassword = pbkdf2Sync(
		password,
		Buffer.from(salt, "base64"),
		iterations,
		32,
		"sha256",
	);
	const clientKey = hmac(saltedPassword, "Client Key");
	const storedKey = sha256(clientKey);

	const clientFinalMessageWithoutProof = `c=biws,r=${combinedNonce}`;
	const authMessage = `${session.clientFirstMessageBare},${serverFirstMessage},${clientFinalMessageWithoutProof}`;

	const clientSignature = hmac(storedKey, authMessage);
	const clientProof = xor(clientKey, clientSignature);

	const serverKey = hmac(saltedPassword, "Server Key");
	const expectedServerSignature = hmac(serverKey, authMessage).toString(
		"base64",
	);

	return {
		clientFinalMessage: `${clientFinalMessageWithoutProof},p=${clientProof.toString("base64")}`,
		expectedServerSignature,
	};
}

export function finalizeSession(
	expectedServerSignature: string,
	serverFinalMessage: string,
): void {
	const fields = parseMessage(serverFinalMessage);
	if (fields.e) {
		throw new Error(`SCRAM: server rejected authentication: ${fields.e}`);
	}
	if (!fields.v) {
		throw new Error("SCRAM: server-final-message missing verifier");
	}
	// Constant-time compare: protects against timing-side-channel probes of
	// the server signature (a would-be impostor trying to guess `v` byte by
	// byte). Jitter from TLS + TCP usually swamps the channel in practice,
	// but this is free and removes the footgun for future readers.
	const got = Buffer.from(fields.v, "base64");
	const want = Buffer.from(expectedServerSignature, "base64");
	if (got.byteLength !== want.byteLength || !timingSafeEqual(got, want)) {
		throw new Error("SCRAM: server signature mismatch");
	}
}

function parseMessage(msg: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of msg.split(",")) {
		const eq = part.indexOf("=");
		if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return out;
}

function hmac(key: Uint8Array, msg: string | Uint8Array): Buffer {
	return createHmac("sha256", key).update(msg).digest();
}

function sha256(x: Uint8Array): Buffer {
	return createHash("sha256").update(x).digest();
}

function xor(a: Uint8Array, b: Uint8Array): Buffer {
	if (a.byteLength !== b.byteLength) {
		throw new Error("SCRAM: XOR operands have different lengths");
	}
	const out = Buffer.allocUnsafe(a.byteLength);
	for (let i = 0; i < a.byteLength; i++) {
		out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return out;
}
