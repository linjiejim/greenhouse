/**
 * Count one open of a module that has no page of its own (the chat-sidebar
 * session tags and groups) each time `active` turns true — a dialog opening, a
 * picker mounting. Fire-and-forget, see `reportPageOpen`.
 */

import { useEffect } from 'react';
import type { CorePageModuleId } from '@greenhouse/types/usage';
import { reportPageOpen } from '../api/usage';

export function useModuleOpen(module: CorePageModuleId, active = true): void {
  useEffect(() => {
    if (active) reportPageOpen(module);
  }, [active, module]);
}
