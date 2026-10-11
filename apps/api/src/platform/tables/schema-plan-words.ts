/**
 * A drafted schema plan in words, for cards a client cannot word itself.
 *
 * The web chat card words a plan from its artifact with its own catalog
 * (`components/tables/schema-plan-card.tsx`). The Bots card (`tables_plan`
 * request, spec 20261011-tables-apps §7) is also drawn by the mobile app, which
 * vendors `@greenhouse/types/bots` verbatim and cannot import the Tables types —
 * so, like every Bots card (`bots/engine/copy.ts`), the server writes the
 * operation lines and the permission section in the member's language when the
 * request is created. Wording follows the web card; app operations are new here.
 *
 * Pure: no database.
 */

import type {
  SchemaPlanAccessChange,
  SchemaPlanAccessLevel,
  SchemaPlanAppAudienceView,
  SchemaPlanAudienceView,
  SchemaPlanOperation,
  SchemaPlanOperationKind,
  SchemaPlanRuleSummary,
} from '@greenhouse/types/tables';

export type PlanWordsLocale = 'en' | 'zh';

type Words = Record<PlanWordsLocale, string>;

const OP_LABELS: Readonly<Record<SchemaPlanOperationKind, Words>> = {
  'base.create': { en: 'Create Base', zh: '新建 Base' },
  'base.update': { en: 'Update Base', zh: '修改 Base' },
  'table.create': { en: 'Create table', zh: '新建表' },
  'table.update': { en: 'Update table', zh: '修改表' },
  'field.create': { en: 'Add field', zh: '新增字段' },
  'field.update': { en: 'Update field', zh: '修改字段' },
  'field.archive': { en: 'Archive field', zh: '归档字段' },
  'view.create': { en: 'Create view', zh: '新建视图' },
  'view.update': { en: 'Update view', zh: '修改视图' },
  'form.create': { en: 'Create form', zh: '新建表单' },
  'form.update': { en: 'Update form', zh: '修改表单' },
  'automation.create': { en: 'Create automation', zh: '新建自动化' },
  'automation.update': { en: 'Update automation', zh: '修改自动化' },
  'dashboard.create': { en: 'Create dashboard', zh: '新建仪表盘' },
  'dashboard.update': { en: 'Update dashboard', zh: '修改仪表盘' },
  'widget.create': { en: 'Add widget', zh: '添加组件' },
  'widget.update': { en: 'Update widget', zh: '修改组件' },
  'widget.delete': { en: 'Remove widget', zh: '删除组件' },
  'role.create': { en: 'Create role', zh: '新建角色' },
  'role.update': { en: 'Update role', zh: '修改角色' },
  'member.set': { en: 'Set member access', zh: '设置成员权限' },
  'app.create': { en: 'Create app', zh: '新建应用' },
  'app.update': { en: 'Update app draft', zh: '修改应用草稿' },
  'app.audience': { en: 'Share app', zh: '设置应用受众' },
  'app.publish': { en: 'Publish app', zh: '发布应用' },
};

/** The label of one operation kind (`field.create` → "Add field"). */
export function planOpLabel(op: SchemaPlanOperationKind, l: PlanWordsLocale): string {
  return OP_LABELS[op][l];
}

/**
 * What an operation is about: the name it sets, else the existing object's
 * current name (`targetNames`, from the draft) — an id only when neither is known.
 */
export function planOpTarget(operation: SchemaPlanOperation, current: string | undefined): string {
  switch (operation.op) {
    case 'base.create':
    case 'table.create':
    case 'field.create':
    case 'view.create':
    case 'form.create':
    case 'automation.create':
    case 'dashboard.create':
    case 'role.create':
    case 'app.create':
      return operation.name;
    case 'widget.create':
      return operation.title;
    case 'base.update':
      return operation.name ?? current ?? `#${operation.baseId ?? operation.baseRef}`;
    case 'table.update':
      return operation.name ?? current ?? `#${operation.tableId}`;
    case 'field.update':
      return operation.name ?? current ?? `#${operation.fieldId}`;
    case 'field.archive':
      return current ?? `#${operation.fieldId}`;
    case 'view.update':
      return operation.name ?? current ?? `#${operation.viewId}`;
    case 'form.update':
      return operation.name ?? current ?? `#${operation.formId}`;
    case 'automation.update':
      return operation.name ?? current ?? `#${operation.automationId}`;
    case 'dashboard.update':
      return operation.name ?? current ?? `#${operation.dashboardId}`;
    case 'widget.update':
      return operation.title ?? current ?? `#${operation.widgetId}`;
    case 'widget.delete':
      return current ?? `#${operation.widgetId}`;
    case 'role.update':
      return operation.name ?? current ?? `#${operation.roleId}`;
    case 'member.set':
      return current ?? (operation.principal === 'group' ? `#${operation.groupId}` : (operation.userId ?? ''));
    case 'app.update':
      return operation.name ?? current ?? `#${operation.appId ?? operation.appRef}`;
    case 'app.audience':
    case 'app.publish':
      return current ?? `#${operation.appId ?? operation.appRef}`;
  }
}

/** One line per operation, in order: its kind, its label and what it names. */
export function planLines(
  operations: readonly SchemaPlanOperation[],
  targetNames: Readonly<Record<number, string>> | undefined,
  l: PlanWordsLocale,
): Array<{ op: string; label: string; target: string }> {
  return operations.map((operation, index) => ({
    op: operation.op,
    label: planOpLabel(operation.op, l),
    target: planOpTarget(operation, targetNames?.[index]),
  }));
}

// ─── The permission section ──────────────────────────────

