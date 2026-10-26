import React, { useEffect } from 'react';
import { create } from 'zustand';
import { Overlay } from './overlay.web';
import type { IconName } from './core';
const useToast = create<{ message: string | null; seq: number }>(() => ({ message: null, seq: 0 }));
export function toast(message: string, _icon?: IconName) {
  useToast.setState((s) => ({ message, seq: s.seq + 1 }));
}
export function ToastHost() {
  const { message, seq } = useToast();
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => useToast.setState({ message: null }), 1800);
    return () => clearTimeout(timer);
  }, [message, seq]);
  return message ? (
    <Overlay role="status" modal={false} onClose={() => {}}>
      <span aria-live="polite">{message}</span>
    </Overlay>
  ) : null;
}
