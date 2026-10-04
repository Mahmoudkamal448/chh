import { AlertTriangle, Check, Cloud, KeyRound, Mail, Plus, RefreshCw, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditEntryView, PendingInvite, TeamMember, TeamRole, TeamSummary } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Button, Field, IconButton, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useApp } from '../../stores/app-store';
import { useSecurity } from '../../stores/lock-store';
import { useTeams } from '../../stores/teams-store';

const isAdmin = (r: TeamRole) => r === 'owner' || r === 'admin';

function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown) => {
    const { key, detail } = errorMessage(err);
    return t(key, { detail });
  };
}

export function TeamsView() {
  const { t } = useTranslation();
  const signedIn = useSecurity((s) => s.sync?.signedIn ?? false);
  const { teams, invites, error, refresh, loading, myFingerprint } = useTeams();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const errorText = useErrorText();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  useEffect(() => {
    if (!selected || !teams.some((x) => x.id === selected)) setSelected(teams[0]?.id ?? null);
  }, [teams, selected]);

  if (!signedIn) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="teams-signed-out">
        <Users size={28} className="text-muted" />
        <h1 className="text-[15px] font-semibold">{t('teams.title')}</h1>
        <p className="max-w-md text-muted">{t('teams.needSync')}</p>
        <Button variant="primary" onClick={() => useApp.getState().setSettingsOpen(true, 'sync')}>
          <Cloud size={14} /> {t('teams.openSync')}
        </Button>
      </div>
    );
  }

  const team = teams.find((x) => x.id === selected) ?? null;
  const respond = async (inviteId: string, accept: boolean) => {
    setActionError(null);
    try {
      if (accept) await window.chh.teams.acceptInvite({ inviteId });
      else await window.chh.teams.declineInvite({ inviteId });
      await refresh();
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h1 className="text-[15px] font-semibold">{t('teams.title')}</h1>
          <IconButton className="ml-auto" label={t('teams.refresh')} onClick={() => void refresh()}>
            <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
          </IconButton>
          <IconButton label={t('teams.new')} onClick={() => setCreating(true)} data-testid="new-team">
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {invites.length > 0 && (
            <section className="mb-3" aria-label={t('teams.invitesTitle')}>
              <h2 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('teams.invitesTitle')}</h2>
              {invites.map((i) => (
                <div key={i.id} className="rounded-md border border-border p-2 text-[12px]" data-testid="team-invite">
                  <div className="flex items-center gap-1.5 font-medium">
                    <Mail size={12} /> {t('teams.invitedBy', { email: i.invitedBy })}
                  </div>
                  <div className="text-muted">{t('teams.inviteRole', { role: t(`teams.role.${i.role}`) })}</div>
                  <div className="mt-2 flex gap-1.5">
                    <Button variant="primary" className="h-7" onClick={() => void respond(i.id, true)} data-testid="invite-accept">
                      <Check size={13} /> {t('teams.accept')}
                    </Button>
                    <Button className="h-7" onClick={() => void respond(i.id, false)}>
                      {t('teams.decline')}
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {teams.length === 0 && invites.length === 0 ? (
            <p className="p-2 text-[12px] text-muted">{t('teams.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {teams.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(x.id)}
                    data-testid="team-item"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      x.id === selected ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                    )}
                  >
                    <Users size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{x.name ?? t('teams.pendingName')}</span>
                    {x.needsRotation && isAdmin(x.role) && <AlertTriangle size={12} className="text-[#d29b00]" aria-label={t('teams.rotateNeeded')} />}
                    <span className="text-[11px] text-muted">{t(`teams.role.${x.role}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(error || actionError) && (
            <p role="alert" className="p-2 text-[12px] text-danger">
              {actionError ?? t(error!)}
            </p>
          )}
        </div>
        {myFingerprint && (
          <div className="border-t border-border px-4 py-2.5" title={t('teams.myFingerprintHint')}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('teams.myFingerprint')}</div>
            <div className="selectable font-mono text-[11px]" data-testid="my-fingerprint">
              {myFingerprint}
            </div>
          </div>
        )}
      </aside>
      {team ? <TeamDetail key={team.id} team={team} /> : <div className="flex-1" />}
      <CreateTeamDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />
    </div>
  );
}

function CreateTeamDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = useErrorText();
  useEffect(() => {
    setName('');
    setError(null);
  }, [open]);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const team = await window.chh.teams.create({ name: name.trim() });
      await useTeams.getState().refresh();
      onCreated(team.id);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('teams.createTitle')}
      description={t('teams.createExplain')}
      testId="create-team"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void create()} data-testid="create-team-save">
            {t('teams.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="flex flex-col gap-3"
      >
        <Field label={t('teams.name')}>
          {(id) => <Input id={id} autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} data-testid="team-name" />}
        </Field>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function TeamDetail({ team }: { team: TeamSummary }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'members' | 'audit'>('members');
  const [leaving, setLeaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorText = useErrorText();
  const admin = isAdmin(team.role);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await useTeams.getState().refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (team.status !== 'confirmed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="team-pending">
        <ShieldCheck size={28} className="text-muted" />
        <p className="max-w-md">{t('teams.awaitingConfirm')}</p>
        <p className="max-w-md text-[12px] text-muted">{t('teams.awaitingConfirmHint', { fingerprint: useTeams.getState().myFingerprint ?? '' })}</p>
        <Button className="mt-2" onClick={() => void run(() => window.chh.teams.leave({ teamId: team.id }))}>
          {t('teams.leave')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="truncate text-[15px] font-semibold" data-testid="team-title">
          {team.name || t('teams.unnamed')}
        </h2>
        <span className="text-[12px] text-muted">{t('teams.memberCount', { count: team.memberCount })}</span>
        <div className="ml-auto flex gap-1.5" role="tablist">
          {(['members', 'audit'] as const)
            .filter((x) => x === 'members' || admin)
            .map((x) => (
              <Button
                key={x}
                role="tab"
                aria-selected={tab === x}
                variant={tab === x ? 'primary' : 'ghost'}
                onClick={() => setTab(x)}
                data-testid={`team-tab-${x}`}
              >
                {t(`teams.tab.${x}`)}
              </Button>
            ))}
        </div>
      </div>
      {team.needsRotation && admin && (
        <div className="flex items-center gap-2 border-b border-border bg-[#d29b00]/10 px-4 py-2 text-[12px]" role="status">
          <AlertTriangle size={14} className="shrink-0 text-[#d29b00]" />
          <span className="flex-1">{t('teams.rotateNeededHint')}</span>
          <Button className="h-7" disabled={busy} onClick={() => setRotating(true)}>
            {t('teams.rotate')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === 'members' ? <Members team={team} onError={setError} /> : <AuditLog team={team} />}</div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <KeyRound size={13} className="text-muted" />
        <span className="text-[12px] text-muted">{t('teams.keyGen', { gen: team.keyGen })}</span>
        <div className="ml-auto flex gap-2">
          {admin && (
            <Button disabled={busy} onClick={() => setRotating(true)} data-testid="team-rotate">
              {t('teams.rotate')}
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => setLeaving(true)} data-testid="team-leave">
            {team.role === 'owner' ? t('teams.delete') : t('teams.leave')}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={rotating}
        title={t('teams.rotateTitle')}
        message={t('teams.rotateMessage')}
        confirmLabel={t('teams.rotate')}
        onCancel={() => setRotating(false)}
        onConfirm={() => {
          setRotating(false);
          void run(() => window.chh.teams.rotateKey({ teamId: team.id }));
        }}
      />
      <ConfirmDialog
        open={leaving}
        danger
        title={team.role === 'owner' ? t('teams.deleteTitle') : t('teams.leaveTitle')}
        message={team.role === 'owner' ? t('teams.deleteMessage', { name: team.name ?? '' }) : t('teams.leaveMessage', { name: team.name ?? '' })}
        confirmLabel={team.role === 'owner' ? t('teams.delete') : t('teams.leave')}
        onCancel={() => setLeaving(false)}
        onConfirm={() => {
          setLeaving(false);
          void run(() => (team.role === 'owner' ? window.chh.teams.delete({ teamId: team.id }) : window.chh.teams.leave({ teamId: team.id })));
        }}
      />
    </div>
  );
}

function Members({ team, onError }: { team: TeamSummary; onError(msg: string | null): void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const [confirming, setConfirming] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(team.role);

  const load = useCallback(async () => {
    try {
      const r = await window.chh.teams.members({ teamId: team.id });
      setMembers(r.members);
      setInvites(r.invites);
    } catch (err) {
      onError(errorText(err));
    }
  }, [team.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    return window.chh.on('teams.changed', () => void load());
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await load();
      await useTeams.getState().refresh();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const invite = () =>
    act(async () => {
      await window.chh.teams.invite({ teamId: team.id, email: email.trim(), role });
      setEmail('');
    });

  return (
    <div className="flex flex-col">
      <ul aria-label={t('teams.tab.members')}>
        {members.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5" data-testid="team-member">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{m.email}</span>
                {m.isMe && <span className="text-[11px] text-muted">{t('teams.you')}</span>}
                {m.status === 'accepted' && <span className="rounded bg-[#d29b00]/15 px-1.5 py-0.5 text-[11px] text-[#a87a00]">{t('teams.needsConfirm')}</span>}
              </div>
              <div className="truncate font-mono text-[11px] text-muted" title={t('teams.fingerprint')}>
                {m.fingerprint}
              </div>
            </div>
            {admin && m.status === 'accepted' && (
              <Button variant="primary" className="h-7" disabled={busy} onClick={() => setConfirming(m)} data-testid="member-confirm">
                {t('teams.confirm')}
              </Button>
            )}
            {admin && !m.isMe && m.role !== 'owner' ? (
              <div className="w-28 shrink-0">
                <Select
                  aria-label={t('teams.roleLabel', { email: m.email })}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void act(() => window.chh.teams.setRole({ teamId: team.id, userId: m.userId, role: e.target.value as TeamRole }))}
                  data-testid="member-role"
                >
                  {(team.role === 'owner' && m.status === 'confirmed'
                    ? (['owner', 'admin', 'editor', 'viewer'] as const)
                    : (['admin', 'editor', 'viewer'] as const)
                  ).map((r) => (
                    <option key={r} value={r}>
                      {t(`teams.role.${r}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <span className="w-28 shrink-0 text-[12px] text-muted">{t(`teams.role.${m.role}`)}</span>
            )}
            {admin && !m.isMe && m.role !== 'owner' ? (
              <IconButton label={t('teams.remove')} disabled={busy} onClick={() => setRemoving(m)} data-testid="member-remove">
                <Trash2 size={14} />
              </IconButton>
            ) : (
              <span className="w-7" />
            )}
          </li>
        ))}
        {invites.map((i) => (
          <li key={i.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 text-muted" data-testid="team-pending-invite">
            <Mail size={14} />
            <span className="min-w-0 flex-1 truncate">{i.email}</span>
            <span className="text-[12px]">{t('teams.invited', { role: t(`teams.role.${i.role}`) })}</span>
            <IconButton
              label={t('teams.cancelInvite')}
              disabled={busy}
              onClick={() => void act(() => window.chh.teams.cancelInvite({ teamId: team.id, inviteId: i.id }))}
            >
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
      {admin && (
        <form
          className="flex items-end gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void invite();
          }}
        >
          <div className="flex-1">
            <Field label={t('teams.inviteEmail')} hint={t('teams.inviteHint')}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" />
              )}
            </Field>
          </div>
          <div className="mb-[22px] w-32">
            <Select aria-label={t('teams.inviteRoleLabel')} value={role} onChange={(e) => setRole(e.target.value as typeof role)} data-testid="invite-role">
              {(['admin', 'editor', 'viewer'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`teams.role.${r}`)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="primary" className="mb-[22px]" disabled={!email.trim() || busy} data-testid="invite-send">
            {t('teams.invite')}
          </Button>
        </form>
      )}
      <p className="px-4 pb-4 text-[12px] text-muted">{t('teams.rolesHelp')}</p>
      <ConfirmMemberDialog
        member={confirming}
        onClose={() => setConfirming(null)}
        onConfirm={(m) => {
          setConfirming(null);
          void act(() => window.chh.teams.confirm({ teamId: team.id, userId: m.userId, fingerprint: m.fingerprint }));
        }}
      />
      <ConfirmDialog
        open={!!removing}
        danger
        title={t('teams.removeTitle')}
        message={
          removing?.status === 'confirmed'
            ? t('teams.removeRotateMessage', { email: removing?.email ?? '' })
            : t('teams.removeMessage', { email: removing?.email ?? '' })
        }
        confirmLabel={t('teams.remove')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const m = removing!;
          setRemoving(null);
          void act(() => window.chh.teams.remove({ teamId: team.id, userId: m.userId }));
        }}
      />
    </div>
  );
}

/** Admins compare the fingerprint with the member (in person, by phone) before sharing the key. */
function ConfirmMemberDialog({ member, onClose, onConfirm }: { member: TeamMember | null; onClose(): void; onConfirm(m: TeamMember): void }) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [member]);
  return (
    <Dialog
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={t('teams.confirmTitle', { email: member?.email ?? '' })}
      description={t('teams.confirmExplain')}
      testId="confirm-member"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!checked} onClick={() => member && onConfirm(member)} data-testid="confirm-member-ok">
            {t('teams.confirmShare')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-border bg-surface-2 p-3 text-center font-mono text-[15px] tracking-wide" data-testid="confirm-fingerprint">
          {member?.fingerprint}
        </div>
        <p className="text-[12px] text-muted">{t('teams.confirmWhere')}</p>
        <label className="inline-flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            data-testid="confirm-member-check"
          />
          {t('teams.confirmChecked')}
        </label>
      </div>
    </Dialog>
  );
}

function AuditLog({ team }: { team: TeamSummary }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [entries, setEntries] = useState<AuditEntryView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      try {
        const r = await window.chh.teams.audit({ teamId: team.id, before });
        setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries));
        setHasMore(r.hasMore);
        setError(null);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [team.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void load();
  }, [load]);

  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const detail = (e: AuditEntryView) => {
    const m = e.meta as Record<string, unknown>;
    if (e.action === 'member.role_changed')
      return t('teams.audit.roleChange', { email: m.email ?? '', from: t(`teams.role.${String(m.from)}`), to: t(`teams.role.${String(m.to)}`) });
    if (typeof m.email === 'string') return m.email;
    if (e.action === 'vault.pulled') return t('teams.audit.items', { count: Number(m.items ?? 0) });
    if (e.action === 'vault.rotated') return t('teams.keyGen', { gen: Number(m.keyGen ?? 0) });
    return e.itemLabel ?? (e.itemId ? t('teams.audit.unknownItem') : '');
  };

  return (
    <div className="flex flex-col" data-testid="audit-log">
      <p className="border-b border-border px-4 py-2 text-[12px] text-muted">{t('teams.audit.explain')}</p>
      {error && (
        <p role="alert" className="px-4 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-surface text-left text-muted">
          <tr>
            <th className="px-4 py-1.5 font-medium">{t('teams.audit.when')}</th>
            <th className="px-2 py-1.5 font-medium">{t('teams.audit.who')}</th>
            <th className="px-2 py-1.5 font-medium">{t('teams.audit.what')}</th>
            <th className="px-2 py-1.5 font-medium">{t('teams.audit.detail')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-border/60" data-testid="audit-row">
              <td className="whitespace-nowrap px-4 py-1.5 text-muted">{fmt.format(e.at)}</td>
              <td className="px-2 py-1.5">
                <div className="truncate">{e.actorEmail}</div>
                {e.deviceName && <div className="truncate text-[11px] text-muted">{e.deviceName}</div>}
              </td>
              <td className="px-2 py-1.5">
                {t(`teams.audit.action.${e.action}`, { defaultValue: e.action })}
                {e.clientReported && (
                  <span className="ml-1.5 rounded bg-surface-2 px-1 py-0.5 text-[10px] text-muted" title={t('teams.audit.clientReportedHint')}>
                    {t('teams.audit.clientReported')}
                  </span>
                )}
              </td>
              <td className="max-w-[260px] truncate px-2 py-1.5 text-muted">{detail(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="p-3 text-center">
          <Button onClick={() => void load(entries[entries.length - 1]?.id)}>{t('teams.audit.more')}</Button>
        </div>
      )}
    </div>
  );
}
