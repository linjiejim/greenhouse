/**
 * `defineProfile` — author a first-party system profile in TS with the manifest
 * schema enforcing its shape (mirrors `defineTool` in tools/define.ts).
 *
 * The long system prompt lives in a co-located `*.prompt.md` file (verbatim,
 * no escaping) loaded via `readPrompt`; the structured config stays type-safe
 * in TS.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { systemProfileSchema, type SystemProfile } from '@greenhouse/types/profile-manifest';

/** Validate + freeze a system profile definition. Throws on an invalid shape. */
export function defineProfile(input: z.input<typeof systemProfileSchema>): SystemProfile {
  return systemProfileSchema.parse(input);
}

/** Read a co-located prompt markdown file as a string. */
export function readPrompt(dirname: string, file: string): string {
  return readFileSync(join(dirname, file), 'utf-8').trimEnd();
}
