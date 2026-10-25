/**
 * Per-member preferences stored in `users.preferences` (jsonb) and served by
 * `GET / PATCH /api/me/preferences`. They follow the account, not the device.
 *
 * - `fontScale`: the mobile app's in-app text size, multiplied onto the system
 *   size (最小 / 更小 / 小 / 标准 / 大 / 特大 / 超大).
 * - `workbench`: the Home workbench layout (versioned blob owned by
 *   `apps/api/src/platform/workbench-preferences.ts`); never written through the
 *   generic PATCH.
 */

import { z } from 'zod';

export const FONT_SCALES = [0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.35] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/** What a member may PATCH. Unknown keys are rejected. */
export const memberPreferencesPatchSchema = z
  .object({
    fontScale: z.union(
      FONT_SCALES.map((value) => z.literal(value)) as [z.ZodLiteral<0.8>, ...z.ZodLiteral<FontScale>[]],
    ),
  })
  .partial()
  .strict();
export type MemberPreferencesPatch = z.infer<typeof memberPreferencesPatchSchema>;

/** The whole stored blob. */
export interface UserPreferences {
  fontScale?: FontScale;
  workbench?: unknown;
}

/** The member-editable view returned by the API (the workbench layout has its own endpoint). */
export interface MemberPreferences {
  fontScale: FontScale;
}

export const DEFAULT_MEMBER_PREFERENCES: MemberPreferences = { fontScale: 1 };

export function memberPreferencesOf(stored: UserPreferences | null | undefined): MemberPreferences {
  const scale = stored?.fontScale;
  return {
    fontScale: (FONT_SCALES as readonly number[]).includes(scale as number)
      ? (scale as FontScale)
      : DEFAULT_MEMBER_PREFERENCES.fontScale,
  };
}
