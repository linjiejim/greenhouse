/**
 * What a hosted computer's two member uids may reach (BOTS_COMPUTER_DRIVER=e2b).
 *
 * Inside the microVM an nftables table filters only packets of sockets owned by `agent` or
 * `browser` — the member's Bots, terminal, background jobs and browser. Root (the provider's
 * agent envd, the boot script, the provider's port forwarders) is untouched. The members'
 * processes cannot reach:
 * - the VM's link-local network, 169.254.0.0/16: Firecracker's metadata service (MMDS) at
 *   169.254.169.254, which answers any process that asks; the gateway; and the VM's own
 *   address, where the provider's port forwarders listen;
 * - private and reserved ranges (the provider refuses them as well — PROVIDER_DENY_OUT —
 *   this holds whatever it does);
 * - the provider's agent (envd, :49983), the two bridges (:7681, :7682 — each is only ever
 *   reached from outside, through the provider's edge) and rpcbind (:111).
 * The internet, DNS (the VM resolves through 8.8.8.8) and the computer's own loopback services
 * (what a port preview opens) stay open.
 *
 * The API applies the table as root at every boot (e2b-host.ts). The rules belong to the API
 * version, not the template: every computer gets them, one still on an older template too, and
 * a change never rebuilds the template (which would move every member's home). The controller
 * then probes from both uids before a computer is used (HOSTED_EGRESS_PROBE): one whose rules
 * are not in force never is (`egress_open`).
 *
 * Packets are matched by owner and jump into a member-only chain. The kernel's own replies —
 * the ICMP "prohibited" that ends a refused connection at once — have no owner and pass;
 * filtered too (they go to the VM's own link-local address), every refusal would hang until a
 * timeout instead.
 */

import type { ComputerUser } from './host.js';

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

/** The table (nft syntax). Loading it replaces the previous one, so it is applied on every boot. */
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
 * Run as root (envs: GH_EGRESS_NFT = the ruleset, base64): load the table, prove the member chain
 * is there, and stop rpcbind — the provider's image runs it and nothing needs it.
 */
export const EGRESS_APPLY_SCRIPT = [
  'set -e',
  'printf %s "$GH_EGRESS_NFT" | base64 -d | nft -f -',
  'nft list chain inet gh_egress member >/dev/null',
  'systemctl disable --now --quiet rpcbind.socket rpcbind.service 2>/dev/null || true',
].join('\n');

export function egressApplyEnv(): Record<string, string> {
  return { GH_EGRESS_NFT: Buffer.from(EGRESS_RULESET, 'utf8').toString('base64') };
}

/**
 * The provider's own egress filter for every new sandbox — outside the VM, so not even root in it
 * gets past: the private ranges. Not link-local: that is the VM's own network (its gateway, the
 * metadata service the provider's agent relies on).
 */
export const PROVIDER_DENY_OUT = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16'];

/** Checked from each member uid before a computer is used: every one must be refused. */
export const HOSTED_EGRESS_PROBE = [
  'http://169.254.169.254/',
  `http://127.0.0.1:${BLOCKED_PORTS.envd}/health`,
  `http://127.0.0.1:${BLOCKED_PORTS.browserBridge}/`,
  `http://127.0.0.1:${BLOCKED_PORTS.agentBridge}/`,
  `http://127.0.0.1:${BLOCKED_PORTS.rpcbind}/`,
  'http://10.0.0.1/',
];

export const HOSTED_EGRESS_PROBE_USERS: readonly ComputerUser[] = ['agent', 'browser'];
