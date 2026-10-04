import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MovableKind } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { useTeams } from '../../stores/teams-store';

export interface MoveRequest {
  kind: MovableKind;
  ids: string[];
  label: string;
  /** Current vault of the item(s). */
  vaultId: string;
}

/** Moves items between the personal vault and team vaults. */
export function MoveToVaultDialog({ request, onClose, onMoved }: { request: MoveRequest | null; onClose(): void; onMoved?(): void }) {
  const { t } = useTranslation();
  const vaults = useTeams((s) => s.vaults);
  const targets = vaults.filter((v) => v.writable && v.id !== request?.vaultId);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTarget(targets[0]?.id ?? '');
    setError(null);
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = vaults.find((v) => v.id === target);
  const move = async () => {
    if (!request || !target) return;
    setBusy(true);
    try {
      await window.chh.teams.move({ kind: request.kind, ids: request.ids, vaultId: target });
      onMoved?.();
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!request}
      onOpenChange={(o) => !o && onClose()}
      title={t('teams.move.title', { label: request?.label ?? '' })}
      description={t('teams.move.explain')}
      width="w-[460px]"
      testId="move-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!target || busy} onClick={() => void move()} data-testid="move-confirm">
            {t('teams.move.confirm')}
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="text-[13px] text-muted">{t('teams.move.noTargets')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label={t('teams.move.to')}>
            {(id) => (
              <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="move-target">
                {targets.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.kind === 'personal' ? t('teams.personalVault') : v.name || t('teams.unnamed')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <p className="text-[12px] text-muted">{chosen?.kind === 'team' ? t('teams.move.toTeamHint') : t('teams.move.toPersonalHint')}</p>
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
