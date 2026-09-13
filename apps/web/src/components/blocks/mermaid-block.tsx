/**
 * MermaidBlock — renders a ```mermaid fence as a themed vector diagram.
 *
 * Mermaid is by far the heaviest dependency in the web bundle, so it is loaded
 * on first use only (same shape as ChartBlock's `import('chart.js/auto')`) —
 * a session that never asks for a diagram never pays for one.
 *
 * Two properties matter more than the rendering itself:
 *  - `securityLevel: 'strict'`. The diagram source is model output, i.e.
 *    untrusted input. Strict disables mermaid's click/href directives, so a
 *    diagram cannot become a navigation or script surface.
 *  - A parse failure falls back to the plain code block. Models do get the
 *    syntax wrong, and showing what they drew beats an empty card.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { IconButton } from '../ui';
import { useT } from '../../lib/i18n';

/** Mermaid needs literal colors; the design system owns them as CSS variables. */
function readThemeVar(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

function readMermaidTheme(_revision: number) {
  const surface = readThemeVar('--t-surface-raised', '#ffffff');
  const text = readThemeVar('--t-fg', '#1f2a20');
  const edge = readThemeVar('--t-edge-strong', '#cbd7c8');
  const primary = readThemeVar('--t-primary-500', '#2E8B3D');
  const muted = readThemeVar('--t-surface-muted', '#f2f6f0');
  return {
    // `base` is the only built-in theme that honours themeVariables wholesale.
    background: surface,
    primaryColor: muted,
    primaryTextColor: text,
    primaryBorderColor: primary,
    secondaryColor: surface,
    secondaryTextColor: text,
    secondaryBorderColor: edge,
    tertiaryColor: surface,
    tertiaryTextColor: text,
    tertiaryBorderColor: edge,
    lineColor: edge,
    textColor: text,
    mainBkg: muted,
    nodeBorder: primary,
    clusterBkg: surface,
    clusterBorder: edge,
    titleColor: text,
    edgeLabelBackground: surface,
    fontFamily: '"Nunito Sans", system-ui, sans-serif',
    fontSize: '14px',
  };
}

/** Stable per-instance id — mermaid injects a <style> keyed on it. */
let renderSeq = 0;

/**
 * Remove the scratch element mermaid lays out in, if it survived.
 *
 * `render()` normally cleans up after itself, but not on every throw path: the
 * `d<id>` div can be left attached to <body> carrying mermaid's own red "Syntax
 * error in text / mermaid version 11.x" graphic, which then floats at the
 * bottom of the page outside any message and no unmount takes it away
 * (reproduced in the browser, 2026-08-08; `suppressErrorRendering` alone did
 * not prevent it). Validating with `parse()` first keeps us off that path;
 * this is the backstop for the ones we haven't hit.
 */
function removeMermaidScratch(id: string): void {
  document.getElementById(`d${id}`)?.remove();
}

export function MermaidBlock({ code, compact = false }: { code: string; compact?: boolean }) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const idRef = useRef(`mermaid-${(renderSeq += 1)}`);

  const themeVariables = useMemo(() => readMermaidTheme(themeRevision), [themeRevision]);

  // Theme switches flip data-theme on the root; the SVG carries baked-in colors
  // so it has to be re-rendered rather than restyled.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let mounted = true;
    setFailed(null);
    // Captured for the cleanup closure: the id never changes for an instance,
    // but reading a ref during cleanup is the lint rule's (fair) complaint.
    const renderId = idRef.current;
    import('mermaid')
      .then(async (module) => {
        const mermaid = module.default ?? module;
        mermaid.initialize({
          startOnLoad: false,
          // Model-authored source is untrusted: no click handlers, no hrefs.
          securityLevel: 'strict',
          // Without this, a failed parse leaves mermaid's own red "Syntax error
          // in text / mermaid version 11.x" SVG attached to <body>, outside the
          // React tree — it floats at the bottom of the page and no unmount
          // ever takes it away. We render our own fallback instead.
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables,
          flowchart: { htmlLabels: false, curve: 'basis' },
        });
        // Validate BEFORE rendering. `parse()` runs the grammar and touches no
        // DOM at all, so a model's syntax error never reaches the code path
        // that can strand mermaid's error graphic on <body>.
        await mermaid.parse(code);
        const { svg: rendered } = await mermaid.render(renderId, code);
        if (mounted) setSvg(rendered);
      })
      .catch((err: unknown) => {
        // Syntax errors are the common case and are the model's, not the user's.
        removeMermaidScratch(renderId);
        if (mounted) setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      mounted = false;
      removeMermaidScratch(renderId);
    };
  }, [code, themeVariables]);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // clipboard denied — the source is visible in the fallback anyway
    }
  };

  const downloadSvg = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'diagram.svg';
    link.click();
    URL.revokeObjectURL(url);
  };

  // Fail open to the source. An unreadable diagram is a model mistake; hiding
  // it entirely would also hide what the model was trying to say.
  if (failed) {
    return (
      <RichBlockShell
        compact={compact}
        tone="muted"
        header={<span className="text-xs text-fg-muted">{t('common.diagramRenderFailed')}</span>}
      >
        <div className={richBlockBodyClass(compact)}>
          <pre className="hl-pre overflow-x-auto text-xs">
            <code>{code}</code>
          </pre>
        </div>
      </RichBlockShell>
    );
  }

  return (
    <RichBlockShell
      compact={compact}
      header={
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">{t('common.diagram')}</span>
          <div className="flex-1" />
          <IconButton label={t('common.copySource')} onClick={copySource} size="compact">
            <Copy size={12} />
          </IconButton>
          <IconButton label={t('common.downloadSvg')} onClick={downloadSvg} size="compact" disabled={!svg}>
            <Download size={12} />
          </IconButton>
        </div>
      }
    >
      <div className={richBlockBodyClass(compact)}>
        {svg ? (
          <div
            className="mermaid-diagram max-h-[70vh] overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            // mermaid renders with securityLevel:'strict', which sanitizes the
            // diagram source before it reaches this markup.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="h-24 animate-skeleton rounded-md bg-surface-muted" />
        )}
      </div>
    </RichBlockShell>
  );
}
