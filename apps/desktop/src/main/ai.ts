import type { SettingsRepo } from './db/settings-repo';
import { AppError } from './ipc/handle';
import type { LocalVault } from './vault/local-vault';

const KEY_SETTING = 'ai_key';
const TIMEOUT_MS = 15_000;
const LOCAL = /^(localhost|127\.|\[?::1\]?)/;

/**
 * Optional AI command suggestions through any OpenAI-compatible chat endpoint (hosted, or local such as
 * Ollama / llama.cpp). Off by default; only called on explicit request. Sends the current line, the
 * host's OS and (only if enabled) a few recent commands — never passwords, keys or env vars.
 */
export class AiProvider {
  constructor(
    private readonly settings: SettingsRepo,
    private readonly vault: LocalVault,
  ) {}

  hasKey(): boolean {
    return !!this.settings.getRaw(KEY_SETTING);
  }

  setKey(key: string | null): void {
    this.settings.setRaw(KEY_SETTING, key ? JSON.stringify(this.vault.sealLocal(key, KEY_SETTING)) : '');
  }

  private key(): string | null {
    const raw = this.settings.getRaw(KEY_SETTING);
    return raw ? this.vault.openLocal(JSON.parse(raw), KEY_SETTING) : null;
  }

  async suggest(input: { line: string; os: string | null; recent: string[] }): Promise<string[]> {
    const cfg = this.settings.getApp().ai;
    if (!cfg.enabled || !cfg.endpoint || !cfg.model) throw new AppError('ai_off', 'suggest.error.aiOff');
    let url: URL;
    try {
      url = new URL(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions');
    } catch {
      throw new AppError('ai_url', 'suggest.error.aiUrl');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.test(url.hostname))) throw new AppError('ai_url', 'suggest.error.aiUrl');
    const key = this.key();
    const context = [
      `Operating system: ${input.os ?? 'unknown (assume a POSIX shell)'}`,
      cfg.sendHistory && input.recent.length ? `Recent commands:\n${input.recent.slice(-10).join('\n')}` : null,
      `Current input: ${input.line}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content:
                'You complete shell commands in a terminal. Reply with up to 3 complete, safe commands that finish or fix the user\'s current input, one per line. No explanations, no markdown, no numbering.',
            },
            { role: 'user', content: context },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new AppError('ai_failed', 'suggest.error.aiFailed', { detail: (e as Error).message.slice(0, 200) });
    }
    if (!res.ok) throw new AppError('ai_failed', 'suggest.error.aiFailed', { detail: `HTTP ${res.status}` });
    const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    return parseSuggestions(data?.choices?.[0]?.message?.content ?? '');
  }
}

/** Cleans model output into at most 3 single-line commands. */
export function parseSuggestions(text: string): string[] {
  return text
    .replace(/```[a-z]*\n?|```/gi, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*$>])\s*/, '').replace(/^`|`$/g, '').trim())
    .filter((l) => l.length > 0 && l.length < 1000)
    .slice(0, 3);
}
