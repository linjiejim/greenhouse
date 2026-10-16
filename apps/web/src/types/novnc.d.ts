/** The part of noVNC's RFB client the web uses (noVNC ships no types). */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
    sendCtrlAltDel(): void;
  }
}
