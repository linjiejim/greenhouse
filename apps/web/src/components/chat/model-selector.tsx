/**
 * ModelSelector — the engine picker beside the composer.
 *
 * Model stopped being part of an agent's identity: quick / deep / K3 were one
 * assistant on three engines, so the engine moved here and the three presets
 * collapsed into one (spec: 20260731-attachment-and-preset-convergence M3).
 *
 * Ids are shown verbatim (`flash`, `pro`, `deepseek-flash`) with the catalog's
 * display name as the tooltip — the ids ARE the vocabulary the team uses, and
 * the list is short enough that inventing labels would only add a translation
 * surface.
 *
 * The list is already filtered server-side to models with a reachable provider,
 * so a deployment without DEEPSEEK_API_KEY never offers `deepseek-flash`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from '../../lib/icons';
import type { ChatModel } from '../../lib/api/profiles';

export function ModelSelector({
  models,
  selectedModelId,
  onSelect,
  disabled,
  lockedReason,
}: {
  models: ChatModel[];
  selectedModelId: string | null;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  /**
   * Name of the Agent that pinned this model. Present means the control is
   * showing a decision already made, not an unavailable one — so it says who
   * made it rather than just greying out.
   */
  lockedReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // One model (or none) is not a choice — don't render a control for it.
  if (models.length < 2) return null;
  const current = models.find((m) => m.id === selectedModelId) ?? models[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={lockedReason ? `${current.name} · ${lockedReason}` : current.name}
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary disabled:opacity-40"
      >
        <span className="max-w-[7rem] truncate font-mono">{current.id}</span>
        {!lockedReason && <ChevronDown size={12} className="flex-shrink-0" />}
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full right-0 z-20 mb-1 min-w-[13rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-edge bg-surface-raised py-1 shadow-lg"
        >
          {models.map((model) => (
            <button
              key={model.id}
              role="option"
              aria-selected={model.id === current.id}
              onClick={() => {
                onSelect(model.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-muted"
            >
              <Check
                size={12}
                className={`flex-shrink-0 ${model.id === current.id ? 'text-primary-fg' : 'invisible'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-fg">{model.id}</span>
                <span className="block truncate text-[10px] text-fg-faint">{model.name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
