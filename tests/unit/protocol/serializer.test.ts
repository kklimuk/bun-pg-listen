import { describe, expect, test } from "bun:test";
import {
	query,
	saslInitial,
	saslResponse,
	sslRequest,
	startup,
	terminate,
} from "@src/protocol/serializer.ts";

describe("serializer", () => {
	test("sslRequest is the documented 8-byte frame", () => {
		expect(Array.from(sslRequest())).toEqual([
			0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f,
		]);
	});

	test("terminate is 5 bytes", () => {
		expect(Array.from(terminate())).toEqual([0x58, 0, 0, 0, 4]);
	});

	test("query wraps text in Q + length + cstring", () => {
		const out = query("LISTEN foo");
		expect(out[0]).toBe(0x51);
		const length = new DataView(out.buffer, out.byteOffset).getInt32(1, false);
		// 4 (length) + 10 ("LISTEN foo") + 1 (null) = 15
		expect(length).toBe(15);
		expect(new TextDecoder().decode(out.subarray(5, -1))).toBe("LISTEN foo");
		expect(out[out.byteLength - 1]).toBe(0);
	});

	test("startup carries protocol version and kv pairs", () => {
		const out = startup({
			user: "postgres",
			database: "app",
			applicationName: "test",
		});
		// No code byte; first 4 bytes are length.
		const view = new DataView(out.buffer, out.byteOffset);
		expect(view.getInt32(0, false)).toBe(out.byteLength);
		expect(view.getInt32(4, false)).toBe(196608);
		const body = new TextDecoder().decode(out.subarray(8, -1));
		expect(body.split("\0")).toContain("user");
		expect(body.split("\0")).toContain("postgres");
		expect(body.split("\0")).toContain("database");
		expect(body.split("\0")).toContain("app");
		expect(body.split("\0")).toContain("application_name");
		expect(body.split("\0")).toContain("test");
		expect(out[out.byteLength - 1]).toBe(0);
	});

	test("saslInitial packs mechanism, response-length, response bytes", () => {
		const first = "n,,n=*,r=abc";
		const out = saslInitial("SCRAM-SHA-256", first);
		expect(out[0]).toBe(0x70);
		const view = new DataView(out.buffer, out.byteOffset);
		// Mechanism is cstring starting at offset 5
		const mech = new TextDecoder().decode(
			out.subarray(5, 5 + "SCRAM-SHA-256".length),
		);
		expect(mech).toBe("SCRAM-SHA-256");
		const mechEnd = 5 + "SCRAM-SHA-256".length + 1;
		expect(view.getInt32(mechEnd, false)).toBe(first.length);
		expect(new TextDecoder().decode(out.subarray(mechEnd + 4))).toBe(first);
	});

	test("saslResponse is p-prefixed raw response bytes", () => {
		const final = "c=biws,r=abc,p=xyz";
		const out = saslResponse(final);
		expect(out[0]).toBe(0x70);
		expect(new TextDecoder().decode(out.subarray(5))).toBe(final);
	});
});
