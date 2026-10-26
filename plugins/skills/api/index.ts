import manifest from '../manifest.js';
import {
  defineExtension,
  extensionPath,
  requireInternal,
  logger,
  listSavedPrompts,
  getSavedPrompt,
} from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import routes from './routes.js';
import { skillQueryTool } from './tools/skill-query.js';
import { skillMutationTool } from './tools/skill-mutation.js';
import { getSkillStore } from './skills/store.js';
import { seedSkillhub } from './skills/boot-seed.js';
import { sweepUnscannedSkills } from './skills/center.js';
import { getSkillPrompt, listSkillPrompts } from './prompts.js';

export default defineExtension({
  ...manifest,
  services: createServices,
  resetTables: ['skill_versions', 'skills'],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  tools: [skillQueryTool, skillMutationTool],
  routes: [{ path: '/api/skills', app: routes, guards: [requireInternal()] }],
  rateLimits: [{ path: '/api/skills/publish', windowMs: 60000, max: 10, internalMax: 20 }],
  mcpGroups: ['skills'],
  hubContext: [
    {
      group: 'skills',
      description: 'SkillHub: team agent skills and versions',
      toolIds: ['skill_query', 'skill_mutation'],
      overviewHint:
        'For reusable output skills, use skill_query skills.find, then skills.download to install them locally.',
    },
  ],
  agentContext: {
    toolIds: ['skill_query'],
    legacyPromptPrefixes: ['skill-', 'prompt-'],
    promptFragment: () =>
      'The team publishes reusable agent skills in SkillHub. When a task needs an established workflow, use skill_query skills.find to find it and skills.download to read its instructions before proceeding.',
    prompts: [
      {
        get: (name, args, ctx) => getSkillPrompt(ctx.db, ctx, name, args),
        list: async (ctx) =>
          (await listSkillPrompts(ctx.db, ctx)).map((prompt) => ({
            ...prompt,
            name: prompt.name.slice('skill-'.length),
            legacyName: prompt.name,
            render: (args, caller) => getSkillPrompt(caller.db, caller, prompt.name, args),
          })),
      },
      {
        get: (name, args, ctx) => getSavedPrompt(ctx.db, ctx, name, args),
        list: async (ctx) =>
          (await listSavedPrompts(ctx.db, ctx)).map((prompt) => ({
            ...prompt,
            legacyName: prompt.name,
            render: (args, caller) => getSavedPrompt(caller.db, caller, prompt.name, args),
          })),
      },
    ],
  },
  activity: [
    {
      actionEntities: { skills: 'skill' },
      toolModules: { skill_mutation: 'skills' },
      toolWrites: { skill_mutation: { entity: 'skill', title: { result: 'skill', field: 'display_name' } } },
    },
  ],
  onBoot: async ({ db }) => {
    const store = getSkillStore();
    logger.info(`[skills] bundle store: ${store.backend}`);
    await seedSkillhub(db);
    void sweepUnscannedSkills(db).catch((error) => logger.warn('[skills] scan sweep failed', { error: String(error) }));
  },
});
