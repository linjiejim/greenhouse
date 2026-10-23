/**
 * Connect an agent — the MCP endpoint, copy-ready setup for the common
 * clients, and how writes are handled. Commands are the clients' real CLIs
 * (checked against codex-cli and claude): add the server, then sign in once.
 *
 * Below it, "Use the team's model quota": the OpenAI-compatible model gateway
 * (`/api/gateway/openai/v1`, Chat Completions + models only) with a personal
 * `ghgw_` key — config for Codex (chat wire API), Cursor, OpenAI SDKs and curl.
 */

import React, { useState } from 'react';
import type { GatewayOverview } from '@greenhouse/types/agent-access';
import { Button, Card } from '../../../components/ui';
import { Check, Copy, Cpu, Plug, ShieldCheck } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';

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

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-fg-secondary">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre className="text-[11px] leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded-lg p-2.5 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

/** Copy-ready config for the model gateway; every value is what the gateway really accepts. */
function GatewayGuide({ gateway, onOpenKeys }: { gateway: GatewayOverview; onOpenKeys: () => void }) {
  const t = useT();
  const base = gateway.base_url;
  const model = gateway.models[0]?.id ?? 'flash';
  const codex = [
    `model = "${model}"`,
    'model_provider = "greenhouse"',
    '',
    '[model_providers.greenhouse]',
    'name = "Greenhouse"',
    `base_url = "${base}"`,
    'env_key = "GREENHOUSE_GATEWAY_KEY"',
    'wire_api = "chat"',
  ].join('\n');
  const sdk = [`export OPENAI_BASE_URL=${base}`, 'export OPENAI_API_KEY=ghgw_…'].join('\n');
  const curl = [
    `curl ${base}/chat/completions \\`,
    '  -H "Authorization: Bearer $GREENHOUSE_GATEWAY_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`,
  ].join('\n');
  return (
    <Card className="p-4 space-y-4" data-testid="gateway-guide">
      <div className="flex items-start gap-2">
        <Cpu size={16} className="text-primary-fg mt-0.5 flex-shrink-0" />
        <div>
          <h3 className="text-sm font-semibold text-fg">{t('gateway.guideTitle')}</h3>
          <p className="text-xs text-fg-muted mt-1 leading-relaxed">{t('gateway.guideIntro')}</p>
        </div>
      </div>
      {!gateway.enabled && <p className="text-xs text-warning leading-relaxed">{t('gateway.disabledNotice')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-fg-secondary mb-1">{t('gateway.baseUrl')}</div>
          <code className="block truncate text-xs font-mono text-fg bg-surface-sunken rounded-lg px-2.5 py-2">
            {base}
          </code>
        </div>
        <div>
          <div className="text-xs font-medium text-fg-secondary mb-1">{t('gateway.modelIds')}</div>
          <code className="block truncate text-xs font-mono text-fg bg-surface-sunken rounded-lg px-2.5 py-2">
            {gateway.models.map((entry) => entry.id).join(', ') || '—'}
          </code>
        </div>
      </div>
      <p className="text-xs text-fg-muted leading-relaxed">
        {t('gateway.guideKey')}{' '}
        <button type="button" className="text-primary-fg hover:underline" onClick={onOpenKeys}>
          {t('gateway.guideKeyLink')}
        </button>
      </p>
      <Snippet title={t('gateway.guideCodex')} code={codex} />
      <Snippet title={t('gateway.guideSdk')} code={sdk} />
      <Snippet title={t('gateway.guideCurl')} code={curl} />
      <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideCursor')}</p>
      <p className="text-xs text-fg-muted leading-relaxed">{t('gateway.guideLimits')}</p>
    </Card>
  );
}

export function ConnectGuide({
  mcpUrl,
  gateway,
  onOpenGatewayKeys,
}: {
  mcpUrl: string;
  gateway: GatewayOverview | null;
  onOpenGatewayKeys: () => void;
}) {
  const t = useT();
  const cursor = JSON.stringify({ mcpServers: { greenhouse: { url: mcpUrl } } }, null, 2);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="p-4 space-y-4">
          <div className="flex items-start gap-2">
            <Plug size={16} className="text-primary-fg mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-fg">{t('agentAccess.connectTitle')}</h3>
              <p className="text-xs text-fg-muted mt-1 leading-relaxed">{t('agentAccess.connectIntro')}</p>
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-fg-secondary mb-1">{t('agentAccess.endpoint')}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs font-mono text-fg bg-surface-sunken rounded-lg px-2.5 py-2">
                {mcpUrl}
              </code>
              <CopyButton text={mcpUrl} />
            </div>
          </div>
          <Snippet
            title={t('agentAccess.connectCodex')}
            code={`codex mcp add greenhouse --url ${mcpUrl}\ncodex mcp login greenhouse`}
          />
          <Snippet
            title={t('agentAccess.connectClaude')}
            code={`claude mcp add --transport http greenhouse ${mcpUrl}`}
          />
          <Snippet title={t('agentAccess.connectCursor')} code={cursor} />
          <Snippet title={t('agentAccess.connectOther')} code={`npx -y mcp-remote ${mcpUrl}`} />
          <p className="text-xs text-fg-muted leading-relaxed">{t('agentAccess.connectAfter')}</p>
        </Card>
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
      {gateway && <GatewayGuide gateway={gateway} onOpenKeys={onOpenGatewayKeys} />}
    </div>
  );
}
