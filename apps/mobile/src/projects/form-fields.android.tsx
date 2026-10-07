/**
 * `OptionalDateField` on Android — the date row of the project / task forms
 * (iOS: ./form-fields.tsx, a Reminders-style toggle + inline calendar). Here:
 * a list row with the date as its supporting line and a switch — so "no date"
 * is a real state; switching on (or tapping the row) opens the Material date
 * picker dialog (`expanded`). Values are `YYYY-MM-DD` stamps: the picker works
 * in UTC days, so a stamp maps to UTC midnight and back with no time-zone
 * off-by-one. Renders inside a `FormSection` of src/ui/native-form.android.
 */

import React from 'react';
import { DatePickerDialog, Icon, ListItem, Switch, Text } from '@expo/ui/jetpack-compose';
import { clickable, fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';
import { useLocale, useT } from '../lib/i18n';
import type { IconName } from '../ui/core';
import { useM3 } from '../ui/m3';
// the Android table explicitly: TypeScript resolves the bare path to the iOS one (SF names)
import { toolbarIcon } from '../ui/toolbar-icon.android';
import { dateSubtitle, todayStamp } from './meta';

const utcDate = (stamp: string) => new Date(`${stamp.slice(0, 10)}T00:00:00Z`);
const utcStamp = (date: Date) => date.toISOString().slice(0, 10);

export function OptionalDateField({
  label,
  icon,
  value,
  onChange,
  fallback,
  min,
  expanded,
  onExpandedChange,
}: {
  label: string;
  icon: IconName;
  value: string | null;
  onChange: (stamp: string | null) => void;
  /** Day used when the switch is turned on (defaults to today). */
  fallback?: string | null;
  /** Earliest selectable day (an end date can't precede its start). */
  min?: string | null;
  /** The date picker dialog is showing. */
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const m = useM3();
  const t = useT();
  const locale = useLocale();
  const toggle = (on: boolean) => {
    onChange(on ? (fallback ?? todayStamp()) : null);
    onExpandedChange(on);
  };
  return (
    <>
      <ListItem
        colors={{ containerColor: m.surfaceContainer }}
        modifiers={[fillMaxWidth(), clickable(() => (value ? onExpandedChange(true) : toggle(true)))]}
      >
        <ListItem.LeadingContent>
          <Icon source={toolbarIcon(icon)} size={24} tint={m.onSurfaceVariant} />
        </ListItem.LeadingContent>
        <ListItem.HeadlineContent>
          <Text style={{ typography: 'bodyLarge' }}>{label}</Text>
        </ListItem.HeadlineContent>
        {value ? (
          <ListItem.SupportingContent>
            <Text color={m.primary} style={{ typography: 'bodyMedium' }}>
              {dateSubtitle(value, locale, t('projects.today'))}
            </Text>
          </ListItem.SupportingContent>
        ) : null}
        <ListItem.TrailingContent>
          <Switch value={!!value} onCheckedChange={toggle} />
        </ListItem.TrailingContent>
      </ListItem>
      {value && expanded ? (
        <DatePickerDialog
          initialDate={utcDate(value).toISOString()}
          selectableDates={min ? { start: utcDate(min) } : undefined}
          confirmButtonLabel={t('common.ok')}
          dismissButtonLabel={t('common.cancel')}
          onDateSelected={(d) => {
            onChange(utcStamp(d));
            onExpandedChange(false);
          }}
          onDismissRequest={() => onExpandedChange(false)}
        />
      ) : null}
    </>
  );
}
