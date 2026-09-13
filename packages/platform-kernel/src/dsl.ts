import { isExactCapability } from './authz.js';

/**
 * Code-first application manifest DSL.
 *
 * Definitions must remain JSON-serializable. Runtime handlers, database
 * clients, React components, and closures belong in adapters/registries, never
 * in a persisted manifest.
 */

export const APPLICATION_MANIFEST_SCHEMA_VERSION = 2 as const;

const STABLE_ID_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type FieldKind =
  | 'text'
  | 'longText'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'enum'
  | 'user'
  | 'users'
  | 'relation'
  | 'relations'
  | 'json';

export type FieldClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export interface FieldDefinition {
  kind: FieldKind;
  title: string;
  required?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  indexed?: boolean;
  unique?: boolean;
  classification?: FieldClassification;
  values?: readonly string[];
  target?: string;
}

export type AccessScope = 'own' | 'collaborating' | 'assigned' | 'department' | 'departmentTree' | 'all';

export interface ModuleDefinition {
  title: string;
  description?: string;
  icon?: string;
}

export interface EntityDefinition {
  title: string;
  module: string;
  table: string;
  fields: Record<string, FieldDefinition>;
  accessScopes: readonly AccessScope[];
}

export type ActionKind = 'query' | 'command';
export type ActionRisk = 'read' | 'low' | 'medium' | 'high' | 'destructive';

export interface ActionDefinition {
  title: string;
  module: string;
  entity?: string;
  kind: ActionKind;
  capability: string;
  risk: ActionRisk;
  idempotent?: boolean;
  mcp?: boolean;
}

export type RuleExpression =
  | { op: 'literal'; value: unknown }
  | { op: 'field'; field: string }
  | { op: 'eq'; left: RuleExpression; right: RuleExpression }
  | { op: 'and'; values: RuleExpression[] }
  | { op: 'or'; values: RuleExpression[] }
  | { op: 'not'; value: RuleExpression }
  | { op: 'isEmpty'; value: RuleExpression };

export interface FormFieldDefinition {
  field: string;
  span?: 1 | 2 | 3 | 4;
  component?: 'input' | 'textarea' | 'select' | 'userSelect' | 'userMultiSelect';
  visibleWhen?: RuleExpression;
  requiredWhen?: RuleExpression;
  readOnlyWhen?: RuleExpression;
}

export interface FormSectionDefinition {
  id: string;
  title?: string;
  description?: string;
  columns?: 1 | 2 | 3 | 4;
  fields: FormFieldDefinition[];
}

export interface FormDefinition {
  title: string;
  entity: string;
  mode: 'create' | 'edit' | 'view';
  sections: FormSectionDefinition[];
}

export interface ViewDefinition {
  title: string;
  entity: string;
  type: 'table' | 'kanban' | 'detail' | 'kpi' | 'calendar';
  fields: string[];
  searchableFields?: string[];
  filterableFields?: string[];
  defaultSort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  groupBy?: string;
}

export interface NavigationItem {
  id: string;
  title: string;
  module: string;
  path: string;
  view?: string;
  capability?: string;
}

export interface ApplicationDefinition {
  id: string;
  version: string;
  title: string;
  description?: string;
  modules: Record<string, ModuleDefinition>;
  entities: Record<string, EntityDefinition>;
  actions: Record<string, ActionDefinition>;
  forms?: Record<string, FormDefinition>;
  views?: Record<string, ViewDefinition>;
  navigation?: readonly NavigationItem[];
}

export type ManifestModule = ModuleDefinition & { id: string };
export type ManifestField = FieldDefinition & { id: string };
export type ManifestEntity = Omit<EntityDefinition, 'fields'> & {
  id: string;
  fields: Record<string, ManifestField>;
};
export type ManifestAction = ActionDefinition & { id: string };

export interface ApplicationManifest extends Omit<
  ApplicationDefinition,
  'modules' | 'entities' | 'actions' | 'forms' | 'views' | 'navigation'
> {
  schemaVersion: typeof APPLICATION_MANIFEST_SCHEMA_VERSION;
  modules: Record<string, ManifestModule>;
  entities: Record<string, ManifestEntity>;
  actions: Record<string, ManifestAction>;
  forms: Record<string, FormDefinition & { id: string }>;
  views: Record<string, ViewDefinition & { id: string }>;
  navigation: readonly NavigationItem[];
  capabilities: string[];
}

export function isStableId(value: string): boolean {
  return STABLE_ID_PATTERN.test(value);
}

function assertStableId(id: string, context: string): void {
  if (!isStableId(id)) {
    throw new ManifestValidationError(`${context} "${id}" 必须是 1-64 位稳定 lowerCamelCase ID`);
  }
}

