import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_HOST_SETTINGS, type Host, type HostSettings, type HostSettingsOverrides, type Protocol } from '@cy-ssh/shared';
import { Button, Field, IconButton, Input, Select } from '../../components/ui';

type SetFn = <K extends keyof HostSettings>(k: K, v: HostSettings[K] | undefined) => void;

/** Jump hosts, proxy, agent forwarding, environment, engine — collapsed by default. */
export function AdvancedFields({
  value,
  inherited,
  set,
  protocol,
  selfId,
}: {
  value: HostSettingsOverrides;
  inherited: HostSettings;
  set: SetFn;
  /** Undefined in the group editor (applies to every protocol). */
  protocol?: Protocol;
  selfId?: string | null;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => {
    void window.cy.hosts.list({}).then((r) => setHosts(r.items.filter((h) => h.protocol === 'ssh' && h.id !== selfId)));
  }, [selfId]);

  const ssh = !protocol || protocol === 'ssh' || protocol === 'mosh';
  if (!ssh) return null;
  const jumps = value.jumpHosts ?? inherited.jumpHosts;
  const proxy = value.proxy ?? inherited.proxy;
  const env = value.env ?? {};
  const engine = value.sshEngine ?? inherited.sshEngine;
  const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? t('settings.missing');
  const setJumps = (next: string[]) => set('jumpHosts', next);
  const inheritedEnv = Object.entries(inherited.env).filter(([k]) => !(k in env));

  return (
    <details className="rounded-md border border-border p-3" data-testid="advanced-fields">
      <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-wide text-muted">{t('advanced.title')}</summary>
      <div className="mt-3 flex flex-col gap-4">
        {(!protocol || protocol === 'ssh') && (
          <Field label={t('advanced.engine')} hint={engine === 'openssh' ? t('advanced.engineOpensshHint') : t('advanced.engineBuiltinHint')}>
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={value.sshEngine ?? ''}
                onChange={(e) => set('sshEngine', (e.target.value || undefined) as HostSettings['sshEngine'] | undefined)}
                data-testid="ssh-engine"
              >
                <option value="">{t('settings.inherit', { value: t(`advanced.engines.${inherited.sshEngine}`) })}</option>
                <option value="builtin">{t('advanced.engines.builtin')}</option>
                <option value="openssh">{t('advanced.engines.openssh')}</option>
              </Select>
            )}
          </Field>
        )}
        {engine === 'openssh' && (
          <Field label={t('advanced.identityFile')} hint={t('advanced.identityFileHint')}>
            {(id, d) => (
              <Input id={id} aria-describedby={d} className="font-mono" placeholder="~/.ssh/id_ed25519_sk" value={value.identityFile ?? ''} onChange={(e) => set('identityFile', e.target.value || undefined)} />
            )}
          </Field>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-muted">{t('advanced.jumpHosts')}</span>
            {value.jumpHosts !== undefined && (
              <button type="button" className="text-[11px] text-muted underline" onClick={() => set('jumpHosts', undefined)}>
                {t('advanced.useInherited')}
              </button>
            )}
          </div>
          <p className="mb-2 text-[11px] text-muted">{t('advanced.jumpHostsHint')}</p>
          <ol className="mb-2 flex flex-col gap-1">
            {jumps.map((jid, i) => (
              <li key={`${jid}-${i}`} className="flex items-center gap-2 rounded bg-surface-2 px-2 py-1 text-[13px]" data-testid="jump-row">
                <span className="text-[11px] text-muted">{i + 1}.</span>
                <span className="flex-1 truncate">{label(jid)}</span>
                <IconButton label={t('advanced.moveUp')} className="h-6 w-6" disabled={i === 0} onClick={() => setJumps(jumps.map((x, j) => (j === i - 1 ? jid : j === i ? jumps[i - 1]! : x)))}>
                  <ArrowUp size={12} />
                </IconButton>
                <IconButton label={t('advanced.moveDown')} className="h-6 w-6" disabled={i === jumps.length - 1} onClick={() => setJumps(jumps.map((x, j) => (j === i + 1 ? jid : j === i ? jumps[i + 1]! : x)))}>
                  <ArrowDown size={12} />
                </IconButton>
                <IconButton label={t('common.delete')} className="h-6 w-6" onClick={() => setJumps(jumps.filter((_, j) => j !== i))}>
                  <X size={12} />
                </IconButton>
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Select aria-label={t('advanced.addJump')} value={pick} onChange={(e) => setPick(e.target.value)} data-testid="jump-pick">
              <option value="">{t('advanced.chooseHost')}</option>
              {hosts
                .filter((h) => !jumps.includes(h.id))
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
            </Select>
            <Button
              className="shrink-0 whitespace-nowrap"
              disabled={!pick || jumps.length >= 8}
              onClick={() => {
                setJumps([...jumps, pick]);
                setPick('');
              }}
              data-testid="jump-add"
            >
              <Plus size={13} /> {t('advanced.addJump')}
            </Button>
          </div>
        </div>

        {(!protocol || protocol === 'ssh') && engine !== 'openssh' && (
          <div className="grid grid-cols-[140px_1fr_100px_1fr] gap-2">
            <Field label={t('advanced.proxy')}>
              {(id) => (
                <Select id={id} value={proxy.type} onChange={(e) => set('proxy', { ...proxy, type: e.target.value as HostSettings['proxy']['type'] })} data-testid="proxy-type">
                  <option value="none">{t('advanced.proxyNone')}</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                  <option value="http">HTTP CONNECT</option>
                </Select>
              )}
            </Field>
            {proxy.type !== 'none' && (
              <>
                <Field label={t('advanced.proxyHost')}>{(id) => <Input id={id} value={proxy.host} onChange={(e) => set('proxy', { ...proxy, host: e.target.value })} data-testid="proxy-host" />}</Field>
                <Field label={t('hostEditor.port')}>
                  {(id) => <Input id={id} type="number" value={proxy.port} onChange={(e) => set('proxy', { ...proxy, port: Number(e.target.value) || 1080 })} data-testid="proxy-port" />}
                </Field>
                <Field label={t('advanced.proxyUser')} hint={t('advanced.proxyUserHint')}>
                  {(id, d) => <Input id={id} aria-describedby={d} value={proxy.username} onChange={(e) => set('proxy', { ...proxy, username: e.target.value })} />}
                </Field>
              </>
            )}
          </div>
        )}

        <Field label={t('advanced.agentForwarding')} hint={t('advanced.agentForwardingHint')}>
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={value.agentForwarding === undefined ? '' : value.agentForwarding ? 'on' : 'off'}
              onChange={(e) => set('agentForwarding', e.target.value === '' ? undefined : e.target.value === 'on')}
              data-testid="agent-forwarding"
            >
              <option value="">{t('settings.inherit', { value: inherited.agentForwarding ? t('common.on') : t('common.off') })}</option>
              <option value="on">{t('common.on')}</option>
              <option value="off">{t('common.off')}</option>
            </Select>
          )}
        </Field>

        <div>
          <span className="text-[12px] font-medium text-muted">{t('advanced.env')}</span>
          <p className="mb-2 text-[11px] text-muted">{t('advanced.envHint')}</p>
          {inheritedEnv.map(([k, v]) => (
            <div key={k} className="mb-1 flex gap-2 text-[12px] text-muted">
              <span className="w-40 truncate font-mono">{k}</span>
              <span className="flex-1 truncate font-mono">{v}</span>
              <span className="text-[11px]">{t('advanced.inheritedTag')}</span>
            </div>
          ))}
          <EnvEditor value={env} onChange={(next) => set('env', Object.keys(next).length ? next : undefined)} />
          <div className="mt-2 w-72">
            <Field label={t('advanced.envMethod')}>
              {(id) => (
                <Select id={id} value={value.envMethod ?? ''} onChange={(e) => set('envMethod', (e.target.value || undefined) as HostSettings['envMethod'] | undefined)}>
                  <option value="">{t('settings.inherit', { value: t(`advanced.envMethods.${inherited.envMethod}`) })}</option>
                  <option value="request">{t('advanced.envMethods.request')}</option>
                  <option value="export">{t('advanced.envMethods.export')}</option>
                </Select>
              )}
            </Field>
          </div>
        </div>
      </div>
    </details>
  );
}

function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange(v: Record<string, string>): void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value));
  useEffect(() => setRows(Object.entries(value)), [JSON.stringify(value)]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Array<[string, string]>) => {
    setRows(next);
    const valid = next.filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    onChange(Object.fromEntries(valid));
  };
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <Input
            className="w-40 font-mono"
            aria-label={t('advanced.envName')}
            placeholder="NAME"
            value={k}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value.trim(), r[1]] : r)))}
            data-testid="env-name"
          />
          <Input className="flex-1 font-mono" aria-label={t('advanced.envValue')} value={v} onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} data-testid="env-value" />
          <IconButton label={t('common.delete')} onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <X size={13} />
          </IconButton>
        </div>
      ))}
      <Button className="self-start" onClick={() => setRows([...rows, ['', '']])} data-testid="env-add">
        <Plus size={13} /> {t('advanced.envAdd')}
      </Button>
    </div>
  );
}

