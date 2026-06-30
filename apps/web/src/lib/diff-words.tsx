/**
 * Word-level diff rendering helper.
 *
 * Renders the word-level diff segments produced by `computeWordDiff`/`computeLineDiffWithWords`
 * (see ./wiki-diff): unchanged text plain, changed text highlighted. Used by the
 * agent update-page-card and the knowledge-base version diff view.
 */

import React from 'react';
import type { WordSegment } from './wiki-diff';

/** Render word-level diff segments: unchanged text plain, changed text highlighted */
export function renderDiffWords(words: WordSegment[], type: 'add' | 'remove') {
  return words.map((w, i) =>
    w.changed ? (
      <span
        key={i}
        className={`${type === 'add' ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'} rounded-sm`}
      >
        {w.text}
      </span>
    ) : (
      <span key={i}>{w.text}</span>
    ),
  );
}
