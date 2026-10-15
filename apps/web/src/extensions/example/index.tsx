import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@greenhouse/contract';
import { noteSchema, type ExampleNote } from '@greenhouse/contract/extensions/example';
import {
  Button,
  ErrorBox,
  Field,
  Input,
  Skeleton,
  defineWebExtension,
  useI18n,
  api,
  errorText,
  ExtensionPanels,
  useDraftNavigation,
  ConfirmDialog,
  type ExtensionPageProps,
} from '../../extension-kit';

const copy = {
  zh: {
    title: '示例笔记',
    personal: '示例偏好',
    admin: '示例管理',
    panel: '相关笔记',
    name: '标题',
    add: '添加笔记',
    label: '显示名称',
    save: '保存',
    more: '显示更多',
    empty: '还没有笔记',
    discard: '放弃修改',
    discardTitle: '放弃未保存的修改？',
    discardBody: '离开后，这次修改不会保存。',
  },
  en: {
    title: 'Example notes',
    personal: 'Example preferences',
    admin: 'Example administration',
    panel: 'Related notes',
    name: 'Title',
    add: 'Add note',
    label: 'Display name',
    save: 'Save',
    more: 'Show more',
    empty: 'No notes yet',
    discard: 'Discard changes',
    discardTitle: 'Discard unsaved changes?',
    discardBody: 'These changes will be lost when you leave.',
  },
};
const label = (key: keyof typeof copy.zh) => ({ zh: copy.zh[key], en: copy.en[key] });

function Notes({ path }: ExtensionPageProps) {
  const { locale, t } = useI18n();
  const words = copy[locale];
  const cache = useQueryClient();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const notes = useQuery({
    queryKey: ['ext', 'example', 'notes', path, cursor],
    queryFn: async () =>
      path
        ? {
            items: [noteSchema.parse(await api.request('GET', `/api/ext/example/notes/${encodeURIComponent(path)}`))],
            next_cursor: null,
          }
        : api.request<Page<ExampleNote>>('GET', '/api/ext/example/notes', undefined, { query: { cursor, limit: 20 } }),
  });
  const add = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.request('POST', '/api/ext/example/notes', { title });
      setTitle('');
      await cache.invalidateQueries({ queryKey: ['ext', 'example', 'notes'] });
    } catch (caught) {
      setError(errorText(caught, t));
    }
  };
  if (notes.isPending) return <Skeleton lines={3} />;
  if (notes.isError) return <ErrorBox onRetry={() => void notes.refetch()}>{errorText(notes.error, t)}</ErrorBox>;
  return (
    <>
      {!path && (
        <form className="app-form" onSubmit={(event) => void add(event)}>
          <Field label={words.name} error={error || undefined}>
            <Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <div>
            <Button type="submit">{words.add}</Button>
          </div>
        </form>
      )}
      {!notes.data.items.length && <p className="app-muted">{words.empty}</p>}
      <ul className="app-list">
        {notes.data.items.map((note) => (
          <li key={note.id}>
            <a className="app-list-row" href={`#/ext/example/notes/${encodeURIComponent(note.id)}`}>
              {note.title}
            </a>
          </li>
        ))}
      </ul>
      {notes.data.next_cursor && <Button onClick={() => setCursor(notes.data.next_cursor!)}>{words.more}</Button>}
      {path && <ExtensionPanels entity="ext:example:note" id={path} />}
    </>
  );
}

function Preferences({ admin = false }: { admin?: boolean }) {
  const { locale, t } = useI18n();
  const words = copy[locale];
  const path = `/api/ext/example/${admin ? 'admin/' : ''}settings`;
  const current = useQuery({
    queryKey: ['ext', 'example', path],
    queryFn: () => api.request<{ label: string }>('GET', path),
  });
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const navigation = useDraftNavigation(value !== null && value !== current.data?.label, saving, () => setValue(null));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.request('PATCH', path, { label: value ?? current.data?.label });
      setValue(null);
      await current.refetch();
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };
  if (current.isPending) return <Skeleton lines={2} />;
  if (current.isError) return <ErrorBox onRetry={() => void current.refetch()}>{errorText(current.error, t)}</ErrorBox>;
  return (
    <>
      <form className="app-form" onSubmit={(event) => void save(event)}>
        <Field label={words.label} error={error || undefined}>
          <Input
            value={value ?? current.data.label}
            required
            maxLength={80}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" loading={saving}>
            {words.save}
          </Button>
        </div>
      </form>
      {navigation.asking && (
        <ConfirmDialog
          title={words.discardTitle}
          confirmLabel={words.discard}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {words.discardBody}
        </ConfirmDialog>
      )}
    </>
  );
}
const AdminPreferences = () => <Preferences admin />;
function DocPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const notes = useQuery({
    queryKey: ['ext', 'example', 'doc', id],
    queryFn: () => api.request<Page<ExampleNote>>('GET', `/api/ext/example/docs/${encodeURIComponent(id)}/panel`),
  });
  if (notes.isPending) return <Skeleton lines={1} />;
  if (notes.isError) return <p role="alert">{errorText(notes.error, t)}</p>;
  return (
    <ul>
      {notes.data.items.map((note) => (
        <li key={note.id}>{note.title}</li>
      ))}
    </ul>
  );
}
function NotePanel({ id }: { id: string }) {
  const note = useQuery({
    queryKey: ['ext', 'example', 'note', id],
    queryFn: async () => noteSchema.parse(await api.request('GET', `/api/ext/example/notes/${encodeURIComponent(id)}`)),
  });
  return <p>{note.data?.body || note.data?.title}</p>;
}
export const exampleWebExtension = defineWebExtension({
  id: 'example',
  pages: [{ id: 'notes', label: label('title'), component: Notes }],
  settingsSections: [{ id: 'preferences', label: label('personal'), component: Preferences }],
  adminSections: [{ id: 'preferences', label: label('admin'), component: AdminPreferences }],
  entityPanels: [
    { id: 'notes', entity: 'doc', label: label('panel'), component: DocPanel },
    { id: 'note', entity: 'ext:example:note', label: label('panel'), component: NotePanel },
  ],
});
