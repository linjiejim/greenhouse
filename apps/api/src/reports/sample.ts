/**
 * Sample content for a template preview: every section filled with
 * placeholder content of its kind (the guidance stands in for prose), so a
 * template's editor sees the real layout in the real brand before anyone
 * writes a report with it.
 */

import type { ReportTemplateDefinition } from '@greenhouse/types/reports';
import type { ReportContentInput } from './content.js';

const COPY = {
  zh: {
    subtitle: '示例内容',
    author: '示例作者',
    period: '本期',
    prose: '这里是示例正文。',
    bullets: ['第一条要点', '第二条要点，**加粗**示例', '第三条要点'],
    columns: ['事项', '负责人', '状态'],
    rows: [
      ['示例事项 A', '张三', '进行中'],
      ['示例事项 B', '李四', '已完成'],
    ],
    figures: [
      { label: '指标一', value: '128', note: '环比 +12%' },
      { label: '指标二', value: '96%' },
      { label: '指标三', value: '3.4k' },
    ],
  },
  en: {
    subtitle: 'Sample content',
    author: 'Sample author',
    period: 'This period',
    prose: 'Sample body text goes here.',
    bullets: ['First point', 'Second point, with **bold**', 'Third point'],
    columns: ['Item', 'Owner', 'Status'],
    rows: [
      ['Sample item A', 'Alex', 'In progress'],
      ['Sample item B', 'Sam', 'Done'],
    ],
    figures: [
      { label: 'Metric one', value: '128', note: '+12% vs last' },
      { label: 'Metric two', value: '96%' },
      { label: 'Metric three', value: '3.4k' },
    ],
  },
} as const;

export function sampleReportContent(template: ReportTemplateDefinition, locale: 'zh' | 'en'): ReportContentInput {
  const copy = COPY[locale];
  const cover: Record<string, string> = {};
  for (const field of template.cover_fields) {
    cover[field.key] =
      field.key === 'title'
        ? template.name
        : field.key === 'subtitle'
          ? copy.subtitle
          : field.key === 'author'
            ? copy.author
            : field.key === 'date'
              ? new Date().toISOString().slice(0, 10)
              : copy.period;
  }
  const sections: Record<string, unknown> = {};
  for (const section of template.sections) {
    if (section.content === 'markdown') sections[section.key] = section.guidance || copy.prose;
    else if (section.content === 'bullets') sections[section.key] = [...copy.bullets];
    else if (section.content === 'table') sections[section.key] = { columns: copy.columns, rows: copy.rows };
    else sections[section.key] = copy.figures;
  }
  return { cover, sections };
}
