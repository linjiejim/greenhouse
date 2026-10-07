/**
 * Memory receipts — a visible, undoable line under every Bot turn that wrote
 * a memory. Silent memory writes are how an assistant stops being
 * trustworthy; the receipt names the scope (all Bots / only this one) so the
 * member always knows who will read it.
 */

import { useState, useSyncExternalStore } from 'react';
import { Brain } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { toast } from '../ui';
import * as botsApi from '../../lib/api/bots';
import { InlineAction } from './transcript-rows';

export interface MemoryReceipt {
  memoryId: number;
  title: string;
  scope: 'user' | 'bot';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `memory.remember` results in a turn's tool calls. */
export function memoryReceiptsFromCalls(calls: ReadonlyArray<{ name: string; output?: unknown }>): MemoryReceipt[] {
  return calls.flatMap((call) => {
    if (call.name !== 'memory') return [];
    const output = asRecord(call.output);
    const remembered = asRecord(output?.remembered);
    if (!output || output.action !== 'remember' || !remembered || typeof remembered.id !== 'number') return [];
    return [
      {
        memoryId: remembered.id,
        title: typeof remembered.title === 'string' ? remembered.title : '',
        scope: output.scope === 'bot' ? 'bot' : 'user',
      },
    ];
  });
}

// ─── Undone memories (shared by every receipt in this tab) ──
//
// A receipt is rendered by more than one component over its life — the live
// segment's, then the persisted message's when the run settles, and again on
// every remount — so "undone" cannot live in one instance. Module scope keeps
// it for the tab; the server's `memory_states` (when the conversation page
// carries it) covers a full reload.

const undoneMemories = new Set<number>();
const undoListeners = new Set<() => void>();
let undoneVersion = 0;

function markUndone(memoryId: number): void {
  if (undoneMemories.has(memoryId)) return;
  undoneMemories.add(memoryId);
  undoneVersion += 1;
  undoListeners.forEach((listener) => listener());
}

function subscribeUndone(listener: () => void): () => void {
  undoListeners.add(listener);
  return () => undoListeners.delete(listener);
}

/** Re-render on any undo; read membership from `undoneMemories`. */
function useUndoneVersion(): number {
  return useSyncExternalStore(
    subscribeUndone,
    () => undoneVersion,
    () => undoneVersion,
  );
}

/** Test hook: forget every undo recorded in this tab. */
export function resetUndoneMemoriesForTest(): void {
  undoneMemories.clear();
  undoneVersion += 1;
}

/** Statuses (from the API's `memory_states`) under which a memory still stands. */
const STANDING = new Set(['active', 'dormant']);

export function MemoryReceipts({
  receipts,
  botId,
  botName,
  memoryStates,
}: {
  receipts: MemoryReceipt[];
  botId: string | null;
  botName: string;
  /** Current status of each memory id, when the server sent it — anything not standing reads as undone. */
  memoryStates?: Readonly<Record<string, string>>;
}) {
  const t = useT();
  useUndoneVersion();
  const [busy, setBusy] = useState<number | null>(null);
  if (receipts.length === 0) return null;

  const undo = async (receipt: MemoryReceipt) => {
    setBusy(receipt.memoryId);
    try {
      if (receipt.scope === 'bot' && botId) await botsApi.deleteBotMemory(botId, receipt.memoryId);
      else await botsApi.archiveUserMemory(receipt.memoryId);
      markUndone(receipt.memoryId);
    } catch (err) {
      // Already gone (undone in another tab, or forgotten from the profile):
      // the member's intent holds — show it undone, no error.
      if (botsApi.isBotsApiError(err) && err.status === 404) markUndone(receipt.memoryId);
      else toast(t('bots.memory.undoFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="bots-memory-receipts">
      {receipts.map((receipt) => {
        const state = memoryStates?.[String(receipt.memoryId)];
        const isUndone = undoneMemories.has(receipt.memoryId) || (state !== undefined && !STANDING.has(state));
        const scopeLabel =
          receipt.scope === 'bot' ? t('bots.memory.rememberedBot', { name: botName }) : t('bots.memory.rememberedAll');
        return (
          <span
            key={receipt.memoryId}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-surface-sunken py-0.5 pl-2 pr-1 text-[11px] ${
              isUndone ? 'text-fg-faint line-through' : 'text-fg-muted'
            }`}
            title={receipt.title}
          >
            <Brain size={11} className="flex-shrink-0 text-primary-fg" aria-hidden="true" />
            <span className="flex-shrink-0 font-medium">{isUndone ? t('bots.memory.undone') : scopeLabel}</span>
            {receipt.title && <span className="min-w-0 truncate">· {receipt.title}</span>}
            {!isUndone && (
              <InlineAction disabled={busy === receipt.memoryId} onClick={() => void undo(receipt)}>
                {t('bots.memory.undo')}
              </InlineAction>
            )}
          </span>
        );
      })}
    </div>
  );
}
