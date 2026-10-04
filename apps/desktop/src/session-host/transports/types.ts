/** A live terminal byte stream (SSH channel, PTY, …) as seen by the session host. */
export interface Transport {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Stop reading from the source (back-pressure). */
  pause(): void;
  resume(): void;
  close(): void;
}

export interface TransportEvents {
  data(chunk: string | Uint8Array): void;
  status(status: 'connecting' | 'authenticating' | 'ready' | 'error', message?: string): void;
  exit(code: number | null): void;
}
