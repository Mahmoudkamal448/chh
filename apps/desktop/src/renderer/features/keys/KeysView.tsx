import * as DM from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Copy, Download, FolderInput, KeyRound, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { MoveToVaultDialog, type MoveRequest } from '../teams/MoveToVaultDialog';
import { VaultBadge } from '../teams/VaultBadge';
import { useTeams } from '../../stores/teams-store';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import type { Key } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PromptDialog } from '../../components/PromptDialog';
import { Button, IconButton, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate, keyKind } from '../../lib/format';
import { useVault } from '../../stores/vault-store';
import { useTabs } from '../../stores/tabs-store';
import { activePaneId } from '../../app/commands';
import { writeToPane } from '../terminal/registry';
import { ExportKeyDialog } from './ExportKeyDialog';
import { GenerateKeyDialog } from './GenerateKeyDialog';
import { ImportKeyDialog } from './ImportKeyDialog';
import { CertificateChip, CertificatePanel } from './Certificate';

/** FIDO2 security keys live on the hardware; OpenSSH generates a key handle file for them. */
function SecurityKeyCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('id_ed25519_sk');
  const command = `ssh-keygen -t ed25519-sk -O resident -f ~/.ssh/${name.replace(/[^\w.-]/g, '') || 'id_ed25519_sk'}`;
  return (
    <details className="border-b border-border px-4 py-2 text-[12px]" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="security-key-card">
      <summary className="cursor-pointer font-medium">{t('fido.title')}</summary>
      <div className="mt-2 flex flex-col gap-2 text-muted">
        <p>{t('fido.hint')}</p>
        <div className="flex items-center gap-2">
          <Input className="w-56 font-mono" aria-label={t('fido.fileName')} value={name} onChange={(e) => setName(e.target.value)} />
          <code className="selectable flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-fg">{command}</code>
          <Button
            onClick={async () => {
              await useTabs.getState().openLocal();
              // Type the command; the user presses Enter, touches the key and enters the PIN.
              setTimeout(() => {
                const pane = activePaneId();
                if (pane) writeToPane(pane, command);
              }, 600);
            }}
            data-testid="fido-generate"
          >
            {t('fido.openTerminal')}
          </Button>
        </div>
        <p>{t('fido.useIt')}</p>
      </div>
    </details>
  );
}

const menuItem = 'flex h-8 cursor-default items-center gap-2 rounded px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2';

