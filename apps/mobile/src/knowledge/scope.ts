/**
 * Where a doc lives, from the viewer's point of view — the same three buckets
 * as the list's scope filter (semantics: apps/api/src/knowledge/access.ts):
 * team docs (everyone collaborates), my personal docs, and personal docs
 * someone shared with me. Each bucket has one SF Symbol and one system tint so
 * the list, the detail meta line and the peek all read the same.
 */

import type { ColorValue } from 'react-native';
import type { KnowledgeDoc } from '../api/knowledge';
import type { TranslationKey } from '../lib/i18n';
import type { ThemeColors } from '../theme';
import type { IconName } from '../ui/core';

export type DocScope = 'team' | 'private' | 'shared';

export function docScope(doc: KnowledgeDoc): DocScope {
  if (doc.visibility === 'team') return 'team';
  return doc.access === 'owner' ? 'private' : 'shared';
}

/**
 * The doc's legacy one-level category (`meta.space`). Superseded by the web's
 * folder tree — the server still defaults it to the literal 'general', which
 * carries no information, so only a real legacy value is shown.
 */
export function docCategory(doc: KnowledgeDoc): string | undefined {
  return doc.space && doc.space !== 'general' ? doc.space : undefined;
}

export const SCOPE_ICON: Record<DocScope, IconName> = { team: 'book', private: 'lock', shared: 'users' };

export const SCOPE_LABEL: Record<DocScope, TranslationKey> = {
  team: 'knowledge.scopeTeam',
  private: 'knowledge.scopeMine',
  shared: 'knowledge.scopeShared',
};

/** Glyph color + tinted tile fill per scope (system colors, so they adapt to dark mode). */
export function scopeTint(scope: DocScope, c: ThemeColors): { fg: ColorValue; bg: ColorValue } {
  switch (scope) {
    case 'team':
      return { fg: c.accent, bg: c.accentFill };
    case 'private':
      return { fg: c.orange, bg: c.orangeFill };
    case 'shared':
      return { fg: c.blue, bg: c.blueFill };
  }
}
