import { describe, expect, test } from "bun:test";
import {
	WriteBuffer,
	WriteBufferClosedError,
	WriteBufferOverflowError,
	type Writer,
} from "@src/write-buffer.ts";

function bytes(...xs: number[]): Uint8Array {
	return new Uint8Array(xs);
}

function recordingWriter(accept: (chunk: Uint8Array) => number): {
	write: Writer;
	calls: Uint8Array[];
} {
	const calls: Uint8Array[] = [];
	const write: Writer = (chunk) => {
		calls.push(new Uint8Array(chunk));
		return accept(chunk);
	};
	return { write, calls };
}

describe("WriteBuffer", () => {
	test("push with full write leaves queue empty", () => {
		const buf = new WriteBuffer();
		const { write, calls } = recordingWriter((c) => c.byteLength);
		buf.push(bytes(1, 2, 3), write);
		expect(calls).toEqual([bytes(1, 2, 3)]);
		expect(buf.length).toBe(0);
	});

	test("push with partial write queues remaining tail", () => {
		const buf = new WriteBuffer();
		const { write } = recordingWriter(() => 2);
		buf.push(bytes(1, 2, 3, 4, 5), write);
		expect(buf.length).toBe(1);
	});

	test("push while queue non-empty appends without writing", () => {
		const buf = new WriteBuffer();
		const { write, calls } = recordingWriter((c) => {
			// First push: accept 1 byte, leaving tail queued.
			// Second push: should NOT call write — must append behind.
			return calls.length === 1 ? 1 : c.byteLength;
		});
		buf.push(bytes(1, 2, 3), write);
		expect(buf.length).toBe(1);
		buf.push(bytes(9, 9), write);
		expect(calls.length).toBe(1);
		expect(buf.length).toBe(2);
	});

	test("push with zero-byte write queues the whole chunk", () => {
		const buf = new WriteBuffer();
		const { write } = recordingWriter(() => 0);
		buf.push(bytes(1, 2, 3), write);
		expect(buf.length).toBe(1);
	});

	test("flush drains queue head-first in FIFO order", () => {
		const buf = new WriteBuffer();
		const noop: Writer = () => 0;
		buf.push(bytes(1, 2), noop);
		buf.push(bytes(3, 4), noop);
		buf.push(bytes(5, 6), noop);
		expect(buf.length).toBe(3);

		const seen: number[] = [];
		buf.flush((c) => {
			seen.push(...c);
			return c.byteLength;
		});
		expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
		expect(buf.length).toBe(0);
	});

	test("flush stops on short write and re-queues the tail at the head", () => {
		const buf = new WriteBuffer();
		const noop: Writer = () => 0;
		buf.push(bytes(1, 2, 3, 4), noop);
		buf.push(bytes(5, 6), noop);

		let calls = 0;
		buf.flush((c) => {
			calls++;
			return calls === 1 ? 1 : c.byteLength;
		});
		expect(calls).toBe(1);
		expect(buf.length).toBe(2);

		const seen: number[] = [];
		buf.flush((c) => {
			seen.push(...c);
			return c.byteLength;
		});
		expect(seen).toEqual([2, 3, 4, 5, 6]);
	});

	test("flush with zero-byte write leaves queue unchanged", () => {
		const buf = new WriteBuffer();
		const noop: Writer = () => 0;
		buf.push(bytes(1, 2, 3), noop);
		buf.push(bytes(4, 5), noop);
		expect(buf.length).toBe(2);

		buf.flush(() => 0);
		expect(buf.length).toBe(2);
	});

	test("clear empties the queue", () => {
		const buf = new WriteBuffer();
		const noop: Writer = () => 0;
		buf.push(bytes(1), noop);
		buf.push(bytes(2), noop);
		expect(buf.length).toBe(2);
		buf.clear();
		expect(buf.length).toBe(0);
	});

	test("push after clear writes synchronously again", () => {
		const buf = new WriteBuffer();
		buf.push(bytes(1, 2), () => 0);
		buf.clear();
		const { write, calls } = recordingWriter((c) => c.byteLength);
		buf.push(bytes(3, 4), write);
		expect(calls).toEqual([bytes(3, 4)]);
		expect(buf.length).toBe(0);
	});

	test("negative writer return from push signals socket closed", () => {
		const buf = new WriteBuffer();
		expect(() => buf.push(bytes(1, 2, 3), () => -1)).toThrow(
			WriteBufferClosedError,
		);
		expect(buf.length).toBe(0);
		expect(buf.bytesQueued).toBe(0);
	});

	test("negative writer return from flush clears queue without re-queuing", () => {
		const buf = new WriteBuffer();
		buf.push(bytes(1, 2, 3), () => 0);
		buf.push(bytes(4, 5), () => 0);
		expect(buf.length).toBe(2);
		buf.flush(() => -1);
		expect(buf.length).toBe(0);
		expect(buf.bytesQueued).toBe(0);
	});

	test("bytesQueued tracks queue depth across pushes and partial flushes", () => {
		const buf = new WriteBuffer();
		buf.push(bytes(1, 2, 3), () => 0);
		expect(buf.bytesQueued).toBe(3);
		buf.push(bytes(4, 5), () => 0);
		expect(buf.bytesQueued).toBe(5);
		buf.flush((c) => (c.byteLength === 3 ? 2 : c.byteLength));
		expect(buf.bytesQueued).toBe(3); // 1 byte left from first chunk + 2-byte chunk
	});

	test("push throws WriteBufferOverflowError when queue would exceed maxBytes", () => {
		const buf = new WriteBuffer(10);
		buf.push(bytes(1, 2, 3, 4, 5, 6), () => 0); // queues 6 bytes
		expect(() => buf.push(bytes(7, 8, 9, 10, 11), () => 0)).toThrow(
			WriteBufferOverflowError,
		);
		// Existing queue preserved; failed push doesn't land
		expect(buf.bytesQueued).toBe(6);
	});

	test("maxBytes allows exactly the limit", () => {
		const buf = new WriteBuffer(6);
		buf.push(bytes(1, 2, 3), () => 0);
		expect(() => buf.push(bytes(4, 5, 6), () => 0)).not.toThrow();
		expect(buf.bytesQueued).toBe(6);
	});
});
