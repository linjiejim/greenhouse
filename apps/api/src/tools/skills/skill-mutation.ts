/**
 * Skill Mutation tool — write side of the Skill Center: publish a new skill or
 * push a new version (changelog mandatory), edit catalog metadata, archive /
 * unarchive, and (super only) permanently delete. Reachable over the cloud
 * proxy mutating allowlist (confirm:true per call) and MCP.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from '../define.js';
import { deleteSkill, publishSkill, setSkillStatus, updateSkillMeta } from '../../skills/center.js';

const skillMutationSchema = z.object({
  action: z
    .enum(['skills.publish', 'skills.update_meta', 'skills.archive', 'skills.unarchive', 'skills.delete'])
    .describe('Write action to perform.'),
  name: z.string().describe('Skill name — kebab-case, immutable, e.g. "pdf-report".'),
  display_name: z.string().optional().describe('Human-friendly title shown in the catalog.'),
  description: z
    .string()
    .optional()
    .describe('Catalog description. On first publish it falls back to SKILL.md frontmatter description.'),
  tags: z.array(z.string()).optional().describe('Catalog tags for discovery.'),
  version: z
    .string()
    .optional()
    .describe(
      'skills.publish: strict X.Y.Z, must be greater than the current latest. Omitted → 0.1.0 for a new skill, patch-bump for an update.',
    ),
  changelog: z
    .string()
    .optional()
    .describe('skills.publish: what changed in this version — REQUIRED when updating an existing skill.'),
  files: z
    .array(
      z.object({
        path: z.string().describe('Relative path inside the skill folder, e.g. "SKILL.md" or "scripts/run.py".'),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).optional().describe('base64 for small binary assets (default utf8).'),
      }),
    )
    .optional()
    .describe('skills.publish: the complete file set for this version (must include SKILL.md at the root).'),
});

type SkillMutationInput = z.infer<typeof skillMutationSchema>;

export interface SkillMutationContext {
  userId: string;
  userRole: string;
}

const meta: ToolMeta = {
  id: 'skill_mutation',
  name: 'Skill Mutation',
  brief: 'Publish, version, and manage shared agent skills in the enterprise Skill Center with confirmation',
  description: `Write access to the enterprise Skill Center. Actions:
- skills.publish: share a skill with the org, or push a new version of one you own. Send the COMPLETE file set as { path, content, encoding? } entries including SKILL.md at the root (read the local skill folder first). Versions are strict semver and immutable: a new skill starts at 0.1.0 (or the version you pass), an update must be greater than the current latest (omit version to patch-bump). A changelog describing what changed is REQUIRED for updates — every version is recorded in browsable history. Limits: ≤ 64 files, ≤ 1 MiB total; base64-encode small binary assets.
- skills.update_meta: edit display_name / description / tags of a skill you own.
- skills.archive / skills.unarchive: hide a skill from discovery (existing installs keep working and can still download pinned versions).
- skills.delete: PERMANENTLY remove a skill and all its versions — super admins only.
Publishing/managing is limited to the skill's owner (or a super admin). Every call requires explicit user confirmation via the cloud proxy (confirm:true). Before publishing an update, use skill_query skills.get to review the current latest version.`,
  category: 'team',
  is_global: true,
  icon: 'UploadCloud',
  group: 'skills',
  surface: { proxy: 'write', mcp: true },
};

export function createSkillMutationTool(db: DatabaseProvider, ctx: SkillMutationContext) {
  const actor = { userId: ctx.userId, role: ctx.userRole };
  return tool({
    description: meta.description,
    inputSchema: skillMutationSchema,
    execute: async (input: SkillMutationInput) => {
      try {
        if (input.action === 'skills.publish') {
          if (!input.files?.length) return { action: input.action, error: 'files is required (include SKILL.md)' };
          const result = await publishSkill(db, actor, {
            name: input.name,
            display_name: input.display_name,
            description: input.description,
            tags: input.tags,
            version: input.version,
            changelog: input.changelog,
            files: input.files,
          });
          if (!result.ok) return { action: input.action, error: result.error };
          return {
            action: input.action,
            status: result.created ? 'created' : 'version_published',
            skill: result.skill,
            version: result.version,
          };
        }

        if (input.action === 'skills.update_meta') {
          const result = await updateSkillMeta(db, actor, input.name, {
            display_name: input.display_name,
            description: input.description,
            tags: input.tags,
          });
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, status: 'updated', skill: result.skill };
        }

        if (input.action === 'skills.archive' || input.action === 'skills.unarchive') {
          const status = input.action === 'skills.archive' ? 'archived' : 'active';
          const result = await setSkillStatus(db, actor, input.name, status);
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, status, skill: result.skill };
        }

        // skills.delete — center re-checks the super role (defense in depth).
        const result = await deleteSkill(db, actor, input.name);
        if (!result.ok) return { action: input.action, error: result.error };
        return { action: input.action, status: 'deleted', name: input.name, deleted_versions: result.deleted_versions };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const skillMutationTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createSkillMutationTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole }),
});
