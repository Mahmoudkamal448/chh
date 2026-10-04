import type { Terminal } from '@xterm/xterm';

/** Delay after Enter before reading the line, so the remote echo has arrived. */
const SETTLE_MS = 250;
const MAX_WRAPPED_LINES = 20;

/**
 * Records commands without shell integration. When the user starts typing, we remember where the
 * cursor is (just after the prompt). When they press Enter we read what the *terminal shows* from
 * that position to the end of the (possibly wrapped) line. That captures tab completion and recalled
 * history, and naturally skips input that isn't echoed, such as passwords.
 */
export class HistoryCapture {
  private start: { line: number; x: number } | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly onCommand: (command: string) => void,
  ) {}

  /** Call with every chunk of user input (term.onData), BEFORE it's sent to the session. */
  input(data: string): void {
    const buf = this.term.buffer.active;
    if (buf.type === 'alternate') {
      this.start = null; // full-screen apps (vim, less, top): nothing to record
      return;
    }
    if (data === '\x03' || data === '\x04') {
      this.start = null; // Ctrl+C / Ctrl+D abandon the line
      return;
    }
    if (!this.start) this.start = { line: buf.baseY + buf.cursorY, x: buf.cursorX };
    if (/[\r\n]/.test(data)) {
      const start = this.start;
      this.start = null;
      setTimeout(() => this.read(start), SETTLE_MS);
    }
  }

  private read(start: { line: number; x: number }): void {
    const buf = this.term.buffer.active;
    if (buf.type === 'alternate') return;
    let text = buf.getLine(start.line)?.translateToString(true).slice(start.x) ?? '';
    for (let i = 1; i <= MAX_WRAPPED_LINES; i++) {
      const next = buf.getLine(start.line + i);
      if (!next?.isWrapped) break;
      text += next.translateToString(true);
    }
    const command = text.trim();
    if (command) this.onCommand(command);
  }
}
