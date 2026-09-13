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
import { mcpGroupDescriptionKey, mcpGroupLabelKey } from '../mcp-groups';

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
  // "mcpGroups.crm.label".
  it.each(MCP_RESOURCE_GROUP_IDS.map((id) => [id] as const))('mcp group %s is labelled in both locales', (id) => {
    for (const key of [mcpGroupLabelKey(id), mcpGroupDescriptionKey(id)]) {
      expect(english.get(key), `missing en: ${key}`).toBeTruthy();
      expect(chinese.get(key), `missing zh: ${key}`).toBeTruthy();
    }
  });
});
