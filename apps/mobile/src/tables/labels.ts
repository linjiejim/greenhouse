/**
 * The words the pure models need, in the app's language: how values read
 * (`ValueLabels`, ./model/fields.ts) and how aggregate cards read (`CardCopy`,
 * ./model/cards.ts). People come from the Tables user directory, or — in an
 * app, whose viewers cannot call `/api/tables` — from the gateway's refs.
 */

import { useMemo } from 'react';
import type { AppRecordRefs } from '../shared/apps';
import type { TableUser } from '../shared/tables-wire';
import { useLocale, useT } from '../lib/i18n';
import type { CardCopy } from './model/cards';
import type { ValueLabels } from './model/fields';

export function useValueLabels(source: { users?: readonly TableUser[]; refs?: AppRecordRefs | null }): ValueLabels {
  const t = useT();
  const locale = useLocale();
  const { users, refs } = source;
  return useMemo<ValueLabels>(() => {
    const byId = new Map((users ?? []).map((user) => [user.id, user.nickname || user.email]));
    return {
      user: (id) => refs?.users[id]?.nickname ?? byId.get(id),
      record: refs ? (tableId, recordId) => refs.records[`${tableId}:${recordId}`] : undefined,
      file: refs ? (id) => refs.files[id]?.name : undefined,
      yes: t('common.yes'),
      no: t('common.no'),
      noAccess: t('tables.noAccess'),
      locale,
    };
  }, [users, refs, t, locale]);
}

export function useCardCopy(): CardCopy {
  const t = useT();
  return useMemo<CardCopy>(
    () => ({
      allRecords: t('tables.card.allRecords'),
      empty: t('tables.card.empty'),
      other: t('tables.card.other'),
      total: t('tables.card.total'),
      yes: t('common.yes'),
      no: t('common.no'),
      weekOf: (date) => t('tables.card.weekOf', { date }),
      quarter: (year, quarter) => t('tables.card.quarter', { year, quarter }),
      valueCaption: (operation, field) => t(`tables.card.${operation}`, { field }),
    }),
    [t],
  );
}
