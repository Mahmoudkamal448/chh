import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Input } from '../../components/ui';
import { octal } from '../../lib/format';

const WHO = ['owner', 'group', 'others'] as const;
const WHAT = ['read', 'write', 'execute'] as const;

/** chmod editor: rwx grid + octal field, kept in sync; optional recursion for folders. */
export function PermissionsDialog({
  target,
  onSubmit,
  onCancel,
}: {
  target: { names: string[]; mode: number; hasDir: boolean } | null;
  onSubmit(mode: number, recursive: boolean): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(0o644);
  const [text, setText] = useState('644');
  const [recursive, setRecursive] = useState(false);

  useEffect(() => {
    if (!target) return;
    setMode(target.mode & 0o7777);
    setText(octal(target.mode));
    setRecursive(false);
  }, [target]);

  const bit = (w: number, x: number) => 1 << ((2 - w) * 3 + (2 - x));
  const toggle = (b: number, on: boolean) => {
    const m = on ? mode | b : mode & ~b;
    setMode(m);
    setText(octal(m));
  };
  const valid = /^[0-7]{3,4}$/.test(text);

  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onCancel()}
      title={t('files.permissionsTitle')}
      description={target ? (target.names.length === 1 ? target.names[0] : t('files.itemsCount', { count: target.names.length })) : ''}
      width="w-[420px]"
      testId="permissions-dialog"
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSubmit(mode, recursive)} data-testid="permissions-apply">
            {t('files.apply')}
          </Button>
        </>
      }
    >
      <table className="mb-3 w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-muted">
            <th />
            {WHAT.map((x) => (
              <th key={x} className="pb-1 font-medium">
                {t(`files.perm.${x}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((w, wi) => (
            <tr key={w}>
              <td className="py-1 pr-3 text-muted">{t(`files.perm.${w}`)}</td>
              {WHAT.map((x, xi) => {
                const b = bit(wi, xi);
                return (
                  <td key={x} className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`${t(`files.perm.${w}`)} ${t(`files.perm.${x}`)}`}
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={(mode & b) !== 0}
                      onChange={(e) => toggle(b, e.target.checked)}
                      data-testid={`perm-${w}-${x}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <label className="text-[12px] text-muted" htmlFor="perm-octal">
          {t('files.octal')}
        </label>
        <Input
          id="perm-octal"
          className="w-24 font-mono"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^[0-7]{3,4}$/.test(e.target.value)) setMode(parseInt(e.target.value, 8));
          }}
          data-testid="perm-octal"
        />
        {target?.hasDir && <Checkbox label={t('files.recursive')} checked={recursive} onChange={setRecursive} />}
      </div>
    </Dialog>
  );
}
