/**
 * One entry for rendering a checked report document to bytes, whatever the
 * format. Rendering is local and free (no provider, no metering).
 *
 * Warnings are things the caller should know but that do not stop the file:
 * characters the embedded PDF font lacks (they show as blanks) and a logo
 * this format cannot carry.
 */

import { documentText, type ReportDocument } from './content.js';
import type { ReportBrand } from './brand.js';
import { missingGlyphs } from './font.js';
import { renderDocx } from './render-docx.js';
import { renderPdf } from './render-pdf.js';
import { renderPptx } from './render-pptx.js';

export interface RenderedReport {
  bytes: Buffer;
  extension: 'pdf' | 'docx' | 'pptx';
  contentType: string;
  warnings: string[];
}

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/** Logo kinds each format embeds. */
const LOGO_SUPPORT = { pdf: ['png', 'jpeg', 'svg'], docx: ['png', 'jpeg'], pptx: ['png', 'jpeg'] } as const;

export async function renderReport(document: ReportDocument, brand: ReportBrand): Promise<RenderedReport> {
  const format = document.format;
  const warnings: string[] = [];
  if (brand.logo && !(LOGO_SUPPORT[format] as readonly string[]).includes(brand.logo.kind)) {
    warnings.push(
      `The workspace logo is ${brand.logo.kind.toUpperCase()}, which ${format.toUpperCase()} files here cannot embed; the brand name is shown instead. A PNG logo in Branding Studio works everywhere.`,
    );
  }
  if (format === 'pdf') {
    const missing = missingGlyphs(documentText(document));
    if (missing.length) {
      warnings.push(
        `${missing.length} character(s) are not in the embedded font and show as blanks: ${missing.slice(0, 20).join(' ')}. Replace them (emoji, rare characters) or render to ${document.kind === 'report' ? 'docx' : 'pptx'}.`,
      );
    }
  }
  let bytes: Buffer;
  if (format === 'pdf') bytes = await renderPdf(document, brand);
  else if (format === 'docx') bytes = await renderDocx(document, brand);
  else bytes = await renderPptx(document, brand);
  return { bytes, extension: format, contentType: CONTENT_TYPES[format], warnings };
}
