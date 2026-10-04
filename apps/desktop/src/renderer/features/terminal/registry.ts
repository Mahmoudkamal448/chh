import type { Terminal } from '@xterm/xterm';

/**
 * Live terminals by tab id. In test mode a read-only text accessor is exposed on window so
 * E2E tests can assert terminal output (the WebGL renderer draws to a canvas).
 */
const terminals = new Map<string, Terminal>();

export function registerTerminal(tabId: string, term: Terminal): void {
  terminals.set(tabId, term);
}

export function unregisterTerminal(tabId: string): void {
  terminals.delete(tabId);
}

export function installTestHooks(): void {
  (window as unknown as { __cyTest: unknown }).__cyTest = {
    terminalText(tabIndex = -1): string {
      const all = [...terminals.values()];
      const term = tabIndex < 0 ? all[all.length + tabIndex] : all[tabIndex];
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n');
    },
  };
}
