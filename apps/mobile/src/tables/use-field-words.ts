/** How table values read in the app's language, and the names of the users a table mentions. */

import { useEffect, useMemo, useState } from 'react';
import { tableUsers } from '../api/tables';
import { captureIdentity } from '../data/identity';
import type { FieldWords } from '../data/table-fields';
import { useT } from '../lib/i18n';
import { calendarDateLabel } from '../lib/time-words';
import type { TableField } from '../shared/greenhouse-types';

/** The words for `displayValue`; user names are loaded only when a field holds users. */
export function useFieldWords(fields: readonly TableField[] | null | undefined): FieldWords {
  const t = useT();
  const needsUsers = !!fields?.some((field) => field.type === 'user' || field.type === 'multi_user');
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!needsUsers) return;
    let alive = true;
    const current = captureIdentity();
    void tableUsers().then((result) => {
      if (alive && current() && result.ok) {
        setNames(new Map(result.data.users.map((user) => [user.id, user.nickname || user.id])));
      }
    });
    return () => {
      alive = false;
    };
  }, [needsUsers]);
  return useMemo(
    () => ({
      yes: t('tables.yes'),
      no: t('tables.no'),
      date: (value: string) => calendarDateLabel(value.length > 10 ? value : value.slice(0, 10)) || value,
      user: (id: string) => names.get(id) ?? id,
    }),
    [t, names],
  );
}
