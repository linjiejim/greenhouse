/**
 * Prints what the API would run, from the API's own builders, so
 * scripts/bot-computer-smoke.sh tests the real argv rather than a copy:
 *
 *   tsx scripts/bot-computer-argv.ts run <name> <volume> <network> <runtime> [blocklist]
 *   tsx scripts/bot-computer-argv.ts shell <timeoutSec> <command>
 *   tsx scripts/bot-computer-argv.ts kill-script
 *
 * One argument per line (none of them contains a newline, except the kill
 * script, which is printed verbatim).
 */

import { buildComputerRunArgs } from '../apps/api/src/bots/computer/docker.js';
import { KILL_SCRIPT, shellArgv } from '../apps/api/src/bots/computer/shell.js';

const [mode, ...rest] = process.argv.slice(2);

function print(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (mode === 'run') {
  const [name, volume, network, runtime, blocklist] = rest;
  if (!name || !volume || !network || !runtime) {
    process.stderr.write('usage: run <name> <volume> <network> <runtime> [blocklist]\n');
    process.exit(2);
  }
  print(
    buildComputerRunArgs({
      name,
      namespace: 'smoke',
      userId: 'smoke-user',
      image: process.env.BOTS_COMPUTER_IMAGE || 'greenhouse/bot-computer:latest',
      volume,
      network,
      runtime,
      memory: '2g',
      cpus: '1.5',
      proxy: null,
      urlBlocklist: (blocklist ?? '').split(',').filter(Boolean),
      timezone: 'UTC',
      lang: null,
    }),
  );
} else if (mode === 'shell') {
  const [timeoutSec, command] = rest;
  print(shellArgv(command ?? 'true', Number(timeoutSec ?? 10)));
} else if (mode === 'kill-script') {
  process.stdout.write(KILL_SCRIPT);
} else {
  process.stderr.write('usage: bot-computer-argv.ts run|shell|kill-script …\n');
  process.exit(2);
}
