/**
 * Hybrid logical clock. Timestamps serialize to fixed-width strings so they compare
 * lexicographically: `<wallMs:15>-<counter:6>-<deviceId>`.
 */
export interface HlcTimestamp {
  wall: number;
  counter: number;
  node: string;
}

const MAX_COUNTER = 999_999;
/** Reject remote clocks this far ahead of us (protects against a device with a wildly wrong clock). */
const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export function formatHlc(t: HlcTimestamp): string {
  return `${t.wall.toString().padStart(15, '0')}-${t.counter.toString().padStart(6, '0')}-${t.node}`;
}

export function parseHlc(s: string): HlcTimestamp {
  const m = /^(\d{15})-(\d{6})-(.+)$/.exec(s);
  if (!m) throw new Error('invalid HLC timestamp');
  return { wall: Number(m[1]), counter: Number(m[2]), node: m[3]! };
}

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Hlc {
  private last: HlcTimestamp;

  constructor(
    private readonly node: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!node || node.includes('-')) throw new Error('HLC node id must be non-empty and contain no "-"');
    this.last = { wall: 0, counter: 0, node };
  }

  /** Timestamp for a local event. */
  tick(): string {
    const wall = this.now();
    if (wall > this.last.wall) this.last = { wall, counter: 0, node: this.node };
    else this.last = { wall: this.last.wall, counter: this.bump(this.last.counter), node: this.node };
    return formatHlc(this.last);
  }

  /** Merge a timestamp received from another replica so later local ticks sort after it. */
  receive(remote: string): void {
    const r = parseHlc(remote);
    const wall = this.now();
    if (r.wall - wall > MAX_DRIFT_MS) throw new Error('remote clock drift too large');
    const maxWall = Math.max(wall, this.last.wall, r.wall);
    let counter: number;
    if (maxWall === this.last.wall && maxWall === r.wall) counter = this.bump(Math.max(this.last.counter, r.counter));
    else if (maxWall === this.last.wall) counter = this.bump(this.last.counter);
    else if (maxWall === r.wall) counter = this.bump(r.counter);
    else counter = 0;
    this.last = { wall: maxWall, counter, node: this.node };
  }

  private bump(c: number): number {
    if (c >= MAX_COUNTER) throw new Error('HLC counter overflow');
    return c + 1;
  }
}
