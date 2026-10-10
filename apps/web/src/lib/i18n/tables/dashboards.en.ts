/**
 * Tables · Dashboards: cards, filter bar, widget editor.
 * Owned by slice D; spread into `tables` by ./en.ts (keys resolve as `tables.<namespace>.*`).
 */

export const tablesDashboardsEn = {
  dashboard: {
    title: 'Dashboard',
    description: 'Live summaries from records in this Base',
    loadFailed: 'Unable to load dashboard',
    saveWidgetFailed: 'Unable to save widget',
    widget: 'Widget',
    emptyTitle: 'No widgets yet',
    emptyBuilder: 'Add a KPI, chart, record list, or text note.',
    emptyViewer: 'A builder has not added dashboard widgets yet.',
    editWidget: 'Edit dashboard widget',
    addWidget: 'Add dashboard widget',
    widgetTitle: 'Title',
    widgetTypeLabel: 'Widget type',
    valueField: 'Value field',
    groupBy: 'Group by',
    noGrouping: 'No grouping',
    saveWidget: 'Save widget',
    deleteTitle: 'Delete {name}?',
    deleteDescription: 'This removes the widget but does not modify source records.',
    editWidgetLabel: 'Edit {name}',
    deleteWidgetLabel: 'Delete {name}',
    allRecords: 'All records',
    widgetType: {
      kpi: 'KPI',
      bar: 'Bar chart',
      line: 'Line chart',
      pie: 'Pie chart',
      area: 'Area chart',
      pivot: 'Pivot table',
      records: 'Record list',
      text: 'Text note',
    },
  },
} as const;
