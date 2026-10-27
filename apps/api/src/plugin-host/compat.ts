/**
 * Extension compatibility declarations: `sdk` (the extension contract revision
 * it was written for) and `core` (a semver range of Greenhouse versions).
 *
 * `EXTENSION_SDK` names the newest host contract; compatible older revisions
 * are accepted explicitly. An unsupported `sdk` (SDK 2 also accepts SDK 1) or a
 * `core` range the running version does not satisfy refuses activation; leaving
 * either out only warns in 3.x (both become required in 4.0).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseTriple } from '@greenhouse/utils/semver';
import { REPO_ROOT } from '../paths.js';

export { EXTENSION_SDK, checkExtensionCompat } from '@greenhouse/utils/extension-compat';
export type { ExtensionCompatDeclaration } from '@greenhouse/utils/extension-compat';

/**
 * The running Greenhouse version: `APP_VERSION` when it is a real version (the
 * release image stamps it), else the root package.json (dev, and an image built
 * without a version, whose default is the `0.0.0-dev` sentinel).
 */
export function runningAppVersion(env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): string | null {
  const stamped = env.APP_VERSION?.trim();
  if (stamped && releaseTriple(stamped) && !stamped.replace(/^v/, '').startsWith('0.0.0')) {
    return stamped.replace(/^v/, '');
  }
  const pkg = resolve(root, 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    const version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && releaseTriple(version) ? version : null;
  } catch {
    return null;
  }
}
