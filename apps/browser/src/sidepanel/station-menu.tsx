/**
 * Station menu — the header status dot doubles as a switcher between saved
 * stations. Picking one flips the registry's active id; the panel remounts
 * ChatView via the station key. Signed-out stations are still listed (the
 * gate screen asks for sign-in after the switch).
 */

import React, { useEffect, useRef, useState } from 'react';
import { StatusDot } from '@greenhouse/ui/components/ui';
import { Check, ChevronDown, Server, Settings } from '@greenhouse/ui/lib/icons';
import { useT } from '@greenhouse/ui/lib/i18n';
import { setActiveStation } from '../lib/storage';
import { useStations } from '../lib/use-auth';

export function StationMenu() {
  const t = useT();
  const { state } = useStations();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = state.stations.find((s) => s.id === state.activeId) ?? null;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        className="flex items-center gap-0.5 rounded p-1 hover:bg-surface-muted"
        title={active ? `${active.name} · ${active.baseUrl}` : t('panel.stationMenu')}
        onClick={() => setOpen((v) => !v)}
      >
        <StatusDot color="success" size="sm" />
        <ChevronDown size={12} className="text-fg-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-edge bg-surface p-1 text-sm shadow-lg">
          <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
            {t('panel.stationMenu')}
          </p>
          {state.stations.map((s) => (
            <button
              key={s.id}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-muted"
              onClick={() => {
                setOpen(false);
                void setActiveStation(s.id);
              }}
            >
              <Server size={15} className="mt-0.5 shrink-0 text-fg-secondary" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 font-medium text-fg">
                  <span className="truncate">{s.name}</span>
                  {s.id === state.activeId && <Check size={13} className="shrink-0 text-primary-600" />}
                </span>
                <span className="block truncate text-[11px] text-fg-faint">
                  {s.auth ? s.auth.user.nickname : t('panel.stationSignedOut')}
                </span>
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-edge" />
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-fg-secondary hover:bg-surface-muted"
            onClick={() => {
              setOpen(false);
              chrome.runtime.openOptionsPage();
            }}
          >
            <Settings size={15} className="shrink-0" />
            {t('panel.manageStations')}
          </button>
        </div>
      )}
    </div>
  );
}
