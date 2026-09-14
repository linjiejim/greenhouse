/** Tests for consolidated Agent Profiles. */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  loadProfile as loadProfileFromDisk,
  registerKnownTools as registerTools,
  clearProfileCache as clearCache,
  validateProfile,
} from '../../apps/api/src/profiles/profile.js';

const PROFILES_DIR = resolve(import.meta.dirname, '../../apps/api/src/profiles');
const KNOWN_TOOLS = [
  'eval_message',
  'manage_eval_dataset',
  'analyze_image',
  'query_eval_runs',
  'external_search',
  'feature_request',
  'generate_image',
  'ask_user',
  'compute',
  'knowledge_query',
  'project_query',
  'project_mutation',
  'session_query',
  'workflow_plan',
];

/**
 * Resolve a profile through the real loader so `extends` is applied — the raw
 * YAML of an extending profile is deliberately partial, and asserting on it
 * would test the file rather than the profile the runtime actually sees.
 */
function loadProfile(id: string) {
  const filePath = resolve(PROFILES_DIR, `${id}.yaml`);
  if (!existsSync(filePath)) return null;
  registerTools(KNOWN_TOOLS);
  clearCache();
  return loadProfileFromDisk(id) as unknown as Record<string, any>;
}

/** Raw YAML, for assertions about the file itself (e.g. `extends` wiring). */
function readProfileYaml(id: string) {
  return parseYaml(readFileSync(resolve(PROFILES_DIR, `${id}.yaml`), 'utf-8'));
}

