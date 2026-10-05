import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const POLICY_SCRIPT = resolve(import.meta.dirname, '../../../../scripts/cloud-agent-net.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" == *"EnableIPv6"* ]]; then echo false
elif [[ "$joined" == *"enable_icc"* ]]; then echo false
elif [[ "$joined" == *"Subnet"* ]]; then echo 172.30.0.0/16
elif [[ "$joined" == *"Gateway"* && "$joined" == *" bridge "* ]]; then echo 172.17.0.1
elif [[ "$joined" == *"Gateway"* ]]; then echo 172.30.0.1
else echo '{}'
fi
`;

const FAKE_IPTABLES = `#!/usr/bin/env bash
set -euo pipefail
chain=""
if [[ "\${1:-}" == "-S" || "\${1:-}" == "-L" ]]; then chain="\${2:-}"; fi
if [[ "\${1:-}" == "-C" ]]; then exit 0; fi
if [[ "\${1:-}" == "-S" ]]; then
  case "$chain" in
    DOCKER-USER) echo '-A DOCKER-USER -s 172.30.0.0/16 -m comment --comment greenhouse-mission-sandbox -j GREENHOUSE-MISSION-FWD' ;;
    INPUT) echo '-A INPUT -s 172.30.0.0/16 -m comment --comment greenhouse-mission-sandbox -j GREENHOUSE-MISSION-IN' ;;
    GREENHOUSE-MISSION-FWD)
      for i in {1..9}; do echo "-A GREENHOUSE-MISSION-FWD rule-$i"; done ;;
    GREENHOUSE-MISSION-IN)
      for i in {1..3}; do echo "-A GREENHOUSE-MISSION-IN rule-$i"; done ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == "-L" ]]; then
  echo 'num target prot opt source destination'
  case "$chain" in
    DOCKER-USER) echo '1 GREENHOUSE-MISSION-FWD all -- 172.30.0.0/16 0.0.0.0/0' ;;
    INPUT) echo '1 GREENHOUSE-MISSION-IN all -- 172.30.0.0/16 0.0.0.0/0' ;;
    GREENHOUSE-MISSION-FWD)
      if [[ "\${FAKE_REORDER:-0}" == "1" ]]; then
        echo '1 RETURN all -- 0.0.0.0/0 0.0.0.0/0'
        echo '2 RETURN tcp -- 0.0.0.0/0 172.30.0.1 tcp dpt:3108'
      else
        echo '1 RETURN tcp -- 0.0.0.0/0 172.30.0.1 tcp dpt:3108'
        echo '2 RETURN tcp -- 0.0.0.0/0 172.17.0.1 tcp dpt:3108'
      fi
      echo '3 REJECT all -- 0.0.0.0/0 172.30.0.0/16 reject-with icmp-port-unreachable'
      echo '4 REJECT all -- 0.0.0.0/0 10.0.0.0/8 reject-with icmp-port-unreachable'
      echo '5 REJECT all -- 0.0.0.0/0 172.16.0.0/12 reject-with icmp-port-unreachable'
      echo '6 REJECT all -- 0.0.0.0/0 192.168.0.0/16 reject-with icmp-port-unreachable'
      echo '7 REJECT all -- 0.0.0.0/0 169.254.0.0/16 reject-with icmp-port-unreachable'
      echo '8 REJECT all -- 0.0.0.0/0 100.64.0.0/10 reject-with icmp-port-unreachable'
      if [[ "\${FAKE_REORDER:-0}" != "1" ]]; then echo '9 RETURN all -- 0.0.0.0/0 0.0.0.0/0'; else echo '9 RETURN tcp -- 0.0.0.0/0 172.17.0.1 tcp dpt:3108'; fi ;;
    GREENHOUSE-MISSION-IN)
      echo '1 ACCEPT tcp -- 0.0.0.0/0 172.30.0.1 tcp dpt:3108'
      echo '2 ACCEPT tcp -- 0.0.0.0/0 172.17.0.1 tcp dpt:3108'
      echo '3 REJECT all -- 0.0.0.0/0 0.0.0.0/0 reject-with icmp-port-unreachable' ;;
  esac
  exit 0
