/**
 * The fixed greeting is one or two sentences — hello, role, pitch — and never
 * promises what the deployment cannot do: a computer-bound template on an org
 * without a ready Bot computer opens with what it can do here, not "on your
 * computer".
 */

import { describe, expect, it } from 'vitest';
import { BOT_TEMPLATES, SPROUTY_BOT_TEMPLATE } from '@greenhouse/types/bots';
import { buildGreeting, type GreetingFacts } from '../greeting.js';

function facts(locale: 'en' | 'zh', computerReady: boolean): GreetingFacts {
  return { locale, computerReady };
}

describe('buildGreeting', () => {
  it('is hello + role + pitch, nothing else', () => {
    const sprouty = { name: 'Sprouty', role: '主助手', template_key: 'sprouty' };
    expect(buildGreeting(sprouty, facts('zh', false))).toBe(
      `你好，我是 **Sprouty**，你的主助手。${SPROUTY_BOT_TEMPLATE.copy.zh.pitch}`,
    );
    const en = buildGreeting({ name: 'Sprouty', role: 'Main assistant', template_key: 'sprouty' }, facts('en', true));
    expect(en).toBe(`Hi, I'm **Sprouty**, your main assistant. ${SPROUTY_BOT_TEMPLATE.copy.en.pitch}`);
    // No capability list, memory line, no-computer note or closing question: the
    // client shows the starters right under the greeting.
    expect(en).not.toContain('\n');
  });

  it('drops the role clause when the role is empty', () => {
    expect(buildGreeting({ name: 'Sage', role: '  ', template_key: 'writer' }, facts('zh', true))).toMatch(
      /^你好，我是 \*\*Sage\*\*。用你的口吻/,
    );
    expect(buildGreeting({ name: 'Sage', role: '', template_key: null }, facts('en', true))).toBe("Hi, I'm **Sage**.");
  });

  for (const key of ['researcher', 'operator', 'analyst']) {
    it(`${key}: no computer → no "on your computer" promise`, () => {
      const bot = { name: 'Sage', role: 'Researcher', template_key: key };
      expect(buildGreeting(bot, facts('en', false))).not.toMatch(/on your computer/);
      expect(buildGreeting(bot, facts('zh', false))).not.toContain('在你的电脑上');
    });
  }

  it('keeps the full pitch where the computer is ready', () => {
    const text = buildGreeting({ name: 'Sage', role: 'Researcher', template_key: 'researcher' }, facts('en', true));
    expect(text).toContain('Searches the web on your computer');
  });

  it('a template that needs no computer keeps its pitch either way', () => {
    const text = buildGreeting({ name: 'Fern', role: 'Writer', template_key: 'writer' }, facts('en', false));
    expect(text).toContain('Drafts and polishes documents');
    const free = BOT_TEMPLATES.filter((template) => !template.needsComputer);
    expect(free.map((template) => template.key)).toEqual(['writer', 'reporter', 'notetaker', 'tracker']);
    for (const template of free) {
      for (const locale of ['en', 'zh'] as const) {
        const { name, role, pitch } = template.copy[locale];
        const bot = { name, role, template_key: template.key };
        expect(buildGreeting(bot, facts(locale, false)), `${template.key}/${locale}`).toBe(
          buildGreeting(bot, facts(locale, true)),
        );
        expect(buildGreeting(bot, facts(locale, false))).toContain(pitch);
      }
    }
  });

  it('keeps every template pitch short', () => {
    for (const template of [SPROUTY_BOT_TEMPLATE, ...BOT_TEMPLATES]) {
      for (const pitch of [template.copy.zh.pitch, template.copy.zh.pitchNoComputer]) {
        if (pitch) expect([...pitch].length, pitch).toBeLessThanOrEqual(30);
      }
      for (const pitch of [template.copy.en.pitch, template.copy.en.pitchNoComputer]) {
        if (pitch) expect(pitch.length, pitch).toBeLessThanOrEqual(90);
      }
    }
  });
});
