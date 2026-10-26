/** Saved prompts plus optional library tabs, keeping existing bookmarked hashes. */
import React from 'react';
import { extensionTabs } from '../../extensions';
import { useExtensionsStore } from '../../stores/extensions-store';
import { ModulePage } from '../../components/app/module-page';
import { Tabs } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { PromptsPanel } from './prompts';

export function SkillHubPage({
  subPath,
  params = new URLSearchParams(),
}: {
  subPath: string;
  params?: URLSearchParams;
}) {
  const t = useT();
  useExtensionsStore((s) => s.extensions);
  const extra = extensionTabs('skillhub');
  const fallback = extra.find((tab) => tab.default)?.key ?? 'prompts';
  const requested = params.get('tab') ?? fallback;
  const selected =
    extra.find((tab) => tab.key === requested) ??
    (requested === 'prompts' ? undefined : extra.find((tab) => tab.key === fallback));
  const active = selected?.key ?? 'prompts';
  const tabs = (
    <Tabs
      tabs={[
        ...extra.filter((tab) => tab.default).map((tab) => ({ key: tab.key, label: t(tab.labelKey) })),
        { key: 'prompts', label: t('savedPrompts.title') },
        ...extra.filter((tab) => !tab.default).map((tab) => ({ key: tab.key, label: t(tab.labelKey) })),
      ]}
      active={active}
      onChange={(key) => {
        window.location.hash = `#/skillhub?tab=${encodeURIComponent(key)}`;
      }}
      ariaLabel={t('savedPrompts.title')}
    />
  );
  if (selected) {
    const Panel = selected.component;
    return selected.page ? (
      <Panel subPath={subPath} params={params} tabs={tabs} />
    ) : (
      <ModulePage moduleId="workspace.skillhub" layout="list" tabs={tabs}>
        <Panel subPath={subPath} params={params} />
      </ModulePage>
    );
  }
  return (
    <ModulePage moduleId="workspace.skillhub" layout="list" tabs={extra.length ? tabs : undefined}>
      <PromptsPanel />
    </ModulePage>
  );
}