export function KeysView() {
  const { t } = useTranslation();
  const keys = useVault((s) => s.keys);
  const refresh = useVault((s) => s.refresh);
  const [moving, setMoving] = useState<MoveRequest | null>(null);
  const canMove = useTeams((s) => s.vaults.length > 1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [importMode, setImportMode] = useState<'file' | 'paste' | null>(null);
  const [exporting, setExporting] = useState<Key | null>(null);
  const [renaming, setRenaming] = useState<Key | null>(null);
  const [deleting, setDeleting] = useState<{ key: Key; usage: string[] } | null>(null);
  const [usage, setUsage] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = keys.find((k) => k.id === selectedId) ?? keys[0] ?? null;

  useEffect(() => {
    if (selected) void window.chh.keys.usage({ id: selected.id }).then(setUsage);
    setCopied(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyPublic = async (k: Key) => {
    await navigator.clipboard.writeText(k.publicKey);
    setCopied(true);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('keys.title')}</h1>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-muted">{t('keys.count', { count: keys.length })}</span>
        <div className="ml-auto flex gap-2">
          <DM.Root>
            <DM.Trigger asChild>
              <Button data-testid="import-key">
                <Upload size={14} /> {t('keys.import')} <ChevronDown size={12} />
              </Button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content align="end" className="z-50 min-w-[180px] rounded-md border border-border bg-surface p-1 shadow-xl">
                <DM.Item className={menuItem} onSelect={() => setImportMode('file')} data-testid="import-key-file">
                  {t('keys.importFile')}
                </DM.Item>
                <DM.Item className={menuItem} onSelect={() => setImportMode('paste')} data-testid="import-key-paste">
                  {t('keys.importPaste')}
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
          <Button variant="primary" onClick={() => setGenerating(true)} data-testid="generate-key">
            <Plus size={14} /> {t('keys.generate')}
          </Button>
        </div>
      </div>

      <SecurityKeyCard />
      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setGenerating(true)}>
                <Plus size={14} /> {t('keys.generate')}
              </Button>
              <Button onClick={() => setImportMode('file')}>
                <Upload size={14} /> {t('identities.importKey')}
              </Button>
            </div>
          }
        >
          {t('keys.empty')}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-[46%] min-w-[280px] overflow-y-auto border-r border-border" role="listbox" aria-label={t('keys.title')}>
            {keys.map((k) => (
              <li
                key={k.id}
                role="option"
                aria-selected={selected?.id === k.id}
                tabIndex={0}
                data-testid="key-row"
                onClick={() => setSelectedId(k.id)}
                onKeyDown={(e) => e.key === 'Enter' && setSelectedId(k.id)}
                className={cn('flex cursor-default items-center gap-3 border-b border-border/60 px-4 py-2.5', selected?.id === k.id ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                  <KeyRound size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{k.label}</span>
                    <VaultBadge vaultId={k.vaultId} />
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted">{k.fingerprint}</div>
                </div>
                {k.certificate && <CertificateChip cert={k.certificate} />}
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{keyKind(k.type, k.bits)}</span>
              </li>
            ))}
          </ul>

          {selected && (
            <section className="selectable flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5" aria-label={selected.label}>
              <div className="flex items-start gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold">{selected.label}</h2>
                  <p className="text-[12px] text-muted">
                    {keyKind(selected.type, selected.bits)} · {t(`keys.origin.${selected.origin}`)} · {formatDate(selected.createdAt)}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 gap-1">
                  <IconButton label={t('keys.rename')} onClick={() => setRenaming(selected)}>
                    <Pencil size={14} />
                  </IconButton>
                  {canMove && (
                    <IconButton label={t('teams.move.menu')} onClick={() => setMoving({ kind: 'key', ids: [selected.id], label: selected.label, vaultId: selected.vaultId })}>
                      <FolderInput size={14} />
                    </IconButton>
                  )}
                  <IconButton label={t('keys.exportPrivate')} onClick={() => setExporting(selected)}>
                    <Download size={14} />
                  </IconButton>
                  <IconButton
                    label={t('common.delete')}
                    onClick={async () => setDeleting({ key: selected, usage: await window.chh.keys.usage({ id: selected.id }) })}
                    data-testid="delete-key"
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>

              <div>
                <h3 className="mb-1 text-[12px] font-medium text-muted">{t('keys.fingerprint')}</h3>
                <p className="font-mono text-[12px]" data-testid="key-fingerprint">
                  {selected.fingerprint}
                </p>
              </div>

              <div>
                <h3 className="mb-1 text-[12px] font-medium text-muted">{t('certs.title')}</h3>
                <CertificatePanel keyItem={selected} />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-[12px] font-medium text-muted">{t('keys.publicKey')}</h3>
                  <Button variant="ghost" onClick={() => void copyPublic(selected)} data-testid="copy-public-key">
                    <Copy size={13} /> {copied ? t('keys.copied') : t('keys.copy')}
                  </Button>
                </div>
                <textarea
                  readOnly
                  rows={5}
                  value={selected.publicKey}
                  aria-label={t('keys.publicKey')}
                  className="w-full resize-none rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] break-all"
                  onFocus={(e) => e.target.select()}
                  data-testid="public-key-text"
                />
                <p className="mt-1 text-[11px] text-muted">{t('keys.publicKeyHint')}</p>
              </div>

              <div>
                <h3 className="mb-1 text-[12px] font-medium text-muted">{t('keys.usedBy')}</h3>
                {usage.length ? (
                  <ul className="flex flex-wrap gap-1">
                    {usage.map((u) => (
                      <li key={u} className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px]">
                        {u}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-muted">{t('keys.unused')}</p>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      <GenerateKeyDialog open={generating} onClose={() => setGenerating(false)} />
      <ImportKeyDialog open={!!importMode} mode={importMode ?? 'file'} onClose={() => setImportMode(null)} />
      <ExportKeyDialog keyItem={exporting} onClose={() => setExporting(null)} />
      <PromptDialog
        open={!!renaming}
        title={t('keys.rename')}
        label={t('keys.label')}
        initial={renaming?.label ?? ''}
        confirmLabel={t('common.save')}
        onCancel={() => setRenaming(null)}
        onSubmit={async (label) => {
          await window.chh.keys.rename({ id: renaming!.id, label });
          setRenaming(null);
          await refresh();
        }}
      />
      <MoveToVaultDialog request={moving} onClose={() => setMoving(null)} onMoved={() => void refresh()} />
      <ConfirmDialog
        open={!!deleting}
        title={t('keys.deleteTitle')}
        message={
          deleting?.usage.length
            ? t('keys.deleteInUse', { label: deleting.key.label, users: deleting.usage.join(', ') })
            : t('keys.deleteMessage', { label: deleting?.key.label ?? '' })
        }
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await window.chh.keys.remove({ ids: [deleting!.key.id] });
          setDeleting(null);
          setSelectedId(null);
          await refresh();
        }}
      />
    </div>
  );
}
