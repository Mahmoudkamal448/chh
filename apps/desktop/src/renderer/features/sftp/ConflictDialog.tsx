import { useTranslation } from 'react-i18next';
import type { ConflictPolicy } from '@cy-ssh/shared';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui';

export function ConflictDialog({ names, onChoose }: { names: string[] | null; onChoose(policy: ConflictPolicy | null): void }) {
  const { t } = useTranslation();
  const shown = names?.slice(0, 8) ?? [];
  return (
    <Dialog
      open={!!names}
      onOpenChange={(o) => !o && onChoose(null)}
      title={t('files.conflictTitle', { count: names?.length ?? 0 })}
      width="w-[480px]"
      testId="conflict-dialog"
      footer={
        <>
          <Button onClick={() => onChoose(null)}>{t('common.cancel')}</Button>
          <Button onClick={() => onChoose('skip')}>{t('files.skip')}</Button>
          <Button onClick={() => onChoose('rename')}>{t('files.keepBoth')}</Button>
          <Button variant="danger" onClick={() => onChoose('overwrite')} data-testid="conflict-overwrite">
            {t('files.overwrite')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px]">{t('files.conflictMessage')}</p>
      <ul className="selectable list-inside list-disc text-[12px] text-muted">
        {shown.map((n) => (
          <li key={n} className="truncate">
            {n}
          </li>
        ))}
        {names && names.length > shown.length && <li>{t('files.andMore', { count: names.length - shown.length })}</li>}
      </ul>
    </Dialog>
  );
}
