/**
 * Projects list panel — sidebar contextual panel for Projects tab.
 * Shows project list with status indicators.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Spinner, SearchInput } from '../../ui';
import { authFetch } from '../../../lib/auth';
import { Lock } from '../../../lib/icons';

interface ProjectSummary {
  id: number;
  title: string;
  status: string;
  progress: number;
  visibility?: 'public' | 'private';
}

const statusColors: Record<string, string> = {
  planning: 'bg-surface-muted',
  active: 'bg-blue-400',
  on_hold: 'bg-yellow-400',
  completed: 'bg-green-400',
  archived: 'bg-fg-faint',
};

interface ProjectsListPanelProps {
  collapsed?: boolean;
}

export function ProjectsListPanel({ collapsed }: ProjectsListPanelProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || data || []);
      }
    } catch (err) {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  if (collapsed) return null;

  const filtered = searchQuery
    ? projects.filter((p) => p.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : projects;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2 flex-shrink-0">
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Projects</span>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div className="relative">
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search projects..." size="sm" />
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-6">
            <Spinner className="h-4 w-4 text-fg-faint" />
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-fg-faint">
            {searchQuery ? 'No matches' : 'No projects'}
          </div>
        )}

        {filtered.map((project) => (
          <a
            key={project.id}
            href={`#/projects/${project.id}`}
            className="w-full text-left px-3 py-2 flex items-center gap-2 transition-colors hover:bg-surface-muted"
          >
            <span className={`flex-shrink-0 w-2 h-2 rounded-full ${statusColors[project.status] || 'bg-fg-faint'}`} />
            <span className="flex-1 min-w-0 text-xs text-fg-secondary truncate" title={project.title}>
              {project.title}
            </span>
            {project.visibility === 'private' && <Lock size={10} className="flex-shrink-0 text-fg-faint" />}
            {project.progress > 0 && (
              <span className="flex-shrink-0 text-[10px] text-fg-faint tabular-nums">{project.progress}%</span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
