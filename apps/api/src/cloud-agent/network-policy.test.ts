import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
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
