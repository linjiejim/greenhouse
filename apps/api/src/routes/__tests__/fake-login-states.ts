/**
 * In-memory stand-in for `db.oauthLoginStates` in the Feishu / WeCom route unit
 * tests: same contract (issue, consume once, provider + kind must match, expiry
 * against the current clock). The SQL itself — hashing, the conditional UPDATE,
 * the race — is pinned by packages/db/src/services/oauth-login-states.db.test.ts and
 * tests/db/security-state.db-commit.test.ts.
 */

interface Entry {
  provider: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: number;
  consumed: boolean;
}

const entries = new Map<string, Entry>();

export const fakeLoginStates = {
  async issue(input: {
    value: string;
    provider: string;
    kind: string;
    payload: Record<string, unknown>;
    expiresAt: string;
  }): Promise<void> {
    entries.set(input.value, {
      provider: input.provider,
      kind: input.kind,
      payload: structuredClone(input.payload),
      expiresAt: Date.parse(input.expiresAt),
      consumed: false,
    });
  },
  async consume(input: { value: string; provider: string; kind: string }): Promise<Record<string, unknown> | null> {
    const entry = entries.get(input.value);
    if (!entry || entry.consumed || entry.provider !== input.provider || entry.kind !== input.kind) return null;
    if (entry.expiresAt <= Date.now()) return null;
    entry.consumed = true;
    return structuredClone(entry.payload);
  },
};
