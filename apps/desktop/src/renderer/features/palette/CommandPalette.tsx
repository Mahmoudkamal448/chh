import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Host } from '@cy-ssh/shared';
import * as RD from '@radix-ui/react-dialog';
import { Kbd } from '../../components/ui';
import { displayAccelerator, effectiveKeymap, type CommandId } from '../../lib/keymap';
import { useApp } from '../../stores/app-store';
import { runCommand } from '../../app/commands';

const PALETTE_COMMANDS: CommandId[] = ['tab.newLocal', 'host.new', 'tab.close', 'tab.next', 'tab.prev', 'tab.hosts', 'settings.open'];

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const keymap = effectiveKeymap(useApp((s) => s.settings.keymap));
  const [search, setSearch] = useState('');
  const [hosts, setHosts] = useState<Host[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.cy.hosts.list({ query: search || undefined, limit: 50 }).then((r) => !cancelled && setHosts(r.items));
    return () => {
      cancelled = true;
    };
  }, [open, search]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const item = 'flex h-9 cursor-default items-center gap-2 rounded-md px-3 text-[13px]';

  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RD.Content className="fixed left-1/2 top-[12vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
          <RD.Title className="sr-only">{t('palette.title')}</RD.Title>
          <RD.Description className="sr-only">{t('palette.placeholder')}</RD.Description>
          <Command label={t('palette.title')} shouldFilter={false} loop>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={t('palette.placeholder')}
              className="h-11 w-full border-b border-border bg-transparent px-4 text-[14px] outline-none placeholder:text-muted"
              data-testid="palette-input"
            />
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-muted">{t('palette.empty')}</Command.Empty>
              {hosts.length > 0 && (
                <Command.Group heading={t('palette.hosts')} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted">
                  {hosts.map((h) => (
                    <Command.Item key={h.id} value={`host:${h.id}`} className={item} onSelect={() => run(() => runCommand({ type: 'connect', host: h }))}>
                      <span className="truncate">{t('palette.connectTo', { label: h.label })}</span>
                      <span className="ml-auto truncate text-[12px] text-muted">{h.address}</span>
                    </Command.Item>
                  ))}
                  {hosts.slice(0, search ? 10 : 3).map((h) => (
                    <Command.Item key={`sftp-${h.id}`} value={`sftp:${h.id}`} className={item} onSelect={() => run(() => runCommand({ type: 'files', host: h }))}>
                      <span className="truncate">{t('palette.filesOn', { label: h.label })}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading={t('palette.commands')} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted">
                {PALETTE_COMMANDS.filter((id) => !search || t(`commands.${id}`).toLowerCase().includes(search.toLowerCase())).map((id) => (
                  <Command.Item key={id} value={id} className={item} onSelect={() => run(() => runCommand({ type: 'command', id }))}>
                    {t(`commands.${id}`)}
                    <span className="ml-auto">
                      <Kbd>{displayAccelerator(keymap[id])}</Kbd>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
