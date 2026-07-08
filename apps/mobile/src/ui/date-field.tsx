/**
 * DateField — a form row that expands into an inline month-grid calendar.
 * Pure JS (no native date-picker dependency, so no dev-client rebuild); dates
 * are `YYYY-MM-DD` strings, UTC-based to match the server's date-only columns.
 */

import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { font, makeStyles, radius, useTheme, weight } from '../theme';
import { useT } from '../lib/i18n';
import { Icon, Touchable } from './core';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function stamp(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

export function DateField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  /** `YYYY-MM-DD` or empty/null for unset. */
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [open, setOpen] = useState(false);

  const selected = value?.slice(0, 10) || null;
  const todayStamp = new Date().toISOString().slice(0, 10);

  // Calendar cursor (year + 0-based month), seeded from the value or today.
  const [cursor, setCursor] = useState(() => {
    const seed = selected ?? todayStamp;
    return { y: Number(seed.slice(0, 4)), m: Number(seed.slice(5, 7)) - 1 };
  });

  const months = t('date.months').split(',');
  const weekdays = t('date.weekdays').split(',');

  const grid = useMemo(() => {
    const firstWeekday = new Date(Date.UTC(cursor.y, cursor.m, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
    const cells: Array<number | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const shiftMonth = (delta: number) => {
    setCursor((prev) => {
      const m = prev.m + delta;
      if (m < 0) return { y: prev.y - 1, m: 11 };
      if (m > 11) return { y: prev.y + 1, m: 0 };
      return { ...prev, m };
    });
  };

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <Touchable haptic="none" onPress={() => setOpen((v) => !v)} pressedStyle={{ opacity: 0.7 }} style={styles.trigger}>
        <Icon name="calendar" size={17} color={c.fgMuted} />
        <Text style={[styles.triggerText, !selected && { color: c.fgFaint }]}>
          {selected ?? placeholder ?? t('projects.noDate')}
        </Text>
        {selected ? (
          <Touchable
            haptic="none"
            hitSlop={8}
            accessibilityLabel={t('date.clear')}
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <Icon name="x" size={15} color={c.fgFaint} />
          </Touchable>
        ) : (
          <Icon name={open ? 'chevD' : 'chevR'} size={15} color={c.fgFaint} />
        )}
      </Touchable>

      {open ? (
        <View style={styles.calendar}>
          <View style={styles.calHeader}>
            <Touchable haptic="selection" hitSlop={8} onPress={() => shiftMonth(-1)} style={styles.calNav}>
              <Icon name="chevL" size={18} color={c.fgSecondary} />
            </Touchable>
            <Text style={styles.calTitle}>{t('date.monthTitle', { y: cursor.y, m: months[cursor.m] })}</Text>
            <Touchable haptic="selection" hitSlop={8} onPress={() => shiftMonth(1)} style={styles.calNav}>
              <Icon name="chevR" size={18} color={c.fgSecondary} />
            </Touchable>
          </View>
          <View style={styles.weekRow}>
            {weekdays.map((w, i) => (
              <Text key={i} style={styles.weekday}>
                {w}
              </Text>
            ))}
          </View>
          <View style={styles.grid}>
            {grid.map((d, i) => {
              if (d === null) return <View key={i} style={styles.cell} />;
              const s = stamp(cursor.y, cursor.m, d);
              const isSelected = s === selected;
              const isToday = s === todayStamp;
              return (
                <Touchable
                  key={i}
                  haptic="selection"
                  onPress={() => {
                    onChange(s);
                    setOpen(false);
                  }}
                  style={[styles.cell, isSelected && { backgroundColor: c.accent }, !isSelected && isToday && styles.todayCell]}
                >
                  <Text
                    style={[
                      styles.cellText,
                      isSelected && { color: c.onAccent, fontWeight: weight.bold },
                      !isSelected && isToday && { color: c.accent, fontWeight: weight.semibold },
                    ]}
                  >
                    {d}
                  </Text>
                </Touchable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  label: { fontSize: font.caption, color: c.fgMuted, marginBottom: 6, fontWeight: weight.medium },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
  },
  triggerText: { flex: 1, fontSize: font.label, color: c.fg },
  calendar: {
    marginTop: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
    padding: 8,
  },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 4 },
  calNav: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  calTitle: { fontSize: font.label, fontWeight: weight.semibold, color: c.fg },
  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: font.caption,
    color: c.fgFaint,
    paddingVertical: 4,
    fontWeight: weight.medium,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    height: 38,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayCell: { borderWidth: 1, borderColor: c.accentBorder },
  cellText: { fontSize: font.label, color: c.fg },
}));
