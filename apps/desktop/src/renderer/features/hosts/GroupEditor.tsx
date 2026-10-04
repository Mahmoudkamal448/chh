import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inheritedSettings, type GroupLike, type HostSettingsOverrides } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { refreshAll, useHosts } from '../../stores/hosts-store';
import { GroupOptions, SettingsFields } from './SettingsFields';

export function GroupEditor() {
  const { t } = useTranslation();
  const editor = useHosts((s) => s.editor);
  const openEditor = useHosts((s) => s.openEditor);
  const groups = useHosts((s) => s.groups);
  const open = editor?.kind === 'group';
  const editingId = open ? editor.id : null;
  const [label, setLabel] = useState('');
  const [parentId, setParentId] = useState('');
  const [settings, setSettings] = useState<HostSettingsOverrides>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const g = editingId ? groups.find((x) => x.id === editingId) : null;
    setLabel(g?.label ?? '');
    setParentId(g ? (g.parentId ?? '') : (editor.parentId ?? ''));
    setSettings(g?.settings ?? {});
  }, [open, editingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupMap = useMemo(() => new Map<string, GroupLike>(groups.map((g) => [g.id, g])), [groups]);
  const inherited = useMemo(() => inheritedSettings(parentId || null, groupMap), [parentId, groupMap]);

  // A group can't be moved under itself or its descendants.
  const exclude = useMemo(() => {
    const out = new Set<string>();
    if (!editingId) return out;
    const stack = [editingId];
    while (stack.length) {
      const id = stack.pop()!;
      out.add(id);
      for (const g of groups) if (g.parentId === id && !out.has(g.id)) stack.push(g.id);
    }
    return out;
  }, [editingId, groups]);

  const close = () => openEditor(null);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!label.trim()) return setError(t('groupEditor.errorRequired'));
    try {
      const payload = { label: label.trim(), parentId: parentId || null, settings };
      if (editingId) await window.chh.groups.update({ id: editingId, patch: payload });
      else await window.chh.groups.create(payload);
      await refreshAll();
      close();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={editingId ? t('groupEditor.editTitle') : t('groupEditor.newTitle')}
      description={t('groupEditor.description')}
      width="w-[600px]"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('groupEditor.name')}>{(id) => <Input id={id} autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>
          <Field label={t('groupEditor.parent')}>
            {(id) => (
              <Select id={id} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">{t('groupEditor.noParent')}</option>
                <GroupOptions groups={groups} exclude={exclude} />
              </Select>
            )}
          </Field>
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t('groupEditor.inherited')}</h3>
        <SettingsFields value={settings} inherited={inherited} onChange={setSettings} showIdentity selfId={null} />
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
