/** The inlined font (~130 KB) is a chunk of its own, loaded with the first diagram. */
export const loadMermaidFont = (): Promise<string> =>
  import('../../ui/brand-web-font.generated').then((m) => m.NUNITO_WEB_FONT_CSS);
