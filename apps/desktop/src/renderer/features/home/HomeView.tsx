import { ArrowLeftRight, Code2, History, KeyRound, Server, ShieldCheck, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useApp, type HomeSection } from '../../stores/app-store';
import { ForwardsView } from '../forwards/ForwardsView';
import { HistoryView } from '../history/HistoryView';
import { HostsView } from '../hosts/HostsView';
import { SnippetsView } from '../snippets/SnippetsView';
import { IdentitiesView } from '../identities/IdentitiesView';
import { KeysView } from '../keys/KeysView';
import { KnownHostsView } from '../known-hosts/KnownHostsView';

const SECTIONS: Array<{ id: HomeSection; icon: typeof Server }> = [
  { id: 'hosts', icon: Server },
  { id: 'snippets', icon: Code2 },
  { id: 'history', icon: History },
  { id: 'forwards', icon: ArrowLeftRight },
  { id: 'keys', icon: KeyRound },
  { id: 'identities', icon: UserRound },
  { id: 'knownHosts', icon: ShieldCheck },
];

/** The home tab: a narrow navigation rail plus the selected section. */
export function HomeView() {
  const { t } = useTranslation();
  const section = useApp((s) => s.section);
  const setSection = useApp((s) => s.setSection);
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label={t('nav.label')} className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
        {SECTIONS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={t(`nav.${id}`)}
            aria-label={t(`nav.${id}`)}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
            data-testid={`nav-${id}`}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg',
              section === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon size={18} />
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1">
        {section === 'hosts' && <HostsView />}
        {section === 'keys' && <KeysView />}
        {section === 'identities' && <IdentitiesView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'snippets' && <SnippetsView />}
        {section === 'history' && <HistoryView />}
        {section === 'forwards' && <ForwardsView />}
      </div>
    </div>
  );
}
