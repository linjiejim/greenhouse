/**
 * Record peek — a Tables record cited in chat (`#/tables/<base>/table/<table>?record=<id>`,
 * `entityRoute` in src/lib/entity-links.ts) as a bottom sheet: the title and
 * its fields, read-only, and "Open Full Page" (the record page with activity
 * and editing; the sheet closes first). A record I may not see is "not
 * available", like a missing one.
 *
 * Params: `baseId`, `tableId`, `recordId`.
 */

import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { useValueLabels } from '../../src/tables/labels';
import { RecordDetails, RecordHeader, useRecord } from '../../src/tables/record-details';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useSchema, useTableUsers } from '../../src/tables/store';
import { space } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';

export default function RecordPeekScreen() {
  return (
    <TablesRouteGate area="tables">
      <RecordPeek />
    </TablesRouteGate>
  );
}

function RecordPeek() {
  const t = useT();
  const leaveTo = useLeaveSheetTo();
  const params = useLocalSearchParams<{ baseId: string; tableId: string; recordId: string }>();
  const tableId = Number(params.tableId);
  const recordId = Number(params.recordId);
  const { schema } = useSchema(tableId);
  const users = useTableUsers();
  const labels = useValueLabels({ users });
  const { record, state, reload } = useRecord(tableId, recordId);
  const fields = useMemo(
    () => [...(schema?.fields ?? [])].filter((field) => !field.archived_at).sort((a, b) => a.position - b.position),
    [schema],
  );

  return (
    <>
      <Stack.Screen options={{ title: schema?.table.name ?? t('tables.record') }} />
      <SheetClose />
      {record && schema ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
          <RecordHeader record={record} fields={fields} labels={labels} />
          <View style={{ paddingHorizontal: space.margin, paddingBottom: space.xl }}>
            <NativeButton
              label={t('tables.openFullPage')}
              icon="open"
              fullWidth
              onPress={() =>
                leaveTo({
                  pathname: '/tables/record/[recordId]',
                  params: { recordId: String(recordId), tableId: String(tableId), baseId: params.baseId },
                })
              }
            />
          </View>
          <RecordDetails record={record} fields={fields} labels={labels} />
        </ScrollView>
      ) : state === 'gone' || state === 'failed' ? (
        <EmptyState
          icon="alert"
          title={t('tables.recordMissing')}
          message={state === 'gone' ? t('tables.recordMissingHint') : undefined}
          onRetry={state === 'failed' ? () => void reload() : undefined}
        />
      ) : (
        <LoadingState />
      )}
    </>
  );
}
