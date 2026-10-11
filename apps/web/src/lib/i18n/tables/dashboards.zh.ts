/**
 * Tables · Dashboards: cards, filter bar, widget editor.
 * Owned by slice D; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesDashboardsEn } from './dashboards.en';

export const tablesDashboardsZh: DeepRecord<typeof tablesDashboardsEn> = {
  dashboard: {
    title: '仪表盘',
    description: '此 Base 记录的实时汇总',
    loadFailed: '无法加载仪表盘',
    saveWidgetFailed: '无法保存组件',
    widget: '组件',
    emptyTitle: '暂无组件',
    emptyBuilder: '添加 KPI、图表、记录列表或文本备注。',
    emptyViewer: '构建者尚未添加仪表盘组件。',
    editWidget: '编辑仪表盘组件',
    addWidget: '添加仪表盘组件',
    widgetTitle: '标题',
    widgetTypeLabel: '组件类型',
    valueField: '数值字段',
    groupBy: '分组依据',
    noGrouping: '不分组',
    saveWidget: '保存组件',
    deleteTitle: '删除 {name}？',
    deleteDescription: '这只会移除组件，不会修改源记录。',
    editWidgetLabel: '编辑 {name}',
    deleteWidgetLabel: '删除 {name}',
    allRecords: '全部记录',
    widgetType: {
      kpi: 'KPI',
      bar: '柱状图',
      line: '折线图',
      pie: '饼图',
      area: '面积图',
      pivot: '透视表',
      records: '记录列表',
      text: '文本备注',
    },
  },
};
