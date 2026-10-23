/**
 * Ambient declaration for `pdfmake` 0.3 (server build, `js/index.js`).
 *
 * The package ships no `.d.ts` for 0.3 and `@types/pdfmake` describes the 0.2
 * API. Only the surface reports/render-pdf.ts uses is declared; document
 * definitions are built as plain objects.
 */
declare module 'pdfmake' {
  interface PdfMakeOutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMakeFontFamily {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }
  interface PdfMakeServer {
    virtualfs: {
      existsSync(name: string): boolean;
      writeFileSync(name: string, content: Buffer): void;
    };
    setFonts(fonts: Record<string, PdfMakeFontFamily>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(docDefinition: Record<string, unknown>, options?: Record<string, unknown>): PdfMakeOutputDocument;
  }
  const pdfmake: PdfMakeServer;
  export default pdfmake;
}
