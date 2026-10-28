/** Nunito for diagram pages; the browser fetches it on demand (mermaid-font.web.ts). */
import { NUNITO_WEB_FONT_CSS } from '../../ui/brand-web-font.generated';

export const loadMermaidFont = (): Promise<string> => Promise.resolve(NUNITO_WEB_FONT_CSS);
