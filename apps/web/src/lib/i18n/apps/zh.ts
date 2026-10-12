import { appsSandboxZh } from './sandbox.zh';
/** Chinese counterpart of ./en.ts — spread once into `../zh.ts`. */

import { appsAgentZh } from './agent.zh';
import { appsBuilderZh } from './builder.zh';
import { appsCenterZh } from './center.zh';
import { appsTemplatesZh } from './templates.zh';
import { appsRuntimeZh } from './runtime.zh';

export const APPS_SLICE_MODULES_ZH = {
  templates: appsTemplatesZh,
  agent: appsAgentZh,
  builder: appsBuilderZh,
  center: appsCenterZh,
  runtime: appsRuntimeZh,
  sandbox: appsSandboxZh,
};

export const APPS_SLICES_ZH = {
  ...appsTemplatesZh,
  ...appsAgentZh,
  ...appsBuilderZh,
  ...appsCenterZh,
  ...appsRuntimeZh,
  ...appsSandboxZh,
};
