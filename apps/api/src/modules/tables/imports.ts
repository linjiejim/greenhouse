/**
 * CSV import (TBL-10): upload, map columns to fields, run through jobs with progress, the result.
 * Being written: see the phase 2 brief.
 */

import type { TablesKit } from './kit.js';

export function createImports(kit: TablesKit) {
  void kit;
  return {};
}

export type ImportsPart = ReturnType<typeof createImports>;
