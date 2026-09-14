/**
 * Feature flag ↔ feature point parity.
 *
 * A flag with no feature point is a flag nobody can grant. `buildUserAccessView`
 * iterates FEATURE_POINTS and the unified permissions modal renders only what it
 * returns, so a flag missing from that list has no toggle anywhere in the product
 * — the only way to turn it on becomes a hand-written INSERT.
 *
 * The email feature shipped that way for two days: `requireFeature('email')` on
 * the routes, no `FEATURE_POINTS` entry, so every team user was locked out with
 * no admin path to change it (super was unaffected by role bypass, which is why
 * it survived manual testing). It was resolved by dropping the flag entirely —
 * these tests exist so the next flag has to make that choice deliberately.
 */

import { describe, it, expect } from 'vitest';
// `allFeatureFlags()`, not the core constant: an extension registers its own
// flags at load, and its feature point must be checked against those too.
import { allFeatureFlags } from '@greenhouse/types/features';
import { FEATURE_POINTS, FEATURE_OWNED_TOOL_IDS, toolsetToolIds } from '../feature-points.js';
import { TOOL_DEFINITIONS, getAllToolIds } from '../../tools/registry.js';

describe('feature flag ↔ feature point parity', () => {
  it('gives every feature flag a feature point, so super has a toggle for it', () => {
    const pointFlags = new Set(FEATURE_POINTS.filter((p) => p.flag).map((p) => p.flag));
    const ungrantable = allFeatureFlags()
      .map((f) => f.key)
      .filter((key) => !pointFlags.has(key));

    expect(
      ungrantable,
      `Feature flag(s) ${ungrantable.join(', ')} have no FEATURE_POINTS entry. ` +
        'The unified permissions modal renders feature points only, so there is no way ' +
        'to grant them. Either add a point, or drop the flag and gate the feature another way.',
    ).toEqual([]);
  });

  it('points every feature point at a flag that still exists', () => {
    const flagKeys = new Set<string>(allFeatureFlags().map((f) => f.key));
    const dangling = FEATURE_POINTS.filter((p) => p.flag && !flagKeys.has(p.flag)).map((p) => p.key);

    expect(dangling, `Feature point(s) ${dangling.join(', ')} reference a deleted flag.`).toEqual([]);
  });
});

describe('feature-owned tools stay out of the assignable bucket', () => {
  it('never offers a feature-owned tool as an individually assignable one', () => {
    const leaked = toolsetToolIds().filter((id) => FEATURE_OWNED_TOOL_IDS.has(id));

    expect(
      leaked,
      `Tool(s) ${leaked.join(', ')} are owned by a feature point but also appear in the ` +
        '"Advanced tools" bucket. A direct assignment there bypasses the feature flag.',
    ).toEqual([]);
  });

  it('keeps every tool reachable through exactly one grant path', () => {
    // A non-global tool is grantable either by riding a feature point or by direct
    // assignment. One that does neither is unreachable for team users: it would be
    // registered, described to the model, and never assembled for anyone but super.
    const assignable = new Set(toolsetToolIds());
    const orphaned = TOOL_DEFINITIONS.filter(
      (m) => !m.is_global && !FEATURE_OWNED_TOOL_IDS.has(m.id) && !assignable.has(m.id),
    ).map((m) => m.id);

    expect(orphaned, `Tool(s) ${orphaned.join(', ')} cannot be granted to a team user by any path.`).toEqual([]);
  });
});

describe('flag-owned tool sets', () => {
  it('references only tools that exist in the catalog', () => {
    const known = new Set(getAllToolIds());
    const ghosts = FEATURE_POINTS.flatMap((p) => p.toolIds.filter((id) => !known.has(id)));

    expect(ghosts, `FEATURE_POINTS reference unknown tool(s): ${ghosts.join(', ')}.`).toEqual([]);
  });

  it('pins the exact membership of every flag-owned set', () => {
    // Membership changes must be conscious: a tool that rides a flag but is
    // missing from its FEATURE_POINTS entry falls into the individually
    // assignable "Advanced tools" bucket, where a direct assignment bypasses
    // the flag (how tables_schema_plan once shipped assignable).
    const byKey = Object.fromEntries(FEATURE_POINTS.map((p) => [p.key, [...p.toolIds]]));

    expect(byKey.tables).toEqual(['tables_query', 'tables_mutation', 'tables_schema_plan']);
    expect(byKey['cloud-agent']).toEqual(['mission_dispatch']);
    expect(byKey.memory).toEqual(['memory']);
    expect(byKey.knowledge).toEqual(['knowledge_query', 'knowledge_mutation']);
    expect(byKey.projects).toEqual(['project_query', 'project_mutation']);
  });
});
