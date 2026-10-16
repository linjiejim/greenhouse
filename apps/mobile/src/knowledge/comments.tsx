import { captureIdentity } from '../data/identity';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { memberDirectory } from '../api/me';
import { comments, addComment } from '../api/knowledge';
import { activity, commentRecord } from '../api/tables';
import { visiblePages } from '../data/pages';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { Markdown } from '../chat/markdown';
import { ListSection, ListRow } from '../ui/list';
import { NativeButton } from '../ui/button';
import { NativeMenu } from '../ui/menu';
import { alertError } from '../ui/dialogs';
import { makeStyles, space, typo, useTheme } from '../theme';

export function Comments({ id, kind = 'doc' }: { id: string; kind?: 'doc' | 'record' }) {
  const t = useT();
  const { colors: c } = useTheme();
  const s = useStyles(c);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let active = true;
    void memberDirectory().then((result) => {
      if (active && result.ok) setPeople(result.data.items);
    });
    return () => {
      active = false;
    };
  }, []);
  const visible = useRef(1);
  useEffect(() => {
    visible.current = 1;
  }, [id, kind]);
  const load = useCallback(async () => {
    if (kind === 'doc') return visiblePages((cursor) => comments(id, cursor), visible.current);
    const result = await visiblePages((cursor) => activity(id, cursor), visible.current);
    return result.ok
      ? {
          ok: true as const,
          data: {
            items: result.data.items.filter((item) => item.kind === 'comment'),
            next_cursor: result.data.next_cursor,
          },
        }
      : result;
  }, [id, kind]);
  const resource = useResource(load, ['comments.updated', 'records.changed', 'knowledge.changed']);
  const more = async () => {
    const current = resource.capture();
    if (!resource.data?.next_cursor || busy) return;
    setBusy(true);
    const result =
      kind === 'doc' ? await comments(id, resource.data.next_cursor) : await activity(id, resource.data.next_cursor);
    setBusy(false);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('work.loadFailed'), undefined, result.message);
      return;
    }
    visible.current++;
    const items = result.data.items.filter((item) => !('kind' in item) || item.kind === 'comment');
    resource.setData((old) =>
      old
        ? { ...old, items: [...old.items, ...(items as typeof old.items)], next_cursor: result.data.next_cursor }
        : old,
    );
  };
  const send = async () => {
    if (busy || !body.trim()) return;
    setBusy(true);
    const current = captureIdentity();
    const result = kind === 'doc' ? await addComment(id, body.trim()) : await commentRecord(id, body.trim());
    if (!current()) return;
    setBusy(false);
    if (!result.ok) {
      alertError(t('work.saveFailed'), undefined, result.message);
      return;
    }
    setBody((current) => (current === body ? '' : current));
    void resource.refresh();
  };
  const mentionItems = people.map((p) => ({ id: `member:${p.id}`, title: p.name }));
  return (
    <ListSection header={t('work.comments')}>
      <View style={s.content}>
        {resource.error ? <NativeButton label={t('common.retry')} onPress={() => void resource.refresh()} /> : null}
        {!resource.data?.items.length ? (
          <Text style={s.note}>{t(resource.loading ? 'common.loading' : 'work.noComments')}</Text>
        ) : (
          resource.data.items.map((item) => (
            <View key={item.id} style={s.comment}>
              <Text style={s.note}>{item.created_by?.name ?? ''}</Text>
              <Markdown source={item.body} safe />
            </View>
          ))
        )}
        {resource.data?.next_cursor ? (
          <NativeButton label={t('work.more')} loading={busy} onPress={() => void more()} />
        ) : null}
        <TextInput
          multiline
          value={body}
          onChangeText={setBody}
          maxLength={10000}
          placeholder={t('work.comment')}
          placeholderTextColor={c.placeholder}
          accessibilityLabel={t('work.comment')}
          style={s.input}
        />
        <View style={s.actions}>
          <NativeMenu
            items={mentionItems}
            onSelect={(id) => {
              const label = mentionItems.find((p) => p.id === id)?.title ?? '';
              setBody(
                (old) => `${old}${old && !/\s$/.test(old) ? ' ' : ''}[@${label.replace(/[\]\n[]/g, '')}](${id}) `,
              );
            }}
          >
            <ListRow title={t('work.mention')} icon="at" menuTrigger onPress={undefined} />
          </NativeMenu>
          <NativeButton
            label={t('work.sendComment')}
            icon="send"
            disabled={!body.trim()}
            loading={busy}
            onPress={() => void send()}
          />
        </View>
      </View>
    </ListSection>
  );
}
const useStyles = makeStyles((c) => ({
  content: { padding: space.md, gap: space.md },
  comment: { gap: space.xs },
  note: { ...typo.footnote, color: c.secondaryLabel },
  input: {
    ...typo.body,
    color: c.label,
    minHeight: 88,
    padding: space.md,
    backgroundColor: c.tertiaryFill,
    borderRadius: 12,
  },
  actions: { gap: space.sm },
}));
