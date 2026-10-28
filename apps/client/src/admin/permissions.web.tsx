/**
 * One member's access, by feature point (GET /api/admin/users/:id/access): basic, app and advanced
 * tabs. Flag points switch per member (PUT …/features), the advanced tool bucket grants tools one
 * by one (PUT …/tools, full list); app capabilities and record/field policies come from the
 * member's role and are read-only. Spend limits live in Services & pricing.
 */
import React, { useCallback, useState } from 'react';
import { useResource } from '../data/use-resource';
import { useT } from '../lib/i18n';
import { Icon, type IconName } from '../ui/core';
import { lucideIcon } from '../plugins/icons';
import * as admin from './api';
import { AdminDialog, Badge, SectionState, Switch, Tabs } from './kit.web';
import { useWrite } from './use-write';
import type { AccessEntity, AccessFeaturePoint, ManagedUser, ReadMode } from './types';

type Tab = 'basic' | 'apps' | 'advanced';
const SCOPES: readonly string[] = ['own', 'collaborating', 'assigned', 'department', 'departmentTree', 'all'];
type Scope = 'own' | 'collaborating' | 'assigned' | 'department' | 'departmentTree' | 'all';

export function PermissionsDialog({ user, close }: { user: Pick<ManagedUser, 'id' | 'nickname'>; close: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('basic');
  const view = useResource(useCallback(() => admin.userAccess(user.id), [user.id]));
  const { busy, run } = useWrite();
  const points = view.data?.featurePoints ?? [];
  const toolset = points.find((p) => p.kind === 'toolset');
  const write = async (call: () => ReturnType<typeof admin.setUserTools>) => {
    if (await run(call, t('admin.permissions.updateFailed'))) void view.refresh();
  };
  const toggleMain = (point: AccessFeaturePoint, next: boolean) => {
    const control = point.mainControl;
    if (control?.type === 'flag') void write(() => admin.setUserFeature(user.id, control.flag, next));
  };
  const toggleTool = (id: string, on: boolean) => {
    const assigned = new Set((toolset?.tools ?? []).filter((tool) => tool.assigned).map((tool) => tool.id));
    if (on) assigned.add(id);
    else assigned.delete(id);
    void write(() => admin.setUserTools(user.id, [...assigned]));
  };
  return (
    <AdminDialog
      title={t('admin.permissions.title', { name: user.nickname })}
      size="lg"
      onClose={close}
      testID="admin-permissions"
    >
      <div className="gh-admin-dialog-tabs">
        <Tabs
          label={t('admin.permissions.title', { name: user.nickname })}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'basic', label: t('admin.permissions.basic') },
            { value: 'apps', label: t('admin.permissions.apps') },
            { value: 'advanced', label: t('admin.permissions.advanced') },
          ]}
        />
      </div>
      {!view.data ? (
        <SectionState loading={view.loading} error={view.error} retry={() => void view.refresh()} />
      ) : (
        <div className="gh-admin-points" role="tabpanel">
          <p className="gh-hint">{t(`admin.permissions.${tab}Hint`)}</p>
          {points
            .filter((point) => point.group === tab)
            .map((point) => (
              <PointCard key={point.key} point={point} busy={busy} onMain={toggleMain} onTool={toggleTool} />
            ))}
          {tab === 'basic' && view.data.baseline.globalTools.length ? (
            <>
              <h4 className="gh-form-heading">{t('admin.permissions.globalTools')}</h4>
              <p className="gh-hint">{t('admin.permissions.globalToolsHint')}</p>
              <div className="gh-chip-row">
                {view.data.baseline.globalTools.map((tool) => (
                  <span key={tool.id} className="gh-badge" title={tool.brief}>
                    {tool.name}
                  </span>
                ))}
              </div>
            </>
          ) : null}
          {!points.some((point) => point.group === tab) && tab !== 'basic' ? (
            <p className="gh-admin-empty-line">{t('admin.permissions.none')}</p>
          ) : null}
        </div>
      )}
    </AdminDialog>
  );
}

