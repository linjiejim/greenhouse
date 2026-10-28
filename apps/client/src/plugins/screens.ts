/**
 * Official plugin screens that replace the read-only list of a native page (keyed by the manifest
 * page's `screen`). The browser has some (./screens.web.ts); on the phone every native page keeps
 * the list (./resource-screen.tsx), with its entry's `wideNote` saying what needs a wider window.
 */
import type React from 'react';

export const pluginScreens: Readonly<Record<string, React.ComponentType<{ title: string }>>> = {};
