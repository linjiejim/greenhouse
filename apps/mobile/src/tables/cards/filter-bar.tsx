/**
 * The viewer's filters over a dashboard or an app page (`TableFilterControl`,
 * web parity: `table-cards/filter-bar.tsx`) as a row of chips, each a system
 * menu: a date range by preset, a select by its options (several may be on),
 * a person ("Me", or anyone from the directory when it is at hand), a search
 * (a text prompt). A chip that is set shows its value and offers "Clear"; a
 * control's default applies until the viewer changes it (`null` = cleared on
 * purpose). The server drops a control whose target I may not read, and
 * ignores its value — the bar only says what to ask.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TableDateRangePreset, TableFilterControl, TableFilterValue } from '../../shared/tables';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { promptText } from '../../ui/dialogs';
import { NativeMenu, menuSections, type MenuItem } from '../../ui/menu';
import { fieldConfig, type FieldLike } from '../model/fields';

const PRESETS: TableDateRangePreset[] = [
  'today',
  'last_7_days',
  'last_30_days',
  'this_week',
  'this_month',
  'this_quarter',
  'this_year',
];

export type FilterValues = Record<string, TableFilterValue | null>;

/** What applies for a control: the viewer's value, else its default (`null` = cleared). */
export function effectiveFilter(control: TableFilterControl, values: FilterValues): TableFilterValue | null {
  const value = values[control.id];
  return value === undefined ? (control.defaultValue ?? null) : value;
}

export function FilterBar({
  controls,
  values,
  onChange,
  fieldsById,
  me,
  people,
}: {
  controls: readonly TableFilterControl[];
  values: FilterValues;
  onChange: (controlId: string, value: TableFilterValue | null) => void;
  /** Fields of the controls' targets (a select control lists its first target's options). */
  fieldsById: ReadonlyMap<number, FieldLike>;
  /** My user id (the "Me" choice of a person control). */
  me: string | undefined;
  /** People to offer besides "Me" (the Tables directory; none in an app). */
  people?: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (!controls.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar}>
      {controls.map((control) => {
        const value = effectiveFilter(control, values);
        const set = (next: TableFilterValue | null) => onChange(control.id, next);
        let summary = '';
        let items: MenuItem[] = [];
        let onSelect: (id: string) => void = () => {};

        if (control.kind === 'date_range') {
          const preset = value?.kind === 'date_range' ? value.preset : undefined;
          summary = preset
            ? t(`apps.preset.${preset}`)
            : value?.kind === 'date_range'
              ? `${value.from ?? ''}–${value.to ?? ''}`
              : '';
          items = menuSections([
            [{ id: '', title: t('apps.filterAll'), checked: !value }],
            PRESETS.map((entry) => ({ id: entry, title: t(`apps.preset.${entry}`), checked: preset === entry })),
          ]);
          onSelect = (id) => set(id ? { kind: 'date_range', preset: id as TableDateRangePreset } : null);
        } else if (control.kind === 'select') {
          const target = control.targets.find((entry) => entry.fieldId !== undefined);
          const field = target?.fieldId !== undefined ? fieldsById.get(target.fieldId) : undefined;
          const options = field ? (fieldConfig(field).options ?? []) : [];
          const chosen = value?.kind === 'select' ? value.values : [];
          summary = chosen.map((id) => options.find((option) => option.id === id)?.label ?? id).join(', ');
          items = menuSections([
            [{ id: '', title: t('apps.filterAll'), checked: chosen.length === 0 }],
            options.map((option) => ({ id: option.id, title: option.label, checked: chosen.includes(option.id) })),
          ]);
          onSelect = (id) => {
            if (!id) return set(null);
            const next = chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id];
            set(next.length ? { kind: 'select', values: next } : null);
          };
        } else if (control.kind === 'user') {
          const chosen = value?.kind === 'user' ? value.userIds : [];
          const name = (id: string) =>
            id === me ? t('apps.filterMe') : (people?.find((p) => p.id === id)?.name ?? id);
          summary = chosen.map(name).join(', ');
          items = menuSections([
            [
              { id: '', title: t('apps.filterAll'), checked: chosen.length === 0 },
              ...(me ? [{ id: me, title: t('apps.filterMe'), checked: chosen.includes(me) }] : []),
            ],
            (people ?? [])
              .filter((person) => person.id !== me)
              .map((person) => ({ id: person.id, title: person.name, checked: chosen.includes(person.id) })),
          ]);
          onSelect = (id) => {
            if (!id) return set(null);
            const next = chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id];
            set(next.length ? { kind: 'user', userIds: next } : null);
          };
        } else if (control.kind === 'search') {
          summary = value?.kind === 'search' ? value.text : '';
          items = menuSections([
            [{ id: 'edit', title: t('apps.filterSearch'), icon: 'search' }],
            summary ? [{ id: 'clear', title: t('apps.filterClear'), icon: 'x' }] : [],
          ]);
          onSelect = (id) => {
            if (id === 'clear') return set(null);
            void promptText({ title: control.label, defaultValue: summary, confirmLabel: t('common.done') }).then(
              (text) => {
                if (text === null || text === undefined) return;
                set(text.trim() ? { kind: 'search', text: text.trim() } : null);
              },
            );
          };
        }

        const on = !!summary;
        return (
          <NativeMenu key={control.id} items={items} onSelect={onSelect} title={control.label}>
            <View
              style={[styles.chip, on && styles.chipOn]}
              accessible
              accessibilityRole="button"
              accessibilityLabel={on ? `${control.label}: ${summary}` : control.label}
            >
              <Text numberOfLines={1} style={[styles.chipText, on && styles.chipTextOn]}>
                {on ? `${control.label}: ${summary}` : control.label}
              </Text>
              <Icon name="chevD" size={11} weight="semibold" color={on ? c.accentText : c.secondaryLabel} />
            </View>
          </NativeMenu>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  bar: { paddingHorizontal: space.margin, paddingVertical: space.sm, gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    maxWidth: 260,
    paddingHorizontal: space.md,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  chipOn: { backgroundColor: c.accentFill },
  chipText: { ...typo.subheadline, color: c.label, flexShrink: 1 },
  chipTextOn: { color: c.accentText, fontWeight: weight.semibold },
}));
