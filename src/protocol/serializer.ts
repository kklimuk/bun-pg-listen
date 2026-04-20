import { Writer } from "./writer.ts";

const PROTOCOL_VERSION_3 = 196608; // 3 << 16
const SSL_REQUEST_CODE = 80877103;

export type StartupParams = {
	user: string;
	database?: string;
	applicationName?: string;
	clientEncoding?: string;
};

/**
 * StartupMessage: `[length][3.0][key=value cstrings...][\0]`.
 * No type byte.
 */
export function startup(params: StartupParams): Uint8Array {
	const w = new Writer();
	w.addInt32(PROTOCOL_VERSION_3);
	w.addCString("user").addCString(params.user);
	if (params.database) w.addCString("database").addCString(params.database);
	w.addCString("client_encoding").addCString(params.clientEncoding ?? "UTF8");
	if (params.applicationName) {
		w.addCString("application_name").addCString(params.applicationName);
	}
	w.addCString("");
	return w.flush();
}

/**
 * SSLRequest: `[length=8][code=80877103]`. Sent before StartupMessage when
 * the caller wants to negotiate TLS. Server responds with a single byte:
 * `S` (accept) or `N` (reject).
 */
export function sslRequest(): Uint8Array {
	const w = new Writer(8);
	w.addInt32(SSL_REQUEST_CODE);
	return w.flush();
}

/**
 * SASLInitialResponse: `'p'[length][mechanism cstring][response-length: i32][response bytes]`.
 */
export function saslInitial(
	mechanism: string,
	clientFirstMessage: string,
): Uint8Array {
	const response = new TextEncoder().encode(clientFirstMessage);
	const w = new Writer();
	w.addCString(mechanism);
	w.addInt32(response.byteLength);
	w.addBytes(response);
	return w.flush(0x70);
}

/**
 * SASLResponse: `'p'[length][response bytes]`.
 */
export function saslResponse(clientFinalMessage: string): Uint8Array {
	const w = new Writer();
	w.addString(clientFinalMessage);
	return w.flush(0x70);
}

/**
 * Simple Query: `'Q'[length][query cstring]`.
 */
export function query(text: string): Uint8Array {
	const w = new Writer();
	w.addCString(text);
	return w.flush(0x51);
}

/**
 * Terminate: `'X'[length=4]`. 5 bytes total.
 */
export function terminate(): Uint8Array {
	const w = new Writer(8);
	return w.flush(0x58);
}
