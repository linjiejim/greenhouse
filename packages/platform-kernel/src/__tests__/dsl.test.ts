import { describe, expect, it } from 'vitest';

import { compileApp, defineApp, evaluateRule, ManifestValidationError, type ApplicationDefinition } from '../dsl.js';

function projectDefinition(): ApplicationDefinition {
  return defineApp({
    id: 'projects',
    version: '1.0.0',
    title: 'Projects',
    modules: {
      project: { title: 'Projects' },
      task: { title: 'Tasks' },
    },
    entities: {
      project: {
        title: 'Project',
        module: 'project',
        table: 'projects',
        accessScopes: ['own', 'collaborating', 'all'],
        fields: {
          title: { kind: 'text', title: 'Title', required: true },
          status: {
            kind: 'enum',
            title: 'Status',
            values: ['planning', 'active'],
          },
        },
      },
      task: {
        title: 'Task',
        module: 'task',
        table: 'tasks',
        accessScopes: ['assigned', 'collaborating', 'all'],
        fields: {
          title: { kind: 'text', title: 'Title' },
          project: { kind: 'relation', title: 'Project', target: 'project' },
        },
      },
    },
    actions: {
      listProjects: {
        title: 'List projects',
        module: 'project',
        entity: 'project',
        kind: 'query',
        capability: 'projects.project.read',
        risk: 'read',
        mcp: true,
      },
      createProject: {
        title: 'Create project',
        module: 'project',
        entity: 'project',
        kind: 'command',
        capability: 'projects.project.create',
        risk: 'medium',
        idempotent: true,
        mcp: true,
      },
    },
    forms: {
      projectCreate: {
        title: 'Create project',
        entity: 'project',
        mode: 'create',
        sections: [
          {
            id: 'main',
            fields: [
              { field: 'title' },
              {
                field: 'status',
                visibleWhen: {
                  op: 'not',
                  value: { op: 'isEmpty', value: { op: 'field', field: 'title' } },
                },
              },
            ],
          },
        ],
      },
    },
    views: {
      projectList: {
        title: 'Projects',
        entity: 'project',
        type: 'table',
        fields: ['title', 'status'],
        searchableFields: ['title'],
      },
    },
    navigation: [
      {
        id: 'projects',
        title: 'Projects',
        module: 'project',
        path: '/projects',
        view: 'projectList',
        capability: 'projects.project.read',
      },
    ],
  });
}

describe('compileApp', () => {
  it('compiles a deterministic v2 manifest and derives capabilities', () => {
    const first = compileApp(projectDefinition());
    const second = compileApp(projectDefinition());

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(2);
    expect(first.entities.project.fields.title.id).toBe('title');
    expect(first.actions.createProject.id).toBe('createProject');
    expect(first.capabilities).toEqual(['projects.project.create', 'projects.project.read']);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('rejects action capabilities outside their app and module', () => {
    const definition = projectDefinition();
    definition.actions.listProjects.capability = 'crm.project.read';

    expect(() => compileApp(definition)).toThrowError(
      new ManifestValidationError('动作 listProjects 的 capability 必须以 projects.project. 开头'),
    );
  });

  it('rejects broken relation references', () => {
    const definition = projectDefinition();
    definition.entities.task.fields.project.target = 'missing';

    expect(() => compileApp(definition)).toThrow(/不存在的实体 missing/);
  });

  it('rejects rule references to missing fields', () => {
    const definition = projectDefinition();
    const field = definition.forms?.projectCreate.sections[0]?.fields[0];
    if (field) field.visibleWhen = { op: 'field', field: 'missing' };

    expect(() => compileApp(definition)).toThrow(/规则引用了不存在的字段 project.missing/);
  });

  it('rejects non-serializable definitions instead of silently dropping values', () => {
    const definition = projectDefinition();
    definition.actions.listProjects.title = (() => 'dynamic') as unknown as string;

    expect(() => compileApp(definition)).toThrow(/不可 JSON 序列化的 function/);
  });

  it('locks query and command risk semantics', () => {
    const query = projectDefinition();
    query.actions.listProjects.risk = 'medium';
    expect(() => compileApp(query)).toThrow(/查询动作 listProjects 的 risk 必须是 read/);

    const command = projectDefinition();
    command.actions.createProject.risk = 'read';
    expect(() => compileApp(command)).toThrow(/命令动作 createProject 的 risk 不能是 read/);
  });

  it('keeps the action map key as the canonical id', () => {
    const definition = projectDefinition();
    (definition.actions.listProjects as unknown as Record<string, unknown>).id = 'createProject';
    const manifest = compileApp(definition);
    expect(manifest.actions.listProjects.id).toBe('listProjects');
  });
});

describe('evaluateRule', () => {
  it('evaluates nested form rules', () => {
    const rule = {
      op: 'and' as const,
      values: [
        {
          op: 'eq' as const,
          left: { op: 'field' as const, field: 'status' },
          right: { op: 'literal' as const, value: 'active' },
        },
        { op: 'not' as const, value: { op: 'isEmpty' as const, value: { op: 'field' as const, field: 'owner' } } },
      ],
    };

    expect(evaluateRule(rule, { status: 'active', owner: 'user-1' })).toBe(true);
    expect(evaluateRule(rule, { status: 'active', owner: '' })).toBe(false);
  });
});
