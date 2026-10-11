/**
 * A Tables record (spec 20261011-mobile-tables-apps §2): the title, its fields
 * grouped (src/tables/record-details.tsx), the automation buttons I may press
 * on it, and its activity — comments and change history — with the pinned
 * comment composer (`@` opens a person strip; picked people are notified via
 * `[@Name](user:id)` links). Pencil = edit (the record sheet); `…` = delete when
 * my role may. A record I may not see (deleted, out of my rows) is a "not
 * available" state, exactly like a missing one.
 *
 * Params: `recordId`, `tableId`, `baseId?` (else the schema's). Push taps and
 * inbox rows land here (`/tables/record/<id>?tableId=&baseId=`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createComment,
  deleteComment,
  deleteRecord,
  listActivity,
  listRecordButtons,
  newRequestId,
  triggerButton,
} from '../../../src/api/tables';
import type { TableRecordButton } from '../../../src/shared/tables';
import { useT } from '../../../src/lib/i18n';
import { useValueLabels } from '../../../src/tables/labels';
import { tableAbilities } from '../../../src/tables/model/access';
import { ActivityList, useCommentDraft, useRecordActivity } from '../../../src/tables/record-activity';
import { RecordDetails, RecordHeader, useRecord } from '../../../src/tables/record-details';
import { TablesRouteGate } from '../../../src/tables/route-gate';
import { useSchema, useTableUsers, useTables, useWorkspace } from '../../../src/tables/store';
import { space } from '../../../src/theme';
import { COMPOSER_SPACE, CommentComposer } from '../../../src/ui/comment-thread';
import { alertError, confirmAction } from '../../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { useHeaderInset } from '../../../src/ui/header-inset';
import { ListRow, ListSection } from '../../../src/ui/list';
import { toast } from '../../../src/ui/toast';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';

export default function RecordScreen() {
  return (
    <TablesRouteGate area="tables">
      <RecordPage />
    </TablesRouteGate>
  );
}

function RecordPage() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const params = useLocalSearchParams<{ recordId: string; tableId: string; baseId?: string }>();
  const recordId = Number(params.recordId);
  const tableId = Number(params.tableId);
  const { schema } = useSchema(tableId);
  const baseId = Number(params.baseId) || schema?.table.base_id || 0;
  const { workspace } = useWorkspace(baseId);
  const users = useTableUsers();
  const labels = useValueLabels({ users });
  const recordsChanged = useTables((s) => s.recordsChanged);
  const { record, state, reload } = useRecord(tableId, recordId);
  const fields = useMemo(
    () => [...(schema?.fields ?? [])].filter((field) => !field.archived_at).sort((a, b) => a.position - b.position),
    [schema],
  );
  const abilities = useMemo(() => tableAbilities(workspace, tableId, fields), [workspace, tableId, fields]);
  const canEdit = abilities.editable.size > 0;

  // automation buttons (only for people who may update this row)
  const [buttons, setButtons] = useState<TableRecordButton[]>([]);
  useEffect(() => {
    let live = true;
    void listRecordButtons(tableId, recordId).then((result) => {
      if (live && result.ok) setButtons(result.value);
    });
    return () => {
      live = false;
    };
  }, [tableId, recordId]);

  const activity = useRecordActivity(
    {
      load: (cursor) => listActivity(tableId, recordId, cursor),
      post: (body) => createComment(tableId, recordId, body),
      remove: (commentId) => deleteComment(commentId),
    },
    `${tableId}:${recordId}`,
  );
  const people = useMemo(() => users.map((user) => ({ id: user.id, name: user.nickname || user.email })), [users]);
  const draft = useCommentDraft(people);
  const [sending, setSending] = useState(false);
  const canComment = activity.viewer?.canComment === true;

  const send = useCallback(async () => {
    const body = draft.encoded();
    if (!body || sending) return;
    setSending(true);
    const ok = await activity.send(body);
    setSending(false);
    if (ok) draft.clear();
  }, [draft, sending, activity]);

  const press = useCallback(
    async (button: TableRecordButton) => {
      const result = await triggerButton(button.ruleId, recordId, newRequestId());
      if (!result.ok) alertError(t('tables.buttonFailed'), result.message || undefined);
      else toast(t('tables.buttonQueued'), 'checkCircle');
    },
    [recordId, t],
  );

  const remove = useCallback(async () => {
    if (!record) return;
    const yes = await confirmAction({
      title: t('tables.deleteConfirm'),
      message: t('tables.deleteHint'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!yes) return;
    const result = await deleteRecord(tableId, record.id, record.revision);
    if (!result.ok) {
      alertError(t('tables.deleteFailed'), result.message || undefined);
      return;
    }
    recordsChanged(tableId);
    toast(t('tables.deleted'), 'trash');
    router.back();
  }, [record, tableId, recordsChanged, router, t]);

  const fieldName = useCallback((id: number) => fields.find((field) => field.id === id)?.name, [fields]);

  if (!record || !schema) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        {state === 'gone' || state === 'failed' ? (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          >
            <EmptyState
              icon="alert"
              title={t('tables.recordMissing')}
              message={state === 'gone' ? t('tables.recordMissingHint') : undefined}
              onRetry={state === 'failed' ? () => void reload() : undefined}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('pen')}
          hidden={!canEdit}
          accessibilityLabel={t('tables.editRecord')}
          onPress={() =>
            router.push({
              pathname: '/tables/record-form',
              params: { tableId: String(tableId), baseId: String(baseId), recordId: String(record.id) },
            })
          }
        />
        <Stack.Toolbar.Menu
          icon={toolbarIcon('more')}
          hidden={!abilities.canDelete}
          accessibilityLabel={t('common.more')}
        >
          <Stack.Toolbar.MenuAction icon={toolbarIcon('trash')} destructive onPress={() => void remove()}>
            {t('tables.deleteRecord')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: (canComment ? COMPOSER_SPACE : space.xxl) + insets.bottom }}
      >
        <RecordHeader record={record} fields={fields} labels={labels} subtitle={schema.table.name} />
        <RecordDetails record={record} fields={fields} labels={labels} />
        {buttons.length ? (
          <ListSection header={t('tables.buttons')}>
            {buttons.map((button) => (
              <ListRow key={button.ruleId} title={button.label} icon="sparkle" onPress={() => void press(button)} />
            ))}
          </ListSection>
        ) : null}
        <ActivityList activity={activity} fieldName={fieldName} userName={labels.user} />
        <View style={{ height: space.md }} />
      </ScrollView>

      {canComment ? (
        <CommentComposer
          value={draft.text}
          onChange={draft.setText}
          onSend={() => void send()}
          sending={sending}
          placeholder={t('tables.commentPlaceholder')}
          sendLabel={t('tables.sendComment')}
          onSelectionChange={draft.onSelectionChange}
          mentions={draft.candidates}
          onPickMention={draft.pick}
        />
      ) : null}
    </>
  );
}
