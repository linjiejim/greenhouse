/**
 * The app's own settings: its name, description, icon and colour (saved on
 * the app, not in a version), how its pages are navigated (in the draft —
 * published with the next version), how it is used (managers: people and
 * actions from the app-scoped audit), and its lifecycle — handing it to
 * another responsible person, recommending it (a super), archiving it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  APP_BUILTIN_ACTIONS,
  APP_LIMITS,
  type AppAccent,
  type AppBuiltinActionId,
  type AppIconName,
  type AppSpec,
  type AppSummary,
  type AppUsageView,
} from '@greenhouse/types/apps';
import { Button, ConfirmDialog, FilterPills, Input, Select, Textarea, Toggle, toast } from '../../../components/ui';
import { FormField, FormGrid } from '../../../components/form';
import { archiveApp, featureApp, getAppUsage, transferApp, updateAppIdentity } from '../../../lib/api/apps-builder';
import type { TableUserOption } from '../../../lib/api/tables';
import { APP_CENTER_HREF } from '../../../lib/app-routes';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { formatDate } from '../../../lib/utils';
import { useAppsStore } from '../../../stores/apps-store';
import { useAuthStore } from '../../../stores';
import { AppAccentPicker, AppIconPicker } from './identity-fields';
import { TemplatePublishSection } from './template-publish-section';
import { PanelSection } from './properties/common';
import { actionLabelsById } from './spec-model';

function IdentitySection({ app, onSaved }: { app: AppSummary; onSaved: (app: AppSummary) => void }) {
  const t = useT();
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? '');
  const [icon, setIcon] = useState<AppIconName>(app.icon);
  const [accent, setAccent] = useState<AppAccent>(app.accent);
  const [saving, setSaving] = useState(false);
  const dirty =
    name.trim() !== app.name ||
    (description.trim() || null) !== (app.description ?? null) ||
    icon !== app.icon ||
    accent !== app.accent;

  const save = async () => {
    setSaving(true);
    try {
      const saved = await updateAppIdentity(app.id, {
        name: name.trim(),
        description: description.trim() || null,
        icon,
        accent,
      });
      onSaved(saved);
      toast(t('apps.builder.settings.saved'), 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : t('apps.builder.settings.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelSection title={t('apps.builder.settings.identity')} hint={t('apps.builder.settings.identityHint')}>
      <FormGrid>
        <FormField label={t('apps.builder.settings.name')} required>
          <Input
            value={name}
            maxLength={APP_LIMITS.nameLength}
            onChange={(event) => setName(event.target.value)}
            data-testid="app-settings-name"
          />
        </FormField>
        <FormField label={t('apps.builder.settings.description')}>
          <Textarea
            rows={2}
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
      </FormGrid>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-secondary">{t('apps.builder.settings.icon')}</p>
        <AppIconPicker
          label={t('apps.builder.settings.icon')}
          value={icon}
          onChange={(next) => next && setIcon(next)}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-secondary">{t('apps.builder.settings.accent')}</p>
        <AppAccentPicker label={t('apps.builder.settings.accent')} value={accent} icon={icon} onChange={setAccent} />
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={!dirty || saving || !name.trim()} onClick={() => void save()}>
          {saving ? t('common.saving') : t('apps.builder.settings.save')}
        </Button>
      </div>
    </PanelSection>
  );
}

/** The built-in writes (`APP_BUILTIN_ACTIONS`) as usage names them. */
const BUILTIN_USAGE_LABELS = {
  [APP_BUILTIN_ACTIONS.submit]: 'apps.builder.settings.usageActions.submitted',
  [APP_BUILTIN_ACTIONS.create]: 'apps.builder.settings.usageActions.created',
  [APP_BUILTIN_ACTIONS.move]: 'apps.builder.settings.usageActions.moved',
  [APP_BUILTIN_ACTIONS.edit]: 'apps.builder.settings.usageActions.edited',
} as const satisfies Record<AppBuiltinActionId, TranslationKey>;

function isBuiltinAction(id: string): id is AppBuiltinActionId {
  return Object.hasOwn(BUILTIN_USAGE_LABELS, id);
}