function assertJsonSerializable(value: unknown, path = '$', ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ManifestValidationError(`${path} 包含非有限数字`);
    }
    return;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new ManifestValidationError(`${path} 包含不可 JSON 序列化的 ${typeof value}`);
  }
  if (typeof value !== 'object') return;

  if (ancestors.has(value)) {
    throw new ManifestValidationError(`${path} 包含循环引用`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ManifestValidationError(`${path} 必须是普通 JSON 对象`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonSerializable(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function referencedRuleFields(expression: RuleExpression): string[] {
  switch (expression.op) {
    case 'literal':
      return [];
    case 'field':
      return [expression.field];
    case 'eq':
      return [...referencedRuleFields(expression.left), ...referencedRuleFields(expression.right)];
    case 'and':
    case 'or':
      return expression.values.flatMap(referencedRuleFields);
    case 'not':
    case 'isEmpty':
      return referencedRuleFields(expression.value);
  }
}

function validateField(entityId: string, fieldId: string, field: FieldDefinition): void {
  assertStableId(fieldId, `实体 ${entityId} 的字段`);
  if ((field.kind === 'enum') !== Boolean(field.values?.length)) {
    throw new ManifestValidationError(`字段 ${entityId}.${fieldId} 的 enum values 配置不完整`);
  }
  const isRelation = field.kind === 'relation' || field.kind === 'relations';
  if (isRelation !== Boolean(field.target)) {
    throw new ManifestValidationError(`字段 ${entityId}.${fieldId} 的 relation target 配置不完整`);
  }
}

export function defineApp<T extends ApplicationDefinition>(definition: T): T {
  return definition;
}

/** Compile and cross-reference validate an application definition. */
export function compileApp(definition: ApplicationDefinition): ApplicationManifest {
  assertJsonSerializable(definition);
  assertStableId(definition.id, '应用');
  if (!SEMVER_PATTERN.test(definition.version)) {
    throw new ManifestValidationError(`应用版本 "${definition.version}" 必须使用 semver`);
  }

  const modules: Record<string, ManifestModule> = {};
  for (const [moduleId, module] of Object.entries(definition.modules)) {
    assertStableId(moduleId, '模块');
    modules[moduleId] = { id: moduleId, ...module };
  }
  if (Object.keys(modules).length === 0) {
    throw new ManifestValidationError('应用至少需要一个模块');
  }

  const entities: Record<string, ManifestEntity> = {};
  const tableNames = new Set<string>();
  for (const [entityId, entity] of Object.entries(definition.entities)) {
    assertStableId(entityId, '实体');
    if (!modules[entity.module]) {
      throw new ManifestValidationError(`实体 ${entityId} 引用了不存在的模块 ${entity.module}`);
    }
    if (!TABLE_NAME_PATTERN.test(entity.table)) {
      throw new ManifestValidationError(`实体 ${entityId} 的物理表名非法`);
    }
    if (entity.accessScopes.length === 0) {
      throw new ManifestValidationError(`实体 ${entityId} 至少需要声明一个 access scope`);
    }
    if (tableNames.has(entity.table)) {
      throw new ManifestValidationError(`物理表 ${entity.table} 被重复使用`);
    }
    tableNames.add(entity.table);

    const fields: Record<string, ManifestField> = {};
    for (const [fieldId, field] of Object.entries(entity.fields)) {
      validateField(entityId, fieldId, field);
      fields[fieldId] = { id: fieldId, ...field };
    }
    entities[entityId] = { id: entityId, ...entity, fields };
  }

  for (const [entityId, entity] of Object.entries(entities)) {
    for (const field of Object.values(entity.fields)) {
      if (field.target && !entities[field.target]) {
        throw new ManifestValidationError(`字段 ${entityId}.${field.id} 引用了不存在的实体 ${field.target}`);
      }
    }
  }

  const actions: Record<string, ManifestAction> = {};
  const capabilities = new Set<string>();
  for (const [actionId, action] of Object.entries(definition.actions)) {
    assertStableId(actionId, '动作');
    if (!modules[action.module]) {
      throw new ManifestValidationError(`动作 ${actionId} 引用了不存在的模块 ${action.module}`);
    }
    if (action.entity && !entities[action.entity]) {
      throw new ManifestValidationError(`动作 ${actionId} 引用了不存在的实体 ${action.entity}`);
    }
    if (action.entity && entities[action.entity]?.module !== action.module) {
      throw new ManifestValidationError(`动作 ${actionId} 的模块与实体 ${action.entity} 不一致`);
    }
    if (action.kind === 'query' && action.risk !== 'read') {
      throw new ManifestValidationError(`查询动作 ${actionId} 的 risk 必须是 read`);
    }
    if (action.kind === 'command' && action.risk === 'read') {
      throw new ManifestValidationError(`命令动作 ${actionId} 的 risk 不能是 read`);
    }
    if (!isExactCapability(action.capability)) {
      throw new ManifestValidationError(`动作 ${actionId} 的 capability "${action.capability}" 格式非法`);
    }
    const prefix = `${definition.id}.${action.module}.`;
    if (!action.capability.startsWith(prefix)) {
      throw new ManifestValidationError(`动作 ${actionId} 的 capability 必须以 ${prefix} 开头`);
    }
    // The map key is the canonical action identity. Never allow a caller-supplied
    // `id` property (including one smuggled through an `any`) to overwrite it.
    actions[actionId] = { ...action, id: actionId };
    capabilities.add(action.capability);
  }
  if (Object.keys(actions).length === 0) {
    throw new ManifestValidationError('应用至少需要一个动作');
  }

  const forms: Record<string, FormDefinition & { id: string }> = {};
  for (const [formId, form] of Object.entries(definition.forms ?? {})) {
    assertStableId(formId, '表单');
    const entity = entities[form.entity];
    if (!entity) {
      throw new ManifestValidationError(`表单 ${formId} 引用了不存在的实体 ${form.entity}`);
    }
    const sectionIds = new Set<string>();
    for (const section of form.sections) {
      assertStableId(section.id, `表单 ${formId} 的分组`);
      if (sectionIds.has(section.id)) {
        throw new ManifestValidationError(`表单 ${formId} 的分组 ${section.id} 重复`);
      }
      sectionIds.add(section.id);
      for (const item of section.fields) {
        if (!entity.fields[item.field]) {
          throw new ManifestValidationError(`表单 ${formId} 引用了不存在的字段 ${form.entity}.${item.field}`);
        }
        for (const expression of [item.visibleWhen, item.requiredWhen, item.readOnlyWhen]) {
          for (const fieldId of expression ? referencedRuleFields(expression) : []) {
            if (!entity.fields[fieldId]) {
              throw new ManifestValidationError(`表单 ${formId} 的规则引用了不存在的字段 ${form.entity}.${fieldId}`);
            }
          }
        }
      }
    }
    forms[formId] = { id: formId, ...form };
  }

  const views: Record<string, ViewDefinition & { id: string }> = {};
  for (const [viewId, view] of Object.entries(definition.views ?? {})) {
    assertStableId(viewId, '视图');
    const entity = entities[view.entity];
    if (!entity) {
      throw new ManifestValidationError(`视图 ${viewId} 引用了不存在的实体 ${view.entity}`);
    }
    const fieldIds = [
      ...view.fields,
      ...(view.searchableFields ?? []),
      ...(view.filterableFields ?? []),
      ...(view.defaultSort ?? []).map((sort) => sort.field),
      ...(view.groupBy ? [view.groupBy] : []),
    ];
    for (const fieldId of fieldIds) {
      if (!entity.fields[fieldId]) {
        throw new ManifestValidationError(`视图 ${viewId} 引用了不存在的字段 ${view.entity}.${fieldId}`);
      }
    }
    views[viewId] = { id: viewId, ...view };
  }

  const navigation = definition.navigation ?? [];
  const navigationIds = new Set<string>();
  for (const item of navigation) {
    assertStableId(item.id, '导航');
    if (navigationIds.has(item.id)) {
      throw new ManifestValidationError(`导航 ID ${item.id} 重复`);
    }
    navigationIds.add(item.id);
    if (!modules[item.module]) {
      throw new ManifestValidationError(`导航 ${item.id} 引用了不存在的模块 ${item.module}`);
    }
    if (!item.path.startsWith('/')) {
      throw new ManifestValidationError(`导航 ${item.id} 的 path 必须以 / 开头`);
    }
    if (item.view && !views[item.view]) {
      throw new ManifestValidationError(`导航 ${item.id} 引用了不存在的视图 ${item.view}`);
    }
    if (item.capability && !capabilities.has(item.capability)) {
      throw new ManifestValidationError(`导航 ${item.id} 引用了未声明的 capability ${item.capability}`);
    }
  }

  return {
    ...definition,
    schemaVersion: APPLICATION_MANIFEST_SCHEMA_VERSION,
    modules,
    entities,
    actions,
    forms,
    views,
    navigation,
    capabilities: [...capabilities].sort(),
  };
}

export function evaluateRule(expression: RuleExpression, values: Record<string, unknown>): unknown {
  switch (expression.op) {
    case 'literal':
      return expression.value;
    case 'field':
      return values[expression.field];
    case 'eq':
      return evaluateRule(expression.left, values) === evaluateRule(expression.right, values);
    case 'and':
      return expression.values.every((value) => Boolean(evaluateRule(value, values)));
    case 'or':
      return expression.values.some((value) => Boolean(evaluateRule(value, values)));
    case 'not':
      return !evaluateRule(expression.value, values);
    case 'isEmpty': {
      const value = evaluateRule(expression.value, values);
      return value === null || value === undefined || value === '';
    }
  }
}

export class ManifestValidationError extends Error {
  readonly code = 'INVALID_APPLICATION_MANIFEST';

  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}
