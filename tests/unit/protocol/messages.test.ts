import { describe, expect, test } from "bun:test";
import { decode } from "@src/protocol/messages.ts";

function payload(...bytes: number[]): Uint8Array {
	return new Uint8Array(bytes);
}

function cstring(s: string): number[] {
	return [...new TextEncoder().encode(s), 0];
}

describe("decode", () => {
	test("AuthenticationOk", () => {
		const msg = decode(0x52, payload(0, 0, 0, 0));
		expect(msg).toEqual({ type: "authenticationOk" });
	});

	test("AuthenticationSASL lists mechanisms", () => {
		const msg = decode(
			0x52,
			payload(
				0,
				0,
				0,
				10,
				...cstring("SCRAM-SHA-256"),
				...cstring("SCRAM-SHA-256-PLUS"),
				0,
			),
		);
		expect(msg).toEqual({
			type: "authenticationSASL",
			mechanisms: ["SCRAM-SHA-256", "SCRAM-SHA-256-PLUS"],
		});
	});

	test("AuthenticationSASLContinue captures server-first-message", () => {
		const data = "r=abc,s=xyz,i=4096";
		const msg = decode(
			0x52,
			payload(0, 0, 0, 11, ...new TextEncoder().encode(data)),
		);
		expect(msg).toEqual({ type: "authenticationSASLContinue", data });
	});

	test("AuthenticationSASLFinal captures server-signature", () => {
		const data = "v=deadbeef";
		const msg = decode(
			0x52,
			payload(0, 0, 0, 12, ...new TextEncoder().encode(data)),
		);
		expect(msg).toEqual({ type: "authenticationSASLFinal", data });
	});

	test("ParameterStatus", () => {
		const msg = decode(
			0x53,
			payload(...cstring("server_version"), ...cstring("18.0")),
		);
		expect(msg).toEqual({
			type: "parameterStatus",
			name: "server_version",
			value: "18.0",
		});
	});

	test("BackendKeyData", () => {
		const msg = decode(0x4b, payload(0, 0, 0x04, 0xd2, 0, 0, 0x10, 0x00));
		expect(msg).toEqual({
			type: "backendKeyData",
			processId: 1234,
			secretKey: 4096,
		});
	});

	test("ReadyForQuery I/T/E", () => {
		expect(decode(0x5a, payload(0x49))).toEqual({
			type: "readyForQuery",
			status: "I",
		});
		expect(decode(0x5a, payload(0x54))).toEqual({
			type: "readyForQuery",
			status: "T",
		});
		expect(decode(0x5a, payload(0x45))).toEqual({
			type: "readyForQuery",
			status: "E",
		});
	});

	test("NotificationResponse", () => {
		const msg = decode(
			0x41,
			payload(
				0,
				0,
				0x30,
				0x39,
				...cstring("page_updates"),
				...cstring('{"id":1}'),
			),
		);
		expect(msg).toEqual({
			type: "notification",
			processId: 0x3039,
			channel: "page_updates",
			payload: '{"id":1}',
		});
	});

	test("CommandComplete", () => {
		const msg = decode(0x43, payload(...cstring("LISTEN")));
		expect(msg).toEqual({ type: "commandComplete", tag: "LISTEN" });
	});

	test("ErrorResponse parses field codes", () => {
		const msg = decode(
			0x45,
			payload(
				0x53, // S
				...cstring("ERROR"),
				0x43, // C
				...cstring("42704"),
				0x4d, // M
				...cstring("channel does not exist"),
				0,
			),
		);
		expect(msg).toEqual({
			type: "error",
			fields: { S: "ERROR", C: "42704", M: "channel does not exist" },
		});
	});

	test("NoticeResponse uses same format as ErrorResponse", () => {
		const msg = decode(
			0x4e,
			payload(0x53, ...cstring("WARNING"), 0x4d, ...cstring("something"), 0),
		);
		expect(msg).toEqual({
			type: "notice",
			fields: { S: "WARNING", M: "something" },
		});
	});

	test("unknown code is surfaced as { type: 'unknown' }", () => {
		const data = payload(1, 2, 3);
		const msg = decode(0x7a, data);
		expect(msg).toEqual({ type: "unknown", code: 0x7a, data });
	});

	test("unsupported authentication subtype throws", () => {
		expect(() => decode(0x52, payload(0, 0, 0, 5))).toThrow(/Unsupported/);
	});
});
