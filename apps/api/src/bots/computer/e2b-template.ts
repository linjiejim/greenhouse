/**
 * The hosted computer's template (BOTS_COMPUTER_DRIVER=e2b): the computer image
 * the provider builds from apps/bot-computer/Dockerfile, plus the hosted layer in
 * apps/bot-computer/e2b/ — the two bridges, their systemd units, the per-start
 * boot script and the hardening start command.
 *
 * The name is content-addressed — `gh-computer-c<contract>-<hash>` over
 * everything that goes in (the Dockerfile, rootfs/, e2b/, the build steps
 * below, the size) — so a
 * deployment computes the name its own sources need, deployments sharing one
 * provider team share one build per version, and a changed image (a greenhouse
 * upgrade, a Chromium update) is a new name: a computer on an older template
 * moves its home into a new sandbox at its next start (e2b-host.ts).
 *
 * What differs from a docker build, and why:
 * - The provider's base layer creates its own account `user` with uid/gid 1000
 *   (the uid `agent` gets), so it is moved to 2000 before the Dockerfile runs.
 * - The Dockerfile's ENTRYPOINT is dropped: systemd is PID 1 in the sandbox, and
 *   the desktop starts per member (gh-e2b-boot), never at build time — whatever
 *   runs at build time is frozen into the snapshot every computer starts from.
 * - The start command only hardens (gh-e2b-harden): the provisioning's sudo,
 *   setuid helpers, sshd and world-writable /usr/local.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient, ConnectionConfig, Template, type TemplateClass } from 'e2b';

/** apps/bot-computer — the docker build context, shipped inside the API image. */
export const COMPUTER_CONTEXT_DIR = fileURLToPath(new URL('../../../../bot-computer/', import.meta.url));

/** Bump when the hosted layer changes in a way neither the files nor the steps show. */
const LAYER_VERSION = 1;
/** gh-bridge's one dependency, installed into the template (pinned). */
const WS_PACKAGE = 'ws@8.21.0';
/** Runs right after FROM: the provider's `user` must not hold the uid our `agent` gets. */
const MOVE_PROVIDER_USER =
  'RUN if id -u user >/dev/null 2>&1 && [ "$(id -u user)" = 1000 ]; then usermod -u 2000 user && groupmod -g 2000 user && chown -R user:user /home/user; fi';
const BRIDGE_DIR = '/opt/gh-bridge';

export interface ComputerTemplateOptions {
  /** The API's image contract (runtime.ts IMAGE_CONTRACT): part of the name. */
  contract: string;
  cpuCount: number;
  memoryMB: number;
  /** Override for tests. */
  contextDir?: string;
}

export interface ProviderConnection {
  apiKey: string;
  domain?: string;
}

function listFiles(root: string, dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The provider's view of the Dockerfile (see the file header). Throws when its shape moved on. */
export function hostedDockerfile(dockerfile: string): string {
  if (!/^ENTRYPOINT .*$/m.test(dockerfile) || !/^FROM .*$/m.test(dockerfile)) {
    throw new Error('apps/bot-computer/Dockerfile changed shape: expected one FROM and one ENTRYPOINT line');
  }
  return dockerfile.replace(/^ENTRYPOINT .*$/m, '').replace(/^(FROM .*)$/m, `$1\n${MOVE_PROVIDER_USER}`);
}

/** `gh-computer-c<contract>-<12 hex>`: changes whenever anything that goes into the template does. */
export async function computerTemplateName(opts: ComputerTemplateOptions): Promise<string> {
  const context = opts.contextDir ?? COMPUTER_CONTEXT_DIR;
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ layer: LAYER_VERSION, cpu: opts.cpuCount, mem: opts.memoryMB }));
  // The steps as the provider receives them (the converted Dockerfile and the hosted layer).
  hash.update(await Template.toJSON(computerTemplate(opts), false));
  const files = [
    join(context, 'Dockerfile'),
    ...listFiles(context, join(context, 'rootfs')),
    ...listFiles(context, join(context, 'e2b')),
  ];
  for (const file of files.sort()) {
    const path = relative(context, file).split(sep).join('/');
    const executable = (statSync(file).mode & 0o111) !== 0;
    hash.update(`\0${path}\0${executable ? 'x' : '-'}\0`);
    hash.update(readFileSync(file));
  }
  return `gh-computer-c${opts.contract}-${hash.digest('hex').slice(0, 12)}`;
}

/** The template definition the provider builds (Template.build). */
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
      .copy('e2b/systemd/gh-bridge-browser.socket', '/etc/systemd/system/gh-bridge-browser.socket', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-browser.service', '/etc/systemd/system/gh-bridge-browser.service', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-agent.socket', '/etc/systemd/system/gh-bridge-agent.socket', { mode: 0o644 })
      .copy('e2b/systemd/gh-bridge-agent.service', '/etc/systemd/system/gh-bridge-agent.service', { mode: 0o644 })
      // HOME is /home/browser from here on (the Dockerfile's ENV): keep npm's cache out of the homes —
      // a root-owned ~/.npm there would be in every member's home (and break moving one).
      .runCmd([
        `HOME=/root npm install --prefix ${BRIDGE_DIR} --cache /tmp/gh-npm-cache --no-save --no-audit --no-fund --ignore-scripts --omit=dev ${WS_PACKAGE}`,
        'rm -rf /tmp/gh-npm-cache /root/.npm /home/browser/.npm',
      ])
      .setStartCmd('/usr/local/sbin/gh-e2b-harden', 'test -f /var/lib/gh-computer/hardened')
  );
}

export interface TemplateStatus {
  /** ready = a successful build exists; building / waiting = in progress; error = the last build failed; missing = never built. */
  state: 'ready' | 'building' | 'error' | 'missing';
  buildId: string | null;
}

/**
 * What the provider has under `name`: a template is usable once a build of it
 * succeeded (`buildID`), even while a newer one runs or after a newer one failed.
 */
export async function templateStatus(conn: ProviderConnection, name: string): Promise<TemplateStatus> {
  const client = new ApiClient(
    new ConnectionConfig({ apiKey: conn.apiKey, ...(conn.domain ? { domain: conn.domain } : {}) }),
  );
  const res = await client.api.GET('/templates', {});
  if (res.error) {
    const status = res.response.status;
    throw Object.assign(new Error(`Listing templates failed (HTTP ${status})`), { statusCode: status });
  }
  const matches = (value: string) => value === name || value.endsWith(`/${name}`);
  const template = (res.data ?? []).find((t) => (t.names ?? []).some(matches) || (t.aliases ?? []).some(matches));
  if (!template) return { state: 'missing', buildId: null };
  if (template.buildID) return { state: 'ready', buildId: template.buildID };
  if (template.buildStatus === 'building' || template.buildStatus === 'waiting')
    return { state: 'building', buildId: null };
  return { state: 'error', buildId: null };
}

/** Build (or rebuild) the template on the provider; resolves once it is ready, logs as it goes. */
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
