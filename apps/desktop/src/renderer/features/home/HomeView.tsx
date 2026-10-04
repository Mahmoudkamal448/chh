import { ArrowLeftRight, Code2, History, KeyRound, PanelLeftClose, PanelLeftOpen, Server, ShieldCheck, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
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
import { TeamsView } from '../teams/TeamsView';
import { useTeams } from '../../stores/teams-store';

const SECTIONS: Array<{ id: HomeSection; icon: typeof Server }> = [
  { id: 'hosts', icon: Server },
  { id: 'snippets', icon: Code2 },
  { id: 'history', icon: History },
  { id: 'forwards', icon: ArrowLeftRight },
  { id: 'keys', icon: KeyRound },
  { id: 'identities', icon: UserRound },
  { id: 'knownHosts', icon: ShieldCheck },
  { id: 'teams', icon: Users },
];

const NAV_KEY = 'chh.nav.expanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(NAV_KEY) !== '0';
  } catch {
    return true;
  }
}

/** The home tab: the navigation (names and icons, or icons only when collapsed) plus the selected section. */
export function HomeView() {
  const { t } = useTranslation();
  const section = useApp((s) => s.section);
  const setSection = useApp((s) => s.setSection);
  const invites = useTeams((s) => s.invites.length);
  const [expanded, setExpanded] = useState(readExpanded);
  const toggle = () => {
    setExpanded((v) => {
      try {
        localStorage.setItem(NAV_KEY, v ? '0' : '1');
      } catch {
        // not persisted; fine
      }
      return !v;
    });
  };
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label={t('nav.label')} className={cn('flex shrink-0 flex-col gap-0.5 border-r border-border bg-surface py-2', expanded ? 'w-44 px-2' : 'w-14 items-center')} data-testid="nav">
        {SECTIONS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={expanded ? undefined : t(`nav.${id}`)}
            aria-label={t(`nav.${id}`)}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
            data-testid={`nav-${id}`}
            className={cn(
              'relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg text-[13px]',
              expanded ? 'w-full px-2.5' : 'w-10 justify-center',
              section === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon size={17} className="shrink-0" aria-hidden />
            {expanded && <span className="truncate">{t(`nav.${id}`)}</span>}
            {id === 'teams' && invites > 0 && (
              <span className={cn('absolute h-2 w-2 rounded-full bg-danger', expanded ? 'right-2.5 top-1/2 -translate-y-1/2' : 'right-1.5 top-1.5')} aria-label={t('teams.invitesTitle')} />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={toggle}
          title={expanded ? t('nav.collapse') : t('nav.expand')}
          aria-label={expanded ? t('nav.collapse') : t('nav.expand')}
          aria-expanded={expanded}
          className={cn('mt-auto flex h-8 items-center gap-2.5 rounded-lg text-[12px] text-muted hover:bg-surface-2 hover:text-fg', expanded ? 'w-full px-2.5' : 'w-10 justify-center')}
          data-testid="nav-toggle"
        >
          {expanded ? <PanelLeftClose size={16} aria-hidden /> : <PanelLeftOpen size={16} aria-hidden />}
          {expanded && <span>{t('nav.collapse')}</span>}
        </button>
      </nav>
      <div className="flex min-w-0 flex-1">
        {section === 'hosts' && <HostsView />}
        {section === 'keys' && <KeysView />}
        {section === 'identities' && <IdentitiesView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'snippets' && <SnippetsView />}
        {section === 'history' && <HistoryView />}
        {section === 'forwards' && <ForwardsView />}
        {section === 'teams' && <TeamsView />}
      </div>
    </div>
  );
}
