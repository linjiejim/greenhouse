import { brandFont as font } from '../ui/brand-font';
/**
 * Field helpers for the project / task form sheets (SwiftUI forms — see
 * src/ui/native-form.tsx; the sheet chrome is the shared `FormChrome` from
 * src/ui/sheet-chrome.tsx, the color palette the shared `ColorSwatchPicker`).
 *
 * `OptionalDateField` — the Reminders "Date" row: a Toggle (symbol + title,
 * and the chosen day as an accent subtitle) turns the date on/off — so "no
 * date" is a real state — and an inline graphical calendar opens under it
 * while it is being edited (switching on opens it; tapping the title toggles
 * it; the form keeps only one open at a time). Values are `YYYY-MM-DD` stamps;
 * the picker works on the same calendar day (src/projects/meta stampToDate /
 * dateToStamp), so there is no time-zone off-by-one, and it follows the app
 * language (not the device locale).
 */

import React from 'react';
import { DatePicker, Label, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import {
  contentShape,
  datePickerStyle,
  environment,
  foregroundStyle,
  frame,
  onTapGesture,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { useLocale, useT } from '../lib/i18n';
import { usePrefs, type LangPref } from '../store/prefs';
import { useTheme } from '../theme';
import { dateSubtitle, dateToStamp, stampToDate, todayStamp } from './meta';

/**
 * ICU locale identifier for the inline calendar. The shared `useLocaleEnv()`
 * passes the BCP-47 tag (`zh-CN`), which the graphical DatePicker ignores —
 * its month header and weekday row stay English (verified on iOS 26.5); the
 * ICU form `zh_Hans_CN` is honoured.
 */
function calendarLocale(lang: LangPref): string {
  return lang === 'zh' ? 'zh_Hans_CN' : 'en_US';
}

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
  icon: React.ComponentProps<typeof Label>['systemImage'];
  value: string | null;
  onChange: (stamp: string | null) => void;
  /** Day used when the toggle is switched on (defaults to today). */
  fallback?: string | null;
  /** Earliest selectable day (an end date can't precede its start). */
  min?: string | null;
  /** The inline calendar is showing. */
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const { hex } = useTheme();
  const t = useT();
  const locale = useLocale();
  const lang = usePrefs((s) => s.lang);
  return (
    <>
      <Toggle
        isOn={!!value}
        onIsOnChange={(on) => {
          onChange(on ? (fallback ?? todayStamp()) : null);
          onExpandedChange(on);
        }}
      >
        <Label
          systemImage={icon}
          modifiers={
            value
              ? [
                  // the whole label area (up to the switch) opens / closes the calendar
                  frame({ maxWidth: 10000, alignment: 'leading' }),
                  contentShape(shapes.rectangle()),
                  onTapGesture(() => onExpandedChange(!expanded)),
                ]
              : undefined
          }
        >
          <VStack alignment="leading" spacing={2}>
            <Text>{label}</Text>
            {value ? (
              <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(hex.accent)]}>
                {dateSubtitle(value, locale, t('projects.today'))}
              </Text>
            ) : null}
          </VStack>
        </Label>
      </Toggle>
      {value && expanded ? (
        <DatePicker
          selection={stampToDate(value)}
          range={min ? { start: stampToDate(min) } : undefined}
          displayedComponents={['date']}
          onDateChange={(d) => onChange(dateToStamp(d))}
          modifiers={[datePickerStyle('graphical'), environment('locale', calendarLocale(lang))]}
        />
      ) : null}
    </>
  );
}
