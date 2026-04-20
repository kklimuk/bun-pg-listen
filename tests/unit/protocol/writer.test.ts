import { describe, expect, test } from "bun:test";
import { Writer } from "@src/protocol/writer.ts";

describe("Writer", () => {
	test("flush with code emits [code][length][payload]", () => {
		const out = new Writer().addCString("hello").flush(0x51);
		expect(out[0]).toBe(0x51);
		// length = 4 (length field) + 6 ("hello" + \0) = 10
		expect(out[1]).toBe(0);
		expect(out[2]).toBe(0);
		expect(out[3]).toBe(0);
		expect(out[4]).toBe(10);
		expect(new TextDecoder().decode(out.subarray(5, 10))).toBe("hello");
		expect(out[10]).toBe(0);
	});

	test("flush without code emits [length][payload]", () => {
		const out = new Writer().addInt32(80877103).flush();
		// SSLRequest: length=8, code=80877103
		expect(Array.from(out)).toEqual([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
	});

	test("terminate is 5 bytes", () => {
		const out = new Writer(8).flush(0x58);
		expect(Array.from(out)).toEqual([0x58, 0, 0, 0, 4]);
	});

	test("addInt16 / addInt32 encode big-endian", () => {
		const out = new Writer().addInt16(0x1234).addInt32(0xabcdef01).flush(0x44);
		expect(out[5]).toBe(0x12);
		expect(out[6]).toBe(0x34);
		expect(out[7]).toBe(0xab);
		expect(out[8]).toBe(0xcd);
		expect(out[9]).toBe(0xef);
		expect(out[10]).toBe(0x01);
	});

	test("addCString writes UTF-8 then null", () => {
		const out = new Writer().addCString("héllo").flush(0x51);
		const body = out.subarray(5);
		const decoded = new TextDecoder().decode(body.subarray(0, body.length - 1));
		expect(decoded).toBe("héllo");
		expect(body[body.length - 1]).toBe(0);
	});

	test("addCString with empty string writes only null", () => {
		const out = new Writer().addCString("").flush(0x51);
		expect(out[5]).toBe(0);
		expect(out.byteLength).toBe(6);
	});

	test("grows buffer past initial size", () => {
		const w = new Writer(8);
		const long = "x".repeat(1000);
		const out = w.addCString(long).flush(0x51);
		expect(out.byteLength).toBe(1 + 4 + 1000 + 1);
	});

	test("reuses writer after flush", () => {
		const w = new Writer();
		const first = w.addCString("a").flush(0x51);
		const second = w.addCString("bb").flush(0x51);
		expect(first.byteLength).toBe(1 + 4 + 2);
		expect(second.byteLength).toBe(1 + 4 + 3);
	});

	test("addBytes copies raw bytes", () => {
		const out = new Writer().addBytes(new Uint8Array([1, 2, 3])).flush(0x51);
		expect(Array.from(out.subarray(5))).toEqual([1, 2, 3]);
	});
});
