import { Code2, FolderInput, Pencil, Play, Plus, Server, Trash2 } from 'lucide-react';
import { MoveToVaultDialog, type MoveRequest } from '../teams/MoveToVaultDialog';
import { VaultBadge } from '../teams/VaultBadge';
import { useTeams } from '../../stores/teams-store';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import { snippetVariables, type Snippet } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Button, Field, IconButton, Input } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { useLibrary } from '../../stores/library-store';
import { activePaneId } from '../../app/commands';
import { paneIds } from '../../stores/layout';
import { useTabs } from '../../stores/tabs-store';
import { fillSnippet } from '@chh/shared';
import { HostMultiPicker } from '../run/HostMultiPicker';
import { startRun } from '../../stores/runs-store';
import { needsVariables, runSnippet } from './run-snippet';
import { VariablesDialog } from './VariablesDialog';

export function SnippetEditor({ editing, initialScript, onClose }: { editing: Snippet | 'new' | null; initialScript?: string; onClose(): void }) {
  const { t } = useTranslation();
  const refresh = useLibrary((s) => s.refreshSnippets);
  const existing = editing && editing !== 'new' ? editing : null;
  const [label, setLabel] = useState('');
  const [script, setScript] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(existing?.label ?? '');
    setScript(existing?.script ?? initialScript ?? '');
    setDescription(existing?.description ?? '');
    setTags(existing?.tags.join(', ') ?? '');
    setError(null);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!label.trim() || !script.trim()) return setError(t('snippets.errorRequired'));
    const payload = { label: label.trim(), script, description, tags: tags.split(',').map((x) => x.trim()).filter(Boolean) };
    try {
      if (existing) await window.chh.snippets.update({ id: existing.id, patch: payload });
      else await window.chh.snippets.create(payload);
      await refresh();
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  const vars = snippetVariables(script);
  return (
    <Dialog
      open={!!editing}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? t('snippets.editTitle') : t('snippets.newTitle')}
      width="w-[640px]"
      testId="snippet-editor"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()} data-testid="snippet-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('snippets.label')}>{(id) => <Input id={id} autoFocus value={label} onChange={(e) => setLabel(e.target.value)} data-testid="snippet-label" />}</Field>
        <Field label={t('snippets.script')} hint={vars.length ? t('snippets.variablesFound', { names: vars.join(', ') }) : t('snippets.scriptHint')}>
          {(id, d) => (
            <textarea
              id={id}
              aria-describedby={d}
              rows={8}
              spellCheck={false}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] focus:border-accent focus:outline-none"
              data-testid="snippet-script"
            />
          )}
        </Field>
        <Field label={t('snippets.description')}>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label={t('hostEditor.tags')} hint={t('hostEditor.tagsHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} value={tags} onChange={(e) => setTags(e.target.value)} />}
        </Field>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function SnippetsView() {
  const { t } = useTranslation();
  const snippets = useLibrary((s) => s.snippets);
  const refresh = useLibrary((s) => s.refreshSnippets);
  const tabs = useTabs((s) => s.tabs);
  const [editing, setEditing] = useState<Snippet | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [moving, setMoving] = useState<MoveRequest | null>(null);
  const canMove = useTeams((s) => s.vaults.length > 1);
  const [asking, setAsking] = useState<Snippet | null>(null);
  const [query, setQuery] = useState('');
  /** Multi-host run: pick hosts first, then (if needed) variables. */
  const [multi, setMulti] = useState<{ snippet: Snippet; hostIds?: string[] } | null>(null);
  const [multiVars, setMultiVars] = useState<Snippet | null>(null);
  const launch = async (s: Snippet, hostIds: string[], values: Record<string, string> = {}) => {
    const runId = await startRun(hostIds, fillSnippet(s.script, values), s.label);
    useTabs.getState().openRun(runId, s.label);
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const target = activePaneId(true);
  const run = (s: Snippet, values?: Record<string, string>) => {
    const pane = activePaneId(true);
    if (!pane) return;
    runSnippet(pane, s, values);
    // Jump to the terminal that received it.
    const tab = tabs.find((x) => x.kind === 'terminal' && paneIds(x.root).includes(pane));
    if (tab) useTabs.getState().activate(tab.id);
  };

  const q = query.toLowerCase();
  const shown = snippets.filter((s) => !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().includes(q) || s.tags.some((x) => x.toLowerCase().includes(q)));

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('snippets.title')}</h1>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-muted">{t('snippets.count', { count: snippets.length })}</span>
        <Input type="search" className="ml-auto w-64" placeholder={t('panel.search')} aria-label={t('panel.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button variant="primary" onClick={() => setEditing('new')} data-testid="new-snippet">
          <Plus size={14} /> {t('snippets.new')}
        </Button>
      </div>
      {snippets.length === 0 ? (
        <EmptyState
          icon={Code2}
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('snippets.new')}
            </Button>
          }
        >
          {t('snippets.empty')}
        </EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((s) => (
            <li key={s.id} className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5 hover:bg-surface-2/60" data-testid="snippet-row" onDoubleClick={() => setEditing(s)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.label}</span>
                  <VaultBadge vaultId={s.vaultId} />
                  {s.tags.map((tag) => (
                    <span key={tag} className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">
                      {tag}
                    </span>
                  ))}
                </div>
                {s.description && <div className="truncate text-[12px] text-muted">{s.description}</div>}
                <pre className="selectable mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{s.script}</pre>
              </div>
              <IconButton
                label={target ? t('snippets.runIn') : t('snippets.noTerminal')}
                disabled={!target}
                onClick={() => (needsVariables(s).length ? setAsking(s) : run(s))}
                data-testid="snippet-run"
              >
                <Play size={14} />
              </IconButton>
              <IconButton label={t('run.onHosts')} onClick={() => setMulti({ snippet: s })} data-testid="snippet-run-multi">
                <Server size={14} />
              </IconButton>
              <IconButton label={t('common.edit')} onClick={() => setEditing(s)}>
                <Pencil size={14} />
              </IconButton>
              {canMove && (
                <IconButton label={t('teams.move.menu')} onClick={() => setMoving({ kind: 'snippet', ids: [s.id], label: s.label, vaultId: s.vaultId })}>
                  <FolderInput size={14} />
                </IconButton>
              )}
              <IconButton label={t('common.delete')} onClick={() => setDeleting(s)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <SnippetEditor editing={editing} onClose={() => setEditing(null)} />
      <HostMultiPicker
        open={!!multi && !multi.hostIds}
        title={t('run.pickTitle', { label: multi?.snippet.label ?? '' })}
        confirmLabel={t('run.start')}
        onCancel={() => setMulti(null)}
        onConfirm={(hostIds) => {
          const s = multi!.snippet;
          if (needsVariables(s).length) {
            setMulti({ snippet: s, hostIds });
            setMultiVars(s);
          } else {
            setMulti(null);
            void launch(s, hostIds);
          }
        }}
      />
      <VariablesDialog
        snippet={multiVars}
        onCancel={() => (setMultiVars(null), setMulti(null))}
        onRun={(values) => {
          const m = multi!;
          setMultiVars(null);
          setMulti(null);
          void launch(m.snippet, m.hostIds!, values);
        }}
      />
      <VariablesDialog
        snippet={asking}
        onCancel={() => setAsking(null)}
        onRun={(values) => {
          if (asking) run(asking, values);
          setAsking(null);
        }}
      />
      <MoveToVaultDialog request={moving} onClose={() => setMoving(null)} onMoved={() => void refresh()} />
      <ConfirmDialog
        open={!!deleting}
        title={t('snippets.deleteTitle')}
        message={t('snippets.deleteMessage', { label: deleting?.label ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await window.chh.snippets.remove({ ids: [deleting!.id] });
          setDeleting(null);
          await refresh();
        }}
      />
    </div>
  );
}
