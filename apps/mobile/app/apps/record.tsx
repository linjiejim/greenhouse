/**
 * A record inside an app (the web runtime's record drawer; spec §3): read
 * through the card that shows it (`POST /api/apps/:id/records/get` — my role's
 * readable ∩ the card's detail fields, labels resolved by the gateway), its
 * actions (the declared ones the gateway says hold now — approve, reject with a
 * reason…), Edit when the card lets my role edit fields of it (`$edit`), and
 * its activity and comments when the card shows them and my role may comment.
 * Attachments download through the gateway's file route (readable for me only).
 * A delete action run here leaves the page; a record that is gone (deleted
 * elsewhere, out of my rows) shows as missing — never the stale copy.
 *
 * Params: `appId`, `pageId`, `cardId`, `recordId`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appFilePath, createAppComment, deleteAppComment, getAppRecord, listAppActivity } from '../../src/api/apps';
import type { AppCard, AppRecordView } from '../../src/shared/apps';
import { BlockActionsView } from '../../src/chat/markdown/blocks/block-actions';
import { useT } from '../../src/lib/i18n';
import { useAppActions } from '../../src/apps/actions';
import { findCard } from '../../src/shared/apps';
import { isRecordsLike, recordActions, tableFields } from '../../src/apps/model';
import { useApps } from '../../src/apps/store';
import { useValueLabels } from '../../src/tables/labels';
import type { FieldLike } from '../../src/tables/model/fields';
import { ActivityList, useCommentDraft, useRecordActivity } from '../../src/tables/record-activity';
import { FieldsCard, RecordHeader } from '../../src/tables/record-details';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { space } from '../../src/theme';
import { COMPOSER_SPACE, CommentComposer } from '../../src/ui/comment-thread';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useHeaderInset } from '../../src/ui/header-inset';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function AppRecordScreen() {
  return (
    <TablesRouteGate area="apps">
      <AppRecord />
    </TablesRouteGate>
  );
}

function AppRecord() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const params = useLocalSearchParams<{ appId: string; pageId: string; cardId: string; recordId: string }>();
  const appId = Number(params.appId);
  const recordId = Number(params.recordId);
  const { pageId, cardId } = params;
  const view = useApps((s) => s.views[appId]);
  const loadApp = useApps((s) => s.loadApp);
  const writes = useApps((s) => s.writes[appId] ?? 0);
  const actions = useAppActions(appId);
  const [data, setData] = useState<AppRecordView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'failed'>('loading');
  const seq = useRef(0);

  useEffect(() => {
    if (!view) void loadApp(appId);
  }, [view, appId, loadApp]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const result = await getAppRecord(appId, { pageId, cardId, recordId });
    if (mine !== seq.current) return;
    if (result.ok) {
      setData(result.value);
      setState('ok');
    } else if (result.definitive) {
      // gone, or no longer mine to read: drop what is on screen (its actions would only be refused)
      setData(null);
      setState('gone');
    } else setState((prev) => (prev === 'ok' ? 'ok' : 'failed'));
  }, [appId, pageId, cardId, recordId]);
  useEffect(() => {
    void load();
  }, [load, writes]);
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) void load();
      focused.current = true;
    }, [load]),
  );

  const card: AppCard | undefined = view ? findCard(view.spec, pageId, cardId) : undefined;
  const recordsCard = card && isRecordsLike(card) ? card : undefined;
  const fields = useMemo(
    () => (view && recordsCard ? (tableFields(view, recordsCard.source.tableId) as FieldLike[]) : []),
    [view, recordsCard],
  );
  const labels = useValueLabels({ refs: data?.refs ?? null });
  const shown = useMemo(() => {
    if (!data) return [];
    const byId = new Map(fields.map((field) => [field.id, field]));
    return data.fieldIds.map((id) => byId.get(id)).filter((field): field is FieldLike => !!field);
  }, [data, fields]);
  const declared = recordsCard ? [...(recordsCard.detail?.actions ?? []), ...(recordsCard.actions ?? [])] : [];
  const available = data ? recordActions(declared, data.record.actionIds) : [];
  const unique = available.filter((action, index) => available.findIndex((entry) => entry.id === action.id) === index);

  const activity = useRecordActivity(
    {
      load: (cursor) => listAppActivity(appId, { pageId, cardId, recordId, ...(cursor ? { cursor } : {}) }),
      post: (body) => createAppComment(appId, { pageId, cardId, recordId, body }),
      remove: (commentId) => deleteAppComment(appId, commentId, { pageId, cardId }),
    },
    `${appId}:${cardId}:${recordId}`,
  );
  // people to mention: the ones this record names (an app viewer has no directory)
  const people = useMemo(
    () => Object.entries(data?.refs.users ?? {}).map(([id, user]) => ({ id, name: user.nickname })),
    [data],
  );
  const draft = useCommentDraft(people);
  const [sending, setSending] = useState(false);
  const canComment = data?.canComment === true;
  const send = useCallback(async () => {
    const body = draft.encoded();
    if (!body || sending) return;
    setSending(true);
    const ok = await activity.send(body);
    setSending(false);
    if (ok) draft.clear();
  }, [draft, sending, activity]);

  if (!data || !view || !card) {
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
              onRetry={state === 'failed' ? () => void load() : undefined}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  const record = data.record;
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('pen')}
          hidden={!data.editableFieldIds.length}
          accessibilityLabel={t('apps.edit')}
          onPress={() =>
            router.push({
              pathname: '/apps/form',
              params: { appId: String(appId), pageId, cardId, mode: 'edit', recordId: String(recordId) },
            })
          }
        />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: (canComment ? COMPOSER_SPACE : space.xxl) + insets.bottom }}
      >
        <RecordHeader record={record} fields={fields} labels={labels} subtitle={view.app.name} />
        {unique.length ? (
          <View style={{ paddingHorizontal: space.margin + space.xs, paddingBottom: space.xl }}>
            <BlockActionsView
              actions={unique.map((action) => ({
                label: action.label,
                value: action.id,
                variant: action.do.type === 'delete' ? 'destructive' : 'secondary',
              }))}
              chosen={null}
              live
              choose={async (id) => {
                const action = unique.find((entry) => entry.id === id);
                if (!action) return;
                const done = await actions.run({ pageId, card, action, record });
                if (done?.outcome === 'deleted' && router.canGoBack()) router.back();
              }}
            />
          </View>
        ) : null}
        <FieldsCard
          title={t('tables.details')}
          fields={shown}
          record={record}
          labels={labels}
          filePath={(field, fileId) => appFilePath(appId, fileId, { pageId, cardId, recordId, fieldId: field.id })}
        />
        {recordsCard?.detail?.comments || canComment ? (
          <ActivityList
            activity={activity}
            fieldName={(id) => fields.find((field) => field.id === id)?.name}
            userName={labels.user}
            canComment={canComment}
          />
        ) : null}
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
