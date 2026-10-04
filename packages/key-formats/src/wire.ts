/** SSH wire-format primitives (RFC 4251 §5). */
export class WireReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  uint32(): number {
    if (this.remaining < 4) throw new Error('truncated');
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  byte(): number {
    if (this.remaining < 1) throw new Error('truncated');
    return this.buf[this.pos++]!;
  }

  bytes(n: number): Buffer {
    if (n > this.remaining) throw new Error('truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }

  text(): string {
    return this.string().toString('utf8');
  }

  /** mpint as unsigned big-endian bytes without leading zeros. */
  mpint(): Buffer {
    const b = this.string();
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    return b.subarray(i);
  }

  rest(): Buffer {
    return this.bytes(this.remaining);
  }
}

export class WireWriter {
  private parts: Buffer[] = [];

  uint32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
    return this;
  }

  raw(b: Buffer): this {
    this.parts.push(b);
    return this;
  }

  string(b: Buffer | string): this {
    const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
    return this.uint32(buf.length).raw(buf);
  }

  /** Writes an unsigned big-endian integer as an SSH mpint (adds a 0x00 if the high bit is set). */
  mpint(unsigned: Buffer): this {
    let i = 0;
    while (i < unsigned.length && unsigned[i] === 0) i++;
    let b = unsigned.subarray(i);
    if (b.length && b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return this.string(b);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export function b64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
