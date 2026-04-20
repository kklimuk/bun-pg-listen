import { describe, expect, test } from "bun:test";
import { Reader } from "@src/protocol/reader.ts";

describe("Reader", () => {
	test("reads big-endian int16 / int32", () => {
		const bytes = new Uint8Array([0x12, 0x34, 0x00, 0x00, 0x04, 0xd2]);
		const r = new Reader(bytes);
		expect(r.int16()).toBe(0x1234);
		expect(r.int32()).toBe(1234);
	});

	test("reads cstring and advances past null", () => {
		const bytes = new Uint8Array([0x61, 0x62, 0x00, 0x63]);
		const r = new Reader(bytes);
		expect(r.cstring()).toBe("ab");
		expect(r.byte()).toBe(0x63);
	});

	test("cstring handles multi-byte UTF-8", () => {
		const bytes = new TextEncoder().encode("héllo\0");
		const r = new Reader(bytes);
		expect(r.cstring()).toBe("héllo");
	});

	test("cstring throws without null terminator", () => {
		const r = new Reader(new Uint8Array([0x61, 0x62]));
		expect(() => r.cstring()).toThrow();
	});

	test("string(n) reads fixed-length UTF-8 slice", () => {
		const r = new Reader(new TextEncoder().encode("hello world"));
		expect(r.string(5)).toBe("hello");
		expect(r.byte()).toBe(0x20);
	});

	test("bytes(n) returns subarray and advances", () => {
		const r = new Reader(new Uint8Array([1, 2, 3, 4, 5]));
		const slice = r.bytes(3);
		expect(Array.from(slice)).toEqual([1, 2, 3]);
		expect(r.remaining()).toBe(2);
	});

	test("bytes(n) throws past end", () => {
		const r = new Reader(new Uint8Array([1, 2]));
		expect(() => r.bytes(3)).toThrow();
	});

	test("respects starting offset", () => {
		const bytes = new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x00, 0x05]);
		const r = new Reader(bytes, 2);
		expect(r.int32()).toBe(5);
	});
});
