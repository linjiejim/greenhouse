/**
 * A member's memories (`/api/auth/me/memories`): how the list groups them, what an edit sends and
 * the limits the station enforces (plugins/memory/api/llm/memory-limits.ts). Members edit, pin,
 * archive and delete; only the assistant's `memory` tool creates them. React-free.
 */

export const MEMORY_CATEGORIES = ['preference', 'fact', 'behavior'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryStatus = 'active' | 'dormant' | 'archived' | 'superseded';

/** One row of `GET /api/auth/me/memories` (the table's columns). */
export interface Memory {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  status: MemoryStatus;
  pinned: boolean;
  source: 'user' | 'agent' | 'consolidation';
  superseded_by: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export const MEMORY_TITLE_MAX = 80;
export const MEMORY_CONTENT_MAX = 2000;

/**
 * `inUse`: in every conversation's index (pinned first); `resting`: unused for 90 days, still
 * found when asked; `archived`: kept out of the index by the member or replaced by a merge.
 */
export type MemoryGroup = 'inUse' | 'resting' | 'archived';
export const MEMORY_GROUPS: readonly MemoryGroup[] = ['inUse', 'resting', 'archived'];

export function memoryGroup(memory: Memory): MemoryGroup {
  if (memory.status === 'active') return 'inUse';
  if (memory.status === 'dormant') return 'resting';
  return 'archived';
}

const touched = (m: Memory) => m.last_used_at ?? m.updated_at ?? m.created_at ?? '';

/** Non-empty groups in order; pinned first, then most recently used or changed. */
export function memorySections(memories: readonly Memory[]): { group: MemoryGroup; items: Memory[] }[] {
  return MEMORY_GROUPS.map((group) => ({
    group,
    items: memories
      .filter((m) => memoryGroup(m) === group)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || touched(b).localeCompare(touched(a))),
  })).filter((section) => section.items.length > 0);
}

export interface MemoryDraft {
  title: string;
  content: string;
  category: MemoryCategory;
  pinned: boolean;
}

export const draftOf = (memory: Memory): MemoryDraft => ({
  title: memory.title,
  content: memory.content,
  category: memory.category,
  pinned: memory.pinned,
});

/** The first field a save would be refused for; the station also refuses secrets and contact details. */
export function draftProblem(draft: MemoryDraft): 'title' | 'titleLong' | 'content' | 'contentLong' | null {
  if (!draft.title.trim()) return 'title';
  if (draft.title.trim().length > MEMORY_TITLE_MAX) return 'titleLong';
  if (!draft.content.trim()) return 'content';
  if (draft.content.trim().length > MEMORY_CONTENT_MAX) return 'contentLong';
  return null;
}

/** `PATCH /api/auth/me/memories/:id` with only what changed; empty when nothing did. */
export function patchBody(memory: Memory, draft: MemoryDraft): Partial<MemoryDraft> {
  const body: Partial<MemoryDraft> = {};
  if (draft.title.trim() !== memory.title) body.title = draft.title.trim();
  if (draft.content.trim() !== memory.content) body.content = draft.content.trim();
  if (draft.category !== memory.category) body.category = draft.category;
  if (draft.pinned !== memory.pinned) body.pinned = draft.pinned;
  return body;
}

/** Archive takes a memory out of the index; restoring puts any kept-out memory back in use. */
export const archiveStatus = (memory: Memory): MemoryStatus => (memory.status === 'active' ? 'archived' : 'active');
