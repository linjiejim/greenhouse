/**
 * "生成本月复盘" — writes (or updates) this month's retro doc now, the same
 * document the scheduled job writes on the 1st, and links to it. Super only
 * (the page itself is Administration; the server checks too).
 */

import React, { useState } from 'react';
import type { RetroResult } from '@greenhouse/types/hub-context';
import { Button, toast } from '@greenhouse/web/extension-kit';
import { ExternalLink, ScrollText } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';
import { generateRetro } from './api.js';

export function RetroButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetroResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const next = await generateRetro();
      setResult(next);
      toast(
        next.skipped_reason
          ? t(`ext.retro.skipped.${next.skipped_reason}`, { month: next.month })
          : t('ext.retro.done', { month: next.month }),
        next.skipped_reason ? 'warning' : 'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.retro.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {result && (
        <a
          href={result.url}
          className="inline-flex items-center gap-1 text-xs text-primary-fg hover:underline"
          data-testid="retro-open"
        >
          <ExternalLink size={12} />
          {t('ext.retro.open', { month: result.month })}
        </a>
      )}
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy} data-testid="retro-generate">
        <ScrollText size={14} />
        {busy ? t('ext.retro.generating') : t('ext.retro.generate')}
      </Button>
    </div>
  );
}
