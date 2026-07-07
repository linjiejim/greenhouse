/**
 * Skill Query tool — read side of the Skill Center: find skills, inspect
 * detail + version history, download a version's files, and check installed
 * skills for pending updates. Static (needs only the shared db); writes go
 * through skill_mutation.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from '../define.js';
import { checkUpdates, downloadSkill, getSkillDetail, toSkillSummary } from '../../skills/center.js';

const skillQuerySchema = z.object({
  action: z
    .enum(['skills.find', 'skills.get', 'skills.download', 'skills.check_updates'])
    .describe('Read action to perform.'),
  query: z.string().optional().describe('skills.find: keyword matched against name/description/tags. Empty = all.'),
  include_archived: z.boolean().optional().describe('skills.find: include archived skills (default false).'),
  limit: z.number().int().positive().max(50).optional().describe('skills.find: max results (default 20).'),
  name: z.string().optional().describe('skills.get / skills.download: the skill name.'),
  version: z.string().optional().describe('skills.download: exact version to fetch (default: latest). Format X.Y.Z.'),
  installed: z
    .array(z.object({ name: z.string(), version: z.string() }))
    .optional()
    .describe('skills.check_updates: the locally installed skills as {name, version} pairs.'),
});

type SkillQueryInput = z.infer<typeof skillQuerySchema>;

const meta: ToolMeta = {
  id: 'skill_query',
  name: 'Skill Query',
  brief: 'Find, inspect, download and sync-check shared agent skills from the enterprise Skill Center',
  description: `Read access to the enterprise Skill Center — the org's shared library of agent skills (a skill = a folder of instructions/files with SKILL.md at its root). Actions:
- skills.find: search the catalog by keyword (name/description/tags); returns summaries with the latest version and download count.
- skills.get: one skill's detail plus its FULL version history with changelogs — use this to review what changed between versions.
- skills.download: fetch a version's files (latest by default). The result carries every file as { path, content, encoding? } — to install, write each file under the client's skills directory (e.g. .claude/skills/<name>/<path>), preserving relative paths and decoding base64 entries. Archived skills stay downloadable for pinned installs.
- skills.check_updates: pass the locally installed skills as {name, version} pairs; returns per skill whether it is up_to_date / update_available (with the pending changelogs, oldest first) / archived / not_found. Use this to sync a local skill set, then skills.download the ones with updates.`,
  category: 'team',
  is_global: true,
  icon: 'Sparkles',
  group: 'skills',
  surface: { proxy: 'read', mcp: true },
};

export function createSkillQueryTool(db: DatabaseProvider) {
  return tool({
    description: meta.description,
    inputSchema: skillQuerySchema,
    execute: async (input: SkillQueryInput) => {
      try {
        if (input.action === 'skills.find') {
          const opts = {
            q: input.query?.trim() || undefined,
            status: input.include_archived ? undefined : ('active' as const),
            limit: input.limit ?? 20,
          };
          const [rows, total] = await Promise.all([db.skills.list(opts), db.skills.count(opts)]);
          return { action: input.action, total, skills: rows.map(toSkillSummary) };
        }

        if (input.action === 'skills.get') {
          if (!input.name) return { action: input.action, error: 'name is required' };
          const detail = await getSkillDetail(db, input.name);
          if (!detail) return { action: input.action, error: `Skill not found: "${input.name}"` };
          return { action: input.action, ...detail };
        }

        if (input.action === 'skills.download') {
          if (!input.name) return { action: input.action, error: 'name is required' };
          const result = await downloadSkill(db, input.name, input.version);
          if (!result.ok) return { action: input.action, error: result.error };
          return {
            action: input.action,
            skill: result.skill,
            version: result.version,
            files: result.files,
          };
        }

        // skills.check_updates
        if (!input.installed || input.installed.length === 0) {
          return {
            action: input.action,
            error: 'installed is required — pass the local skills as {name, version} pairs',
          };
        }
        const report = await checkUpdates(db, input.installed);
        return { action: input.action, skills: report };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const skillQueryTool = defineTool({
  meta,
  kind: 'static',
  create: (ctx) => createSkillQueryTool(ctx.db),
});
