import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Snippet } from '@cy-ssh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input } from '../../components/ui';
import { needsVariables } from './run-snippet';

/** Asks for {{placeholder}} values before running a snippet. */
export function VariablesDialog({ snippet, onRun, onCancel }: { snippet: Snippet | null; onRun(values: Record<string, string>): void; onCancel(): void }) {
  const { t } = useTranslation();
  const names = snippet ? needsVariables(snippet) : [];
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [snippet]);
  return (
    <Dialog
      open={!!snippet}
      onOpenChange={(o) => !o && onCancel()}
      title={t('snippets.variablesTitle', { label: snippet?.label ?? '' })}
      width="w-[440px]"
      testId="snippet-variables"
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onRun(values)} data-testid="snippet-variables-run">
            {t('snippets.run')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onRun(values);
        }}
      >
        {names.map((n, i) => (
          <Field key={n} label={n}>
            {(id) => <Input id={id} autoFocus={i === 0} value={values[n] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} data-testid={`var-${n}`} />}
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
