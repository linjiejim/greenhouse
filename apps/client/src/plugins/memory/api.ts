/** Memory plugin reads and writes (`/api/auth/me/memories`, plugins/memory/api/routes.ts); there is no create. */
import { del, get, patch, seg } from '../../api/client';
import type { Memory, MemoryDraft, MemoryStatus } from './model';

export const listMemories = () => get<{ memories: Memory[] }>('/api/auth/me/memories');
export const updateMemory = (id: string, body: Partial<MemoryDraft> & { status?: MemoryStatus }) =>
  patch<Memory | null>(`/api/auth/me/memories/${seg(id)}`, body);
export const deleteMemory = (id: string) => del(`/api/auth/me/memories/${seg(id)}`);
