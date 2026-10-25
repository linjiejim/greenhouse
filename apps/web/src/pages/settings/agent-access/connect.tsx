/**
 * Connect an agent — a step-by-step wizard per client (Codex, Claude Code,
 * Cursor, any other MCP client):
 *
 *   1. pick the client
 *   2. copy-ready setup: the MCP URL and the client's own commands (checked
 *      against codex-cli and claude: add the server, then sign in once — OAuth
 *      in the browser), plus the model gateway for that client when it can use
 *      it (Claude Code on `/api/gateway/anthropic` when an Anthropic-wire
 *      upstream exists; OpenAI-compatible tools and Cursor on Chat Completions;
 *      Codex cannot, it only speaks the Responses API the gateway does not serve)
 *   3. "检查连接": whether that client reached the MCP server in the last few
 *      minutes (GET /api/agent-access/connections — the last use of the
 *      member's own OAuth tokens)
 *   4. tips: call team_context first, prompts, data_catalog
 */

import React, { useState } from 'react';
import type { GatewayOverview } from '@greenhouse/types/agent-access';
import type { AgentClientKind, AgentConnectionsCheck } from '@greenhouse/types/hub-context';
import { Button, Card } from '../../../components/ui';
import { Check, CheckCircle2, Clock, Copy, Cpu, Lightbulb, Plug, RefreshCw, ShieldCheck } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { timeAgo } from '../../../lib/utils';
import { fetchAgentConnections } from '../../../lib/api/agent-access';

/** "Seen in the last minutes" — long enough for a sign-in and a first call. */
export const RECENT_CONNECTION_MS = 10 * 60_000;

const CLIENTS: AgentClientKind[] = ['codex', 'claude-code', 'cursor', 'other'];

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={t('agentAccess.copy')}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? t('agentAccess.copied') : t('agentAccess.copy')}
    </Button>
  );
}

