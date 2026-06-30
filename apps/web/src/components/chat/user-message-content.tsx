/**
 * User message content renderer with annotation support.
 * Extracted from message.tsx.
 */

import React, { useMemo } from 'react';
import { Markdown } from '../markdown';
import { parseAnnotatedContent } from './annotations';

export function UserMessageContent({ content }: { content: string }) {
  const parsed = useMemo(() => parseAnnotatedContent(content), [content]);

  if (!parsed) {
    return <Markdown content={content} />;
  }

  return (
    <>
      <div className="space-y-1.5 mb-2">
        {parsed.annotations.map((ann) => (
          <div key={ann.index} className="border-l-2 border-primary-300 pl-2.5 py-1">
            <p className="text-xs text-fg-secondary leading-relaxed whitespace-pre-wrap">{ann.quote}</p>
            {ann.note && <p className="text-xs text-fg font-medium mt-0.5">→ {ann.note}</p>}
          </div>
        ))}
      </div>
      {parsed.message && (
        <>
          <div className="border-t border-primary-edge/40 my-2" />
          <Markdown content={parsed.message} />
        </>
      )}
    </>
  );
}
