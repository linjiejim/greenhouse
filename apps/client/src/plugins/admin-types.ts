import type React from 'react';
import type { IconName } from '../ui/core';

/** What the Admin place hands a plugin-owned admin screen. */
export interface AdminScreenProps {
  plugin: string;
  page: string;
  /** The page title from the station manifest, in the app's language. */
  title: string;
}

/** A plugin's Admin section screen (browser), keyed by its manifest page's `screen`. */
export interface AdminScreenEntry {
  screen: string;
  icon: IconName;
  component: React.ComponentType<AdminScreenProps>;
}
