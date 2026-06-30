import { useRef, type ReactNode, type RefObject } from 'react';

/**
 * Anchored popover container shared by the chat command-menu and mention
 * popovers — a positioned card floated above the composer input.
 */
export function PopoverWrapper({
  children,
  anchorRef: _anchorRef,
}: {
  children: ReactNode;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={popRef}
      style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 4, zIndex: 50 }}
      className="bg-surface-raised border border-edge rounded-lg shadow-lg overflow-hidden max-w-full md:max-w-[360px]"
    >
      {children}
    </div>
  );
}
