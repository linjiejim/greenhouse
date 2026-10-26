import { useCallback, useEffect, useRef, useState } from 'react';
import { get, type ApiResult } from '../api/client';
import { captureIdentity } from '../data/identity';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import type { PluginEntitySchema, EntityViewSchema } from '../shared/plugins';
import { entityQuery, safeEndpoint, type EntityRow } from './surface-model';
export function useEntityList(
  entity: PluginEntitySchema,
  view: EntityViewSchema | undefined,
  filters: Record<string, string>,
  sort?: { field: string; dir: 'asc' | 'desc' },
) {
  const [items, setItems] = useState<EntityRow[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const station = useStations((s) => s.activeId),
    member = useAuth((s) => s.user?.id);
  const generation = useRef(0),
    busy = useRef(false);
  const query = entityQuery(entity, view, 0, filters, sort);
  const request = useCallback(
    async (skip: number, gen: number) => {
      if (!safeEndpoint(entity.endpoint)) {
        setError('Invalid entity endpoint');
        return;
      }
      const current = captureIdentity();
      busy.current = true;
      setLoading(true);
      const q = new URLSearchParams(query);
      q.set('skip', String(skip));
      const r: ApiResult<{ items: EntityRow[]; total: number }> = await get(`${entity.endpoint}?${q}`);
      if (gen !== generation.current || !current()) return;
      busy.current = false;
      setLoading(false);
      if (!r.ok) {
        setError(r.message || r.code);
        return;
      }
      setError('');
      setTotal(r.data.total);
      setItems((previous) =>
        skip
          ? [...previous, ...r.data.items.filter((row) => !previous.some((old) => old.id === row.id))]
          : r.data.items,
      );
    },
    [entity.endpoint, query],
  );
  useEffect(() => {
    const gen = ++generation.current;
    setItems([]);
    setTotal(0);
    setError('');
    void request(0, gen);
    return () => {
      // Invalidate pending requests rather than a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
    // An inspector covers this route without changing its query. Keep its pages
    // and DOM scroll container alive when navigation focus returns to the list.
  }, [request, station, member]);
  const more = () => {
    if (!busy.current && items.length < total) void request(items.length, generation.current);
  };
  return { items, total, loading, error, more, refresh: () => request(0, ++generation.current) };
}
