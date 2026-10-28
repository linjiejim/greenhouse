/**
 * Official plugin screens in the browser (./screens.ts). Each plugin folder owns its screen
 * (`src/plugins/<id>/screen.web.tsx`); this file only indexes them by the manifest page's `screen`.
 */
import type React from 'react';
import { SkillsScreen } from './skills/screen.web';
import { ReportTemplatesScreen } from './reports/screen.web';

export const pluginScreens: Readonly<Record<string, React.ComponentType<{ title: string }>>> = {
  skills: SkillsScreen,
  reports: ReportTemplatesScreen,
};
