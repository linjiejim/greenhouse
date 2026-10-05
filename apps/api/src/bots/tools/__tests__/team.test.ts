/**
 * The `team` tool's proposed-Bot avatar: a plant hashed from the proposed name
 * (never the built-in Sprouty's reserved sprout), carried on the bot_create card.
 */

import { describe, expect, it } from 'vitest';
import { IMPLICIT_POOL, PLANT_LEGACY_COLOR } from '@greenhouse/types';
import type { BotCreatePayload } from '@greenhouse/types/bots';
import type { TeamPort } from '../../engine/ports.js';
import { testTurn } from '../../__tests__/helpers/turn.js';
import { createTeamTool, proposedAvatar } from '../team.js';

const NAMES = ['Translator', '翻译', 'Scout', 'Writer', 'Researcher', 'Planner', 'Editor', '小研', 'Archivist'];

describe('proposed Bot avatar', () => {
  it('is the same plant for the same name, pinned across releases', () => {
    expect(proposedAvatar('Translator')).toEqual({ plant: 'clover', color: 'forest' });
    expect(proposedAvatar('Writer')).toEqual({ plant: 'maple', color: 'autumn' });
    expect(proposedAvatar('小研')).toEqual({ plant: 'eucalyptus', color: 'midnight' });
    for (const name of NAMES) expect(proposedAvatar(name)).toEqual(proposedAvatar(name));
  });

  it('draws from the implicit pool — more looks than the five templates, never sprout', () => {
    const plants = NAMES.map((name) => proposedAvatar(name).plant);
    expect(new Set(plants).size).toBeGreaterThan(5);
    for (const name of NAMES) {
      const avatar = proposedAvatar(name);
      expect(IMPLICIT_POOL).toContain(avatar.plant);
      expect(avatar.color).toBe(PLANT_LEGACY_COLOR[avatar.plant as keyof typeof PLANT_LEGACY_COLOR]);
      expect(avatar).not.toHaveProperty('accessories');
    }
  });

  it('rides on the bot_create card the create action raises', async () => {
    const ctx = testTurn();
    const port: TeamPort = {
      kind: 'direct',
      allowBotChat: true,
      members: () => [{ bot: ctx.bot, role: 'owner' }],
      others: () => [],
      checkAsk: () => null,
      acceptAsk: async () => undefined,
      addMember: async () => ({ ok: true }),
    };
    const team = createTeamTool(ctx, port) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{ status?: string }>;
    };
    const result = await team.execute(
      { action: 'create', name: 'Writer', role: 'Writer', instructions: 'Write clearly.' },
      {},
    );
    expect(result.status).toBe('proposed');
    expect(ctx.createRequest).toHaveBeenCalledTimes(1);
    const [kind, payload] = ctx.createRequest.mock.calls[0] as [string, BotCreatePayload];
    expect(kind).toBe('bot_create');
    expect(payload.avatar).toEqual(proposedAvatar('Writer'));
    expect(payload.template_key).toBeNull();
  });
});
