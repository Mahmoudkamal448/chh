import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { TERMINAL_SCHEMES } from '../../themes/terminal-themes';

/** Grid of terminal color scheme swatches. */
export function ThemePicker({ value, onChange }: { value: string; onChange(id: string): void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('settings.terminalTheme')} className="grid grid-cols-4 gap-2">
      {TERMINAL_SCHEMES.map((s) => {
        const th = s.theme;
        const colors = [th.red, th.green, th.yellow, th.blue, th.magenta, th.cyan];
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={value === s.id}
            onClick={() => onChange(s.id)}
            className={cn('overflow-hidden rounded-md border text-left', value === s.id ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-muted')}
            data-testid={`theme-${s.id}`}
          >
            <div className="px-2 py-1.5 font-mono text-[11px]" style={{ background: th.background, color: th.foreground }}>
              <span style={{ color: th.green }}>$</span> ls
              <div className="mt-1 flex gap-0.5">
                {colors.map((c, i) => (
                  <span key={i} className="h-2 w-3 rounded-sm" style={{ background: c }} />
                ))}
              </div>
            </div>
            <div className="truncate bg-surface px-2 py-1 text-[11px]">{s.name}</div>
          </button>
        );
      })}
    </div>
  );
}
