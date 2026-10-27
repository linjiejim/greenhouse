export interface FrameBridge {
  /** Trusted plugin frames alone use a real origin; document previews stay opaque. */
  origin: string;
  outgoing: Record<string, unknown> | null;
  onMessage: (data: unknown, origin: string) => void;
  onLoad?: () => void;
  title?: string;
}
