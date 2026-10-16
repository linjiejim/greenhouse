import { useQueries } from '@tanstack/react-query';
import type { FileView } from '@greenhouse/contract';
import { api } from '../lib/api';

/**
 * Files by id, each with its short-lived URL (`file.url` works in an <img> or a download link
 * without a header). URLs last at least an hour, so they are refreshed well before that.
 */
export function useFiles(ids: readonly string[]): { files: FileView[]; loading: boolean } {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['files', id],
      queryFn: () => api.files.get(id),
      staleTime: 30 * 60_000,
      refetchInterval: 45 * 60_000,
      retry: false,
    })),
  });
  return {
    files: results.flatMap((result) => (result.data ? [result.data] : [])),
    loading: results.some((result) => result.isPending),
  };
}

/** Images show inline; anything else is a download (web pages and SVG always are). */
export const isImage = (file: Pick<FileView, 'content_type'>) =>
  /^image\/(png|jpe?g|gif|webp)$/i.test(file.content_type);

export function formatSize(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}
