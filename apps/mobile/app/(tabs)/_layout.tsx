/**
 * The tab bar — 首页 · 知识库 · 云盘 · 项目 (search is a button on home's bar). It is the system's own
 * (UITabBarController: Liquid Glass on iOS 26, a sidebar on iPad; Material navigation on
 * Android), so labels follow the system text size, not the in-app one. Each tab has its own
 * native stack; objects open over every tab as sheets (src/shell/open-object.ts).
 */

import React from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useT } from '../../src/lib/i18n';
import { useTheme } from '../../src/theme';
import { selectionTick } from '../../src/ui/haptics';

export const unstable_settings = { initialRouteName: '(home)' };

export default function TabsLayout() {
  const t = useT();
  const { hex } = useTheme();
  return (
    // UIKit fixes the tab bar's height (no API for it); what shrinks it natively is fewer items
    // (search lives on home's bar) and the iOS 26 minimize: scrolling down folds it to a small pill
    <NativeTabs
      tintColor={hex.accent}
      sidebarAdaptable
      minimizeBehavior="onScrollDown"
      labelStyle={{ fontFamily: 'Nunito' }}
      // a tab is a selection: it ticks like every other pick (DESIGN.md)
      screenListeners={{ tabPress: () => selectionTick() }}
    >
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
        <NativeTabs.Trigger.Label>{t('nav.home')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="knowledge">
        <NativeTabs.Trigger.Icon sf={{ default: 'book', selected: 'book.fill' }} md="menu_book" />
        <NativeTabs.Trigger.Label>{t('nav.knowledge')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="drive">
        <NativeTabs.Trigger.Icon sf={{ default: 'cloud', selected: 'cloud.fill' }} md="cloud" />
        <NativeTabs.Trigger.Label>{t('nav.files')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf={{ default: 'checklist', selected: 'checklist' }} md="checklist" />
        <NativeTabs.Trigger.Label>{t('nav.projects')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
