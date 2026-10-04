import { fillSnippet, snippetVariables, type Snippet } from '@chh/shared';
import { writeToPane } from '../terminal/registry';

/** Normalizes line endings and sends the script to a pane, ending with Enter. */
export function sendScript(paneId: string, script: string): boolean {
  const text = script.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r');
  return writeToPane(paneId, `${text}\r`);
}

export function needsVariables(s: Snippet): string[] {
  return snippetVariables(s.script);
}

export function runSnippet(paneId: string, s: Snippet, values: Record<string, string> = {}): boolean {
  return sendScript(paneId, fillSnippet(s.script, values));
}
