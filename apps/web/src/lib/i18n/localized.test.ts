/**
 * pickLocalized — resolves server-authored copy (system profile names,
 * descriptions, capability cards) to the active locale.
 */

import { describe, expect, it } from 'vitest';
import en from './en';
import zh from './zh';
import { pickLocalized, translate } from './index';
import { EMAIL_PRESETS } from '@greenhouse/types/email';
import { MCP_RESOURCE_GROUP_IDS } from '@greenhouse/types/mcp';
import { AUTOMATION_OPT_IN_TOOLS } from '@greenhouse/types/automation-tools';
import { mcpGroupDescriptionKey, mcpGroupLabelKey } from '../mcp-groups';
import { RECIPE_LABELS } from '../workbench/recipes';

function flatten(value: Record<string, unknown>, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'string') entries.set(path, item);
    else if (item && typeof item === 'object') {
      for (const [childKey, childValue] of flatten(item as Record<string, unknown>, path)) {
        entries.set(childKey, childValue);
      }
    }
  }
  return entries;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('locale catalogs', () => {
  const english = flatten(en);
  const chinese = flatten(zh);

  it('keeps the same keys in every locale', () => {
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('keeps interpolation placeholders aligned', () => {
    for (const [key, englishValue] of english) {
      expect(placeholders(chinese.get(key) ?? ''), key).toEqual(placeholders(englishValue));
    }
  });

  it('does not contain empty translations', () => {
    for (const [key, value] of [...english, ...chinese]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('translates imperative non-React copy', () => {
    expect(translate('en', 'runtimeConfig.pendingCount', { count: 3 })).toBe('3 pending');
    expect(translate('zh', 'runtimeConfig.pendingCount', { count: 3 })).toBe('3 项待保存');
    expect(translate('zh', 'common.save')).toBe('保存');
  });
});

describe('pickLocalized', () => {
  const map = { zh: '深度联网调研', en: 'Deep web research' };

  it('returns the requested locale when present', () => {
    expect(pickLocalized(map, 'flat', 'en')).toBe('Deep web research');
    expect(pickLocalized(map, 'flat', 'zh')).toBe('深度联网调研');
  });

  it('falls back to the source locale when the translation is missing', () => {
    expect(pickLocalized({ zh: '只有中文' }, 'flat', 'en')).toBe('只有中文');
  });

  it('falls back to the flat field when there is no map at all', () => {
    // User-authored custom profiles never carry a locale map.
    expect(pickLocalized(undefined, '我的调研助手', 'en')).toBe('我的调研助手');
    expect(pickLocalized(null, '我的调研助手', 'zh')).toBe('我的调研助手');
  });

  it('treats an empty locale entry as missing', () => {
    expect(pickLocalized({ en: '', zh: '中文' }, 'flat', 'en')).toBe('中文');
  });

  it('returns the flat field when the map is empty', () => {
    expect(pickLocalized({}, 'flat', 'en')).toBe('flat');
  });
});

/**
 * Data-driven i18n keys — keys that live in a data table rather than in a `t()`
 * call site, so the TranslationKey union cannot check them.
 *
 * The email preset table carries a `help_key` per provider. Renaming the
 * namespace once shipped the raw key string to the screen ("emailAccounts.help.feishu"
 * where the setup steps should be): the call site casts to TranslationKey, so
 * neither the compiler nor the parity test above noticed. This is that guard.
 */
describe('data-driven translation keys resolve', () => {
  const english = flatten(en);
  const chinese = flatten(zh as unknown as Record<string, unknown>);

  it.each(EMAIL_PRESETS.map((preset) => [preset.id, preset.help_key] as const))(
    'email preset %s has setup steps in both locales',
    (_id, key) => {
      expect(english.get(key), `missing en: ${key}`).toBeTruthy();
      expect(chinese.get(key), `missing zh: ${key}`).toBeTruthy();
    },
  );

  // MCP resource groups: the OAuth consent screen renders one checkbox per
  // group, so a missing key here is a user authorizing a capability labelled
  // "mcpGroups.knowledge.label".
  it.each(MCP_RESOURCE_GROUP_IDS.map((id) => [id] as const))('mcp group %s is labelled in both locales', (id) => {
    for (const key of [mcpGroupLabelKey(id), mcpGroupDescriptionKey(id)]) {
      expect(english.get(key), `missing en: ${key}`).toBeTruthy();
      expect(chinese.get(key), `missing zh: ${key}`).toBeTruthy();
    }
  });

  /**
   * …and the other direction. A label with no group behind it is worse than a
   * missing one: the group registry is the consent screen's single source of
   * truth, so the checkbox never renders and nobody ever sees the copy — it just
   * sits there claiming the product can read a data domain it cannot. Both
   * halves of this pair exist because a whole module was deleted and its
   * `mcpGroups.crm` label outlived it.
   */
  it('has no mcpGroups label without a registered resource group', () => {
    const labelled = new Set(
      [...english.keys()].filter((key) => key.startsWith('mcpGroups.')).map((key) => key.split('.')[1]),
    );
    const known = new Set<string>(MCP_RESOURCE_GROUP_IDS);
    for (const id of labelled) {
      expect(known.has(id), `mcpGroups.${id}.* is labelled but ${id} is not in MCP_RESOURCE_GROUP_IDS`).toBe(true);
    }
  });

  /**
   * Workbench card recipes. The catalog lives in @greenhouse/types/workbench and
   * the copy in `home.recipe.*`, joined by `RECIPE_LABELS`. An unclaimed key is a
   * card recipe the picker cannot offer — the nine `home.recipe.crm*` keys
   * survived their module exactly this way.
   *
   * Only CORE recipes go through that table: an extension's recipe ships its own
   * `ext.<id>.*` keys, which are not in `en.ts` at all, so this stays exact.
   */
  it('has no home.recipe key that no recipe claims', () => {
    const claimed = new Set(
      Object.values(RECIPE_LABELS).flatMap((labels) => [labels.labelKey as string, labels.descriptionKey as string]),
    );
    for (const key of english.keys()) {
      if (!key.startsWith('home.recipe.')) continue;
      expect(claimed.has(key), `${key} is not referenced by RECIPE_LABELS in lib/workbench/recipes.ts`).toBe(true);
    }
  });

  /**
   * Automation opt-in tool labels. `toolLabel()` (pages/automations.tsx) builds
   * `automations.tool_<id>` from the catalog id, so a label whose id left the
   * catalog is a checkbox nobody can ever tick — `tool_crm_mutation` was one.
   */
  it('has no automations.tool_ label outside the opt-in catalog', () => {
    const catalog = new Set(AUTOMATION_OPT_IN_TOOLS.map((tool) => tool.id));
    for (const key of english.keys()) {
      const id = key.startsWith('automations.tool_') ? key.slice('automations.tool_'.length) : null;
      if (!id) continue;
      expect(catalog.has(id), `${key} has no matching id in AUTOMATION_OPT_IN_TOOLS`).toBe(true);
    }
  });
});
