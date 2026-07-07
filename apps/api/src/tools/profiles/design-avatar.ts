/**
 * Sprouty avatar designer tool — the agent-side path of the avatar DSL
 * ("Agent 启发式生成"): the agent composes an AvatarConfig (validated against
 * avatarConfigSchema) and applies it to a custom profile OWNED by the calling
 * user. The vocabulary (colors / accessories / leaf & face styles) comes from
 * the canonical catalogs in @greenhouse/types/profile-manifest.
 *
 * Actions:
 * - options: list the available option ids (so the agent can present choices)
 * - apply:   validate + write the avatar onto one of the user's own profiles
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import {
  avatarConfigSchema,
  SPROUTY_COLOR_IDS,
  SPROUTY_ACCESSORY_IDS,
  SPROUTY_LEAF_STYLE_IDS,
  SPROUTY_FACE_STYLE_IDS,
} from '@greenhouse/types/profile-manifest';
import { defineTool, type ToolMeta } from '../define.js';

export interface DesignAvatarContext {
  userId: string;
}

const designAvatarSchema = z.object({
  action: z.enum(['options', 'apply']).describe('options = list available choices; apply = write to a profile'),
  profile_slug: z
    .string()
    .optional()
    .describe('Slug of one of the CALLING USER\'s custom profiles (required for apply), e.g. "my-researcher"'),
  avatar: avatarConfigSchema
    .optional()
    .describe(
      'The avatar DSL (required for apply). Compose it from the option catalogs: ' +
        `color ∈ [${SPROUTY_COLOR_IDS.join(', ')}]; ` +
        `accessories ⊆ [${SPROUTY_ACCESSORY_IDS.join(', ')}] (max one hat, one glasses, one held item reads best); ` +
        `leafStyle ∈ [${SPROUTY_LEAF_STYLE_IDS.join(', ')}]; ` +
        `faceStyle ∈ [${SPROUTY_FACE_STYLE_IDS.join(', ')}]; ` +
        'palette = { body: "#rrggbb", leaf: "#rrggbb" } for free colors (wins over the color preset).',
    ),
});

type DesignAvatarInput = z.infer<typeof designAvatarSchema>;

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'design_sprouty_avatar',
  name: 'Sprouty Avatar Designer',
  brief: 'Design the Sprouty avatar of a custom agent profile',
  description: `Design a Sprouty mascot avatar for one of the user's custom agent profiles.
Use action "options" to see the available colors, accessories, leaf styles and face styles,
then action "apply" with profile_slug + avatar to save. Pick a look that matches the
profile's role and the user's wishes (e.g. a researcher: ocean color, round-glasses + magnifier).`,
  category: 'team',
  is_global: true,
  icon: 'Palette',
  group: 'interaction',
};

export function createDesignAvatarTool(db: DatabaseProvider, ctx: DesignAvatarContext) {
  return tool({
    description: meta.description,
    inputSchema: designAvatarSchema,
    execute: async (input: DesignAvatarInput) => {
      try {
        switch (input.action) {
          case 'options': {
            const profiles = await db.customProfiles.listForUser(ctx.userId);
            return {
              colors: SPROUTY_COLOR_IDS,
              accessories: SPROUTY_ACCESSORY_IDS,
              leaf_styles: SPROUTY_LEAF_STYLE_IDS,
              face_styles: SPROUTY_FACE_STYLE_IDS,
              palette: 'free body/leaf hex colors, e.g. { "body": "#5ec4d6", "leaf": "#3a8fa0" }',
              // Only the user's OWN profiles are editable.
              editable_profiles: profiles
                .filter((p) => p.user_id === ctx.userId)
                .map((p) => ({ slug: p.slug, name: p.name, current_avatar: p.data.avatar ?? null })),
            };
          }

          case 'apply': {
            if (!input.profile_slug) return { error: 'profile_slug is required for apply' };
            if (!input.avatar) return { error: 'avatar is required for apply' };
            const parsed = avatarConfigSchema.safeParse(input.avatar);
            if (!parsed.success) {
              return { error: `Invalid avatar: ${parsed.error.issues[0]?.message}` };
            }
            // getByUserSlug is scoped to the calling user — ownership enforced.
            const profile = await db.customProfiles.getByUserSlug(ctx.userId, input.profile_slug);
            if (!profile) {
              return {
                error: `No custom profile with slug "${input.profile_slug}" owned by you. Use action "options" to list yours.`,
              };
            }
            const updated = await db.customProfiles.update(profile.id, {
              data: { ...profile.data, avatar: parsed.data },
            });
            return {
              success: true,
              message: `Avatar applied to "${profile.name}". The new look shows up immediately in the profile picker.`,
              profile: { slug: profile.slug, name: profile.name },
              avatar: updated?.data.avatar ?? parsed.data,
            };
          }

          default:
            return { error: `Unknown action` };
        }
      } catch (err) {
        return { error: `Avatar design error: ${toErrorMessage(err)}` };
      }
    },
  });
}

export const designAvatarTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createDesignAvatarTool(ctx.db, { userId: ctx.userId }),
});
