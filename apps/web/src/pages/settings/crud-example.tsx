/**
 * CRUD Framework Demo — the end-to-end reference for @greenhouse/crud.
 *
 * One `defineCrud` schema drives the whole page (list + filters + add/edit form
 * + detail + delete), talking to the generic /api/crud/demo endpoint via
 * createRestDataSource. This is the "one-stop" path a fork copies to add a table
 * → API → page. Super-only (see nav-registry).
 */

import React, { useMemo } from 'react';
import { defineCrud, CrudPage, createRestDataSource } from '@greenhouse/crud';
import { FlaskConical } from '../../lib/icons';
import { authFetch } from '../../lib/auth';

interface DemoItem {
  id: number;
  name: string;
  category: 'plant' | 'device' | 'sensor' | 'other';
  status: 'draft' | 'active' | 'archived';
  priority: number;
  is_featured: boolean;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const dataSource = createRestDataSource<DemoItem>('/api/crud/demo', authFetch);

const CATEGORY = [
  { value: 'plant', label: 'Plant' },
  { value: 'device', label: 'Device' },
  { value: 'sensor', label: 'Sensor' },
  { value: 'other', label: 'Other' },
];
const STATUS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

export function CrudExamplePage() {
  const schema = useMemo(
    () =>
      defineCrud<DemoItem>({
        name: 'Demo Item',
        icon: FlaskConical,
        dataSource,
        columns: [
          { key: 'name', label: 'Name', sortable: true },
          {
            key: 'category',
            label: 'Category',
            type: 'badge',
            badgeMap: { plant: 'success', device: 'secondary', sensor: 'warning', other: 'default' },
          },
          {
            key: 'status',
            label: 'Status',
            type: 'badge',
            badgeMap: { active: 'success', draft: 'default', archived: 'destructive' },
          },
          { key: 'priority', label: 'Priority', type: 'number', sortable: true, align: 'right' },
          { key: 'is_featured', label: 'Featured', type: 'boolean', align: 'center', responsiveHide: 'md' },
          { key: 'tags', label: 'Tags', type: 'tags', responsiveHide: 'lg' },
          { key: 'notes', label: 'Notes', type: 'longtext', hidden: true },
          { key: 'created_at', label: 'Created', type: 'date', sortable: true, responsiveHide: 'md' },
        ],
        filters: [
          { key: 'name', label: 'Search name', kind: 'text' },
          { key: 'category', label: 'Category', kind: 'select', options: CATEGORY },
          { key: 'status', label: 'Status', kind: 'select', options: STATUS },
          { key: 'is_featured', label: 'Featured', kind: 'boolean', secondary: true },
        ],
        defaultSort: { key: 'created_at', order: 'desc' },
        formFields: [
          { key: 'name', label: 'Name', type: 'text', required: true, width: 2 },
          { key: 'priority', label: 'Priority', type: 'number', width: 2, min: 0, max: 9, defaultValue: 0 },
          { key: 'category', label: 'Category', type: 'select', options: CATEGORY, width: 2, defaultValue: 'other' },
          { key: 'status', label: 'Status', type: 'select', options: STATUS, width: 2, defaultValue: 'draft' },
          { key: 'is_featured', label: 'Featured', type: 'switch', width: 2, defaultValue: false },
          { key: 'tags', label: 'Tags', type: 'tags', width: 4, comment: 'Press Enter to add a tag' },
          { key: 'notes', label: 'Notes', type: 'textarea', rows: 3, width: 4 },
        ],
        access: { canView: true, canAdd: true, canEdit: true, canDelete: true },
        detailTabs: [{ key: 'all', label: 'Details', kind: 'fields' }],
      }),
    [],
  );

  return <CrudPage schema={schema} />;
}
