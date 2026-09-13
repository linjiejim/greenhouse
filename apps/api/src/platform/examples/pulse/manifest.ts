/**
 * Pulse is a test-only reference application used to prove that an entirely
 * new app can join the Platform without changing the kernel.
 */

import { compileApp, defineApp } from '@greenhouse/platform-kernel';

export const pulseManifest = compileApp(
  defineApp({
    id: 'pulse',
    version: '0.1.0',
    title: 'Pulse',
    description: 'Reference application for team status signals.',
    modules: {
      monitoring: {
        title: 'Monitoring',
        description: 'Publish and read lightweight operational signals.',
        icon: 'Gauge',
      },
    },
    entities: {
      signal: {
        title: 'Signal',
        module: 'monitoring',
        table: 'pulse_signals',
        accessScopes: ['own', 'all'],
        fields: {
          id: { kind: 'integer', title: 'ID', classification: 'internal' },
          title: {
            kind: 'text',
            title: 'Title',
            required: true,
            searchable: true,
          },
          ownerId: {
            kind: 'user',
            title: 'Owner',
            required: true,
            filterable: true,
          },
          severity: {
            kind: 'enum',
            title: 'Severity',
            required: true,
            filterable: true,
            values: ['info', 'warning', 'critical'],
          },
        },
      },
    },
    actions: {
      listSignals: {
        title: 'List signals',
        module: 'monitoring',
        entity: 'signal',
        kind: 'query',
        capability: 'pulse.monitoring.read',
        risk: 'read',
        mcp: true,
      },
      publishSignal: {
        title: 'Publish signal',
        module: 'monitoring',
        entity: 'signal',
        kind: 'command',
        capability: 'pulse.monitoring.publish',
        risk: 'medium',
        mcp: true,
      },
    },
    navigation: [
      {
        id: 'pulse',
        title: 'Pulse',
        module: 'monitoring',
        path: '/pulse',
        capability: 'pulse.monitoring.read',
      },
    ],
  }),
);
