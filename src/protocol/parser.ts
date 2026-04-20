import { type BackendMessage, decode } from "./messages.ts";

const HEADER_SIZE = 5;

/**
 * Incremental parser for the Postgres backend wire protocol.
 *
 * Each message is framed as `[code: u8][length: u32 BE][payload]` where
 * `length` includes the 4 length bytes but excludes `code`.
 *
 * Accepts arbitrarily-fragmented chunks; preserves the tail of the current
 * buffer until enough bytes arrive to complete the next message.
 */
export class Parser {
	private buffer: Uint8Array = new Uint8Array(0);
	private offset = 0;

	push(chunk: Uint8Array, onMessage: (msg: BackendMessage) => void): void {
		this.merge(chunk);
		const view = new DataView(
			this.buffer.buffer,
			this.buffer.byteOffset,
			this.buffer.byteLength,
		);

		while (this.buffer.byteLength - this.offset >= HEADER_SIZE) {
			const code = this.buffer[this.offset] ?? 0;
			const length = view.getInt32(this.offset + 1, false);
			const total = 1 + length;

			if (this.buffer.byteLength - this.offset < total) break;

			const payload = this.buffer.subarray(
				this.offset + HEADER_SIZE,
				this.offset + total,
			);
			onMessage(decode(code, payload));
			this.offset += total;
		}

		if (this.offset === this.buffer.byteLength) {
			this.buffer = new Uint8Array(0);
			this.offset = 0;
		}
	}

	private merge(chunk: Uint8Array): void {
		if (this.buffer.byteLength === this.offset) {
			this.buffer = chunk;
			this.offset = 0;
			return;
		}
		const tail = this.buffer.byteLength - this.offset;
		const combined = new Uint8Array(tail + chunk.byteLength);
		combined.set(this.buffer.subarray(this.offset), 0);
		combined.set(chunk, tail);
		this.buffer = combined;
		this.offset = 0;
	}
}
