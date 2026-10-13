/**
 * What a hosted computer's two member accounts may reach (ported from v1, live-verified on E2B).
 *
 * Inside the microVM an nftables table filters only packets of sockets owned by `agent` or
 * `browser`: the Agent's shell, the member's terminal, background jobs and the browser. Root (the
 * provider's agent envd, the boot script, the provider's port forwarders) is untouched. The
 * members' processes cannot reach:
 * - the VM's link-local network, 169.254.0.0/16: Firecracker's metadata service (MMDS) at
 *   169.254.169.254, which answers any process that asks; the gateway; and the VM's own address,
 *   where the provider's port forwarders listen;
 * - private and reserved ranges (the provider refuses them as well, PROVIDER_DENY_OUT; this holds
 *   whatever it does);
 * - the provider's agent (envd, :49983), the two bridges (:7681, :7682, only ever reached from
 *   outside through the provider's edge) and rpcbind (:111).
 * The internet, DNS and the computer's own loopback services stay open.
 *
 * The adapter applies the table as root at every start, so the rules belong to the API version,
 * not the template, and then probes from both accounts before the computer is used: one whose
 * rules are not in force never is.
 *
 * Packets are matched by owner and jump into a member-only chain. The kernel's own replies (the
 * ICMP "prohibited" that ends a refused connection at once) have no owner and pass; filtered too
 * (they go to the VM's own link-local address), every refusal would hang until a timeout.
 */

/** IPv4 ranges no member process may reach (link-local is a rule of its own). */
const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/3',
];

/** Ports on the VM itself no member process may connect to, on any address. */
export const BLOCKED_PORTS = { rpcbind: 111, browserBridge: 7681, agentBridge: 7682, envd: 49983 } as const;

/** The table (nft syntax). Loading it replaces the previous one, so it is applied on every start. */
export const EGRESS_RULESET = `table inet gh_egress
delete table inet gh_egress
table inet gh_egress {
	chain output {
		type filter hook output priority filter; policy accept;
		meta skuid { "agent", "browser" } jump member
	}
	chain member {
		ip daddr 169.254.0.0/16 reject with icmpx admin-prohibited
		ip daddr { ${BLOCKED_V4.join(', ')} } reject with icmpx admin-prohibited
		ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } reject with icmpx admin-prohibited
		tcp dport { ${Object.values(BLOCKED_PORTS).join(', ')} } reject with tcp reset
		udp dport ${BLOCKED_PORTS.rpcbind} reject with icmpx admin-prohibited
	}
}
`;

/**
 * Run as root with GH_EGRESS_NFT (the ruleset, base64): load the table, prove the member chain is
 * there, and stop rpcbind, which the provider's image runs and nothing needs.
 */
export const EGRESS_APPLY_SCRIPT = [
  'set -e',
  'printf %s "$GH_EGRESS_NFT" | base64 -d | nft -f -',
  'nft list chain inet gh_egress member >/dev/null',
  'systemctl disable --now --quiet rpcbind.socket rpcbind.service 2>/dev/null || true',
].join('\n');

export const egressApplyEnv = (): Record<string, string> => ({
  GH_EGRESS_NFT: Buffer.from(EGRESS_RULESET, 'utf8').toString('base64'),
});

/**
 * The provider's own filter for every new computer, outside the VM, so not even root in it gets
 * past: the private ranges. Never link-local: that is the VM's own network (its gateway and the
 * metadata service the provider's agent relies on).
 */
export const PROVIDER_DENY_OUT = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16'];

/** Tried from each member account before a computer is used: every one must be refused (curl exit 7). */
export const EGRESS_PROBE = [
  'http://169.254.169.254/',
  `http://127.0.0.1:${BLOCKED_PORTS.envd}/health`,
  `http://127.0.0.1:${BLOCKED_PORTS.browserBridge}/`,
  `http://127.0.0.1:${BLOCKED_PORTS.agentBridge}/`,
  `http://127.0.0.1:${BLOCKED_PORTS.rpcbind}/`,
  'http://10.0.0.1/',
];

/** The probe as one shell command: a line `<curl exit> <url>` per target. */
export const EGRESS_PROBE_ARGV = [
  'sh',
  '-c',
  `for u in ${EGRESS_PROBE.join(' ')}; do curl -sS -m 5 --noproxy '*' -o /dev/null "$u" 2>/dev/null; echo "$? $u"; done`,
];

/** The targets a probe's output says were reached (anything but a refused connection). */
export function egressLeaks(stdout: string): string[] {
  const codes = new Map(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' '))
      .map(([code, url]) => [url ?? '', Number(code)] as const),
  );
  return EGRESS_PROBE.filter((url) => codes.get(url) !== 7);
}
