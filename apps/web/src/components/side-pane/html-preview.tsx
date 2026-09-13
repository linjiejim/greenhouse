/**
 * HTML preview — model-authored markup rendered in an isolated iframe.
 *
 * This is the one place in the app that runs HTML it did not write, so the
 * isolation is the feature and everything else is packaging:
 *
 *   `srcdoc` + `sandbox="allow-scripts"`, and deliberately NOT
 *   `allow-same-origin`.
 *
 * Those two together give the frame an *opaque* origin: scripts run, so an
 * interactive prototype actually works, but the document cannot reach this
 * page's localStorage, cookies, `window.parent`, or any same-origin API — it
 * cannot read the session token it would need to act as the user. Adding
 * `allow-same-origin` alongside `allow-scripts` would undo the whole thing;
 * the pair is equivalent to no sandbox at all.
 *
 * `srcdoc` rather than a `blob:` URL for the same reason the attachments block
 * refuses to preview HTML: a blob URL inherits the creating page's origin, so
 * opening attacker-authored markup that way runs it *as this session*. It is
 * also why there is no "open in new tab" here — that would be the same hole
 * wearing a different button.
 *
 * The parent page's CSP still applies to the frame's own network requests, so
 * `connect-src 'self' …` bounds where a script inside could send anything.
 *
 * PDF export holds the same line. Print is a browser capability, not a server
 * one — the report skills already ship print stylesheets, so the browser's own
 * "save as PDF" is the highest-fidelity exporter available and needs no
 * headless chromium on the api host. But `print()` is unreachable across an
 * opaque origin, so a second, offscreen frame gets the document plus a tiny
 * message bridge and prints itself on request. That frame is still
 * `allow-scripts` with no `allow-same-origin`; the only added token is
 * `allow-modals`, which is what makes the print dialog open at all. It lives
 * for one export and is torn down after.
 *
 * The pane's header row is the toolbar (see ./header-slot) — this component
 * renders no chrome of its own.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Code2, Download, Eye, FileDown, RefreshCw } from '../../lib/icons';
import { IconButton } from '../ui';
import { useT } from '../../lib/i18n';
import { SidePaneHeaderActions } from './header-slot';

/** Sandbox tokens, named so a future edit has to think about the omission. */
const SANDBOX = 'allow-scripts';

/**
 * The print frame's tokens. `allow-modals` is the print dialog; `allow-scripts`
 * is what lets the injected bridge answer. Still no `allow-same-origin`.
 *
 * Exported so the isolation test can assert on it: the print frame is only
 * mounted mid-export, so it never appears in a static render.
 */
export const PRINT_SANDBOX = 'allow-scripts allow-modals';

/** A4 at 96dpi — a sane layout viewport for a frame nobody ever sees. */
const PRINT_FRAME_SIZE = { width: 794, height: 1123 };

/** If the frame never answers (blocked dialog, broken document), clean up anyway. */
const PRINT_TIMEOUT_MS = 120_000;

const PRINT_REQUEST = 'greenhouse:print';
const PRINT_DONE = 'greenhouse:printed';

/**
 * Injected into the print frame's copy of the document — never into the
 * preview, and never into the downloaded file.
 */
const PRINT_BRIDGE = `<script>
(function () {
  window.addEventListener('message', function (event) {
    if (event.data !== ${JSON.stringify(PRINT_REQUEST)}) return;
    window.addEventListener('afterprint', function () {
      parent.postMessage(${JSON.stringify(PRINT_DONE)}, '*');
    });
    window.print();
  });
})();
</script>`;

/** Filesystem-safe stem shared by both exports. */
function fileStem(title?: string): string {
  return (title || 'preview').replace(/[^\w.-]+/g, '_');
}

export function HtmlPreview({ code, title }: { code: string; title?: string }) {
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  // Remounts the iframe, which is the only way to re-run a document that has
  // already scribbled on itself.
  const [reloadKey, setReloadKey] = useState(0);
  // Non-null while an export is in flight; the value keys the frame so a second
  // export gets a fresh document rather than reusing a printed one.
  const [printJob, setPrintJob] = useState<number | null>(null);

  const download = useMemo(
    () => () => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/html' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileStem(title)}.html`;
      link.click();
      URL.revokeObjectURL(url);
    },
    [code, title],
  );

  const exportPdf = useCallback(() => {
    setPrintJob((job) => (job ?? 0) + 1);
  }, []);

  /**
   * Hand the loaded frame the print request, then wait for it to say it is
   * done. `afterprint` fires whether the user saved or cancelled, so this is
   * also the cancel path; the timeout covers a frame that never answers.
   */
  const startPrint = useCallback((frame: HTMLIFrameElement) => {
    const done = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      setPrintJob(null);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.data === PRINT_DONE) done();
    };
    const timer = setTimeout(done, PRINT_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    frame.contentWindow?.postMessage(PRINT_REQUEST, '*');
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidePaneHeaderActions>
        <IconButton
          label={showSource ? t('sidePane.showPreview') : t('sidePane.showSource')}
          onClick={() => setShowSource((v) => !v)}
          size="compact"
        >
          {showSource ? <Eye size={14} /> : <Code2 size={14} />}
        </IconButton>
        <IconButton label={t('common.refresh')} onClick={() => setReloadKey((v) => v + 1)} size="compact">
          <RefreshCw size={14} />
        </IconButton>
        <IconButton label={t('sidePane.downloadHtml')} onClick={download} size="compact">
          <Download size={14} />
        </IconButton>
        <IconButton label={t('sidePane.exportPdf')} onClick={exportPdf} size="compact" disabled={printJob !== null}>
          <FileDown size={14} />
        </IconButton>
      </SidePaneHeaderActions>
      {showSource ? (
        <pre className="hl-pre min-h-0 flex-1 overflow-auto px-3 py-2 text-xs">
          <code>{code}</code>
        </pre>
      ) : (
        <iframe
          key={reloadKey}
          // Opaque origin: scripts yes, access to this session no. See the file
          // header before touching this attribute.
          sandbox={SANDBOX}
          srcDoc={code}
          title={title || t('sidePane.htmlPreview')}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      )}
      {printJob !== null && (
        <iframe
          key={`print-${printJob}`}
          aria-hidden
          tabIndex={-1}
          // Same opaque origin as the preview, plus the token that lets the
          // print dialog open. Read the file header before adding to this.
          sandbox={PRINT_SANDBOX}
          srcDoc={code + PRINT_BRIDGE}
          title={t('sidePane.exportPdf')}
          onLoad={(event) => startPrint(event.currentTarget)}
          // Offscreen at a real page size: a 0×0 frame lays the document out at
          // zero width before print styles ever get a chance.
          style={{ width: PRINT_FRAME_SIZE.width, height: PRINT_FRAME_SIZE.height }}
          className="pointer-events-none fixed left-[-10000px] top-0 border-0 opacity-0"
        />
      )}
    </div>
  );
}
