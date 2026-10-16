/**
 * Built-in base templates (TBL-15). 「项目」: a projects table and a tasks table; milestones are
 * tasks of the type 里程碑 (data-model §12.8), with owners, dates, a parent task and
 * dependencies, and views for the grid, the board, the timeline and the calendar. A small
 * sample project shows how the pieces fit; its dates start today.
 */

import type { FieldConfig, FieldType, ViewConfig, ViewType } from '@greenhouse/contract';

export const TEMPLATE_VERSIONS = { project: '1.0.0' } as const;

export interface TemplateField {
  ref: string;
  name: string;
  type: FieldType;
  config?: FieldConfig;
  primary?: boolean;
}

export interface TemplateTable {
  ref: string;
  name: string;
  fields: TemplateField[];
  /** Views in order; `config` names fields by ref, turned into ids when the base is made. */
  views: Array<{ name: string; type: ViewType; config: (id: (ref: string) => string) => ViewConfig }>;
  /** Sample rows: values by field ref; links name rows by ref, `$me` is the member making it, numbers on date fields are days from today. */
  rows: Array<{ ref: string; values: Record<string, unknown> }>;
}

export interface TemplatePlan {
  name: string;
  tables: TemplateTable[];
}

type Words = Record<
  | 'name'
  | 'projects'
  | 'tasks'
  | 'title'
  | 'owner'
  | 'status'
  | 'start'
  | 'due'
  | 'notes'
  | 'project'
  | 'kind'
  | 'parent'
  | 'dependsOn'
  | 'priority'
  | 'planning'
  | 'active'
  | 'done'
  | 'paused'
  | 'todo'
  | 'doing'
  | 'task'
  | 'milestone'
  | 'high'
  | 'medium'
  | 'low'
  | 'all'
  | 'grid'
  | 'board'
  | 'timeline'
  | 'calendar'
  | 'sample'
  | 'sampleNotes'
  | 'kickoff'
  | 'research'
  | 'design'
  | 'homeDesign'
  | 'detailDesign'
  | 'build'
  | 'api'
  | 'review'
  | 'launch',
  string
>;

const WORDS: Record<'zh' | 'en', Words> = {
  zh: {
    name: '项目管理',
    projects: '项目',
    tasks: '任务',
    title: '名称',
    owner: '负责人',
    status: '状态',
    start: '开始日期',
    due: '截止日期',
    notes: '说明',
    project: '项目',
    kind: '类型',
    parent: '父任务',
    dependsOn: '依赖',
    priority: '优先级',
    planning: '规划中',
    active: '进行中',
    done: '已完成',
    paused: '已暂停',
    todo: '待开始',
    doing: '进行中',
    task: '任务',
    milestone: '里程碑',
    high: '高',
    medium: '中',
    low: '低',
    all: '全部项目',
    grid: '表格',
    board: '看板',
    timeline: '时间线',
    calendar: '日历',
    sample: '示例项目',
    sampleNotes: '这是一个示例，可以直接改成你的项目，或者删除。',
    kickoff: '项目启动',
    research: '需求调研',
    design: '设计',
    homeDesign: '首页设计',
    detailDesign: '详情页设计',
    build: '前端开发',
    api: '后端接口',
    review: '联调与验收',
    launch: '上线',
  },
  en: {
    name: 'Projects',
    projects: 'Projects',
    tasks: 'Tasks',
    title: 'Name',
    owner: 'Owner',
    status: 'Status',
    start: 'Start',
    due: 'Due',
    notes: 'Notes',
    project: 'Project',
    kind: 'Type',
    parent: 'Parent task',
    dependsOn: 'Depends on',
    priority: 'Priority',
    planning: 'Planning',
    active: 'Active',
    done: 'Done',
    paused: 'Paused',
    todo: 'To do',
    doing: 'In progress',
    task: 'Task',
    milestone: 'Milestone',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    all: 'All projects',
    grid: 'Grid',
    board: 'Board',
    timeline: 'Timeline',
    calendar: 'Calendar',
    sample: 'Sample project',
    sampleNotes: 'A sample: rename it to your project, or delete it.',
    kickoff: 'Kickoff',
    research: 'Research',
    design: 'Design',
    homeDesign: 'Home page design',
    detailDesign: 'Detail page design',
    build: 'Front end',
    api: 'Back end API',
    review: 'Integration and review',
    launch: 'Launch',
  },
};

