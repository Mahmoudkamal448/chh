import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { Button, Field, Input } from './ui';

/** Asks for one line of text (rename, new folder, …). */
export function PromptDialog({
  open,
  title,
  label,
  initial = '',
  confirmLabel,
  onSubmit,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onSubmit(value: string): void;
  onCancel(): void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const submit = () => value.trim() && onSubmit(value.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      width="w-[420px]"
      testId={testId}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()} data-testid="prompt-submit">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={label}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => {
                // Select the name without its extension, like file managers do.
                const dot = e.target.value.lastIndexOf('.');
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
              data-testid="prompt-input"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
