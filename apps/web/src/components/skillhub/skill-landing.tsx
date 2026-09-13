/**
 * SkillHubLanding — shown when no skill is selected. Introduces the library,
 * shows per-group counts, and walks a member through wiring SkillHub into their
 * own AI tool (connect MCP → tools self-document; install output skills on
 * demand via skill_query). This page is the bootstrap.
 *
 * SkillHub's real use happens in each member's own MCP client; the web's value
 * here is "understand + get started". See spec D7.
 */

import React, { useMemo, useState } from 'react';
import { Button, toast } from '../ui';
import { Copy, Package, Upload } from '../../lib/icons';
import { useAuthStore } from '../../stores';
import { countSkillOrigins, ORIGIN_ORDER } from './grouping';
import { SkillUploadDialog } from './skill-upload-dialog';
import { useSkills } from './use-skills';
import { useT } from '../../lib/i18n';

// The MCP endpoint of the deployment the user is looking at — same origin as
// the web app, so a self-hosted instance never has to configure it separately.
const MCP_URL = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/mcp`;
const CONNECT_CMD = `claude mcp add --transport http greenhouse ${MCP_URL}`;

async function copy(text: string, okMsg: string, errorMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, 'success');
  } catch {
    toast(errorMsg, 'error');
  }
}

function CopyBlock({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="flex items-stretch gap-2">
      <pre className="flex-1 min-w-0 overflow-x-auto rounded-md bg-surface-sunken border border-edge px-3 py-2 text-xs font-mono text-fg-secondary">
        {text}
      </pre>
      <button
        onClick={() => copy(text, t('common.copied'), t('skillHub.copyFailed'))}
        className="flex-shrink-0 px-2 rounded-md border border-edge text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
        title={t('common.copy')}
        aria-label={t('skillHub.copyToClipboard')}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

export function SkillHubLanding({ showHeader = true }: { showHeader?: boolean }) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const { skills, loading } = useSkills();
  const [uploadOpen, setUploadOpen] = useState(false);

  const counts = useMemo(() => {
    const active = (skills ?? []).filter((s) => s.status === 'active');
    return countSkillOrigins(active, currentUser?.id);
  }, [skills, currentUser?.id]);

  return (
    <div className={`mx-auto max-w-3xl space-y-6 ${showHeader ? 'py-6' : 'py-1'}`}>
      {showHeader && (
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface-muted flex items-center justify-center">
            <Package size={20} className="text-fg-muted" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium text-fg">{t('skillHub.title')}</h1>
            <p className="mt-1 text-sm text-fg-muted max-w-2xl">{t('skillHub.description')}</p>
          </div>
          <Button size="sm" className="flex-shrink-0" onClick={() => setUploadOpen(true)}>
            <Upload size={14} className="mr-1" />
            {t('skillHub.upload')}
          </Button>
        </div>
      )}

      {/* Group counts */}
      <div className="grid grid-cols-3 gap-3">
        {ORIGIN_ORDER.map((key) => (
          <div key={key} className="rounded-lg border border-edge bg-surface-card px-4 py-3">
            <div className="text-2xl font-semibold text-fg">{loading ? '—' : counts[key]}</div>
            <div className="text-xs text-fg-muted mt-0.5">{t(`skillHub.group.${key}`)}</div>
          </div>
        ))}
      </div>

      {/* Getting started */}
      <div className="rounded-lg border border-edge bg-surface-card p-4 md:p-5 space-y-4">
        <div>
          <h2 className="text-sm font-medium text-fg">{t('skillHub.useInOwnTool')}</h2>
          <p className="mt-1 text-xs text-fg-muted">{t('skillHub.useInOwnToolHint')}</p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-secondary">{t('skillHub.connectMcp')}</div>
          <CopyBlock text={CONNECT_CMD} />
          <p className="text-[11px] text-fg-faint">{t('skillHub.connectMcpHint')}</p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-fg-secondary">{t('skillHub.startUsing')}</div>
          <p className="text-[11px] text-fg-faint">{t('skillHub.pasteToAgent')}</p>
          <CopyBlock text={t('skillHub.bootstrapPrompt')} />
        </div>
      </div>

      {showHeader && (
        <SkillUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onPublished={(name) => {
            window.location.hash = `#/skillhub/${name}`;
          }}
        />
      )}
    </div>
  );
}