/** The 「项目」 template in the member's language. */
export function projectTemplate(locale: 'zh' | 'en'): TemplatePlan {
  const w = WORDS[locale];
  return {
    name: w.name,
    tables: [
      {
        ref: 'projects',
        name: w.projects,
        fields: [
          { ref: 'title', name: w.title, type: 'text', primary: true },
          { ref: 'owner', name: w.owner, type: 'member', config: { multiple: false } },
          {
            ref: 'status',
            name: w.status,
            type: 'single_select',
            config: {
              options: [
                { id: 'planning', label: w.planning, color: 'gray' },
                { id: 'active', label: w.active, color: 'blue' },
                { id: 'done', label: w.done, color: 'green' },
                { id: 'paused', label: w.paused, color: 'amber' },
              ],
            },
          },
          { ref: 'start', name: w.start, type: 'date' },
          { ref: 'due', name: w.due, type: 'date' },
          { ref: 'notes', name: w.notes, type: 'long_text' },
        ],
        views: [{ name: w.all, type: 'grid', config: () => ({}) }],
        rows: [
          {
            ref: 'sample',
            values: { title: w.sample, owner: ['$me'], status: 'active', start: 0, due: 30, notes: w.sampleNotes },
          },
        ],
      },
      {
        ref: 'tasks',
        name: w.tasks,
        fields: [
          { ref: 'title', name: w.title, type: 'text', primary: true },
          { ref: 'project', name: w.project, type: 'relation', config: { table_id: 'projects', multiple: false } },
          {
            ref: 'kind',
            name: w.kind,
            type: 'single_select',
            config: {
              options: [
                { id: 'task', label: w.task, color: 'gray' },
                { id: 'milestone', label: w.milestone, color: 'purple' },
              ],
            },
          },
          {
            ref: 'status',
            name: w.status,
            type: 'single_select',
            config: {
              options: [
                { id: 'todo', label: w.todo, color: 'gray' },
                { id: 'doing', label: w.doing, color: 'blue' },
                { id: 'done', label: w.done, color: 'green' },
              ],
            },
          },
          { ref: 'owner', name: w.owner, type: 'member', config: { multiple: false } },
          { ref: 'start', name: w.start, type: 'date' },
          { ref: 'due', name: w.due, type: 'date' },
          { ref: 'parent', name: w.parent, type: 'parent' },
          { ref: 'depends', name: w.dependsOn, type: 'dependency' },
          {
            ref: 'priority',
            name: w.priority,
            type: 'single_select',
            config: {
              options: [
                { id: 'high', label: w.high, color: 'red' },
                { id: 'medium', label: w.medium, color: 'amber' },
                { id: 'low', label: w.low, color: 'gray' },
              ],
            },
          },
          { ref: 'notes', name: w.notes, type: 'long_text' },
        ],
        views: [
          {
            name: w.grid,
            type: 'grid',
            config: (id) => ({ hidden: [id('parent'), id('notes')], widths: { [id('title')]: 240 } }),
          },
          {
            name: w.board,
            type: 'kanban',
            config: (id) => ({
              kanban: { field: id('status') },
              hidden: [id('project'), id('kind'), id('start'), id('parent'), id('depends'), id('notes')],
            }),
          },
          {
            name: w.timeline,
            type: 'timeline',
            config: (id) => ({
              timeline: {
                start: id('start'),
                end: id('due'),
                dependency: id('depends'),
                milestone: { field: id('kind'), option: 'milestone' },
                scale: 'week',
              },
            }),
          },
          {
            name: w.calendar,
            type: 'calendar',
            config: (id) => ({ calendar: { start: id('start'), end: id('due') } }),
          },
        ],
        rows: [
          { ref: 'kickoff', values: { title: w.kickoff, kind: 'milestone', status: 'done', start: 0, due: 0 } },
          {
            ref: 'research',
            values: { title: w.research, status: 'doing', owner: ['$me'], start: 0, due: 4, depends: ['kickoff'] },
          },
          {
            ref: 'design',
            values: { title: w.design, status: 'todo', priority: 'high', start: 5, due: 11, depends: ['research'] },
          },
          {
            ref: 'homeDesign',
            values: { title: w.homeDesign, status: 'todo', start: 5, due: 8, parent: ['design'] },
          },
          {
            ref: 'detailDesign',
            values: { title: w.detailDesign, status: 'todo', start: 8, due: 11, parent: ['design'] },
          },
          {
            ref: 'build',
            values: { title: w.build, status: 'todo', priority: 'high', start: 12, due: 20, depends: ['design'] },
          },
          { ref: 'api', values: { title: w.api, status: 'todo', start: 12, due: 18, depends: ['research'] } },
          {
            ref: 'review',
            values: { title: w.review, status: 'todo', start: 21, due: 25, depends: ['build', 'api'] },
          },
          {
            ref: 'launch',
            values: { title: w.launch, kind: 'milestone', status: 'todo', start: 26, due: 26, depends: ['review'] },
          },
        ].map((row) => ({ ...row, values: { kind: 'task', project: ['sample'], ...row.values } })),
      },
    ],
  };
}
