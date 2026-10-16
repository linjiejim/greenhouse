/**
 * The E2B computer template (ported from v1): the image apps/bot-computer/Dockerfile builds, plus
 * the hosted layer in apps/bot-computer/e2b/ (the two bridges, their systemd units, the boot
 * script and the hardening start command), built at the provider with the E2B SDK. The running
 * API never builds templates or uses the SDK: scripts/e2b-template.mts and the live test do, with
 * the operator's key, and the sandbox adapter (packages/providers, plain HTTP) only names the
 * template it starts computers from.
 *
 * The name is content-addressed, `gh-computer-<hash>` over everything that goes in (the
 * Dockerfile, rootfs/, e2b/, the build steps and the size), so a deployment computes the name its
 * own sources need and deployments sharing one account share one build per version. Existing
 * computers keep the template they were made from; new ones use the configured one.
 *
 * What differs from a docker build, and why:
 * - The provider's base layer creates its own account `user` with uid 1000 (the uid `agent`
 *   gets), so it moves to 2000 before the Dockerfile runs.
 * - The Dockerfile's ENTRYPOINT is dropped: systemd is PID 1 in the sandbox, and the desktop starts
 *   per computer (gh-e2b-boot), never at build time: what runs at build time is frozen into the
 *   snapshot every computer starts from.
 * - The start command only hardens (gh-e2b-harden): the provisioning's sudo, setuid helpers, sshd
 *   and a world-writable /usr/local; the build fails unless every check passes.
 * - CPU and memory are the template's (the create API has no per-computer size).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template, type TemplateClass } from 'e2b';
import { e2bEndpoints, e2bTemplateState, pinnedFetch, type E2bTemplateState } from '@greenhouse/providers';

/** apps/bot-computer, the docker build context. */
export const COMPUTER_CONTEXT_DIR = fileURLToPath(new URL('../../../bot-computer/', import.meta.url));

/** Bump when the hosted layer changes in a way neither the files nor the steps show. */
const LAYER_VERSION = 1;
/** gh-bridge's one dependency, installed into the template (pinned; the API's client is the same). */
const WS_PACKAGE = 'ws@8.21.0';
/** Runs right after FROM: the provider's `user` must not hold the uid our `agent` gets. */
const MOVE_PROVIDER_USER =
  'RUN if id -u user >/dev/null 2>&1 && [ "$(id -u user)" = 1000 ]; then usermod -u 2000 user && groupmod -g 2000 user && chown -R user:user /home/user; fi';
const BRIDGE_DIR = '/opt/gh-bridge';

export interface ComputerTemplateOptions {
  cpuCount: number;
  memoryMB: number;
  /** Override for tests. */
  contextDir?: string;
}

export interface ProviderConnection {
  apiKey: string;
  /** e2b.app when absent. */
  domain?: string;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The provider's view of the Dockerfile (see the header). Throws when its shape moved on. */
export function hostedDockerfile(dockerfile: string): string {
  if (!/^ENTRYPOINT .*$/m.test(dockerfile) || !/^FROM .*$/m.test(dockerfile)) {
    throw new Error('apps/bot-computer/Dockerfile changed shape: expected one FROM and one ENTRYPOINT line');
  }
  return dockerfile.replace(/^ENTRYPOINT .*$/m, '').replace(/^(FROM .*)$/m, `$1\n${MOVE_PROVIDER_USER}`);
}

/** The template definition the provider builds. */
export function computerTemplate(opts: ComputerTemplateOptions): TemplateClass {
  const context = opts.contextDir ?? COMPUTER_CONTEXT_DIR;
  const dockerfile = hostedDockerfile(readFileSync(join(context, 'Dockerfile'), 'utf8'));
  return (
    Template({ fileContextPath: context })
      .fromDockerfile(dockerfile)
      .setUser('root')
      .setWorkdir('/')
      .copy('e2b/gh-bridge.mjs', `${BRIDGE_DIR}/gh-bridge.mjs`, { mode: 0o644 })
      .copy('e2b/gh-e2b-harden', '/usr/local/sbin/gh-e2b-harden', { mode: 0o755 })
      .copy('e2b/gh-e2b-boot', '/usr/local/sbin/gh-e2b-boot', { mode: 0o755 })
      .copy('e2b/gh-e2b-rundir', '/usr/local/sbin/gh-e2b-rundir', { mode: 0o755 })
      .copy('e2b/systemd/gh-desktop.service', '/etc/systemd/system/gh-desktop.service', { mode: 0o644 })
      .copy('e2b/systemd/gh-agent.slice', '/etc/systemd/system/gh-agent.slice', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-browser.socket', '/etc/systemd/system/gh-bridge-browser.socket', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-browser.service', '/etc/systemd/system/gh-bridge-browser.service', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-agent.socket', '/etc/systemd/system/gh-bridge-agent.socket', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-agent.service', '/etc/systemd/system/gh-bridge-agent.service', { mode: 0o644 })
      // HOME is /home/browser from here on (the Dockerfile's ENV): npm's cache stays out of the homes.
      .runCmd([
        `HOME=/root npm install --prefix ${BRIDGE_DIR} --cache /tmp/gh-npm-cache --no-save --no-audit --no-fund --ignore-scripts --omit=dev ${WS_PACKAGE}`,
        'rm -rf /tmp/gh-npm-cache /root/.npm /home/browser/.npm',
      ])
      .setStartCmd('/usr/local/sbin/gh-e2b-harden', 'test -f /var/lib/gh-computer/hardened')
  );
}

/** `gh-computer-<12 hex>`: changes whenever anything that goes into the template does. */
export async function computerTemplateName(opts: ComputerTemplateOptions): Promise<string> {
  const context = opts.contextDir ?? COMPUTER_CONTEXT_DIR;
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ layer: LAYER_VERSION, cpu: opts.cpuCount, mem: opts.memoryMB }));
  // The steps as the provider receives them (the converted Dockerfile and the hosted layer).
  hash.update(await Template.toJSON(computerTemplate(opts), false));
  const files = [
    join(context, 'Dockerfile'),
    ...listFiles(join(context, 'rootfs')),
    ...listFiles(join(context, 'e2b')),
  ];
  for (const file of files.sort()) {
    const path = relative(context, file).split(sep).join('/');
    const executable = (statSync(file).mode & 0o111) !== 0;
    hash.update(`\0${path}\0${executable ? 'x' : '-'}\0`);
    hash.update(readFileSync(file));
  }
  return `gh-computer-${hash.digest('hex').slice(0, 12)}`;
}

/** Whether the provider has a finished build of `name`, through the same pinned client the adapter uses. */
export function templateState(conn: ProviderConnection, name: string): Promise<E2bTemplateState> {
  const config = { domain: conn.domain ?? 'e2b.app', template: name };
  return e2bTemplateState(pinnedFetch(e2bEndpoints(config)), config, conn.apiKey);
}

/** Builds (or rebuilds) the template at the provider; resolves once it is ready, logging as it goes. */
export async function buildComputerTemplate(
  conn: ProviderConnection,
  opts: ComputerTemplateOptions,
  onLog: (line: string) => void,
): Promise<{ name: string; buildId: string }> {
  const name = await computerTemplateName(opts);
  const info = await Template.build(computerTemplate(opts), name, {
    apiKey: conn.apiKey,
    ...(conn.domain ? { domain: conn.domain } : {}),
    cpuCount: opts.cpuCount,
    memoryMB: opts.memoryMB,
    onBuildLogs: (entry) => onLog(String((entry as { message?: unknown })?.message ?? entry)),
  });
  return { name, buildId: info.buildId };
}
