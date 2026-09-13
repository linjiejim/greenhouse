/**
 * PDF Export — browser-based PDF generation from Markdown content.
 *
 * Uses window.print() with a styled hidden iframe for zero-dependency,
 * high-quality PDF output. Supports full CJK characters and special symbols
 * via native browser fonts.
 *
 * Flow: Markdown → marked → HTML → styled iframe → window.print() → PDF
 */

import React, { useCallback, useState } from 'react';
import { marked } from 'marked';
import { FileDown } from '../lib/icons';
import { useI18n, useT } from '../lib/i18n';

// ─── PDF Print Stylesheet ────────────────────────────────

const PDF_CSS = `
@page {
  size: A4;
  margin: 25mm 20mm 20mm 20mm;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei",
               "Source Han Sans SC", "WenQuanYi Micro Hei", -apple-system,
               BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.8;
  color: #1a1a1a;
  max-width: 100%;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ── Title Page ── */
h1:first-of-type {
  margin-top: 60px;
  font-size: 32px;
  font-weight: 700;
  text-align: center;
  color: #1a1a1a;
  border-bottom: none;
  padding-bottom: 0;
  page-break-before: avoid;
}

h1:first-of-type + blockquote {
  text-align: center;
  border-left: none;
  background: none;
  color: #64748b;
  font-size: 13px;
  font-style: normal;
  margin-bottom: 20px;
  padding: 0;
}

/* ── Headings ── */
h1 {
  font-size: 26px;
  font-weight: 700;
  color: #1a1a1a;
  border-bottom: 3px solid #2563eb;
  padding-bottom: 10px;
  margin-top: 36px;
  margin-bottom: 18px;
}

h2 {
  font-size: 20px;
  font-weight: 600;
  color: #1e40af;
  border-bottom: 1.5px solid #bfdbfe;
  padding-bottom: 6px;
  margin-top: 28px;
  margin-bottom: 14px;
  page-break-before: always;
}

h3 {
  font-size: 16px;
  font-weight: 600;
  color: #1e3a5f;
  margin-top: 22px;
  margin-bottom: 10px;
}

h4 {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
  margin-top: 18px;
  margin-bottom: 8px;
}

/* ── Body ── */
p { margin: 8px 0; }

blockquote {
  border-left: 4px solid #2563eb;
  background: #f0f7ff;
  padding: 10px 14px;
  margin: 14px 0;
  border-radius: 0 6px 6px 0;
  color: #1e3a5f;
}

blockquote p { margin: 3px 0; }

/* ── Tables ── */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 12px;
  page-break-inside: avoid;
}

thead {
  background: #1e40af;
  color: white;
}

th {
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  font-size: 11.5px;
}

td {
  padding: 7px 10px;
  border-bottom: 1px solid #e2e8f0;
}

tr:nth-child(even) { background: #f8fafc; }

/* ── Lists ── */
ul, ol { padding-left: 22px; margin: 6px 0; }
li { margin: 3px 0; }

/* ── Code ── */
code {
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
  color: #be185d;
  font-family: "SF Mono", "Fira Code", Menlo, Monaco, monospace;
}

pre {
  background: #1e293b;
  color: #e2e8f0;
  padding: 14px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 11.5px;
  page-break-inside: avoid;
  margin: 10px 0;
}

pre code {
  background: none;
  color: inherit;
  padding: 0;
}

/* ── Misc ── */
hr {
  border: none;
  border-top: 1.5px solid #cbd5e1;
  margin: 24px 0;
}

strong { color: #0f172a; }

a {
  color: #2563eb;
  text-decoration: none;
}

img { max-width: 100%; }

/* ── Footer ── */
.pdf-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0 20mm 8mm 20mm;
  font-size: 9px;
  color: #94a3b8;
  display: flex;
  justify-content: space-between;
}

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pdf-footer { display: flex; }
}
`;

// ─── Markdown → HTML ─────────────────────────────────────

function renderMarkdownToHtml(markdown: string): string {
  return marked.parse(markdown, {
    gfm: true,
    breaks: false,
  }) as string;
}

// ─── Build Full HTML Document ────────────────────────────

function buildPrintDocument(markdown: string, title: string, lang: string): string {
  const htmlContent = renderMarkdownToHtml(markdown);
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${PDF_CSS}</style>
</head>
<body>
${htmlContent}
<div class="pdf-footer">
  <span>Greenhouse Research · ${dateStr}</span>
</div>
</body>
</html>`;
}

// ─── Export PDF via Print ────────────────────────────────

function triggerPdfPrint(markdown: string, title: string, lang: string): void {
  const html = buildPrintDocument(markdown, title, lang);

  // Create a hidden iframe for isolated print context
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;';
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    return;
  }

  iframeDoc.open();
  iframeDoc.write(html);
  iframeDoc.close();

  // Wait for content to render, then print (single trigger)
  const doPrint = () => {
    setTimeout(() => {
      iframe.contentWindow?.print();
      // Clean up after print dialog closes
      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch (_err) {
          /* already removed */
        }
      }, 1000);
    }, 300);
  };

  // Use onload for async-loaded iframes, but after write()+close()
  // the readyState is already 'complete', so just call directly.
  if (iframeDoc.readyState === 'complete') {
    doPrint();
  } else {
    iframe.onload = doPrint;
  }
}

// ─── React Component ─────────────────────────────────────

interface ExportPdfButtonProps {
  /** Raw markdown content to export */
  markdown: string;
  /** Optional custom label */
  label?: string;
  /** Is the message currently streaming? */
  isStreaming?: boolean;
  /** Render as a compact icon action inside a message footer. */
  iconOnly?: boolean;
}

export function ExportPdfButton({ markdown, label, isStreaming, iconOnly = false }: ExportPdfButtonProps) {
  const t = useT();
  const { locale } = useI18n();
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(() => {
    setExporting(true);
    try {
      triggerPdfPrint(markdown, t('common.report'), locale === 'zh' ? 'zh-CN' : 'en');
    } finally {
      // Reset after print dialog opens
      setTimeout(() => setExporting(false), 1000);
    }
  }, [locale, markdown, t]);

  // Only show for substantial content (likely a report)
  if (isStreaming || !markdown || markdown.length < 500) {
    return null;
  }

  return (
    <button
      onClick={handleExport}
      disabled={exporting}
      className={
        iconOnly
          ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-info-subtle hover:text-info disabled:opacity-40'
          : 'inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-primary-300 hover:bg-info-subtle hover:text-info disabled:opacity-40'
      }
      title={t('common.exportPdf')}
      aria-label={t('common.exportPdf')}
    >
      <FileDown size={14} />
      {!iconOnly && (label || 'PDF')}
    </button>
  );
}
