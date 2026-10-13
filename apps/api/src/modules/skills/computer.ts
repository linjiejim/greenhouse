/**
 * A package's files on the Agent's computer: its canonical ZIP is streamed in and unpacked into
 * ~/skills/<name>/, replacing what an earlier install left there. Everything runs as the `agent`
 * user, the one the Agent's own shell uses; the name and sizes reach the script as arguments.
 */

import type { ComputersService } from '../computers/service.js';
import { AGENT_HOME, scriptArgv, scriptError } from '../computers/files.js';
import { runToEnd } from '../computers/streams.js';

/** `$1` destination, `$2` byte count, `$3` the package's top folder; stdin = the ZIP. */
const INSTALL_SCRIPT = [
  'set -e',
  'parent=$(dirname -- "$1")',
  'mkdir -p -- "$parent"',
  'tmp=$(mktemp -d "$parent/.gh-skill.XXXXXXXX")',
  'trap \'rm -rf -- "$tmp"\' EXIT',
  'head -c "$2" >"$tmp/package.zip"',
  '[ "$(stat -c %s -- "$tmp/package.zip")" = "$2" ] || { echo "The package arrived cut short." >&2; exit 8; }',
  'unzip -q "$tmp/package.zip" -d "$tmp/out" || { echo "The package could not be unpacked." >&2; exit 9; }',
  '[ -d "$tmp/out/$3" ] || { echo "The package has an unexpected layout." >&2; exit 4; }',
  'rm -rf -- "$1"',
  'mv -- "$tmp/out/$3" "$1"',
].join('\n');

const INSTALL_TIMEOUT_MS = 60_000;

/** Where a skill's files go in the home. */
export const skillHome = (name: string) => `skills/${name}`;

export async function installOnComputer(
  computers: ComputersService,
  input: { memberId: string; agentId: string; name: string; zip: Uint8Array },
): Promise<string> {
  const { row, client } = await computers.ensure(input.memberId, input.agentId);
  const stream = client.stream(row.sandboxRef, {
    argv: scriptArgv(INSTALL_SCRIPT, [
      `${AGENT_HOME}/${skillHome(input.name)}`,
      String(input.zip.byteLength),
      input.name,
    ]),
    user: 'agent',
    cwd: AGENT_HOME,
  });
  const result = await runToEnd(stream, input.zip, { timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 4096 });
  if (result.code !== 0) throw scriptError(result.code, result.stderr);
  return `~/${skillHome(input.name)}`;
}
