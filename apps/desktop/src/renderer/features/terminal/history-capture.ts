import type { Terminal } from '@xterm/xterm';

/** Delay after Enter before reading the line, so the remote echo has arrived. */
const SETTLE_MS = 250;
const MAX_WRAPPED_LINES = 20;
/**
 * Replies xterm sends through onData on the shell's behalf: focus in/out (Windows ConPTY turns focus
 * reporting on), cursor position and device attribute reports, mode reports and OSC replies.
 */
const TERMINAL_REPORT = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]+\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;
/** How far up from the cursor to look for the echoed command (it may have printed output since). */
const SEARCH_LINES = 200;

/**
 * Records commands without shell integration. When the input was plain typing, we record it once the
 * terminal has echoed it, which skips input that isn't echoed, such as passwords. Otherwise (tab
 * completion, recalled history, line editing) we remember where the cursor was when the user started
 * typing (just after the prompt) and, on Enter, read what the *terminal shows* from that position to
 * the end of the (possibly wrapped) line.
 */
export class HistoryCapture {
  /** Where input started: line, cursor column, and the text already there (the prompt). */
  private start: Start | null = null;

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
    if (TERMINAL_REPORT.test(data)) return; // the terminal answering the shell, not the user typing
    if (data === '\x03' || data === '\x04') {
      this.start = null; // Ctrl+C / Ctrl+D abandon the line
      return;
    }
    if (!this.start) {
      const line = buf.baseY + buf.cursorY;
      this.start = { line, x: buf.cursorX, prompt: buf.getLine(line)?.translateToString(true) ?? '', keys: '' };
    }
    // Plain typing (no editing or completion keys) is remembered verbatim, see read().
    const m = /^([^\x00-\x1f\x7f]*)([\r\n]?)/.exec(data)!;
    if (this.start.keys !== null) this.start.keys = m[0] === data ? this.start.keys + m[1] : null;
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
    const text = buf.getLine(line)?.translateToString(true) ?? '';
    // Plain typing that the terminal has echoed: no need to trust the cursor position (see read()).
    const keys = this.start.keys;
    if (keys) return text.trimEnd().endsWith(keys.trimEnd()) ? keys : null; // null: not echoed yet
    if (line !== this.start.line) return null;
    if (text.length > buf.cursorX) return null; // cursor is mid-line
    return text.slice(inputColumn(this.start, text), buf.cursorX);
  }

  private read(start: Start): void {
    const buf = this.term.buffer.active;
    if (buf.type === 'alternate') return;
    // Plain typing: record it if the terminal echoed it at the end of a line. This doesn't depend on
    // cursor positions, which Windows ConPTY doesn't always report where the shell drew its input.
    const keys = start.keys?.trim();
    if (keys) {
      const end = buf.baseY + buf.cursorY;
      for (let l = end; l >= Math.max(0, end - SEARCH_LINES); l--) {
        if (buf.getLine(l)?.isWrapped) continue;
        if (this.logicalLine(l).trimEnd().endsWith(keys)) {
          this.onCommand(keys);
          return;
        }
      }
    }
    // Otherwise read from where typing started; input that wasn't echoed (a password) reads as empty.
    const first = buf.getLine(start.line)?.translateToString(true) ?? '';
    const command = (first.slice(inputColumn(start, first)) + this.logicalLine(start.line).slice(first.length)).trim();
    if (command) this.onCommand(command);
  }

  /** The text of buffer line `l` plus the lines it wraps onto. */
  private logicalLine(l: number): string {
    const buf = this.term.buffer.active;
    let text = buf.getLine(l)?.translateToString(true) ?? '';
    for (let i = 1; i <= MAX_WRAPPED_LINES; i++) {
      const next = buf.getLine(l + i);
      if (!next?.isWrapped) break;
      text += next.translateToString(true);
    }
    return text;
  }
}

interface Start {
  line: number;
  x: number;
  prompt: string;
  /** What was typed, when it was plain text only; null after editing keys, completion or pasted control characters. */
  keys: string | null;
}

/**
 * Column where the typed input begins. Normally the cursor column when typing started, but a
 * terminal can report the cursor at the start of the line while the prompt is already drawn there
 * (Windows ConPTY with PowerShell does): then the input begins after that prompt text.
 */
function inputColumn(start: Start, line: string): number {
  if (!start.prompt || !line.startsWith(start.prompt) || start.x >= start.prompt.length) return start.x;
  // The saved prompt has trailing blanks trimmed: skip the separator space after it too.
  return line[start.prompt.length] === ' ' ? start.prompt.length + 1 : start.prompt.length;
}
