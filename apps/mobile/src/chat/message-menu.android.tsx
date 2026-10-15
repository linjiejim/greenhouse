import type { ReactNode } from 'react';
import { NativeMenu, type MenuItem } from '../ui/menu.android';
export function MessageMenu({
  items,
  onSelect,
  width,
  children,
}: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  width?: number;
  children: ReactNode;
  text: string;
  streaming?: boolean;
}) {
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={onSelect} width={width}>
      {children}
    </NativeMenu>
  );
}