function UsageSection({ appId, spec }: { appId: number; spec: AppSpec }) {
  const t = useT();
  const [usage, setUsage] = useState<AppUsageView | null>(null);
  const labels = useMemo(() => actionLabelsById(spec), [spec]);
  // Built-in writes by what they did, declared actions by their label; an action the draft no
  // longer has (it ran in a published version) keeps its id.
  const actionName = (id: string) => (isBuiltinAction(id) ? t(BUILTIN_USAGE_LABELS[id]) : (labels.get(id) ?? id));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getAppUsage(appId)
      .then((next) => !cancelled && setUsage(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [appId]);
  const actions = usage ? Object.entries(usage.actions30d).sort(([, a], [, b]) => b - a) : [];
  return (
    <PanelSection title={t('apps.builder.settings.usage')} hint={t('apps.builder.settings.usageHint')}>
      {failed ? (
        <p className="text-xs text-fg-faint">{t('apps.builder.settings.usageUnavailable')}</p>
      ) : !usage ? (
        <p className="text-xs text-fg-faint">{t('common.loading')}</p>
      ) : (
        <div className="space-y-3" data-testid="app-usage">
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { label: t('apps.builder.settings.users7d'), value: String(usage.users7d) },
              { label: t('apps.builder.settings.users30d'), value: String(usage.users30d) },
              {
                label: t('apps.builder.settings.lastUsed'),
                value: usage.lastUsedAt ? formatDate(usage.lastUsedAt) : t('apps.builder.settings.neverUsed'),
              },
            ].map((entry) => (
              <div key={entry.label} className="rounded-lg border border-edge px-3 py-2">
                <dt className="text-[11px] text-fg-faint">{entry.label}</dt>
                <dd className="text-sm font-semibold text-fg">{entry.value}</dd>
              </div>
            ))}
          </dl>
          {actions.length > 0 && (
            <ul className="divide-y divide-edge rounded-lg border border-edge text-xs">
              {actions.map(([id, runs]) => (
                <li key={id} className="flex justify-between gap-2 px-3 py-1.5" data-testid={`app-usage-action-${id}`}>
                  <span
                    className={`truncate text-fg-secondary ${isBuiltinAction(id) || labels.has(id) ? '' : 'font-mono'}`}
                    title={id}
                  >
                    {actionName(id)}
                  </span>
                  <span className="text-fg-muted">{t('apps.builder.settings.runs', { count: runs })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PanelSection>
  );
}

export function SettingsTab({
  app,
  spec,
  owners,
  edit,
  onApp,
}: {
  app: AppSummary;
  spec: AppSpec;
  /** Who may own an app on this Base (owners and builders) — the only people it can be handed to. */
  owners: TableUserOption[];
  edit: (change: (spec: AppSpec) => AppSpec) => void;
  onApp: (app: AppSummary) => void;
}) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const reloadCatalog = useAppsStore((state) => state.load);
  const [transferTo, setTransferTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const isSuper = currentUser?.role === 'super';
  const canTransfer = app.canPublish || app.ownerId === currentUser?.id;
  const canArchive = app.canPublish || app.publishedVersion === null;
  const handOverTo = owners.filter((user) => user.id !== app.ownerId);

  const run = async (action: () => Promise<AppSummary>, done: string) => {
    setBusy(true);
    try {
      const next = await action();
      onApp(next);
      void reloadCatalog(true);
      toast(done, 'success');
      return next;
    } catch (error) {
      toast(error instanceof Error ? error.message : t('apps.builder.settings.actionFailed'), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="app-settings-tab">
      <IdentitySection
        key={app.id}
        app={app}
        onSaved={(next) => {
          onApp(next);
          void reloadCatalog(true);
        }}
      />

      <TemplatePublishSection app={app} />
      <PanelSection title={t('apps.builder.settings.navigation')} hint={t('apps.builder.settings.navigationHint')}>
        <FilterPills
          variant="segment"
          items={[
            { key: 'tabs', label: t('apps.builder.settings.navTabs') },
            { key: 'sidebar', label: t('apps.builder.settings.navSidebar') },
          ]}
          activeKey={spec.nav?.layout ?? 'tabs'}
          onChange={(layout) => {
            if (layout !== 'tabs' && layout !== 'sidebar') return;
            edit((current) => {
              const next = { ...current };
              if (layout === 'tabs') delete next.nav;
              else next.nav = { layout };
              return next;
            });
          }}
        />
      </PanelSection>

      <UsageSection appId={app.id} spec={spec} />

      {canTransfer && (
        <PanelSection title={t('apps.builder.settings.transfer')} hint={t('apps.builder.settings.transferHint')}>
          {handOverTo.length === 0 ? (
            <p className="text-xs text-fg-faint" data-testid="app-transfer-none">
              {t('apps.builder.settings.transferNone')}
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label={t('apps.builder.settings.transferTo')} className="min-w-[12rem] flex-1">
                <Select
                  value={transferTo}
                  onChange={(event) => setTransferTo(event.target.value)}
                  data-testid="app-transfer-to"
                >
                  <option value="">{t('apps.builder.settings.transferChoose')}</option>
                  {handOverTo.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.nickname}
                    </option>
                  ))}
                </Select>
              </FormField>
              <Button
                variant="outline"
                size="sm"
                disabled={!transferTo || busy}
                onClick={() =>
                  void run(
                    () => transferApp(app.id, transferTo),
                    t('apps.builder.settings.transferred', {
                      name: handOverTo.find((user) => user.id === transferTo)?.nickname ?? transferTo,
                    }),
                  ).then((next) => next && setTransferTo(''))
                }
              >
                {t('apps.builder.settings.transferAction')}
              </Button>
            </div>
          )}
        </PanelSection>
      )}

      {isSuper && (
        <PanelSection title={t('apps.builder.settings.feature')} hint={t('apps.builder.settings.featureHint')}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg">
              {app.publishedVersion === null
                ? t('apps.builder.settings.featureNeedsPublish')
                : t('apps.builder.settings.featureLabel')}
            </span>
            <Toggle
              checked={app.featured}
              disabled={busy || (app.publishedVersion === null && !app.featured)}
              label={t('apps.builder.settings.featureLabel')}
              onChange={(featured) =>
                void run(
                  () => featureApp(app.id, featured),
                  featured ? t('apps.builder.settings.featured') : t('apps.builder.settings.unfeatured'),
                )
              }
            />
          </div>
        </PanelSection>
      )}

      <PanelSection title={t('apps.builder.settings.archive')} hint={t('apps.builder.settings.archiveHint')}>
        {canArchive ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || app.status === 'archived'}
            onClick={() => setArchiving(true)}
          >
            {t('apps.builder.settings.archiveAction')}
          </Button>
        ) : (
          <p className="text-xs text-fg-faint">{t('apps.builder.settings.archiveOwnerOnly')}</p>
        )}
      </PanelSection>

      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        onConfirm={() => {
          setArchiving(false);
          void run(() => archiveApp(app.id), t('apps.builder.settings.archived')).then((next) => {
            if (next) window.location.hash = APP_CENTER_HREF;
          });
        }}
        title={t('apps.builder.settings.archiveTitle', { name: app.name })}
        description={t('apps.builder.settings.archiveDescription')}
        confirmLabel={t('apps.builder.settings.archiveAction')}
        confirmVariant="destructive"
      />
    </div>
  );
}
