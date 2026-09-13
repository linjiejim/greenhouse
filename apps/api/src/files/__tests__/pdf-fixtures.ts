/**
 * Hand-built PDFs for the extraction tests.
 *
 * Written by hand rather than checked in as binaries so each fixture's defining
 * property is readable: which one has a text layer, which one is a scan, which
 * one is encrypted. They carry no xref table — pdf.js rebuilds it, the same way
 * it copes with the real-world files this code has to survive.
 */

/** A PDF whose pages carry a real text layer. */
export function pdfWithText(text: string, pages = 1): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) kids.push(`${3 + i * 2} 0 R`);
  objs.push('1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj');
  objs.push(`2 0 obj <</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>> endobj`);
  for (let i = 0; i < pages; i++) {
    const pageNo = 3 + i * 2;
    const contentNo = 4 + i * 2;
    objs.push(
      `${pageNo} 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNo} 0 R/Resources<</Font<</F1 99 0 R>>>>>> endobj`,
    );
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(`${contentNo} 0 obj <</Length ${stream.length}>> stream\n${stream}\nendstream endobj`);
  }
  objs.push('99 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj');
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer <</Root 1 0 R>>\n%%EOF`);
}

/** Pages with no content stream at all — what a scan looks like to a parser. */
export function pdfWithoutTextLayer(pages = 1): Buffer {
  const kids: string[] = [];
  const pageObjs: string[] = [];
  for (let i = 0; i < pages; i++) {
    const n = 3 + i;
    kids.push(`${n} 0 R`);
    pageObjs.push(`${n} 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>> endobj`);
  }
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n' +
      `2 0 obj <</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages}>> endobj\n` +
      `${pageObjs.join('\n')}\n` +
      'trailer <</Root 1 0 R>>\n%%EOF',
  );
}

/**
 * Standard security handler with a password. The O/U strings are arbitrary:
 * pdf.js validates them against the empty password, fails, and reports
 * NEED_PASSWORD — which is exactly the branch under test.
 */
export function encryptedPdf(): Buffer {
  const id = '11223344556677889900aabbccddeeff';
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n' +
      '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n' +
      '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>> endobj\n' +
      `4 0 obj <</Filter/Standard/V 1/R 2/O <${'ab'.repeat(32)}>/U <${'cd'.repeat(32)}>/P -1>> endobj\n` +
      `trailer <</Root 1 0 R/Encrypt 4 0 R/ID[<${id}><${id}>]>>\n%%EOF`,
  );
}

/** A PDF header over bytes that are not a PDF. */
export function malformedPdf(): Buffer {
  return Buffer.from('%PDF-1.4\nthis is not really a pdf at all');
}
