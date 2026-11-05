/** One notice API on every platform (DESIGN.md States and feedback). */
export type NotifyKind = 'success' | 'info' | 'warning' | 'undo' | 'error';

export interface NotifyOptions {
  /** A second, quieter line: what happened or what to do next. */
  body?: string;
  /** One action beside the text: Retry on an error, Open on a finished export. */
  action?: { label: string; onPress: () => void };
  /** The technical reason, one tap away behind Details (errors). */
  detail?: string;
  /** Called when the notice goes away without its action. */
  onDismiss?: () => void;
}

export interface NotifyApi {
  /** A success whose result is not on screen; when it is, say nothing. */
  (text: string, options?: NotifyOptions): () => void;
  success(text: string, options?: NotifyOptions): () => void;
  info(text: string, options?: NotifyOptions): () => void;
  warning(text: string, options?: NotifyOptions): () => void;
  /** A reversible action that already ran: Undo for 8 seconds. */
  undo(text: string, onUndo: () => void, options?: NotifyOptions): () => void;
  /** A failure that belongs to no field or block: stays until dismissed. */
  error(text: string, options?: NotifyOptions): () => void;
}
