/**
 * The tab bar — 首页 · 知识库 · 云盘 · 项目, and the system search tab. It is the system's own
 * (UITabBarController: Liquid Glass on iOS 26, a sidebar on iPad; Material navigation on
 * Android), so labels follow the system text size, not the in-app one. Each tab has its own
 * native stack; objects open over every tab as sheets (src/shell/open-object.ts).
 */

import React from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useT } from '../../src/lib/i18n';
import { useTheme } from '../../src/theme';

export const unstable_settings = { initialRouteName: '(home)' };

export default function TabsLayout() {
  const t = useT();
  const { hex } = useTheme();
  return (
    <NativeTabs tintColor={hex.accent} sidebarAdaptable labelStyle={{ fontFamily: 'Nunito' }}>
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
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>{t('common.search')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
