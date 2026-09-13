/**
 * Knowledge document peek.
 *
 * The other kinds hand the peek an existing detail screen; knowledge is the one
 * that needs an adapter. `KnowledgeDetail` renders only the body — its title,
 * tags and Edit/Archive/History actions are supplied by the knowledge page's own
 * top bar — and it takes a loaded doc rather than an id. So this fetches by id
 * (authoritative, survives slug renames) and supplies the small amount of
 * heading a glance needs.
 *
 * Editing, history and sharing stay out of the peek on purpose: those are the
 * full editor, and a reader who wants them has "open full page" one click away.
 */

import React, { useEffect, useState } from 'react';
import type { KnowledgeDoc } from '@greenhouse/types/api';
import { getKnowledgeDocById } from '../../lib/api/knowledge';
import { KnowledgeDetail } from '../knowledge/knowledge-detail';
import { Spinner, TagList } from '../ui';
import { safeParse, formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';

export function KnowledgeDocPeek({ id }: { id: number }) {
  const t = useT();
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setDoc(null);
    setFailed(false);
    getKnowledgeDocById(id)
      .then((loaded) => {
        if (active) setDoc(loaded);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (failed) {
    return <div className="p-6 text-sm text-fg-muted">{t('entityPeek.notFound')}</div>;
  }
  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-fg-faint" />
      </div>
    );
  }

  const tags = safeParse<string[]>(doc.tags, []);
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-shrink-0 border-b border-edge px-4 md:px-6 py-3">
        <h1 className="text-lg font-bold text-fg">{doc.title}</h1>
        <div className="mt-1 flex items-center gap-2 text-xs text-fg-faint">
          <span>{doc.updated_at ? formatDate(doc.updated_at) : ''}</span>
          {tags.length > 0 && <TagList items={tags} max={3} />}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <KnowledgeDetail doc={doc} />
      </div>
    </div>
  );
}