function PointCard({
  point,
  busy,
  onMain,
  onTool,
}: {
  point: AccessFeaturePoint;
  busy: boolean;
  onMain: (point: AccessFeaturePoint, next: boolean) => void;
  onTool: (id: string, on: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const toolset = point.kind === 'toolset';
  const finer = point.kind === 'app' && !!(point.capabilities?.length || point.entities?.length);
  const icon: IconName = lucideIcon(point.icon) ?? 'wrench';
  const tools = point.tools ?? [];
  return (
    <div className="gh-admin-point" data-testid={`permission-${point.key}`}>
      <header>
        <span className="gh-admin-point-icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="gh-admin-point-text">
          <strong>{point.title}</strong>
          <span>{point.description}</span>
        </span>
        {toolset ? (
          <small className="gh-count">
            {t('admin.permissions.toolsOn', { on: tools.filter((tool) => tool.assigned).length, total: tools.length })}
          </small>
        ) : null}
        {finer || toolset ? (
          <button type="button" className="gh-link-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open
              ? t('admin.permissions.hide')
              : toolset
                ? t('admin.permissions.tools')
                : t('admin.permissions.details')}
          </button>
        ) : null}
        {!toolset && point.mainControl ? (
          <Switch
            checked={point.enabled}
            disabled={busy}
            label={point.title}
            onChange={(next) => onMain(point, next)}
          />
        ) : null}
      </header>
      {open ? (
        <div className="gh-admin-point-detail">
          {point.kind === 'app' && !point.enabled ? <span>{t('admin.permissions.enableFirst')}</span> : null}
          {point.capabilities?.length ? (
            <>
              <h4 className="gh-form-heading">{t('admin.permissions.actions')}</h4>
              {point.capabilities.map((cap) => (
                <div key={cap.capability} className="gh-admin-tool">
                  <span className="gh-mono" title={cap.capability}>
                    {cap.capability}
                    <small>{cap.reason}</small>
                  </span>
                  <Badge tone={cap.allowed ? 'success' : 'danger'}>
                    {cap.allowed ? t('admin.permissions.allowed') : t('admin.permissions.denied')}
                  </Badge>
                </div>
              ))}
            </>
          ) : null}
          {point.entities?.length ? (
            <>
              <h4 className="gh-form-heading">{t('admin.permissions.records')}</h4>
              {point.entities.map((entity) => (
                <EntityPolicy key={`${entity.appId}:${entity.entityId}`} entity={entity} />
              ))}
            </>
          ) : null}
          {toolset
            ? tools.map((tool) => (
                <div key={tool.id} className="gh-admin-tool">
                  <span>
                    {tool.name}
                    <small>{tool.brief}</small>
                  </span>
                  <Switch
                    checked={tool.assigned}
                    disabled={busy}
                    label={tool.name}
                    onChange={(on) => onTool(tool.id, on)}
                  />
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

function EntityPolicy({ entity }: { entity: AccessEntity }) {
  const t = useT();
  const read: Record<ReadMode, string> = {
    full: t('admin.permissions.full'),
    masked: t('admin.permissions.masked'),
    none: t('admin.permissions.hidden'),
  };
  const scopes = entity.effectivePolicy.scopes;
  return (
    <details>
      <summary className="gh-admin-tool">
        <span>{entity.title}</span>
        <span className="gh-chip-row">
          {scopes.length ? (
            scopes.map((scope) => (
              <Badge key={scope}>
                {SCOPES.includes(scope) ? t(`admin.permissions.scope.${scope as Scope}`) : scope}
              </Badge>
            ))
          ) : (
            <Badge tone="danger">{t('admin.permissions.denied')}</Badge>
          )}
        </span>
      </summary>
      <table className="gh-data-grid gh-admin-grid">
        <thead>
          <tr>
            <th>{t('admin.permissions.field')}</th>
            <th>{t('admin.permissions.read')}</th>
            <th>{t('admin.permissions.write')}</th>
            <th>{t('admin.permissions.export')}</th>
          </tr>
        </thead>
        <tbody>
          {entity.fields.map((field) => {
            const policy = entity.effectivePolicy.fields[field.id] ?? { read: 'none', write: false, export: false };
            return (
              <tr key={field.id}>
                <td>{field.title}</td>
                <td>{read[policy.read]}</td>
                <td>{policy.write ? '✓' : '—'}</td>
                <td>{policy.export ? '✓' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
