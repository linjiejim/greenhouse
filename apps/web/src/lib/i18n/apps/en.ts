import { appsSandboxEn } from './sandbox.en';
/**
 * Apps copy (Phase 1, spec 20261011-tables-apps), split per slice so parallel
 * slices never edit the same catalog lines — the same layout as ../tables. Each
 * `<slice>.en.ts` owns one namespace under `apps` (`apps.runtime.*`,
 * `apps.builder.*`, `apps.center.*`, `apps.agent.*`); this file spreads them
 * once into `../en.ts`. Keys several slices share (the module title, the
 * sidebar section) stay in `../en.ts` under `apps`. The slice test pins that no
 * two modules (and no core key) claim the same namespace.
 */

import { appsAgentEn } from './agent.en';
import { appsBuilderEn } from './builder.en';
import { appsCenterEn } from './center.en';
import { appsTemplatesEn } from './templates.en';
import { appsRuntimeEn } from './runtime.en';

export const APPS_SLICE_MODULES_EN = {
  templates: appsTemplatesEn,
  agent: appsAgentEn,
  builder: appsBuilderEn,
  center: appsCenterEn,
  runtime: appsRuntimeEn,
  sandbox: appsSandboxEn,
} as const;

export const APPS_SLICES_EN = {
  ...appsTemplatesEn,
  ...appsAgentEn,
  ...appsBuilderEn,
  ...appsCenterEn,
  ...appsRuntimeEn,
  ...appsSandboxEn,
} as const;