fi
exit 0
`;

async function runPolicyCheck(reordered: boolean): Promise<{ stdout: string; stderr: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'mission-net-test-'));
  await Promise.all([writeFile(join(bin, 'docker'), FAKE_DOCKER), writeFile(join(bin, 'iptables'), FAKE_IPTABLES)]);
  await Promise.all([chmod(join(bin, 'docker'), 0o755), chmod(join(bin, 'iptables'), 0o755)]);
  return execFileAsync('bash', [POLICY_SCRIPT, '--check'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      API_PORT: '3108',
      FAKE_REORDER: reordered ? '1' : '0',
    },
  });
}

// Timeout is declared on the suite because both cases are the same shape: each
// writes shims to a temp dir and then runs the real policy script under bash,
// which forks docker/iptables shims many times over. That process chain is
// scheduler-bound, not CPU-bound — it measures 1.1-3.0s on an idle machine and
// stretches several-fold when other work saturates the box, which is enough to
// cross the 5s default and report a passing assertion as a false red. The
// explicit bound keeps the assertions (anchored allow/deny ordering for Mission
// network egress) untouched while still failing a script that truly hangs.
describe('Mission network policy verification', () => {
  it('accepts the exact anchored allow/deny sequence', async () => {
    await expect(runPolicyCheck(false)).resolves.toMatchObject({
      stdout: expect.stringContaining('verified all greenhouse-mission-sandbox rules'),
    });
  });

  it('rejects the same rules when public RETURN shadows the private denies', async () => {
    await expect(runPolicyCheck(true)).rejects.toMatchObject({
      stderr: expect.stringContaining('unsafe order/content'),
    });
  });
}, 15_000);

// ─── Bot computers profile (`--profile bots`) ─────────────
//
// A data-driven fake: each `iptables -S/-L <chain>` prints a fixture file, and
// `-C` succeeds unless its exact argv is listed in C-missing. The computers'
// bridge is 172.31.0.0/16; Mission's (for the coexistence cases) 172.30.0.0/16.

const DATA_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" == *"EnableIPv6"* ]]; then echo false
elif [[ "$joined" == *"enable_icc"* ]]; then echo false
elif [[ "$joined" == *"Subnet"* && "$joined" == *" bots "* ]]; then echo 172.31.0.0/16
elif [[ "$joined" == *"Subnet"* ]]; then echo 172.30.0.0/16
elif [[ "$joined" == *"Gateway"* && "$joined" == *" bridge "* ]]; then echo 172.17.0.1
elif [[ "$joined" == *"Gateway"* && "$joined" == *" bots "* ]]; then echo 172.31.0.1
elif [[ "$joined" == *"Gateway"* ]]; then echo 172.30.0.1
else echo '{}'
fi
`;

const DATA_IPTABLES = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -S | -L)
    f="$FAKE_DIR/\${1#-}/\${2:-}"
    if [ -f "$f" ]; then cat "$f"; fi
    exit 0 ;;
  -C)
    if [ -f "$FAKE_DIR/C-missing" ] && grep -qxF -- "$*" "$FAKE_DIR/C-missing"; then
      echo "iptables: Bad rule (does a matching rule exist in that chain?)." >&2
      exit 1
    fi
    exit 0 ;;
