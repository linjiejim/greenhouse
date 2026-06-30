/**
 * 项目管理共享类型与配置常量
 */

import { Circle, Loader, Eye, CheckCircle2 } from '../../lib/icons';

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

export const statusConfig: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  todo: { label: 'Todo', color: 'text-fg-muted', bg: 'bg-surface-sunken border-edge', icon: Circle },
  in_progress: { label: 'In Progress', color: 'text-info', bg: 'bg-info-subtle border-info', icon: Loader },
  in_review: { label: 'In Review', color: 'text-warning', bg: 'bg-warning-subtle border-warning', icon: Eye },
  done: { label: 'Done', color: 'text-success', bg: 'bg-success-subtle border-success', icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', color: 'text-danger', bg: 'bg-danger-subtle border-danger', icon: Circle },
};

export const projectStatusConfig: Record<string, { label: string; color: string }> = {
  planning: { label: 'Planning', color: 'bg-surface-muted text-fg-secondary border-edge' },
  active: { label: 'Active', color: 'bg-info-subtle text-info border-info' },
  on_hold: { label: 'On Hold', color: 'bg-warning-subtle text-warning-fg border-warning' },
  completed: { label: 'Completed', color: 'bg-success-subtle text-success-fg border-success' },
  archived: { label: 'Archived', color: 'bg-surface-sunken text-fg-faint border-edge' },
};

export const priorityColors: Record<string, string> = {
  low: 'text-fg-faint',
  normal: 'text-info',
  high: 'text-warning',
  urgent: 'text-danger',
};
