/**
 * 项目管理共享类型与配置常量
 */

import { Circle, Loader, Eye, CheckCircle2 } from '../../lib/icons';
import type { TranslationKey } from '../../lib/i18n';

// ─── Types ───────────────────────────────────────────────

export interface Task {
  id: number;
  project_id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  task_type: string;
  assignee_id: string | null;
  assignee_nickname: string | null;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  estimated_hours: number | null;
  tags: string[] | string;
  dependencies: number[] | string;
  created_by: string;
  created_at: string;
  updated_at: string;
  children?: Task[];
}

export interface Project {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner_id: string;
  owner_nickname: string;
  start_date: string | null;
  end_date: string | null;
  color?: string | null;
  visibility?: 'public' | 'private';
}

export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: string;
  role: 'owner' | 'member';
  nickname: string;
  added_by: string;
  created_at: string;
}

export interface Comment {
  id: number;
  task_id: number;
  user_id: string;
  user_nickname: string;
  content: string;
  created_at: string;
}

export interface Activity {
  id: number;
  action: string;
  detail: string | null;
  user_id: string;
  user_nickname: string;
  created_at: string;
}

// ─── Config ──────────────────────────────────────────────

export const statusConfig: Record<string, { label: TranslationKey; color: string; bg: string; icon: any }> = {
  todo: { label: 'projects.todo', color: 'text-fg-muted', bg: 'bg-surface-sunken border-edge', icon: Circle },
  in_progress: { label: 'projects.inProgress', color: 'text-info', bg: 'bg-info-subtle border-info', icon: Loader },
  in_review: { label: 'projects.inReview', color: 'text-warning', bg: 'bg-warning-subtle border-warning', icon: Eye },
  done: { label: 'common.done', color: 'text-success', bg: 'bg-success-subtle border-success', icon: CheckCircle2 },
  cancelled: { label: 'common.cancelled', color: 'text-danger', bg: 'bg-danger-subtle border-danger', icon: Circle },
};

export const projectStatusConfig: Record<string, { label: TranslationKey; color: string }> = {
  planning: { label: 'projects.planning', color: 'bg-surface-muted text-fg-secondary border-edge' },
  active: { label: 'common.active', color: 'bg-info-subtle text-info border-info' },
  on_hold: { label: 'projects.onHold', color: 'bg-warning-subtle text-warning-fg border-warning' },
  completed: { label: 'common.completed', color: 'bg-success-subtle text-success-fg border-success' },
  archived: { label: 'common.archived', color: 'bg-surface-sunken text-fg-faint border-edge' },
};

export const priorityColors: Record<string, string> = {
  low: 'text-fg-faint',
  normal: 'text-info',
  high: 'text-warning',
  urgent: 'text-danger',
};
