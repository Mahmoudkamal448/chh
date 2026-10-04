import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { HistoryCapture } from '../../src/renderer/features/terminal/history-capture';

/** Just enough of xterm's buffer API: one screen of lines and a cursor. */
function fakeTerm(lines: string[], cursor: { x: number; y: number }) {
  const buffer = {
    type: 'normal',
    baseY: 0,
    get cursorX() {
      return cursor.x;
    },
    get cursorY() {
      return cursor.y;
    },
    getLine: (i: number) => (lines[i] === undefined ? undefined : { translateToString: () => lines[i]!.replace(/\s+$/, ''), isWrapped: false }),
  };
  return { buffer: { active: buffer } } as unknown as Terminal;
}

describe('HistoryCapture', () => {
  it('records what the terminal shows after the prompt', () => {
    vi.useFakeTimers();
    const lines = ['user@box:~$ '];
    const cursor = { x: 12, y: 0 };
    const seen: string[] = [];
    const cap = new HistoryCapture(fakeTerm(lines, cursor), (c) => seen.push(c));
    cap.input('l');
    lines[0] = 'user@box:~$ ls -la';
    cursor.x = 18;
    expect(cap.typed()).toBe('ls -la');
    cap.input('\r');
    vi.runAllTimers();
    expect(seen).toEqual(['ls -la']);
    vi.useRealTimers();
  });

  it('skips the prompt when the cursor is reported at column 0 (Windows ConPTY + PowerShell)', () => {
    vi.useFakeTimers();
    const lines = ['PS C:\\Users\\me> '];
    const cursor = { x: 0, y: 0 };
    const seen: string[] = [];
    const cap = new HistoryCapture(fakeTerm(lines, cursor), (c) => seen.push(c));
    cap.input('e');
    lines[0] = 'PS C:\\Users\\me> echo hi';
    cursor.x = lines[0].length;
    expect(cap.typed()).toBe('echo hi');
    cap.input('\r');
    vi.runAllTimers();
    expect(seen).toEqual(['echo hi']);
    vi.useRealTimers();
  });

  it('records plain typing once echoed, wherever the cursor is reported (ConPTY)', () => {
    vi.useFakeTimers();
    const lines = ['PS C:\\Users\\me> ', ''];
    // ConPTY reports the cursor at column 0 while the prompt is drawn, and the line it was on scrolls.
    const cursor = { x: 0, y: 0 };
    const seen: string[] = [];
    const cap = new HistoryCapture(fakeTerm(lines, cursor), (c) => seen.push(c));
    for (const ch of 'echo typed-$((3*3))') cap.input(ch);
    lines[0] = 'PS C:\\Users\\me> echo typed-$((3*3))';
    expect(cap.typed()).toBe('echo typed-$((3*3))');
    cap.input('\r');
    // The screen was repainted one line further down, with the output below it.
    lines.splice(0, 2, '', 'PS C:\\Users\\me> echo typed-$((3*3))', 'typed-9', 'PS C:\\Users\\me> ');
    cursor.y = 3;
    vi.runAllTimers();
    expect(seen).toEqual(['echo typed-$((3*3))']);
    vi.useRealTimers();
  });

  it('does not record typing the terminal never echoed (passwords)', () => {
    vi.useFakeTimers();
    const lines = ['[sudo] password for me: '];
    const cursor = { x: 24, y: 0 };
    const seen: string[] = [];
    const cap = new HistoryCapture(fakeTerm(lines, cursor), (c) => seen.push(c));
    cap.input('hunter2\r');
    lines[1] = 'ok';
    cursor.y = 1;
    vi.runAllTimers();
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it('reads the screen after tab completion', () => {
    vi.useFakeTimers();
    const lines = ['$ '];
    const cursor = { x: 2, y: 0 };
    const seen: string[] = [];
    const cap = new HistoryCapture(fakeTerm(lines, cursor), (c) => seen.push(c));
    cap.input('cat RE');
    cap.input('\t');
    lines[0] = '$ cat README.md ';
    cursor.x = 16;
    cap.input('\r');
    vi.runAllTimers();
    expect(seen).toEqual(['cat README.md']);
    vi.useRealTimers();
  });
});
