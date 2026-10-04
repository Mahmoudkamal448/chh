import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

export type EditorTab = 'general' | 'terminal' | 'advanced';

/** General / Terminal / Advanced, at the top of the host and group editors. */
export function EditorTabs({ value, onChange }: { value: EditorTab; onChange(tab: EditorTab): void }) {
  const { t } = useTranslation();
  const tabs: EditorTab[] = ['general', 'terminal', 'advanced'];
  return (
    <div role="tablist" aria-label={t('hostEditor.tabs.label')} className="-mt-1 flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={value === tab}
          onClick={() => onChange(tab)}
          onKeyDown={(e) => {
            const i = tabs.indexOf(tab);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length]!);
            if (e.key === 'ArrowLeft') onChange(tabs[(i + tabs.length - 1) % tabs.length]!);
          }}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-focus',
            value === tab ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
          data-testid={`editor-tab-${tab}`}
        >
          {t(`hostEditor.tabs.${tab}`)}
        </button>
      ))}
    </div>
  );
}
