/**
 * Back-pressure between a transport and the renderer. The renderer acknowledges bytes once
 * xterm.js has parsed them; if too much is in flight we pause the source so a flood
 * (`cat /dev/urandom`) can't freeze the UI or balloon memory.
 */
export const HIGH_WATER = 512 * 1024;
export const LOW_WATER = 128 * 1024;

export class FlowControl {
  private inFlight = 0;
  private paused = false;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  sent(bytes: number): void {
    this.inFlight += bytes;
    if (!this.paused && this.inFlight > HIGH_WATER) {
      this.paused = true;
      this.pause();
    }
  }

  acked(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    if (this.paused && this.inFlight < LOW_WATER) {
      this.paused = false;
      this.resume();
    }
  }

  get pending(): number {
    return this.inFlight;
  }
}

/** Byte size used for flow accounting (strings are counted by UTF-16 length — close enough). */
export function chunkSize(chunk: string | Uint8Array): number {
  return typeof chunk === 'string' ? chunk.length : chunk.byteLength;
}
