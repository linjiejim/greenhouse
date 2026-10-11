/**
 * One app card's data from the gateway (`POST /api/apps/:id/cards/query`):
 * evaluated for my role with the page's filter values. Records-like cards page
 * their rows (`more()` follows the cursor; the label refs of every page are
 * merged), aggregate cards answer once. Refetches when a write goes through the
 * app (`useApps.writes`) and when the page regains focus; a response for older
 * filter values is dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { queryCard } from '../api/apps';
import type { AppCardQueryResult, AppRecordRefs, AppRecordRow } from '../shared/apps';
import type { TableFilterValue } from '../shared/tables';
import { useApps } from './store';

type RecordsResult = Extract<AppCardQueryResult, { kind: 'records' }>;

export interface CardData {
  result: AppCardQueryResult | null;
  /** Records-like cards: every row loaded so far. */
  records: AppRecordRow[];
  refs: AppRecordRefs;
  total: number;
  hasMore: boolean;
  failed: boolean;
  more: () => Promise<void>;
  reload: () => Promise<void>;
}

const EMPTY_REFS: AppRecordRefs = { users: {}, records: {}, files: {} };

function mergeRefs(a: AppRecordRefs, b: AppRecordRefs): AppRecordRefs {
  return {
    users: { ...a.users, ...b.users },
    records: { ...a.records, ...b.records },
    files: { ...a.files, ...b.files },
  };
}

export function useCardQuery(
  appId: number,
  pageId: string,
  cardId: string,
  filterValues: Record<string, TableFilterValue | null>,
  opts: { previewRole?: string; enabled?: boolean } = {},
): CardData {
  const enabled = opts.enabled !== false;
  const [result, setResult] = useState<AppCardQueryResult | null>(null);
  const [records, setRecords] = useState<AppRecordRow[]>([]);
  const [refs, setRefs] = useState<AppRecordRefs>(EMPTY_REFS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const writes = useApps((s) => s.writes[appId] ?? 0);
  const seq = useRef(0);
  const key = JSON.stringify(filterValues);
  const input = useRef({ pageId, cardId, filterValues, previewRole: opts.previewRole });
  input.current = { pageId, cardId, filterValues, previewRole: opts.previewRole };

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const { pageId: page, cardId: card, filterValues: values, previewRole } = input.current;
    const answer = await queryCard(appId, {
      pageId: page,
      cardId: card,
      filterValues: values as AppCardQueryInputValues,
      ...(previewRole ? { previewRole } : {}),
    });
    if (mine !== seq.current) return;
    if (!answer.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setResult(answer.value);
    if (answer.value.kind === 'records') {
      const page = answer.value as RecordsResult;
      setRecords(page.records);
      setRefs(page.refs);
      setCursor(page.nextCursor);
    } else {
      setRecords([]);
      setCursor(null);
    }
  }, [appId]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload, key, pageId, cardId, writes]);

  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current && enabled) void reload();
      focused.current = true;
    }, [reload, enabled]),
  );

  const more = useCallback(async () => {
    if (!cursor) return;
    const mine = seq.current;
    const { pageId: page, cardId: card, filterValues: values, previewRole } = input.current;
    const answer = await queryCard(appId, {
      pageId: page,
      cardId: card,
      filterValues: values as AppCardQueryInputValues,
      cursor,
      ...(previewRole ? { previewRole } : {}),
    });
    if (mine !== seq.current || !answer.ok || answer.value.kind !== 'records') return;
    const next = answer.value as RecordsResult;
    setRecords((prev) => {
      const seen = new Set(prev.map((row) => row.id));
      return [...prev, ...next.records.filter((row) => !seen.has(row.id))];
    });
    setRefs((prev) => mergeRefs(prev, next.refs));
    setCursor(next.nextCursor);
  }, [appId, cursor]);

  const total = result?.kind === 'records' ? (result as RecordsResult).total : 0;
  return { result, records, refs, total, hasMore: !!cursor, failed, more, reload };
}

/** `AppCardQueryInput.filterValues` takes cleared controls as absent; `null` is how the bar clears a default. */
type AppCardQueryInputValues = Record<string, TableFilterValue>;
