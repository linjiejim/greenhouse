/**
 * Official plugin pages with screens of their own, keyed by the manifest page's `screen`. Each
 * plugin folder owns its screen (`src/plugins/<id>/screen.tsx`, `screen.web.tsx` in the browser);
 * this file only indexes them. Other native pages render through ./resource-screen.
 */
import type React from 'react';
import { ComputerScreen } from './computer/screen';
import { EmailScreen } from './email/screen';
import { MemoryScreen } from './memory/screen';

export const pluginScreens: Readonly<Record<string, React.ComponentType<{ title: string }>>> = {
  email: EmailScreen,
  memory: MemoryScreen,
  computer: ComputerScreen,
};
