import { Reader } from "./reader.ts";

/**
 * Message type codes for backend (server → client) messages.
 * From https://www.postgresql.org/docs/current/protocol-message-formats.html
 */
export const BackendCode = {
	Authentication: 0x52, // 'R'
	BackendKeyData: 0x4b, // 'K'
	CommandComplete: 0x43, // 'C'
	ErrorResponse: 0x45, // 'E'
	NoticeResponse: 0x4e, // 'N'
	NotificationResponse: 0x41, // 'A'
	ParameterStatus: 0x53, // 'S'
	ReadyForQuery: 0x5a, // 'Z'
} as const;

export type TransactionStatus = "I" | "T" | "E";

export type BackendMessage =
	| { type: "authenticationOk" }
	| { type: "authenticationSASL"; mechanisms: string[] }
	| { type: "authenticationSASLContinue"; data: string }
	| { type: "authenticationSASLFinal"; data: string }
	| { type: "parameterStatus"; name: string; value: string }
	| { type: "backendKeyData"; processId: number; secretKey: number }
	| { type: "readyForQuery"; status: TransactionStatus }
	| {
			type: "notification";
			processId: number;
			channel: string;
			payload: string;
	  }
	| { type: "commandComplete"; tag: string }
	| { type: "error"; fields: Record<string, string> }
	| { type: "notice"; fields: Record<string, string> }
	| { type: "unknown"; code: number; data: Uint8Array };

const AuthSubtype = {
	Ok: 0,
	SASL: 10,
	SASLContinue: 11,
	SASLFinal: 12,
} as const;

export function decode(code: number, payload: Uint8Array): BackendMessage {
	const reader = new Reader(payload);
	switch (code) {
		case BackendCode.Authentication:
			return decodeAuthentication(reader);
		case BackendCode.ParameterStatus:
			return {
				type: "parameterStatus",
				name: reader.cstring(),
				value: reader.cstring(),
			};
		case BackendCode.BackendKeyData:
			return {
				type: "backendKeyData",
				processId: reader.int32(),
				secretKey: reader.int32(),
			};
		case BackendCode.ReadyForQuery:
			return {
				type: "readyForQuery",
				status: decodeTransactionStatus(reader.byte()),
			};
		case BackendCode.NotificationResponse:
			return {
				type: "notification",
				processId: reader.int32(),
				channel: reader.cstring(),
				payload: reader.cstring(),
			};
		case BackendCode.CommandComplete:
			return { type: "commandComplete", tag: reader.cstring() };
		case BackendCode.ErrorResponse:
			return { type: "error", fields: decodeFields(reader) };
		case BackendCode.NoticeResponse:
			return { type: "notice", fields: decodeFields(reader) };
		default:
			// `payload` is a view over the parser's live buffer — copy so
			// callers that retain `data` across parser pushes don't get
			// surprising byte corruption.
			return { type: "unknown", code, data: new Uint8Array(payload) };
	}
}

function decodeAuthentication(reader: Reader): BackendMessage {
	const subtype = reader.int32();
	switch (subtype) {
		case AuthSubtype.Ok:
			return { type: "authenticationOk" };
		case AuthSubtype.SASL: {
			const mechanisms: string[] = [];
			while (reader.remaining() > 1) {
				const mech = reader.cstring();
				if (mech.length === 0) break;
				mechanisms.push(mech);
			}
			return { type: "authenticationSASL", mechanisms };
		}
		case AuthSubtype.SASLContinue:
			return {
				type: "authenticationSASLContinue",
				data: reader.string(reader.remaining()),
			};
		case AuthSubtype.SASLFinal:
			return {
				type: "authenticationSASLFinal",
				data: reader.string(reader.remaining()),
			};
		default:
			throw new Error(`Unsupported authentication method: ${subtype}`);
	}
}

function decodeTransactionStatus(byte: number): TransactionStatus {
	if (byte === 0x49) return "I";
	if (byte === 0x54) return "T";
	if (byte === 0x45) return "E";
	throw new Error(`Invalid transaction status byte: 0x${byte.toString(16)}`);
}

function decodeFields(reader: Reader): Record<string, string> {
	const fields: Record<string, string> = {};
	while (reader.remaining() > 0) {
		const key = reader.byte();
		if (key === 0) break;
		const value = reader.cstring();
		fields[String.fromCharCode(key)] = value;
	}
	return fields;
}