esac
exit 0
`;

const HEADER = 'num target prot opt source destination';
const BOTS_ANCHOR_L = (chain: string) => `1 ${chain} all -- 172.31.0.0/16 0.0.0.0/0 /* greenhouse-bots-computer */`;
const BOTS_DENIES_L = [
  'REJECT all -- 0.0.0.0/0 172.31.0.0/16 reject-with icmp-port-unreachable',
  'REJECT all -- 0.0.0.0/0 10.0.0.0/8 reject-with icmp-port-unreachable',
  'REJECT all -- 0.0.0.0/0 172.16.0.0/12 reject-with icmp-port-unreachable',
  'REJECT all -- 0.0.0.0/0 192.168.0.0/16 reject-with icmp-port-unreachable',
  'REJECT all -- 0.0.0.0/0 169.254.0.0/16 reject-with icmp-port-unreachable',
  'REJECT all -- 0.0.0.0/0 100.64.0.0/10 reject-with icmp-port-unreachable',
  'RETURN all -- 0.0.0.0/0 0.0.0.0/0',
];

interface BotsFixture {
  /** Rows (without numbers) of each chain's -L listing. */
  list: Record<string, string[]>;
  /** -S lines of each chain. */
  rules: Record<string, string[]>;
  cMissing?: string[];
}

function cleanBotsFixture(): BotsFixture {
  return {
    list: {
      'DOCKER-USER': [BOTS_ANCHOR_L('GREENHOUSE-BOTS-FWD').slice(2)],
      INPUT: [BOTS_ANCHOR_L('GREENHOUSE-BOTS-IN').slice(2)],
      'GREENHOUSE-BOTS-FWD': [...BOTS_DENIES_L],
      'GREENHOUSE-BOTS-IN': ['REJECT all -- 0.0.0.0/0 0.0.0.0/0 reject-with icmp-port-unreachable'],
    },
    rules: {
      'DOCKER-USER': [
        '-A DOCKER-USER -s 172.31.0.0/16 -m comment --comment greenhouse-bots-computer -j GREENHOUSE-BOTS-FWD',
      ],
      INPUT: ['-A INPUT -s 172.31.0.0/16 -m comment --comment greenhouse-bots-computer -j GREENHOUSE-BOTS-IN'],
      'GREENHOUSE-BOTS-FWD': BOTS_DENIES_L.map((_, i) => `-A GREENHOUSE-BOTS-FWD rule-${i + 1}`),
      'GREENHOUSE-BOTS-IN': ['-A GREENHOUSE-BOTS-IN -j REJECT'],
    },
  };
}

async function runWithFixture(
  fixture: BotsFixture,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bots-net-test-'));
  const bin = join(dir, 'bin');
  await mkdir(join(bin), { recursive: true });
  await Promise.all([mkdir(join(dir, 'L')), mkdir(join(dir, 'S'))]);
  await Promise.all([writeFile(join(bin, 'docker'), DATA_DOCKER), writeFile(join(bin, 'iptables'), DATA_IPTABLES)]);
  await Promise.all([chmod(join(bin, 'docker'), 0o755), chmod(join(bin, 'iptables'), 0o755)]);
  const writes: Array<Promise<void>> = [];
  for (const [chain, rows] of Object.entries(fixture.list)) {
    const numbered = rows.map((row, i) => `${i + 1} ${row}`);
    writes.push(writeFile(join(dir, 'L', chain), [HEADER, ...numbered].join('\n') + '\n'));
  }
  for (const [chain, lines] of Object.entries(fixture.rules)) {
    writes.push(writeFile(join(dir, 'S', chain), lines.join('\n') + (lines.length ? '\n' : '')));
  }
  if (fixture.cMissing) writes.push(writeFile(join(dir, 'C-missing'), fixture.cMissing.join('\n') + '\n'));
  await Promise.all(writes);
  return execFileAsync('bash', [POLICY_SCRIPT, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_DIR: dir, ...env },
  });
}

const botsCheck = (fixture: BotsFixture, env: Record<string, string> = {}) =>
  runWithFixture(fixture, ['--profile', 'bots', '--check'], { BOTS_COMPUTER_NETWORK: 'bots', ...env });

describe('Bot computers network policy verification (--profile bots)', () => {
  it('accepts zero allow rows followed by the exact deny block', async () => {
    await expect(botsCheck(cleanBotsFixture())).resolves.toMatchObject({
      stdout: expect.stringContaining('verified all greenhouse-bots-computer rules'),
    });
  });

  it('rejects an API port allow row — computers get no allow rows at all', async () => {
    const fixture = cleanBotsFixture();
    fixture.list['GREENHOUSE-BOTS-FWD'] = ['RETURN tcp -- 0.0.0.0/0 172.31.0.1 tcp dpt:3111', ...BOTS_DENIES_L];
    fixture.rules['GREENHOUSE-BOTS-FWD'] = [
      '-A GREENHOUSE-BOTS-FWD -d 172.31.0.1/32 -p tcp -m tcp --dport 3111 -j RETURN',
      ...fixture.rules['GREENHOUSE-BOTS-FWD']!,
    ];
    await expect(botsCheck(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining('port allow row'),
    });
  });

  it('rejects a missing INPUT anchor (host-published ports would stay reachable)', async () => {
    const fixture = cleanBotsFixture();
    fixture.list.INPUT = ['ACCEPT all -- 0.0.0.0/0 0.0.0.0/0'];
    fixture.rules.INPUT = [];
    await expect(botsCheck(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining('INPUT must enter GREENHOUSE-BOTS-IN'),
    });
  });

  it('rejects the public RETURN moved above the private denies', async () => {
    const fixture = cleanBotsFixture();
    fixture.list['GREENHOUSE-BOTS-FWD'] = [BOTS_DENIES_L[6]!, ...BOTS_DENIES_L.slice(0, 6)];
    await expect(botsCheck(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining('unsafe order/content'),
    });
  });

  it('allows exactly one row for a private-IP egress proxy, and only when it is there', async () => {
    const fixture = cleanBotsFixture();
    fixture.list['GREENHOUSE-BOTS-FWD'] = ['RETURN tcp -- 0.0.0.0/0 10.0.0.5 tcp dpt:3128', ...BOTS_DENIES_L];
    fixture.list['GREENHOUSE-BOTS-IN'] = [
      'ACCEPT tcp -- 0.0.0.0/0 10.0.0.5 tcp dpt:3128',
      ...fixture.list['GREENHOUSE-BOTS-IN']!,
    ];
    fixture.rules['GREENHOUSE-BOTS-FWD'] = [
      '-A GREENHOUSE-BOTS-FWD -d 10.0.0.5/32 -p tcp -m tcp --dport 3128 -j RETURN',
      ...fixture.rules['GREENHOUSE-BOTS-FWD']!,
    ];
    fixture.rules['GREENHOUSE-BOTS-IN'] = [
      '-A GREENHOUSE-BOTS-IN -d 10.0.0.5/32 -p tcp -m tcp --dport 3128 -j ACCEPT',
      ...fixture.rules['GREENHOUSE-BOTS-IN']!,
    ];
    const proxy = { BOTS_COMPUTER_PROXY: 'http://10.0.0.5:3128' };
    await expect(botsCheck(fixture, proxy)).resolves.toMatchObject({
      stdout: expect.stringContaining('verified all greenhouse-bots-computer rules'),
    });
    // Without that proxy configured the same row is just an allow row too many.
    await expect(botsCheck(fixture)).rejects.toMatchObject({ stderr: expect.stringContaining('port allow row') });
    // Configured but not applied: the -C for the proxy row fails.
    await expect(
      botsCheck(
        { ...cleanBotsFixture(), cMissing: ['-C GREENHOUSE-BOTS-FWD -d 10.0.0.5 -p tcp --dport 3128 -j RETURN'] },
        proxy,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Bad rule') });
  });

  it('refuses a missing network name and a proxy in the metadata range', async () => {
    await expect(runWithFixture(cleanBotsFixture(), ['--profile', 'bots', '--check'])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('BOTS_COMPUTER_NETWORK'),
    });
    await expect(
      botsCheck(cleanBotsFixture(), { BOTS_COMPUTER_PROXY: 'http://169.254.169.254:80' }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('169.254.0.0/16') });
  });

  it('coexists with Mission on one host: each check accepts the other profile’s anchor above its own', async () => {
    const missionAnchor = (chain: string) => `${chain} all -- 172.30.0.0/16 0.0.0.0/0 /* greenhouse-mission-sandbox */`;
    const both = cleanBotsFixture();
    both.list['DOCKER-USER'] = [missionAnchor('GREENHOUSE-MISSION-FWD'), both.list['DOCKER-USER']![0]!];
    both.list.INPUT = [missionAnchor('GREENHOUSE-MISSION-IN'), both.list.INPUT![0]!];
    await expect(botsCheck(both)).resolves.toMatchObject({
      stdout: expect.stringContaining('verified all greenhouse-bots-computer rules'),
    });

    // A look-alike anchor whose source covers the computers' subnet is not skipped.
    const overlapping = cleanBotsFixture();
    overlapping.list['DOCKER-USER'] = [
      'GREENHOUSE-MISSION-FWD all -- 172.16.0.0/12 0.0.0.0/0 /* greenhouse-mission-sandbox */',
      overlapping.list['DOCKER-USER']![0]!,
    ];
    await expect(botsCheck(overlapping)).rejects.toMatchObject({
      stderr: expect.stringContaining('DOCKER-USER must enter GREENHOUSE-BOTS-FWD'),
    });

    // Mission's own check, with the computers' anchors inserted above Mission's.
    const missionFwd = [
      'RETURN tcp -- 0.0.0.0/0 172.30.0.1 tcp dpt:3108',
      'RETURN tcp -- 0.0.0.0/0 172.17.0.1 tcp dpt:3108',
      ...BOTS_DENIES_L.map((row) => row.replace('172.31.0.0/16', '172.30.0.0/16')),
    ];
    const mission: BotsFixture = {
      list: {
        'DOCKER-USER': [BOTS_ANCHOR_L('GREENHOUSE-BOTS-FWD').slice(2), missionAnchor('GREENHOUSE-MISSION-FWD')],
        INPUT: [BOTS_ANCHOR_L('GREENHOUSE-BOTS-IN').slice(2), missionAnchor('GREENHOUSE-MISSION-IN')],
        'GREENHOUSE-MISSION-FWD': missionFwd,
        'GREENHOUSE-MISSION-IN': [
          'ACCEPT tcp -- 0.0.0.0/0 172.30.0.1 tcp dpt:3108',
          'ACCEPT tcp -- 0.0.0.0/0 172.17.0.1 tcp dpt:3108',
          'REJECT all -- 0.0.0.0/0 0.0.0.0/0 reject-with icmp-port-unreachable',
        ],
      },
      rules: {
        'DOCKER-USER': [
          '-A DOCKER-USER -s 172.31.0.0/16 -m comment --comment greenhouse-bots-computer -j GREENHOUSE-BOTS-FWD',
          '-A DOCKER-USER -s 172.30.0.0/16 -m comment --comment greenhouse-mission-sandbox -j GREENHOUSE-MISSION-FWD',
        ],
        INPUT: [
          '-A INPUT -s 172.31.0.0/16 -m comment --comment greenhouse-bots-computer -j GREENHOUSE-BOTS-IN',
          '-A INPUT -s 172.30.0.0/16 -m comment --comment greenhouse-mission-sandbox -j GREENHOUSE-MISSION-IN',
        ],
        'GREENHOUSE-MISSION-FWD': missionFwd.map((_, i) => `-A GREENHOUSE-MISSION-FWD rule-${i + 1}`),
        'GREENHOUSE-MISSION-IN': [1, 2, 3].map((i) => `-A GREENHOUSE-MISSION-IN rule-${i}`),
      },
    };
    await expect(runWithFixture(mission, ['--check'], { API_PORT: '3108' })).resolves.toMatchObject({
      stdout: expect.stringContaining('verified all greenhouse-mission-sandbox rules'),
    });
  });
}, 30_000);
