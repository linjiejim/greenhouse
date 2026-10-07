/**
 * The slice of noVNC's `RFB` client the Bots computer pane relies on.
 *
 * @novnc/novnc ships plain ESM with no type declarations, so this file is the
 * typed contract between our code and the library (see ./novnc.d.ts for the
 * ambient module that points at it). Keep it to what we actually call — every
 * member here is one more thing a noVNC upgrade has to keep honouring.
 * Reference: node_modules/@novnc/novnc/docs/API.md (v1.7).
 */

export interface RfbOptions {
  /** Ask the server to keep other viewers connected. The API rewrites ClientInit to shared anyway. */
  shared?: boolean;
  /** WebSocket sub-protocols. Our viewer endpoint negotiates none. */
  wsProtocols?: string[];
}

export interface RfbDisconnectDetail {
  /** False when the connection dropped instead of being closed on purpose. */
  clean: boolean;
}

export interface RfbSecurityFailureDetail {
  status: number;
  reason?: string;
}

export interface RfbEventMap {
  connect: CustomEvent<Record<string, never>>;
  disconnect: CustomEvent<RfbDisconnectDetail>;
  securityfailure: CustomEvent<RfbSecurityFailureDetail>;
  credentialsrequired: CustomEvent<{ types: string[] }>;
  desktopname: CustomEvent<{ name: string }>;
}

export interface RfbClient {
  /** Drop local keyboard/pointer input. The server enforces the same rule; this keeps the UI honest. */
  viewOnly: boolean;
  /** Focus the canvas on click so keystrokes reach the remote screen. */
  focusOnClick: boolean;
  /** Scale the remote framebuffer to fit the container (never changes the remote resolution). */
  scaleViewport: boolean;
  /** Ask the server to resize to the container. Off: the desktop keeps the resolution the Bots work in (1280×800 by default). */
  resizeSession: boolean;
  clipViewport: boolean;
  /** CSS background behind the framebuffer. */
  background: string;
  qualityLevel: number;
  compressionLevel: number;
  disconnect(): void;
  /** Press (and release, when `down` is omitted) one key by X11 keysym. No-op while view-only. */
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  focus(options?: FocusOptions): void;
  blur(): void;
  addEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
  removeEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
}

export type RfbConstructor = new (target: HTMLElement, url: string, options?: RfbOptions) => RfbClient;

/** X11 keysyms for the helper keys the pane offers (Enter after typing, Tab between fields…). */
export const RFB_KEYSYMS = {
  enter: 0xff0d,
  tab: 0xff09,
  backspace: 0xff08,
  escape: 0xff1b,
} as const;

export type RfbHelperKey = keyof typeof RFB_KEYSYMS;

/** DOM `code` values matching RFB_KEYSYMS, so QEMU extended key events carry a scancode too. */
export const RFB_KEY_CODES: Record<RfbHelperKey, string> = {
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  escape: 'Escape',
};
