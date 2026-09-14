/**
 * Small write-once registries that core render paths read (tool cards, tool
 * icons). They live apart from `extensions/index.ts` so that `lib/icons.ts`
 * and `components/tool-call/*` can consult them without importing the
 * extension list — which imports them back (a module cycle).
 */
import type { ComponentType } from 'react';
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

export function _resetExtensionRegistries(): void {
  toolCards.clear();
  toolIcons.clear();
}