export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** Serial line settings (host editor, protocol = serial). */
export function SerialFields({ value, inherited, set }: { value: HostSettingsOverrides; inherited: HostSettings; set: SetFn }) {
  const { t } = useTranslation();
  const s = { ...DEFAULT_HOST_SETTINGS.serial, ...inherited.serial, ...value.serial };
  const upd = (patch: Partial<HostSettings['serial']>) => set('serial', { ...s, ...patch });
  return (
    <div className="grid grid-cols-4 gap-3" data-testid="serial-fields">
      <Field label={t('serial.baud')}>
        {(id) => (
          <Select id={id} value={s.baudRate} onChange={(e) => upd({ baudRate: Number(e.target.value) })} data-testid="serial-baud">
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('serial.dataBits')}>
        {(id) => (
          <Select id={id} value={s.dataBits} onChange={(e) => upd({ dataBits: Number(e.target.value) as 8 })}>
            {[5, 6, 7, 8].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('serial.parity')}>
        {(id) => (
          <Select id={id} value={s.parity} onChange={(e) => upd({ parity: e.target.value as 'none' })}>
            {(['none', 'even', 'odd', 'mark', 'space'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`serial.parities.${p}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('serial.stopBits')}>
        {(id) => (
          <Select id={id} value={s.stopBits} onChange={(e) => upd({ stopBits: Number(e.target.value) as 1 })}>
            {[1, 1.5, 2].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('serial.flow')}>
        {(id) => (
          <Select id={id} value={s.flowControl} onChange={(e) => upd({ flowControl: e.target.value as 'none' })}>
            <option value="none">{t('serial.flows.none')}</option>
            <option value="rtscts">RTS/CTS</option>
            <option value="xonxoff">XON/XOFF</option>
          </Select>
        )}
      </Field>
      <Field label={t('serial.newline')}>
        {(id) => (
          <Select id={id} value={s.newline} onChange={(e) => upd({ newline: e.target.value as 'cr' })}>
            <option value="cr">CR</option>
            <option value="lf">LF</option>
            <option value="crlf">CR LF</option>
          </Select>
        )}
      </Field>
      <Field label={t('serial.localEcho')}>
        {(id) => (
          <Select id={id} value={s.localEcho ? 'on' : 'off'} onChange={(e) => upd({ localEcho: e.target.value === 'on' })}>
            <option value="off">{t('common.off')}</option>
            <option value="on">{t('common.on')}</option>
          </Select>
        )}
      </Field>
    </div>
  );
}