function Snippet({ title, code, testId }: { title: string; code: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-fg-secondary">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre className="text-caption leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded-md p-2.5 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

function UrlBox({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-fg-secondary mb-1">{label}</div>
      <code className="block truncate text-xs font-mono text-fg bg-surface-sunken rounded-md px-2.5 py-2">{value}</code>
    </div>
  );
}

function Step({
  index,
  title,
  children,
  testId,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary-fg-strong">
          {index}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {children}
        </div>
      </div>
    </Card>
  );
}

/**
 * Copy-ready config for the model gateway, for the chosen client; every value
 * is what the gateway really accepts. The Claude Code part appears only when
 * some model has an Anthropic-wire upstream (models.yaml `anthropic_base_url`).
 */
function GatewayGuide({
  gateway,
  client,
  onOpenKeys,
}: {
  gateway: GatewayOverview;
  client: AgentClientKind;
  onOpenKeys: () => void;
}) {
  const t = useT();
  const base = gateway.base_url;
  const openaiModels = gateway.models.filter((entry) => entry.openai).map((entry) => entry.id);
  const anthropicModels = gateway.models.filter((entry) => entry.anthropic).map((entry) => entry.id);
  const model = openaiModels[0] ?? 'flash';
  const sdk = [`export OPENAI_BASE_URL=${base}`, 'export OPENAI_API_KEY=ghgw_…'].join('\n');
  const curl = [
    `curl ${base}/chat/completions \\`,
    '  -H "Authorization: Bearer $GREENHOUSE_GATEWAY_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`,
  ].join('\n');
  const claudeModel = anthropicModels[0];
  const claude = claudeModel
    ? [
        `export ANTHROPIC_BASE_URL=${gateway.anthropic_base_url}`,
        'export ANTHROPIC_AUTH_TOKEN=ghgw_…',
        `export ANTHROPIC_MODEL=${claudeModel}`,
        `export ANTHROPIC_DEFAULT_OPUS_MODEL=${claudeModel}`,
        `export ANTHROPIC_DEFAULT_SONNET_MODEL=${claudeModel}`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${claudeModel}`,
        `export CLAUDE_CODE_SUBAGENT_MODEL=${claudeModel}`,
        'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        'claude',
      ].join('\n')
    : null;
  const showOpenAi = client === 'cursor' || client === 'other';
  return (
    <div className="space-y-3 border-t border-edge pt-3" data-testid="gateway-guide">
      <div className="flex items-start gap-2">
        <Cpu size={16} className="text-primary-fg mt-0.5 flex-shrink-0" />
        <div>
          <h4 className="text-xs font-semibold text-fg">{t('gateway.guideTitle')}</h4>
          <p className="text-xs text-fg-muted mt-1 leading-relaxed">{t('gateway.guideIntro')}</p>
        </div>
      </div>
      {client === 'codex' ? (
        <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideCodex')}</p>
      ) : (
        <>
          {!gateway.enabled && <p className="text-xs text-warning leading-relaxed">{t('gateway.disabledNotice')}</p>}
          <p className="text-xs text-fg-muted leading-relaxed">
            {t('gateway.guideKey')}{' '}
            <button type="button" className="text-primary-fg hover:underline" onClick={onOpenKeys}>
              {t('gateway.guideKeyLink')}
            </button>
          </p>
          {client === 'claude-code' &&
            (claude ? (
              <div className="space-y-3" data-testid="gateway-guide-claude">
                <div className="grid gap-3 sm:grid-cols-2">
                  <UrlBox label={t('gateway.anthropicBaseUrl')} value={gateway.anthropic_base_url} />
                  <UrlBox label={t('gateway.modelIds')} value={anthropicModels.join(', ')} />
                </div>
                <Snippet title={t('gateway.guideClaude')} code={claude} />
                <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideClaudeNote')}</p>
              </div>
            ) : (
              <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideNoAnthropic')}</p>
            ))}
          {showOpenAi && (
            <div className="space-y-3" data-testid="gateway-guide-openai">
              <div className="grid gap-3 sm:grid-cols-2">
                <UrlBox label={t('gateway.baseUrl')} value={base} />
                <UrlBox label={t('gateway.modelIds')} value={openaiModels.join(', ') || '—'} />
              </div>
              <Snippet title={t('gateway.guideSdk')} code={sdk} />
              <Snippet title={t('gateway.guideCurl')} code={curl} />
              {client === 'cursor' && (
                <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideCursor')}</p>
              )}
            </div>
          )}
          <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideLimits')}</p>
        </>
      )}
    </div>
  );
}

/** The client's own setup commands; each is that client's real CLI or config file. */
function ClientSetup({ client, mcpUrl }: { client: AgentClientKind; mcpUrl: string }) {
  const t = useT();
  if (client === 'codex') {
    return (
      <>
        <Snippet
          testId="connect-snippet"
          title={t('agentAccess.connectCodex')}
          code={`codex mcp add greenhouse --url ${mcpUrl}\ncodex mcp login greenhouse`}
        />
        <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.oauthCodex')}</p>
      </>
    );
  }
  if (client === 'claude-code') {
    return (
      <>
        <Snippet
          testId="connect-snippet"
          title={t('agentAccess.connectClaude')}
          code={`claude mcp add --transport http greenhouse ${mcpUrl}`}
        />
        <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.oauthClaude')}</p>
      </>
    );
  }
  if (client === 'cursor') {
    return (
      <>
        <Snippet
          testId="connect-snippet"
          title={t('agentAccess.connectCursor')}
          code={JSON.stringify({ mcpServers: { greenhouse: { url: mcpUrl } } }, null, 2)}
        />
        <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.oauthCursor')}</p>
      </>
    );
  }
  return (
    <>
      <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.otherHttp')}</p>
      <Snippet testId="connect-snippet" title={t('agentAccess.connectOther')} code={`npx -y mcp-remote ${mcpUrl}`} />
      <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.oauthOther')}</p>
    </>
  );
}

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'failed'; message: string }
  | { status: 'done'; result: AgentConnectionsCheck };

function ConnectionCheck({ client }: { client: AgentClientKind }) {
  const t = useT();
  const [state, setState] = useState<CheckState>({ status: 'idle' });

  const run = async () => {
    setState({ status: 'checking' });
    try {
      setState({ status: 'done', result: await fetchAgentConnections() });
    } catch (err) {
      setState({ status: 'failed', message: err instanceof Error ? err.message : t('agentAccess.wizard.checkFailed') });
    }
  };

  let verdict: React.ReactNode = null;
  if (state.status === 'failed') {
    verdict = <p className="text-xs text-danger">{state.message}</p>;
  } else if (state.status === 'done') {
    const now = Date.parse(state.result.now);
    const mine = state.result.connections.filter((entry) => client === 'other' || entry.kind === client);
    const recent = mine.find(
      (entry) => entry.last_seen_at && now - Date.parse(entry.last_seen_at) <= RECENT_CONNECTION_MS,
    );
    const earlier = mine.find((entry) => entry.last_seen_at);
    verdict = recent ? (
      <p className="flex items-center gap-1.5 text-xs text-success" data-testid="connect-check-ok">
        <CheckCircle2 size={14} />
        {t('agentAccess.wizard.checkOk', { name: recent.client_name, ago: timeAgo(recent.last_seen_at!) })}
      </p>
    ) : earlier ? (
      <p className="flex items-center gap-1.5 text-xs text-warning" data-testid="connect-check-stale">
        <Clock size={14} />
        {t('agentAccess.wizard.checkStale', { name: earlier.client_name, ago: timeAgo(earlier.last_seen_at!) })}
      </p>
    ) : mine.length > 0 ? (
      <p className="text-xs text-warning" data-testid="connect-check-never">
        {t('agentAccess.wizard.checkNeverCalled', { name: mine[0]!.client_name })}
      </p>
    ) : (
      <p className="text-xs text-fg-muted" data-testid="connect-check-none">
        {t('agentAccess.wizard.checkNone')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.checkIntro')}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void run()}
        disabled={state.status === 'checking'}
        data-testid="connect-check"
      >
        <RefreshCw size={14} className={state.status === 'checking' ? 'animate-spin' : ''} />
        {state.status === 'checking' ? t('agentAccess.wizard.checking') : t('agentAccess.wizard.check')}
      </Button>
      {verdict}
    </div>
  );
}

export function ConnectGuide({
  mcpUrl,
  gateway,
  onOpenGatewayKeys,
  initialClient = null,
}: {
  mcpUrl: string;
  gateway: GatewayOverview | null;
  onOpenGatewayKeys: () => void;
  initialClient?: AgentClientKind | null;
}) {
  const t = useT();
  const [client, setClient] = useState<AgentClientKind | null>(initialClient);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <Step index={1} title={t('agentAccess.wizard.pickTitle')}>
          <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.connectIntro')}</p>
          <div role="radiogroup" aria-label={t('agentAccess.wizard.pickTitle')} className="grid gap-2 sm:grid-cols-4">
            {CLIENTS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={client === kind}
                data-testid={`connect-client-${kind}`}
                onClick={() => setClient(kind)}
                className={`rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors ${
                  client === kind
                    ? 'border-accent bg-primary-subtle text-primary-fg-strong'
                    : 'border-edge text-fg-secondary hover:bg-surface-sunken'
                }`}
              >
                {t(`agentAccess.wizard.client.${kind}`)}
              </button>
            ))}
          </div>
        </Step>
        {client ? (
          <>
            <Step index={2} title={t('agentAccess.wizard.setupTitle')} testId="connect-step-setup">
              <div>
                <div className="text-xs font-medium text-fg-secondary mb-1">{t('agentAccess.endpoint')}</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate text-xs font-mono text-fg bg-surface-sunken rounded-md px-2.5 py-2">
                    {mcpUrl}
                  </code>
                  <CopyButton text={mcpUrl} />
                </div>
              </div>
              <ClientSetup client={client} mcpUrl={mcpUrl} />
              <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.wizard.scopes')}</p>
              {gateway && <GatewayGuide gateway={gateway} client={client} onOpenKeys={onOpenGatewayKeys} />}
            </Step>
            <Step index={3} title={t('agentAccess.wizard.checkTitle')} testId="connect-step-check">
              <ConnectionCheck key={client} client={client} />
            </Step>
            <Step index={4} title={t('agentAccess.wizard.tipsTitle')} testId="connect-step-tips">
              <ul className="space-y-1.5 text-xs text-fg-secondary leading-relaxed">
                {(['tipTeamContext', 'tipPrompts', 'tipCatalog'] as const).map((key) => (
                  <li key={key} className="flex gap-1.5">
                    <Lightbulb size={13} className="mt-0.5 flex-shrink-0 text-primary-fg" />
                    <span>{t(`agentAccess.wizard.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </Step>
          </>
        ) : (
          <p className="flex items-center gap-1.5 px-1 text-xs text-fg-faint">
            <Plug size={13} />
            {t('agentAccess.wizard.pickFirst')}
          </p>
        )}
      </div>
      <Card className="p-4 space-y-2 h-fit">
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-primary-fg" />
          <h3 className="text-sm font-semibold text-fg">{t('agentAccess.howWritesWork')}</h3>
        </div>
        <ul className="space-y-1.5 text-xs text-fg-secondary leading-relaxed list-disc pl-4">
          <li>{t('agentAccess.howWrites1')}</li>
          <li>{t('agentAccess.howWrites2')}</li>
          <li>{t('agentAccess.howWrites3')}</li>
          <li>{t('agentAccess.howWrites4')}</li>
        </ul>
      </Card>
    </div>
  );
}
