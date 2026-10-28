/**
 * Memory (phone page; the browser place is ./screen.web.tsx): what my assistant remembers, grouped
 * in use / resting / archived. A row's menu edits, pins, archives or restores, and deletes after
 * a confirm; editing swaps the page for its form. New memories come only from the assistant (the
 * `memory` tool), so the empty state says how to ask.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Keyboard, RefreshControl, ScrollView, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { makeStyles, space, typo, useTheme } from '../../theme';
import { alertError, confirmAction } from '../../ui/dialogs';
import { EmptyState, LoadingState } from '../../ui/empty';
import { Row, Section, SectionFooter } from '../../ui/list';
import { NativeMenu, menuSections } from '../../ui/menu';
import { usePullRefresh } from '../../ui/refresh';
import { Screen } from '../../ui/screen';
import { toast } from '../../ui/toast';
import { NativeToggle } from '../../ui/toggle';
import { FormField } from '../app-form';
import { deleteMemory, listMemories, updateMemory } from './api';
import {
  archiveStatus,
  draftOf,
  draftProblem,
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  memorySections,
  patchBody,
  type Memory,
  type MemoryCategory,
  type MemoryDraft,
} from './model';

export function MemoryScreen({ title }: { title: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const list = useResource(useCallback(() => listMemories(), []));
  const pull = usePullRefresh(list.refresh);
  const [editing, setEditing] = useState<Memory | null>(null);
  const sections = useMemo(() => (list.data ? memorySections(list.data.memories) : null), [list.data]);

  const change = async (memory: Memory, body: Parameters<typeof updateMemory>[1], done: string) => {
    const current = captureIdentity();
    const r = await updateMemory(memory.id, body);
    if (!current()) return;
    if (!r.ok) alertError(t('appPages.memory.saveFailed'), r.message);
    else toast(done);
    void list.refresh();
  };
  const remove = async (memory: Memory) => {
    const current = captureIdentity();
    const ok = await confirmAction({
      title: t('appPages.memory.deleteTitle', { title: memory.title }),
      message: t('appPages.memory.deleteHint'),
      confirmLabel: t('appPages.memory.delete'),
      destructive: true,
    });
    if (!ok || !current()) return;
    const r = await deleteMemory(memory.id);
    if (!current()) return;
    if (!r.ok) alertError(t('appPages.memory.deleteFailed'), r.message);
    else toast(t('appPages.memory.deleted'), 'trash');
    void list.refresh();
  };
  const act = (id: string, memory: Memory) => {
    if (id === 'edit') setEditing(memory);
    if (id === 'pin')
      void change(
        memory,
        { pinned: !memory.pinned },
        t(memory.pinned ? 'appPages.memory.unpinnedDone' : 'appPages.memory.pinnedDone'),
      );
    if (id === 'archive') {
      const status = archiveStatus(memory);
      void change(
        memory,
        { status },
        t(status === 'archived' ? 'appPages.memory.archivedDone' : 'appPages.memory.restored'),
      );
    }
    if (id === 'delete') void remove(memory);
  };

  if (editing)
    return (
      <MemoryForm
        memory={editing}
        close={() => setEditing(null)}
        saved={() => {
          setEditing(null);
          toast(t('appPages.memory.saved'));
          void list.refresh();
        }}
      />
    );

  return (
    <>
      <Screen title={title} busy={list.loading && !pull.refreshing && !!sections} />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {!sections ? (
          list.loading ? (
            <LoadingState />
          ) : list.error?.status === 403 ? (
            <EmptyState
              icon="brain"
              title={t('appPages.memory.unavailable')}
              message={t('appPages.memory.unavailableHint')}
              style={styles.state}
            />
          ) : (
            <EmptyState
              icon="brain"
              title={list.error?.message || t('places.pluginError')}
              onRetry={() => void list.refresh()}
              style={styles.state}
            />
          )
        ) : !sections.length ? (
          <EmptyState
            icon="brain"
            title={t('appPages.memory.empty')}
            message={t('appPages.memory.emptyHint')}
            style={styles.state}
          />
        ) : (
          <>
            {sections.map(({ group, items }) => (
              <Section
                key={group}
                header={t(`appPages.memory.group.${group}`)}
                footer={t(`appPages.memory.groupHint.${group}`)}
              >
                {items.map((memory) => (
                  <NativeMenu
                    key={memory.id}
                    title={memory.title}
                    items={menuSections([
                      [
                        { id: 'edit', title: t('appPages.memory.edit'), icon: 'pen' },
                        {
                          id: 'pin',
                          title: t(memory.pinned ? 'appPages.memory.unpin' : 'appPages.memory.pin'),
                          icon: memory.pinned ? 'pinOff' : 'pin',
                        },
                        {
                          id: 'archive',
                          title: t(memory.status === 'active' ? 'appPages.memory.archive' : 'appPages.memory.restore'),
                          icon: 'archive',
                        },
                      ],
                      [{ id: 'delete', title: t('appPages.memory.delete'), icon: 'trash', destructive: true }],
                    ])}
                    onSelect={(id) => act(id, memory)}
                    fill
                  >
                    <Row
                      title={memory.title}
                      subtitle={`${t(`appPages.memory.category.${memory.category}`)} · ${
                        memory.last_used_at
                          ? t('appPages.memory.used', { when: relativeTimeNow(memory.last_used_at) })
                          : t('appPages.memory.changed', { when: relativeTimeNow(memory.updated_at) })
                      }\n${memory.content}`}
                      subtitleLines={3}
                      icon={memory.pinned ? 'pin' : 'brain'}
                      menuTrigger
                    />
                  </NativeMenu>
                ))}
              </Section>
            ))}
            <SectionFooter text={t('appPages.memory.intro')} />
          </>
        )}
      </ScrollView>
    </>
  );
}

function MemoryForm({ memory, close, saved }: { memory: Memory; close: () => void; saved: () => void }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [draft, setDraft] = useState<MemoryDraft>(() => draftOf(memory));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<MemoryDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = async () => {
    if (busy) return;
    const problem = draftProblem(draft);
    if (problem) {
      setError(
        t(`appPages.memory.problem.${problem}`, { max: problem === 'titleLong' ? MEMORY_TITLE_MAX : MEMORY_CONTENT_MAX }),
      );
      return;
    }
    const body = patchBody(memory, draft);
    Keyboard.dismiss();
    if (!Object.keys(body).length) return close();
    const current = captureIdentity();
    setBusy(true);
    const r = await updateMemory(memory.id, body);
    if (!current()) return;
    setBusy(false);
    // the station's words name what it refused (a secret, a phone number)
    if (!r.ok) setError(r.message || t('appPages.memory.saveFailed'));
    else saved();
  };
  return (
    <>
      <Screen
        title={t('appPages.memory.editTitle')}
        actions={[
          { icon: 'x', label: t('common.cancel'), onPress: close },
          { icon: 'check', label: t('common.save'), onPress: () => void submit(), disabled: busy },
        ]}
      />
      <KeyboardAwareScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.form}
      >
        <FormField
          label={t('appPages.memory.title')}
          value={draft.title}
          onChange={(title) => set({ title })}
          hint={t('appPages.memory.titleHint')}
          counter={{ length: draft.title.trim().length, max: MEMORY_TITLE_MAX }}
        />
        <FormField
          label={t('appPages.memory.content')}
          value={draft.content}
          onChange={(content) => set({ content })}
          multiline
          counter={{ length: draft.content.trim().length, max: MEMORY_CONTENT_MAX }}
        />
        <Section header={t('appPages.memory.kind')} variant="plain">
          {MEMORY_CATEGORIES.map((category: MemoryCategory) => (
            <Row
              key={category}
              title={t(`appPages.memory.category.${category}`)}
              accessory={draft.category === category ? 'check' : 'none'}
              onPress={() => set({ category })}
            />
          ))}
        </Section>
        <View style={styles.toggle}>
          <NativeToggle label={t('appPages.memory.pin')} value={draft.pinned} onChange={(pinned) => set({ pinned })} />
          <SectionFooter text={t('appPages.memory.pinHint')} style={styles.flush} />
        </View>
        {error ? <SectionFooter text={error} style={[styles.flush, { color: c.red }]} /> : null}
      </KeyboardAwareScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  form: { padding: space.margin, gap: space.lg, paddingBottom: space.xxxl * 2 },
  toggle: { gap: space.xs },
  flush: { marginHorizontal: 0, ...typo.footnote },
}));
