const decoder = new TextDecoder();

export class Reader {
	private buffer: Uint8Array;
	private view: DataView;
	private offset: number;

	constructor(buffer: Uint8Array, offset = 0) {
		this.buffer = buffer;
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
		this.offset = offset;
	}

	byte(): number {
		const b = this.buffer[this.offset];
		if (b === undefined)
			throw new RangeError("Reader.byte: past end of buffer");
		this.offset += 1;
		return b;
	}

	int16(): number {
		const n = this.view.getInt16(this.offset, false);
		this.offset += 2;
		return n;
	}

	int32(): number {
		const n = this.view.getInt32(this.offset, false);
		this.offset += 4;
		return n;
	}

	cstring(): string {
		const start = this.offset;
		const end = this.buffer.indexOf(0, start);
		if (end === -1)
			throw new RangeError("Reader.cstring: missing null terminator");
		const str = decoder.decode(this.buffer.subarray(start, end));
		this.offset = end + 1;
		return str;
	}

	string(length: number): string {
		const end = this.offset + length;
		if (end > this.buffer.byteLength)
			throw new RangeError("Reader.string: past end of buffer");
		const str = decoder.decode(this.buffer.subarray(this.offset, end));
		this.offset = end;
		return str;
	}

	bytes(length: number): Uint8Array {
		const end = this.offset + length;
		if (end > this.buffer.byteLength)
			throw new RangeError("Reader.bytes: past end of buffer");
		const out = this.buffer.subarray(this.offset, end);
		this.offset = end;
		return out;
	}

	remaining(): number {
		return this.buffer.byteLength - this.offset;
	}

	position(): number {
		return this.offset;
	}
}
