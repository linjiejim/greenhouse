import { afterEach, expect, it } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { defineApp } from '@greenhouse/platform-kernel';
import { allFeatureFlags, registerFeatureFlags, _resetExtensionFeatureFlags } from '@greenhouse/types/features';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../runtime.js';
import { defineExtension } from '../define.js';
import { stationManifest } from '../station-manifest.js';
import { fixture } from './data-source-fixture.js';

const originalFlags = allFeatureFlags();

afterEach(() => {
  resetPlatformRuntimeForTests();
  _resetProvider();
  _resetExtensionFeatureFlags();
  registerFeatureFlags(originalFlags);
});

it('filters entities, pages and nav by each data source flag within a visible plugin', async () => {
  const declaration = fixture().dataSources![0];
  const extension = defineExtension({
    id: 'fixture',
    name: 'Fixture',
    sdk: 2,
    featureFlags: ['a', 'b'].map((key) => ({
      key: `fixture_${key}`,
      label: `Source ${key}`,
      description: `Access to source ${key}`,
      defaultEnabled: false,
    })),
    dataSources: ['a', 'b'].map((key) => ({
      ...declaration,
      featureFlag: `fixture_${key}`,
      app: defineApp({
        ...declaration.app,
        id: `fixture${key}`,
        modules: { [key]: { title: `Source ${key}` } },
        entities: { [key]: { ...declaration.app.entities.note, module: key } },
      }),
      entities: { [key]: { ...declaration.entities.note, actions: { read: 'team' } } },
      tools: { query: { id: `fixture_${key}_query` } },
    })),
  });
  registerFeatureFlags(extension.featureFlags!);
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  try {
    const registrations = extension.applications!;
    initializePlatformRuntime(db, registrations);
    const team = (await db.platform.getRoleByCode('default', 'team'))!;
    // Both sources have the same baseline permissions; only their feature grants differ.
    await db.platform.replaceRoleCapabilities(team.id, [
      ...(await db.platform.listRoleCapabilities([team.id])).map((row) => row.capability),
      ...registrations.flatMap((registration) => registration.teamCapabilities ?? []),
    ]);
    for (const registration of registrations) {
      for (const entity of Object.values(registration.manifest.entities)) {
        await db.platform.upsertRoleEntityPolicy(team.id, {
          app_id: registration.manifest.id,
          module_id: entity.module,
          entity_id: entity.id,
          scopes: [{ kind: 'own' }],
          field_policies: registration.teamFieldPolicies![entity.id],
        });
      }
    }
    const onlyA = await createInternalTestUser(db, { email: `manifest-a-${crypto.randomUUID()}@test.local` });
    const both = await createInternalTestUser(db, { email: `manifest-ab-${crypto.randomUUID()}@test.local` });
    for (const [user, keys] of [
      [onlyA, ['a']],
      [both, ['a', 'b']],
    ] as const) {
      for (const key of keys)
        await db.userFeatures.upsert({ user_id: user.id, feature: `fixture_${key}`, enabled: true });
    }

    for (const [user, keys] of [
      [onlyA, ['a']],
      [both, ['a', 'b']],
    ] as const) {
      const manifest = await stationManifest(db, { id: user.id, role: 'team' }, [extension]);
      expect(manifest.plugins).toHaveLength(1);
      const plugin = manifest.plugins[0];
      expect(plugin.id).toBe('fixture');
      expect(plugin.features).toEqual(keys.map((key) => `fixture_${key}`));
      expect(plugin.entities.map((entity) => entity.id)).toEqual(keys.map((key) => `fixture${key}.${key}`));
      expect(
        plugin.pages.map((page) => ({
          id: page.id,
          kind: page.kind,
          entity: 'entity' in page ? page.entity : undefined,
        })),
      ).toEqual(
        keys.flatMap((key) => [
          { id: `fixture-${key}`, kind: 'entity-list', entity: `fixture${key}.${key}` },
          { id: `fixture-${key}-detail`, kind: 'entity-detail', entity: `fixture${key}.${key}` },
        ]),
      );
      expect(plugin.nav.map((item) => ({ id: item.id, page: item.page }))).toEqual(
        keys.map((key) => ({ id: `fixture-${key}`, page: `fixture-${key}` })),
      );
      const kinds = keys.map((key) => ({ kind: `ext:fixture:${key}`, route: `#/ext/fixture/${key}/:id` }));
      expect(plugin.entity_kinds).toEqual(kinds);
      expect(manifest.entityKinds).toEqual(kinds);
    }
  } finally {
    await db.close();
  }
});
