/**
 * Official plugin screens in the browser (./screens.ts on every other platform). Each plugin folder
 * owns its screen (`src/plugins/<id>/screen.web.tsx`); this file only indexes them by the manifest
 * page's `screen`. Skills and report templates have a browser screen only.
 */
import type React from 'react';
import { ComputerScreen } from './computer/screen';
import { EmailScreen } from './email/screen';
import { MemoryScreen } from './memory/screen';
import { SkillsScreen } from './skills/screen.web';
import { ReportTemplatesScreen } from './reports/screen.web';

export const pluginScreens: Readonly<Record<string, React.ComponentType<{ title: string }>>> = {
  email: EmailScreen,
  memory: MemoryScreen,
  computer: ComputerScreen,
  skills: SkillsScreen,
  reports: ReportTemplatesScreen,
};
