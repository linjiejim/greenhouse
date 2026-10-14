/**
 * Files going into the knowledge base (KNOW-14): each one uploads on its own with its status, a
 * failed one can be tried again, and the lists refresh as they land.
 */

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KnowledgeFile, KnowledgeSpace } from '@greenhouse/contract';
import { refreshTree } from '../../data/knowledge';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useT } from '../../lib/i18n';

/** The API takes files up to 50 MB (MAX_UPLOAD_BYTES). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface UploadTarget {
  folder_id?: string;
  space?: KnowledgeSpace;
}

export interface Upload {
  key: string;
  file: File;
  target: UploadTarget;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
  result?: KnowledgeFile;
}

export function useUploads() {
  const client = useQueryClient();
  const t = useT();
  const [items, setItems] = useState<Upload[]>([]);
  const counter = useRef(0);

  const patch = (key: string, changes: Partial<Upload>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...changes } : item)));

  const run = useCallback(
    async (upload: Upload): Promise<KnowledgeFile | null> => {
      if (upload.file.size > MAX_FILE_BYTES) {
        patch(upload.key, { status: 'failed', error: t('errors.tooLarge') });
        return null;
      }
      try {
        const result = await api.knowledge.files.upload(upload.file, upload.target);
        patch(upload.key, { status: 'done', result, error: undefined });
        void refreshTree(client);
        return result;
      } catch (error) {
        patch(upload.key, { status: 'failed', error: errorText(error, t) });
        return null;
      }
    },
    [client, t],
  );

  /** Uploads every file at once; resolves with those that made it. */
  const start = useCallback(
    async (files: readonly File[], target: UploadTarget): Promise<KnowledgeFile[]> => {
      const added = files.map(
        (file): Upload => ({ key: `upload-${(counter.current += 1)}`, file, target, status: 'uploading' }),
      );
      setItems((list) => [...list.filter((item) => item.status !== 'done'), ...added]);
      const results = await Promise.all(added.map(run));
      return results.filter((result): result is KnowledgeFile => !!result);
    },
    [run],
  );

  const retry = (key: string) => {
    const upload = items.find((item) => item.key === key);
    if (!upload) return;
    patch(key, { status: 'uploading', error: undefined });
    void run(upload);
  };

  const dismiss = (key: string) => setItems((list) => list.filter((item) => item.key !== key));

  return {
    items,
    start,
    retry,
    dismiss,
    busy: items.some((item) => item.status === 'uploading'),
  };
}