describe('All profiles: structural validation', () => {
  const profileFiles = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  it('has exactly 3 internal system profiles', () => {
    // One agent + two hidden runtimes. quick/deep/K3/workflows collapsed on
    // 2026-08-01 — they differed only by model, which is now a per-turn choice.
    expect(profileFiles.length).toBe(3);
    expect(profileFiles.map((f) => f.replace(/\.ya?ml$/, '')).sort()).toEqual(['desktop', 'eval-judge', 'sprouty']);
  });

  for (const file of profileFiles) {
    const id = file.replace(/\.ya?ml$/, '');
    describe(`Profile: ${id}`, () => {
      const profile = loadProfile(id);
      if (!profile) return;

      it('has required fields', () => {
        expect(profile.id).toBe(id);
        expect(profile.name).toBeDefined();
        expect(profile.system_prompt).toBeDefined();
        expect(profile.model?.id).toBeDefined();
        expect(['flash', 'pro', 'kimi-k3']).toContain(profile.model.id);
      });

      it('has valid tools', () => {
        expect(Array.isArray(profile.tools)).toBe(true);
        for (const tool of profile.tools) expect(KNOWN_TOOLS).toContain(tool);
      });

      it('has valid access config and version', () => {
        expect(['internal', 'hidden']).toContain(profile.access.level);
        expect(typeof profile.access.rich_output).toBe('boolean');
        expect(Object.keys(profile.access).sort()).toEqual(['level', 'rich_output']);
        expect(profile.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  }
});

describe('Profile identities', () => {
  it('has no public default profile', () => {
    expect(loadProfile('default')).toBeNull();
  });

  it('only Sprouty is pickable — judges and runtimes are not', () => {
    // `hidden` keeps a profile out of the picker while leaving it resolvable by
    // id server-side (the eval flow and scheduled tasks still target it).
    expect(loadProfile('eval-judge')!.hidden).toBe(true);
    expect(loadProfile('eval-judge')!.access.level).toBe('internal');
    expect(loadProfile('desktop')!.hidden).toBe(true);
  });

  it('Sprouty is selectable, internal and rich-output', () => {
    const profile = loadProfile('sprouty')!;
    expect(profile.name).toBe('Sprouty');
    expect(profile.access.level).toBe('internal');
    expect(profile.access.rich_output).toBe(true);
    expect(profile.hidden).toBeFalsy();
    expect(profile.tools).toContain('knowledge_query');
    // Sampling/reasoning belongs to the model catalog now, not the agent.
    expect(profile.model.id).toBe('flash');
    expect(profile.model.options).toBeUndefined();
  });

  it('keeps the desktop id only as a headless integration compatibility profile', () => {
    const profile = loadProfile('desktop')!;
    expect(profile.name).toBe('Agent Runtime');
    expect(profile.hidden).toBe(true);
    expect(profile.desktop).toBeUndefined();
    expect(profile.access.level).toBe('hidden');
    expect(profile.access.rich_output).toBe(false);
    expect(profile.tools).toEqual([]);
    expect(profile.system_prompt).toMatch(/Never assume access to a local filesystem, shell/);
  });
});

describe('Profile module loading and legacy compatibility', () => {
  it('loadAllProfiles returns 3 internal system profiles', async () => {
    const { loadAllProfiles, clearProfileCache, registerKnownTools } = await import('../../apps/api/src/profiles/profile.js');
    registerKnownTools(KNOWN_TOOLS);
    clearProfileCache();
    expect(
      loadAllProfiles()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['desktop', 'eval-judge', 'sprouty']);
  });

  it('maps stored legacy profile IDs onto the presets that replaced them', async () => {
    const { resolveProfile, clearProfileCache } = await import('../../apps/api/src/profiles/profile.js');
    clearProfileCache();
    // Sessions/eval runs/scheduled tasks still store these; they must keep working.
    for (const legacy of [
      'team',
      'default',
      'researcher',
      'cc-analyzer',
      // Retired 2026-08-01 — every conversation ever opened under these still
      // has to resolve, or its history becomes unopenable.
      'sprouty-quick',
      'sprouty-deep',
      'sprouty-k3',
      'sprouty-workflows',
      'sprouty-mission',
      'workflow-planner',
      'sprouty-agents',
    ]) {
      expect(resolveProfile(legacy).id, legacy).toBe('sprouty');
    }
    expect(resolveProfile('local-dev').id).toBe('desktop');
    expect(resolveProfile('local-pi').id).toBe('desktop');
  });

  it("the catalog owns each model's options — the agent declares none", async () => {
    const { parseModelCatalog } = await import('../../apps/api/src/config/models.js');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const saved = { LLM_MODEL: process.env.LLM_MODEL, LLM_MODEL_PRO: process.env.LLM_MODEL_PRO };
    process.env.LLM_MODEL = 'fast-model';
    process.env.LLM_MODEL_PRO = 'stronger-model';
    try {
      const catalog = parseModelCatalog(
        readFileSync(resolve(import.meta.dirname, '../../apps/api/src/config/models.yaml'), 'utf-8'),
      );
      // What used to be "deep is quick on a stronger model" is now literally one
      // catalog entry: same agent, different engine, no second profile.
      expect(catalog.models.pro!.providers[0]!.model).toBe('stronger-model');
      expect(catalog.models.pro!.options?.temperature).toBeDefined();
      expect(catalog.chat.selectable).toContain('pro');
      expect(catalog.chat.selectable).toContain('flash');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('never sends Kimi a sampling parameter, whatever the previous model set', async () => {
    const { resolveModelConfig, setModelRegistry, DEFAULT_MODEL_REGISTRY } = await import('@greenhouse/agent-core');
    setModelRegistry({
      ...DEFAULT_MODEL_REGISTRY,
      'kimi-k3': {
        name: 'Kimi K3',
        options: { reasoning_effort: 'high', max_tokens: 20000 },
        providers: [{ provider: 'kimi', model: 'k3', apiKeyEnv: 'KIMI_API_KEY' }],
      },
    });
    try {
      // Switching a turn to K3 carries the previous config forward; Kimi pins
      // sampling server-side and hard-400s anything else, so it must be dropped.
      const resolved = resolveModelConfig({
        id: 'kimi-k3',
        provider: 'kimi',
        model: 'k3',
        options: { temperature: 0.4, top_p: 0.9, thinking: true },
      });
      expect(resolved.options?.temperature).toBeUndefined();
      expect(resolved.options?.top_p).toBeUndefined();
      expect(resolved.options?.reasoning_effort).toBe('high');
      expect(resolved.options?.max_tokens).toBe(20000);
    } finally {
      setModelRegistry(DEFAULT_MODEL_REGISTRY);
    }
  });

  it('rejects an unusable reasoning_effort at load, not on every message', () => {
    const base = { id: 'fixture', name: 'Fixture', tools: [], system_prompt: 'fixture' };
    const withEffort = (reasoning_effort: unknown) =>
      validateProfile({ ...base, model: { id: 'kimi-k3', options: { reasoning_effort } } }, 'fixture');

    expect(() => withEffort('medium')).toThrow(/reasoning_effort/); // Kimi takes low|high|max only
    for (const effort of ['low', 'high', 'max']) {
      expect(withEffort(effort).model.options?.reasoning_effort, effort).toBe(effort);
    }
  });

  it('a model with no key configured is never offered in the picker', async () => {
    const { listChatModels } = await import('../../apps/api/src/config/models.js');
    const { setModelRegistry, DEFAULT_MODEL_REGISTRY } = await import('@greenhouse/agent-core');
    const saved = { KIMI_API_KEY: process.env.KIMI_API_KEY };
    setModelRegistry({
      ...DEFAULT_MODEL_REGISTRY,
      'kimi-k3': { name: 'Kimi K3', providers: [{ provider: 'kimi', model: 'k3', apiKeyEnv: 'KIMI_API_KEY' }] },
    });
    try {
      // The check that used to hide a whole preset now hides just the engine:
      // no KIMI_API_KEY → K3 is simply not in the dropdown.
      delete process.env.KIMI_API_KEY;
      expect(listChatModels().map((m) => m.id)).not.toContain('kimi-k3');
      process.env.KIMI_API_KEY = 'sk-test';
      expect(listChatModels().map((m) => m.id)).toContain('kimi-k3');
    } finally {
      if (saved.KIMI_API_KEY === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = saved.KIMI_API_KEY;
      setModelRegistry(DEFAULT_MODEL_REGISTRY);
    }
  });

  it('reports the provider the catalog will actually run, not a hard-coded default', async () => {
    const { loadProfile, clearProfileCache, registerKnownTools } = await import('../../apps/api/src/profiles/profile.js');
    registerKnownTools(KNOWN_TOOLS);
    clearProfileCache();
    // The profile declares only `model.id`; the provider comes from the catalog.
    expect(loadProfile('sprouty').model.provider).toBe('openai-compatible');
  });

  it('no profile inherits from another — the mechanism went with the presets', () => {
    // `extends` existed only to say "same agent, another model". That is a
    // dropdown now, so a YAML reaching for it is a sign the collapse is being
    // undone one file at a time.
    for (const id of ['sprouty', 'eval-judge', 'desktop']) {
      expect(readProfileYaml(id).extends, id).toBeUndefined();
    }
  });

  it('validates custom base profile IDs', async () => {
    const { isValidCustomBaseProfileId } = await import('../../apps/api/src/profiles/profile.js');
    expect(isValidCustomBaseProfileId('sprouty')).toBe(true);
    // Retired preset ids are not fork bases (stored rows normalize first).
    expect(isValidCustomBaseProfileId('sprouty-quick')).toBe(false);
    expect(isValidCustomBaseProfileId('sprouty-workflows')).toBe(false);
    // Hidden/system and removed ids are never fork bases.
    expect(isValidCustomBaseProfileId('default')).toBe(false);
    expect(isValidCustomBaseProfileId('team')).toBe(false);
    expect(isValidCustomBaseProfileId('desktop')).toBe(false);
    expect(isValidCustomBaseProfileId('eval-judge')).toBe(false);
  });

  it('resolveProfileAsync handles custom malformed IDs', async () => {
    const { resolveProfileAsync } = await import('../../apps/api/src/profiles/profile.js');
    await expect(resolveProfileAsync('custom:abc')).rejects.toThrow(/Invalid custom profile ID/);
  });
});

describe('Rich output guide', () => {
  it('is one shared copy — every rich-output profile gets it, no YAML restates it', async () => {
    const { enrichSystemPrompt } = await import('../../apps/api/src/profiles/profile.js');
    const { RICH_OUTPUT_GUIDE } = await import('@greenhouse/utils/prompts');

    for (const id of ['sprouty', 'eval-judge']) {
      const profile = loadProfile(id)!;
      expect(enrichSystemPrompt(profile as any), id).toContain(RICH_OUTPUT_GUIDE);
      // A second copy in the YAML would drift from this one.
      expect(profile.system_prompt, id).not.toContain('```datatable');
    }

    const desktop = loadProfile('desktop')!;
    expect(desktop.access.rich_output).toBe(false);
    expect(enrichSystemPrompt(desktop as any)).toBe(desktop.system_prompt);
  });

  it('forbids opening a datatable before the rows are known', async () => {
    // dev session c0b6bf83 wrote title + 7 columns, changed its mind, then
    // answered with a markdown table — leaving a rowless block above the real
    // answer. The renderer degrades that to an empty table (it used to crash the
    // whole message); this rule is what stops it being authored at all.
    const { RICH_OUTPUT_GUIDE } = await import('@greenhouse/utils/prompts');
    expect(RICH_OUTPUT_GUIDE).toMatch(/数据没齐就不要开 fence/);
    expect(RICH_OUTPUT_GUIDE).toMatch(/开了就必须一次写完/);
    expect(RICH_OUTPUT_GUIDE).toMatch(/整块重写/);
  });
});

describe('Task-specific LLM configs', () => {
  it('batch eval judge is a task profile, not a YAML Agent Profile', async () => {
    expect(existsSync(resolve(PROFILES_DIR, 'batch-eval-judge.yaml'))).toBe(false);
    const { BATCH_EVAL_JUDGE_PROFILE } = await import('../../apps/api/src/llm/tasks/batch-eval-judge.js');
    expect(BATCH_EVAL_JUDGE_PROFILE.id).toBe('task:batch-eval-judge');
    expect(BATCH_EVAL_JUDGE_PROFILE.tools).toEqual([]);
    expect(BATCH_EVAL_JUDGE_PROFILE.tool_choice).toBe('none');
  });
});
