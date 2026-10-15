/**
 * The hosted computers' network rules (sandbox/e2b/egress.ts) as text: only the member accounts
 * are filtered, through a jump so the kernel's own refusals pass; every blocked range and port is
 * in the table and in the probe; the provider is never told to refuse the VM's own link-local
 * network; and the probe's verdict. The rules themselves run in the live test.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCKED_PORTS,
  EGRESS_PROBE,
  EGRESS_RULESET,
  PROVIDER_DENY_OUT,
  egressApplyEnv,
  egressLeaks,
} from '../sandbox/e2b/egress.js';

describe('hosted egress rules', () => {
  it('filters only the member accounts, through a jump into their own chain', () => {
    const output = /chain output \{([\s\S]*?)\n\t\}/.exec(EGRESS_RULESET)![1]!;
    expect(output).toContain('type filter hook output priority filter; policy accept;');
    expect(
      output
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .slice(1),
    ).toEqual(['meta skuid { "agent", "browser" } jump member']);
    expect(EGRESS_RULESET).not.toMatch(/policy drop/);
  });

  it('refuses link-local, private ranges and the VM’s own services, and replaces itself when loaded again', () => {
    const member = /chain member \{([\s\S]*?)\n\t\}/.exec(EGRESS_RULESET)![1]!;
    expect(member).toContain('ip daddr 169.254.0.0/16 reject');
    for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']) {
      expect(member).toContain(range);
    }
    expect(member).toContain('ip6 daddr != ::1 reject');
    expect(member).toContain('tcp dport { 111, 7681, 7682, 49983 } reject with tcp reset');
    expect(EGRESS_RULESET.startsWith('table inet gh_egress\ndelete table inet gh_egress\n')).toBe(true);
    expect(Buffer.from(egressApplyEnv().GH_EGRESS_NFT!, 'base64').toString()).toBe(EGRESS_RULESET);
  });

  it('probes every blocked kind of target', () => {
    expect(EGRESS_PROBE).toContain('http://169.254.169.254/');
    for (const port of Object.values(BLOCKED_PORTS)) {
      expect(EGRESS_PROBE.some((url) => url.startsWith(`http://127.0.0.1:${port}/`))).toBe(true);
    }
    expect(EGRESS_PROBE.some((url) => url.startsWith('http://10.'))).toBe(true);
  });

  it('counts only a refused connection as refused', () => {
    const refused = EGRESS_PROBE.map((url) => `7 ${url}`).join('\n');
    expect(egressLeaks(refused)).toEqual([]);
    // Answered (0), connected then cut (52, 56), timed out (28) or missing from the output: not refused.
    const mixed = [
      `0 ${EGRESS_PROBE[0]}`,
      `52 ${EGRESS_PROBE[1]}`,
      `28 ${EGRESS_PROBE[2]}`,
      `7 ${EGRESS_PROBE[3]}`,
    ].join('\n');
    expect(egressLeaks(mixed)).toEqual(EGRESS_PROBE.filter((url) => url !== EGRESS_PROBE[3]));
  });

  it('never asks the provider to refuse the VM’s own link-local network', () => {
    expect(PROVIDER_DENY_OUT.some((range) => range.startsWith('169.254.'))).toBe(false);
    expect(PROVIDER_DENY_OUT).toEqual(['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16']);
  });
});
