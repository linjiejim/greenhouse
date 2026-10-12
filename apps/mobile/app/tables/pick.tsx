/**
 * The choice sheet (spec §3: "多选与人员（勾选列表 sheet）/ 关联（记录选择 sheet）"):
 * a SwiftUI checklist of what a field may take — a select's options, the
 * people directory, a related table's rows I can read (searchable, titled by
 * their primary field), or an app card's choices from the gateway. Single
 * choice: a tap answers and closes; several: tap to toggle, ✓ answers. The
 * answer goes back through `usePick` (src/tables/pick.ts). A missing handoff
 * (the app was restarted) shows an empty state.
 *
 * Params: `k` (handoff: `PickRequest`). Android: ./pick.android.tsx.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ProgressView, Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { textInputAutocapitalization } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { fieldOptions } from '../../src/api/apps';
import { queryRecords, type TableRecord } from '../../src/api/tables';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { useValueLabels } from '../../src/tables/labels';
import { recordTitle } from '../../src/tables/model/fields';
import { usePick, type PickChoice, type PickRequest } from '../../src/tables/pick';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useSchema, useTables } from '../../src/tables/store';
import { useTheme } from '../../src/theme';
import { FormCheckRow, NativeForm } from '../../src/ui/native-form';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function PickScreen() {
  const params = useLocalSearchParams<{ k?: string }>();
  const request = getHandoff<PickRequest>(params.k);
  // the gate of whoever opened it: a Tables form, an app form, a submit-only form
  return (
    <TablesRouteGate area={request?.area ?? 'tables'} latched>
      <Pick request={request} />
    </TablesRouteGate>
  );
}

function Pick({ request }: { request: PickRequest | undefined }) {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const answer = usePick((s) => s.answer);
  const [selected, setSelected] = useState<Array<string | number>>(request?.selected ?? []);
  const [search, setSearch] = useState('');
  const searchText = useNativeState('');
  const [choices, setChoices] = useState<PickChoice[] | null>(
    request?.source.kind === 'options' ? request.source.choices : null,
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const labelsRef = useRef<Record<string, string>>({ ...(request?.labels ?? {}) });

  // records of the related table, titled by their primary field
  const targetTable = request?.source.kind === 'records' ? request.source.tableId : 0;
  const { schema, failed: schemaFailed, reload } = useSchema(targetTable);
  // names for people inside related rows' titles: whatever directory is already loaded (never a new load —
  // an app or form viewer may not read the Tables directory)
  const users = useTables((s) => s.users) ?? undefined;
  const labels = useValueLabels({ users });

  useEffect(() => {
    if (!request || request.source.kind === 'options') return;
    let live = true;
    const timer = setTimeout(async () => {
      const source = request.source;
      if (source.kind === 'records') {
        if (!schema) return;
        const result = await queryRecords(source.tableId, { ...(search ? { search } : {}), limit: 100 });
        if (!live) return;
        if (!result.ok) return setFailed(true);
        const fields = schema.fields.filter((field) => !field.archived_at);
        setChoices(
          result.value.records.map((record: TableRecord) => ({
            value: record.id,
            label: recordTitle(record, fields, labels),
          })),
        );
        setFailed(false);
      } else if (source.kind === 'app') {
        const result = await fieldOptions(source.appId, {
          pageId: source.pageId,
          cardId: source.cardId,
          fieldId: source.fieldId,
          ...(source.buttonId ? { buttonId: source.buttonId } : {}),
          ...(search ? { search } : {}),
        });
        if (!live) return;
        if (!result.ok) return setFailed(true);
        setChoices(result.value.options);
        setFailed(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [request, schema, search, labels, attempt]);

  const shown = useMemo(() => {
    if (!choices) return null;
    if (request?.source.kind !== 'options' || !search.trim()) return choices;
    const q = search.trim().toLocaleLowerCase();
    return choices.filter(
      (choice) => choice.label.toLocaleLowerCase().includes(q) || (choice.detail ?? '').toLocaleLowerCase().includes(q),
    );
  }, [choices, search, request]);

  if (!request) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <SheetClose />
        <NativeForm>
          <Section>
            <Text>{t('tables.pick.none')}</Text>
          </Section>
        </NativeForm>
      </>
    );
  }

  for (const choice of choices ?? []) labelsRef.current[String(choice.value)] = choice.label;
  const done = (values: Array<string | number>) => {
    const named: Record<string, string> = {};
    for (const value of values) {
      const label = labelsRef.current[String(value)];
      if (label) named[String(value)] = label;
    }
    answer(request.id, values, named);
    router.back();
  };
  const isOn = (value: string | number) => selected.some((entry) => String(entry) === String(value));

  return (
    <>
      <Stack.Screen options={{ title: request.title }} />
      <SheetClose />
      {request.multiple ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('check')}
            variant="done"
            tintColor={hex.accent}
            accessibilityLabel={t('tables.pick.done')}
            onPress={() => done(selected)}
          />
        </Stack.Toolbar>
      ) : null}
      <NativeForm>
        <Section>
          <TextField
            text={searchText}
            placeholder={t('tables.pick.search')}
            onTextChange={setSearch}
            modifiers={[textInputAutocapitalization('never')]}
          />
        </Section>
        {failed || (targetTable > 0 && schemaFailed) ? (
          <Section>
            <Text>{t('tables.pick.failed')}</Text>
            <Button
              label={t('common.retry')}
              systemImage="arrow.clockwise"
              onPress={() => {
                setFailed(false);
                if (targetTable && (schemaFailed || !schema)) void reload({ fresh: true });
                setAttempt((value) => value + 1);
              }}
            />
          </Section>
        ) : shown === null ? (
          <Section>
            <ProgressView />
          </Section>
        ) : shown.length === 0 ? (
          <Section>
            <Text>{t('tables.pick.none')}</Text>
          </Section>
        ) : (
          <Section>
            {!request.multiple && selected.length ? (
              <FormCheckRow label={t('tables.form.none')} checked={false} onPress={() => done([])} />
            ) : null}
            {shown.map((choice) => (
              <FormCheckRow
                key={String(choice.value)}
                label={choice.label}
                detail={choice.detail}
                checked={isOn(choice.value)}
                onPress={() => {
                  if (!request.multiple) return done([choice.value]);
                  setSelected((prev) =>
                    isOn(choice.value)
                      ? prev.filter((entry) => String(entry) !== String(choice.value))
                      : [...prev, choice.value],
                  );
                }}
              />
            ))}
          </Section>
        )}
        {request.multiple && selected.length ? (
          <Section>
            <FormCheckRow label={t('tables.pick.clear')} checked={false} onPress={() => setSelected([])} />
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}
