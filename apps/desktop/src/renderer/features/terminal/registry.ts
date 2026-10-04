import type { Terminal } from '@xterm/xterm';

/** Live terminals by pane id: lets snippets and history insert text into the focused pane. */
interface Entry {
  term: Terminal;
  /** Sends input to the session as if typed. */
  write(data: string): void;
}

const terminals = new Map<string, Entry>();

export function registerTerminal(paneId: string, entry: Entry): void {
  terminals.set(paneId, entry);
}

export function unregisterTerminal(paneId: string): void {
  terminals.delete(paneId);
}

export function writeToPane(paneId: string, data: string): boolean {
  const t = terminals.get(paneId);
  if (!t) return false;
  t.write(data);
  t.term.focus();
  return true;
}

/** In test mode, expose a read-only accessor so E2E tests can read terminal text (WebGL draws to canvas). */
export function installTestHooks(): void {
  (window as unknown as { __cyTest: unknown }).__cyTest = {
    terminalText(index = -1): string {
      const all = [...terminals.values()];
      const t = index < 0 ? all[all.length + index] : all[index];
      if (!t) return '';
      const buf = t.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n');
    },
    paneCount: () => terminals.size,
  };
}
