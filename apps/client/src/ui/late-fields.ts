/**
 * SwiftUI / Compose text fields own their text and report edits to JS a beat later, so Save tapped
 * right after typing would see the text without its last characters. A form keeps one `LateFields`;
 * each native text field registers a reader of its own state, and save reads them all at the tap.
 */
import { useEffect, useRef } from 'react';

export interface LateFields {
  /** Register a reader under `key`; returns the unregister call. */
  register(key: string, read: () => string | null | undefined): () => void;
  /** Every registered field's current text, by key. */
  read(): Record<string, string>;
}

export function createLateFields(): LateFields {
  const readers = new Map<string, () => string | null | undefined>();
  return {
    register(key, read) {
      readers.set(key, read);
      return () => {
        if (readers.get(key) === read) readers.delete(key);
      };
    },
    read() {
      const out: Record<string, string> = {};
      for (const [key, read] of readers) {
        const text = read();
        if (typeof text === 'string') out[key] = text;
      }
      return out;
    },
  };
}

/** One `LateFields` for the life of a form screen. */
export function useLateFields(): LateFields {
  const ref = useRef<LateFields | null>(null);
  if (!ref.current) ref.current = createLateFields();
  return ref.current;
}

/** Register a native field's state (anything with `get()`) under `key` while it is mounted. */
export function useLateField(fields: LateFields | undefined, key: string, state: { get(): string | null | undefined }) {
  useEffect(() => fields?.register(key, () => state.get()), [fields, key, state]);
}
