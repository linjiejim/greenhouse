import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import type { TextFieldRef } from '@expo/ui/jetpack-compose';

/** SDK 57 Compose value props cannot resolve ObservableState ids on Android. */
export function useNativeState<T>(initial: T) {
  const [value, update] = useState(() => initial);
  const latest = useRef(value);
  latest.current = value;
  const state = useRef({
    get: () => latest.current,
    set: (next: T) => {
      latest.current = next;
      update(() => next);
    },
  });
  return state.current;
}

/** Native fields own input and AutoFill; refs apply explicit reloads without resetting the caret. */
export function useTextBinding(
  state: ReturnType<typeof useNativeState<string>>,
  forwarded?: Ref<TextFieldRef>,
  change?: (text: string) => void,
) {
  const field = useRef<TextFieldRef | null>(null);
  const shown = useRef<string | null>(null);
  const ready = useRef(false);
  const value = state.get();
  const ref = useCallback(
    (instance: TextFieldRef | null) => {
      if (field.current !== instance) {
        shown.current = null;
        ready.current = false;
      }
      field.current = instance;
      if (typeof forwarded === 'function') forwarded(instance);
      else if (forwarded) forwarded.current = instance;
    },
    [forwarded],
  );
  const apply = useCallback(() => {
    const value = state.get();
    if (!ready.current || shown.current === value || !field.current) return;
    shown.current = value;
    void field.current.setText(value).catch(() => {
      if (shown.current === value) shown.current = null;
    });
  }, [state]);
  useEffect(() => {
    apply();
  }, [value, apply]);
  return {
    ref,
    onReady: () => {
      ready.current = true;
      apply();
    },
    onValueChange: (text: string) => {
      shown.current = text;
      state.set(text);
      change?.(text);
    },
  };
}
