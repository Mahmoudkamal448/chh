import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

export interface SuggestionItem {
  kind: 'history' | 'snippet' | 'ai' | 'ask-ai';
  /** Full command (or snippet script). */
  text: string;
  label?: string;
}

/** Dimmed completion drawn right after the cursor. */
export function Ghost({ text, left, top, font, size }: { text: string; left: number; top: number; font: string; size: number }) {
  return (
    <span
      className="pointer-events-none absolute z-10 whitespace-pre opacity-40"
      style={{ left, top, fontFamily: font, fontSize: size, lineHeight: 'normal' }}
      data-testid="ghost-suggestion"
    >
      {text}
    </span>
  );
}

/** Ctrl+Space suggestion list. */
export function SuggestionList({
  items,
  index,
  left,
  top,
  loading,
  onPick,
}: {
  items: SuggestionItem[];
  index: number;
  left: number;
  top: number;
  loading: boolean;
  onPick(i: number): void;
}) {
  const { t } = useTranslation();
  return (
    <ul
      role="listbox"
      aria-label={t('autocomplete.label')}
      className="absolute z-30 max-h-64 w-[420px] max-w-[80%] overflow-y-auto rounded-md border border-border bg-surface p-1 text-[12px] shadow-xl"
      style={{ left, top }}
      data-testid="suggestion-list"
    >
      {items.map((it, i) => (
        <li
          key={`${it.kind}-${i}`}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          className={cn('flex cursor-default items-center gap-2 rounded px-2 py-1', i === index && 'bg-surface-2')}
        >
          <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted">{t(`autocomplete.kind.${it.kind}`)}</span>
          {it.kind === 'ask-ai' ? (
            <span className="flex items-center gap-1 text-accent">
              <Sparkles size={12} /> {t('autocomplete.askAi')}
            </span>
          ) : (
            <span className="truncate font-mono">{it.label ? `${it.label} — ${it.text.split('\n')[0]}` : it.text}</span>
          )}
        </li>
      ))}
      {loading && <li className="px-2 py-1 text-muted">{t('autocomplete.thinking')}</li>}
      {!loading && !items.length && <li className="px-2 py-1 text-muted">{t('autocomplete.none')}</li>}
    </ul>
  );
}

/** Pixel position of the terminal cursor inside the terminal container. */
export function cursorPosition(term: import('@xterm/xterm').Terminal, container: HTMLElement): { left: number; top: number; cellH: number } | null {
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screen || !term.cols || !term.rows) return null;
  const cellW = screen.clientWidth / term.cols;
  const cellH = screen.clientHeight / term.rows;
  const box = screen.getBoundingClientRect();
  const base = container.getBoundingClientRect();
  const buf = term.buffer.active;
  return { left: box.left - base.left + buf.cursorX * cellW, top: box.top - base.top + buf.cursorY * cellH, cellH };
}
