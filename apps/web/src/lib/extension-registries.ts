/**
 * Small write-once registries that core render paths read (tool cards, tool
 * icons). They live apart from `extensions/index.ts` so that `lib/icons.ts`
 * and `components/tool-call/*` can consult them without importing the
 * extension list — which imports them back (a module cycle).
 */
import type { ComponentType, ReactNode } from 'react';
import type { EntityRef } from '@greenhouse/types/entity-links';
import type { LucideIcon } from './icons';

export interface RegisteredToolCard {
  component: ComponentType<{ call: { name: string; input?: unknown; output?: unknown; status?: 'calling' | 'done' } }>;
  placement: 'inline' | 'below';
}

const toolCards = new Map<string, RegisteredToolCard>();
const toolIcons = new Map<string, LucideIcon>();

export function registerToolCard(tool: string, card: RegisteredToolCard): void {
  toolCards.set(tool, card);
}

export function registeredToolCard(tool: string): RegisteredToolCard | undefined {
  return toolCards.get(tool);
}

export function registerToolIcons(icons: Record<string, LucideIcon>): void {
  for (const [tool, icon] of Object.entries(icons)) toolIcons.set(tool, icon);
}

export function registeredToolIcon(tool: string): LucideIcon | undefined {
  return toolIcons.get(tool);
}

// ─── Record kinds owned by extensions ────────────────────

export interface RegisteredEntityKind {
  /** `ext:<extension id>:<name>` — the same kind the API registered a route for. */
  kind: string;
  icon: LucideIcon;
  /** Header copy while the record has no title of its own. */
  fallbackTitleKey: string;
  /** Peek / side-pane body, or omitted when the record has no inline view. */
  render?: (ref: EntityRef) => ReactNode;
}

const entityKinds = new Map<string, RegisteredEntityKind>();

export function registerEntityKindUi(defs: readonly RegisteredEntityKind[]): void {
  for (const def of defs) entityKinds.set(def.kind, def);
}

export function registeredEntityKind(kind: string): RegisteredEntityKind | undefined {
  return entityKinds.get(kind);
}

// ─── MCP consent groups owned by extensions ──────────────

export interface RegisteredMcpGroup {
  id: string;
  labelKey: string;
  descriptionKey: string;
  /** The extension that owns it — the group only shows while that one is active. */
  extensionId: string;
}

const mcpGroups: RegisteredMcpGroup[] = [];

export function registerMcpGroupUi(defs: readonly RegisteredMcpGroup[]): void {
  for (const def of defs) if (!mcpGroups.some((g) => g.id === def.id)) mcpGroups.push(def);
}

export function registeredMcpGroups(): readonly RegisteredMcpGroup[] {
  return mcpGroups;
}

// ─── Panels added to a knowledge document ────────────────

export interface RegisteredKnowledgeDocPanel {
  id: string;
  extensionId: string;
  component: ComponentType<{ docId: number }>;
}

const knowledgeDocPanels: RegisteredKnowledgeDocPanel[] = [];

export function registerKnowledgeDocPanels(defs: readonly RegisteredKnowledgeDocPanel[]): void {
  for (const def of defs) if (!knowledgeDocPanels.some((p) => p.id === def.id)) knowledgeDocPanels.push(def);
}

export function registeredKnowledgeDocPanels(): readonly RegisteredKnowledgeDocPanel[] {
  return knowledgeDocPanels;
}

export function _resetExtensionRegistries(): void {
  toolCards.clear();
  toolIcons.clear();
  entityKinds.clear();
  mcpGroups.length = 0;
  knowledgeDocPanels.length = 0;
}
