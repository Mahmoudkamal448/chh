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
  /** Where input started: line, cursor column, and the text already there (the prompt). */
  private start: { line: number; x: number; prompt: string } | null = null;

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
    if (!this.start) {
      const line = buf.baseY + buf.cursorY;
      this.start = { line, x: buf.cursorX, prompt: buf.getLine(line)?.translateToString(true) ?? '' };
    }
    if (/[\r\n]/.test(data)) {
      const start = this.start;
      this.start = null;
      setTimeout(() => this.read(start), SETTLE_MS);
    }
  }

  /**
   * What's been typed on the current line so far (as displayed), or null when unknown — e.g. in a
   * full-screen app, or when the cursor isn't at the end of the input.
   */
  typed(): string | null {
    const buf = this.term.buffer.active;
    if (!this.start || buf.type === 'alternate') return null;
    const line = buf.baseY + buf.cursorY;
    if (line !== this.start.line) return null;
    const text = buf.getLine(line)?.translateToString(true) ?? '';
    if (text.length > buf.cursorX) return null; // cursor is mid-line
    return text.slice(inputColumn(this.start, text), buf.cursorX);
  }

  private read(start: { line: number; x: number; prompt: string }): void {
    const buf = this.term.buffer.active;
    if (buf.type === 'alternate') return;
    const first = buf.getLine(start.line)?.translateToString(true) ?? '';
    let text = first.slice(inputColumn(start, first));
    for (let i = 1; i <= MAX_WRAPPED_LINES; i++) {
      const next = buf.getLine(start.line + i);
      if (!next?.isWrapped) break;
      text += next.translateToString(true);
    }
    const command = text.trim();
    if (command) this.onCommand(command);
  }
}

/**
 * Column where the typed input begins. Normally the cursor column when typing started, but a
 * terminal can report the cursor at the start of the line while the prompt is already drawn there
 * (Windows ConPTY with PowerShell does): then the input begins after that prompt text.
 */
function inputColumn(start: { x: number; prompt: string }, line: string): number {
  if (!start.prompt || !line.startsWith(start.prompt) || start.x >= start.prompt.length) return start.x;
  // The saved prompt has trailing blanks trimmed: skip the separator space after it too.
  return line[start.prompt.length] === ' ' ? start.prompt.length + 1 : start.prompt.length;
}
