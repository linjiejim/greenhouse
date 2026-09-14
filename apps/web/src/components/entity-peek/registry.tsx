/**
 * What each kind of record looks like in a peek.
 *
 * The detail screens themselves are reused verbatim — a peek is a different
 * frame around the same component, not a second implementation of the same
 * screen. Everything is lazy so opening a project link never pulls the knowledge
 * editor into the bundle, and vice versa.
 *
 * Deliberately keyed by `EntityKind` alone, with no assumption that the caller
 * is a Markdown link: a global search palette resolves to the same `{kind, id}`
 * and should route through this table unchanged.
 */

import React, { lazy } from 'react';
import type { CoreEntityKind, EntityKind, EntityRef } from '@greenhouse/types/entity-links';
import { FileText, FolderKanban, HelpCircle, Table2, type LucideIcon } from '../../lib/icons';
import type { TranslationKey } from '../../lib/i18n';
import { registeredEntityKind } from '../../lib/extension-registries';

const ProjectDetailPage = lazy(() =>
  import('../../pages/project-detail').then((m) => ({ default: m.ProjectDetailPage })),
);
const KnowledgeDocPeek = lazy(() => import('./knowledge-doc-peek').then((m) => ({ default: m.KnowledgeDocPeek })));

/** Header chrome for every core kind, including the ones with no peek body yet. */
export const ENTITY_PEEK_META: Record<CoreEntityKind, { icon: LucideIcon; fallbackTitleKey: TranslationKey }> = {
  project: { icon: FolderKanban, fallbackTitleKey: 'entityPeek.project' },
  kb_doc: { icon: FileText, fallbackTitleKey: 'entityPeek.doc' },
  tables_record: { icon: Table2, fallbackTitleKey: 'entityPeek.record' },
};

/**
 * Chrome for any kind — core from the table above, extension kinds from the
 * registry their web half fills. Falls back to a neutral icon so an unknown
 * kind renders a plain peek instead of crashing the host.
 */
export function entityPeekMeta(kind: EntityKind): { icon: LucideIcon; fallbackTitleKey: TranslationKey } {
  const core = (ENTITY_PEEK_META as Record<string, { icon: LucideIcon; fallbackTitleKey: TranslationKey }>)[kind];
  if (core) return core;
  const registered = registeredEntityKind(kind);
  return registered
    ? { icon: registered.icon, fallbackTitleKey: registered.fallbackTitleKey as TranslationKey }
    : { icon: HelpCircle, fallbackTitleKey: 'entityPeek.record' };
}

/**
 * The peek body for a record, or null when this kind has no peek yet — the host
 * then offers "open full page" instead of showing an empty panel. Tables records
 * are the one such kind today (their deeplink lands in a later phase).
 */
export function renderEntityPeekBody(ref: EntityRef): React.ReactNode | null {
  switch (ref.kind) {
    case 'project':
      return <ProjectDetailPage projectId={ref.id} />;
    case 'kb_doc':
      return <KnowledgeDocPeek id={ref.id} />;
    case 'tables_record':
      return null;
    default:
      return registeredEntityKind(ref.kind)?.render?.(ref) ?? null;
  }
}
