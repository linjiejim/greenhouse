/**
 * Builds the Agent computer's E2B template from apps/bot-computer at the provider and prints the
 * name to configure (SANDBOX_E2B_TEMPLATE, or the template of the sandbox instance in
 * 管理 → 服务). The name follows the content: run it again after the image changes; a build that
 * already exists is not repeated. A build takes a few minutes and is billed by the provider.
 *
 *   E2B_API_KEY=… node --import tsx scripts/e2b-template.mts [--cpus 2] [--memory 2048] [--force]
 *   E2B_API_KEY=… E2B_DOMAIN=cn-beijing-1.sandbox.ppio.com node --import tsx scripts/e2b-template.mts
 *   node --import tsx scripts/e2b-template.mts --name     # only print the name (no key, no network)
 */

import { parseArgs } from 'node:util';
import { buildComputerTemplate, computerTemplateName, templateState } from '../apps/api/src/providers/e2b-template.ts';

const { values } = parseArgs({
  options: {
    cpus: { type: 'string', default: '2' },
    memory: { type: 'string', default: '2048' },
    name: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
const options = { cpuCount: Number(values.cpus), memoryMB: Number(values.memory) };
if (!Number.isInteger(options.cpuCount) || options.cpuCount < 1 || !Number.isInteger(options.memoryMB)) {
  console.error('--cpus and --memory are whole numbers (vCPUs, MiB)');
  process.exit(2);
}
// The provider sizes memory in even MiB.
if (options.memoryMB % 2) options.memoryMB += 1;

const name = await computerTemplateName(options);
if (values.name) {
  console.log(name);
  process.exit(0);
}
const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) {
  console.error('Set E2B_API_KEY (and E2B_DOMAIN for a compatible host such as PPIO).');
  process.exit(2);
}
const conn = { apiKey, ...(process.env.E2B_DOMAIN?.trim() ? { domain: process.env.E2B_DOMAIN.trim() } : {}) };

const state = await templateState(conn, name);
if (state.state === 'ready' && !values.force) {
  console.log(`${name} is ready at ${conn.domain ?? 'e2b.app'} (build ${state.buildId}).`);
} else {
  console.log(`Building ${name} at ${conn.domain ?? 'e2b.app'} (${options.cpuCount} vCPU, ${options.memoryMB} MiB)…`);
  const built = await buildComputerTemplate(conn, options, (line) => console.log(`  ${line}`));
  console.log(`${built.name} is ready (build ${built.buildId}).`);
}
console.log(`\nSANDBOX_E2B_TEMPLATE=${name}`);
