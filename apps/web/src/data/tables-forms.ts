/**
 * 表格 forms data (TBL-11). A table's forms, who may submit and the submissions are its
 * builders' and live under the base's key, so `base.updated` (and refreshBase) refetch them.
 * A form to fill in is loaded once: refetching while someone types could take it away mid-way;
 * submitting says whether it closed.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Form } from '@greenhouse/contract';
import { api } from '../lib/api';
import { queryClient } from './query';
import { tablesKeys } from './tables';

export const formsKeys = {
  list: (baseId: string, tableId: string) => [...tablesKeys.base(baseId), 'forms', tableId] as const,
  shares: (baseId: string, formId: string) => [...tablesKeys.base(baseId), 'form-shares', formId] as const,
  submissions: (baseId: string, formId: string) => [...tablesKeys.base(baseId), 'form-submissions', formId] as const,
  fill: (formId: string) => ['forms', 'fill', formId] as const,
};

export function useForms(baseId: string, tableId: string) {
  return useQuery({ queryKey: formsKeys.list(baseId, tableId), queryFn: () => api.tables.forms.list(tableId) });
}

export function useFormShares(baseId: string, formId: string) {
  return useQuery({ queryKey: formsKeys.shares(baseId, formId), queryFn: () => api.tables.forms.shares(formId) });
}

export function useSubmissions(baseId: string, formId: string) {
  return useInfiniteQuery({
    queryKey: formsKeys.submissions(baseId, formId),
    queryFn: ({ pageParam }) => api.tables.forms.submissions(formId, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 0,
  });
}

export function useFormFill(formId: string) {
  return useQuery({
    queryKey: formsKeys.fill(formId),
    queryFn: () => api.tables.forms.fill(formId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Puts a form the server returned into its table's list. */
export function putForm(baseId: string, form: Form) {
  queryClient.setQueryData<{ items: Form[] }>(formsKeys.list(baseId, form.table_id), (data) =>
    data
      ? {
          items: data.items.some((item) => item.id === form.id)
            ? data.items.map((item) => (item.id === form.id ? form : item))
            : [...data.items, form],
        }
      : data,
  );
}

export function dropForm(baseId: string, form: Pick<Form, 'id' | 'table_id'>) {
  queryClient.setQueryData<{ items: Form[] }>(formsKeys.list(baseId, form.table_id), (data) =>
    data ? { items: data.items.filter((item) => item.id !== form.id) } : data,
  );
}
