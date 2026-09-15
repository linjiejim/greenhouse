/**
 * The web-bundle version of a checkout.
 *
 * Hot updates need a number that only ever grows, so a newer bundle always wins
 * over a staged older one. The commit count of the branch is exactly that and
 * needs no hand-maintained field: `git rev-list --count HEAD`. Every consumer —
 * `build.rs` (the baseline stamped into the shell), `make-web-bundle.mjs` (the
 * published manifest) and the release-notes generator — asks this one function,
 * and CI passes the number it computed once via `GREENHOUSE_WEB_BUNDLE_VERSION`
 * so all jobs of a run agree.
 */
import { execFileSync } from 'node:child_process';

export function resolveWebBundleVersion(env = process.env, cwd = process.cwd()) {
  const fromEnv = env.GREENHOUSE_WEB_BUNDLE_VERSION?.trim();
  if (fromEnv) {
    if (!/^\d+$/.test(fromEnv))
      throw new Error(`GREENHOUSE_WEB_BUNDLE_VERSION must be an integer, got ${JSON.stringify(fromEnv)}`);
    return fromEnv;
  }
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (!/^\d+$/.test(count)) throw new Error(`git rev-list --count HEAD returned ${JSON.stringify(count)}`);
  return count;
}
