const encoder = new TextEncoder();

export class Writer {
	private buffer: Uint8Array;
	private view: DataView;
	private offset = 5;

	constructor(initialSize = 256) {
		this.buffer = new Uint8Array(initialSize);
		this.view = new DataView(
			this.buffer.buffer,
			this.buffer.byteOffset,
			this.buffer.byteLength,
		);
	}

	private ensure(extra: number): void {
		const needed = this.offset + extra;
		if (needed <= this.buffer.length) return;
		let newSize = this.buffer.length;
		while (newSize < needed) newSize *= 2;
		const next = new Uint8Array(newSize);
		next.set(this.buffer);
		this.buffer = next;
		this.view = new DataView(next.buffer, next.byteOffset, next.byteLength);
	}

	addByte(b: number): this {
		this.ensure(1);
		this.buffer[this.offset++] = b;
		return this;
	}

	addInt16(n: number): this {
		this.ensure(2);
		this.view.setInt16(this.offset, n, false);
		this.offset += 2;
		return this;
	}

	addInt32(n: number): this {
		this.ensure(4);
		this.view.setInt32(this.offset, n, false);
		this.offset += 4;
		return this;
	}

	addString(s: string): this {
		const encoded = encoder.encode(s);
		this.ensure(encoded.byteLength);
		this.buffer.set(encoded, this.offset);
		this.offset += encoded.byteLength;
		return this;
	}

	addCString(s: string): this {
		if (s.length > 0) this.addString(s);
		this.ensure(1);
		this.buffer[this.offset++] = 0;
		return this;
	}

	addBytes(bytes: Uint8Array): this {
		this.ensure(bytes.byteLength);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.byteLength;
		return this;
	}

	/**
	 * Finalize the message. If `code` is provided, emits `[code][length][payload]`
	 * (standard PG message). If omitted, emits `[length][payload]` (used by
	 * `SSLRequest` and `StartupMessage`, which carry no type byte).
	 *
	 * `length` is the big-endian int32 byte count including itself but
	 * excluding `code`.
	 */
	flush(code?: number): Uint8Array {
		if (code !== undefined) {
			this.buffer[0] = code;
			const length = this.offset - 1;
			this.view.setInt32(1, length, false);
			const out = this.buffer.slice(0, this.offset);
			this.reset();
			return out;
		}
		const length = this.offset - 1;
		this.view.setInt32(1, length, false);
		const out = this.buffer.slice(1, this.offset);
		this.reset();
		return out;
	}

	private reset(): void {
		this.offset = 5;
	}
}
