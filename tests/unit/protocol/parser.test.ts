import { describe, expect, test } from "bun:test";
import type { BackendMessage } from "@src/protocol/messages.ts";
import { Parser } from "@src/protocol/parser.ts";

function collect(chunks: Uint8Array[]): BackendMessage[] {
	const parser = new Parser();
	const messages: BackendMessage[] = [];
	for (const chunk of chunks) parser.push(chunk, (m) => messages.push(m));
	return messages;
}

function frame(code: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.byteLength);
	out[0] = code;
	new DataView(out.buffer).setInt32(1, 4 + payload.byteLength, false);
	out.set(payload, 5);
	return out;
}

function cstring(s: string): Uint8Array {
	const encoded = new TextEncoder().encode(s);
	const out = new Uint8Array(encoded.byteLength + 1);
	out.set(encoded);
	return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
	const total = arrs.reduce((n, a) => n + a.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrs) {
		out.set(a, off);
		off += a.byteLength;
	}
	return out;
}

const readyForQuery = frame(0x5a, new Uint8Array([0x49]));
const commandComplete = frame(0x43, cstring("LISTEN"));
const notification = frame(
	0x41,
	concat(new Uint8Array([0, 0, 0x30, 0x39]), cstring("ch"), cstring("payload")),
);

describe("Parser", () => {
	test("parses single complete message", () => {
		expect(collect([readyForQuery])).toEqual([
			{ type: "readyForQuery", status: "I" },
		]);
	});

	test("parses multiple messages in one chunk", () => {
		const msgs = collect([concat(commandComplete, readyForQuery)]);
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({ type: "commandComplete", tag: "LISTEN" });
		expect(msgs[1]).toEqual({ type: "readyForQuery", status: "I" });
	});

	test("handles split header", () => {
		// Split right in the middle of the length field
		const msg = notification;
		const msgs = collect([msg.subarray(0, 2), msg.subarray(2)]);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({
			type: "notification",
			channel: "ch",
			payload: "payload",
		});
	});

	test("handles byte-by-byte feed", () => {
		const full = concat(commandComplete, readyForQuery, notification);
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < full.byteLength; i++)
			chunks.push(full.subarray(i, i + 1));
		const msgs = collect(chunks);
		expect(msgs).toHaveLength(3);
		expect(msgs[0]?.type).toBe("commandComplete");
		expect(msgs[1]?.type).toBe("readyForQuery");
		expect(msgs[2]?.type).toBe("notification");
	});

	test("splits at every offset produce identical output", () => {
		const full = concat(commandComplete, readyForQuery);
		const reference = collect([full]);
		for (let split = 1; split < full.byteLength; split++) {
			const msgs = collect([full.subarray(0, split), full.subarray(split)]);
			expect(msgs).toEqual(reference);
		}
	});

	test("holds payload across push boundary", () => {
		const msg = notification;
		// Split 10 bytes in (header done, payload partial)
		const msgs = collect([msg.subarray(0, 10), msg.subarray(10)]);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ channel: "ch", payload: "payload" });
	});

	test("unknown message codes are emitted, not dropped", () => {
		const weird = frame(0x7a, new Uint8Array([1, 2, 3]));
		const msgs = collect([weird]);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.type).toBe("unknown");
	});

	test("unknown.data is a copy, not a live view into the parser buffer", () => {
		const parser = new Parser();
		const messages: BackendMessage[] = [];
		const weird = frame(0x7a, new Uint8Array([0xaa, 0xbb, 0xcc]));
		parser.push(weird, (m) => messages.push(m));

		// Push another chunk; this reuses / overwrites the parser's internal buffer.
		parser.push(frame(0x5a, new Uint8Array([0x49])), (m) => messages.push(m));

		// The originally captured bytes must still be intact.
		const first = messages[0];
		expect(first?.type).toBe("unknown");
		if (first?.type === "unknown") {
			expect(Array.from(first.data)).toEqual([0xaa, 0xbb, 0xcc]);
		}
	});
});