const LEVELS: Readonly<Record<'none' | 'owner' | 'builder' | 'editor' | 'viewer', Words>> = {
  none: { en: 'no access', zh: '无权限' },
  owner: { en: 'owner', zh: '所有者' },
  builder: { en: 'builder', zh: '搭建者' },
  editor: { en: 'editor', zh: '编辑者' },
  viewer: { en: 'viewer', zh: '查看者' },
};

function levelWords(level: SchemaPlanAccessLevel, l: PlanWordsLocale): string {
  if (level.kind === 'none') return LEVELS.none[l];
  if (level.kind === 'custom') return l === 'zh' ? `自定义角色 ${level.roleName}` : `custom role ${level.roleName}`;
  return LEVELS[level.role][l];
}

function formAudienceWords(audience: SchemaPlanAudienceView | null, l: PlanWordsLocale): string {
  if (!audience) return l === 'zh' ? '新表单' : 'new form';
  if (audience.kind === 'base') return l === 'zh' ? 'Base 成员' : 'Base members';
  if (audience.kind === 'team') return l === 'zh' ? '团队所有人' : 'everyone in the team';
  return audience.names.join(', ');
}

function rulesWords(summary: SchemaPlanRuleSummary | null, l: PlanWordsLocale): string {
  if (!summary) return l === 'zh' ? '新角色' : 'new role';
  const tables = summary.tables.map((rule) => {
    const parts = [
      rule.access === 'edit' ? (l === 'zh' ? '可编辑' : 'edit') : l === 'zh' ? '可读' : 'read',
      ...(rule.limitedRows ? [l === 'zh' ? '限定行' : 'limited rows'] : []),
      ...(rule.hiddenFields > 0
        ? [
            l === 'zh'
              ? `${rule.hiddenFields} 个隐藏字段`
              : `${rule.hiddenFields} hidden field${rule.hiddenFields === 1 ? '' : 's'}`,
          ]
        : []),
    ];
    return `${rule.table}${l === 'zh' ? '：' : ': '}${parts.join(', ')}`;
  });
  const listed = tables.length > 0 ? tables : [l === 'zh' ? '无表' : 'no tables'];
  return [...listed, ...(summary.dashboards ? [l === 'zh' ? '仪表盘' : 'dashboards'] : [])].join('; ');
}

/** One app audience entry: "group Finance (managed by Ann) as Approver" — never an arrow, which means before → after. */
export function appAudienceEntryWords(entry: SchemaPlanAppAudienceView, l: PlanWordsLocale): string {
  const who =
    entry.principal === 'team'
      ? l === 'zh'
        ? '团队所有人'
        : 'everyone in the team'
      : entry.principal === 'group'
        ? l === 'zh'
          ? `群组 ${entry.name}${entry.managedBy ? `（由 ${entry.managedBy} 管理）` : ''}`
          : `group ${entry.name}${entry.managedBy ? ` (managed by ${entry.managedBy})` : ''}`
        : entry.name;
  return l === 'zh' ? `${who}为「${entry.role}」` : `${who} as ${entry.role}`;
}

function appAudienceWords(entries: readonly SchemaPlanAppAudienceView[] | null, l: PlanWordsLocale): string {
  if (!entries || entries.length === 0) return l === 'zh' ? '未分发' : 'shared with nobody';
  return entries.map((entry) => appAudienceEntryWords(entry, l)).join(l === 'zh' ? '；' : '; ');
}

/** Subject, before and after of one permission or outbound change. */
export function accessChangeWords(
  change: SchemaPlanAccessChange,
  l: PlanWordsLocale,
): { subject: string; before: string; after: string } {
  switch (change.kind) {
    case 'grant':
      return {
        subject:
          change.principal === 'group'
            ? l === 'zh'
              ? `群组 ${change.name}（${change.base}）`
              : `Group ${change.name} on ${change.base}`
            : l === 'zh'
              ? `${change.name}（${change.base}）`
              : `${change.name} on ${change.base}`,
        before: levelWords(change.before, l),
        after: levelWords(change.after, l),
      };
    case 'team':
      return {
        subject: l === 'zh' ? `团队所有人（${change.base}）` : `Everyone in the team on ${change.base}`,
        before: levelWords(change.before, l),
        after: levelWords(change.after, l),
      };
    case 'role':
      return {
        subject: l === 'zh' ? `角色 ${change.role}` : `Role ${change.role}`,
        before: rulesWords(change.before, l),
        after: rulesWords(change.after, l),
      };
    case 'form':
      return {
        subject: l === 'zh' ? `表单 ${change.form}` : `Form ${change.form}`,
        before: formAudienceWords(change.before, l),
        after: `${formAudienceWords(change.after, l)} · ${
          change.published
            ? l === 'zh'
              ? '开放提交'
              : 'open for submissions'
            : l === 'zh'
              ? '草稿，未开放'
              : 'draft, closed'
        }`,
      };
    case 'app_audience':
      return {
        subject: l === 'zh' ? `应用 ${change.app} 的受众` : `Who uses the app ${change.app}`,
        before: appAudienceWords(change.before, l),
        after: appAudienceWords(change.after, l),
      };
    case 'app_publish':
      return {
        subject: l === 'zh' ? `发布应用 ${change.app}` : `Publish the app ${change.app}`,
        before:
          change.version > 1
            ? l === 'zh'
              ? `v${change.version - 1} 在用`
              : `v${change.version - 1} live`
            : l === 'zh'
              ? '未发布'
              : 'not published',
        after: `${l === 'zh' ? `v${change.version} 上线，` : `v${change.version} live for `}${appAudienceWords(change.audience, l)}`,
      };
  }
}

/** The permission section of a plan card, in order. */
export function planAccessLines(
  changes: readonly SchemaPlanAccessChange[],
  l: PlanWordsLocale,
): Array<{ subject: string; before: string; after: string }> {
  return changes.map((change) => accessChangeWords(change, l));
}
