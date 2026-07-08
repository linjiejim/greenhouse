/**
 * SSO connector registry — env-driven built-ins + fork extensions.
 *
 * Built-in connectors register only when their env group is COMPLETE; a
 * partial group refuses to start (same fail-fast contract as SKILLS_S3_*) —
 * silently disabling a half-configured IdP would read as "SSO is broken".
 * No SSO env at all simply means no providers (email/password login only).
 *
 * `getSsoConnectors()` is called once from main() so misconfiguration fails
 * at startup, not on the first login attempt.
 */

import { logger } from '@greenhouse/utils/logger';
import type { SsoConnector } from './types.js';
import { createWecomConnector } from './wecom.js';
import { createFeishuConnector } from './feishu.js';
import { EXTENSION_SSO_CONNECTORS } from './extensions.js';

let _connectors: Map<string, SsoConnector> | null = null;

// ─── JIT provisioning config ─────────────────────────────

export function autoProvisionEnabled(): boolean {
  return process.env.SSO_AUTO_PROVISION === 'true';
}

/** JIT account role — 'team' | 'external' only (never super). Invalid values throw. */
export function autoProvisionRole(): 'team' | 'external' {
  const raw = process.env.SSO_AUTO_PROVISION_ROLE ?? 'team';
  if (raw !== 'team' && raw !== 'external') {
    throw new Error(`Invalid SSO_AUTO_PROVISION_ROLE "${raw}" — must be 'team' or 'external'.`);
  }
  return raw;
}

function buildBuiltinConnectors(): SsoConnector[] {
  const out: SsoConnector[] = [];

  const wecom = {
    corpId: process.env.SSO_WECOM_CORP_ID,
    agentId: process.env.SSO_WECOM_AGENT_ID,
    secret: process.env.SSO_WECOM_SECRET,
  };
  const wecomSet = Object.values(wecom).filter(Boolean).length;
  if (wecomSet === 3) {
    out.push(createWecomConnector({ corpId: wecom.corpId!, agentId: wecom.agentId!, secret: wecom.secret! }));
  } else if (wecomSet > 0) {
    throw new Error(
      'Partial WeCom SSO config: set ALL of SSO_WECOM_CORP_ID / SSO_WECOM_AGENT_ID / SSO_WECOM_SECRET, or none.',
    );
  }

  const feishu = {
    appId: process.env.SSO_FEISHU_APP_ID,
    appSecret: process.env.SSO_FEISHU_APP_SECRET,
  };
  const feishuSet = Object.values(feishu).filter(Boolean).length;
  if (feishuSet === 2) {
    out.push(
      createFeishuConnector({
        appId: feishu.appId!,
        appSecret: feishu.appSecret!,
        baseUrl: process.env.SSO_FEISHU_BASE_URL,
      }),
    );
  } else if (feishuSet > 0) {
    throw new Error('Partial Feishu SSO config: set BOTH SSO_FEISHU_APP_ID and SSO_FEISHU_APP_SECRET, or neither.');
  }

  return out;
}

/** All enabled connectors (built once). Throws on a partial env group. */
export function getSsoConnectors(): SsoConnector[] {
  if (!_connectors) {
    autoProvisionRole(); // startup validation — an invalid role must not surface on first JIT login
    const map = new Map<string, SsoConnector>();
    for (const connector of [...buildBuiltinConnectors(), ...EXTENSION_SSO_CONNECTORS]) {
      if (map.has(connector.id)) {
        throw new Error(`Duplicate SSO connector id: ${connector.id}`);
      }
      map.set(connector.id, connector);
    }
    _connectors = map;
    if (map.size > 0) {
      logger.info('[sso] enabled providers', { providers: [...map.keys()] });
    }
  }
  return [..._connectors.values()];
}

export function getSsoConnector(id: string): SsoConnector | undefined {
  getSsoConnectors();
  return _connectors!.get(id);
}

/** Reset the registry cache (env-dependent tests only). */
export function _resetSsoConnectorsForTests(): void {
  _connectors = null;
}
