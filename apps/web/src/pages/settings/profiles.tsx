/**
 * Profiles panel — agent profile viewer with usage statistics (Settings › System Agents).
 */

import React, { useState, useEffect } from 'react';
import { Badge, Spinner } from '../../components/ui';
import { Bot } from '../../lib/icons';
import { fetchProfiles, fetchProfileDetail, formatTokens, formatDuration, estimateCost } from '../../lib/api';
import type { Profile, ProfileDetail } from '../../lib/api';

// ─── Time-bucketed Usage Display ─────────────────────────

function UsageTimeBuckets({ detail }: { detail: ProfileDetail }) {
  const { usage } = detail;
  const buckets = [
    { label: 'All Time', data: usage.total },
    { label: 'Last 7 Days', data: usage.last_7d },
    { label: 'Last 24 Hours', data: usage.last_24h },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {buckets.map(({ label, data }) => (
        <div key={label} className="bg-surface-raised border border-edge rounded-lg p-3">
          <div className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider mb-2">{label}</div>
          {data ? (
            <div className="space-y-1">
              <div className="text-lg font-bold text-fg">{data.calls.toLocaleString()}</div>
              <div className="text-[11px] text-fg-muted">calls</div>
              <div className="flex gap-3 mt-1 text-[11px] text-fg-muted">
                <span>In: {formatTokens(data.input_tokens)}</span>
                <span>Out: {formatTokens(data.output_tokens)}</span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-fg-faint">No data</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Recent Calls Table ──────────────────────────────────

function RecentCallsTable({ detail }: { detail: ProfileDetail }) {
  if (!detail.recent_calls.length) {
    return <div className="text-sm text-fg-faint">No recent calls</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-fg-muted border-b border-edge">
            <th className="py-1.5 pr-3 font-medium">Time</th>
            <th className="py-1.5 pr-3 font-medium">Caller</th>
            <th className="py-1.5 pr-3 font-medium">Model</th>
            <th className="py-1.5 pr-3 font-medium text-right">Input</th>
            <th className="py-1.5 pr-3 font-medium text-right">Output</th>
            <th className="py-1.5 pr-3 font-medium text-right">Duration</th>
            <th className="py-1.5 font-medium text-right">Est. Cost</th>
          </tr>
        </thead>
        <tbody>
          {detail.recent_calls.map((call) => {
            const cost = estimateCost({
              inputTokens: call.input_tokens,
              outputTokens: call.output_tokens,
              cachedTokens: call.cached_tokens,
            });
            return (
              <tr key={call.id} className="border-b border-edge hover:bg-surface-sunken">
                <td className="py-1.5 pr-3 text-fg-muted whitespace-nowrap">
                  {new Date(call.created_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      call.caller === 'chat'
                        ? 'bg-info-subtle text-info'
                        : call.caller === 'compiler'
                          ? 'bg-info-subtle text-info'
                          : call.caller === 'judge'
                            ? 'bg-warning-subtle text-warning'
                            : 'bg-surface-muted text-fg-secondary'
                    }`}
                  >
                    {call.caller}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-fg-secondary">{call.model}</td>
                <td className="py-1.5 pr-3 text-right text-fg-secondary">{formatTokens(call.input_tokens)}</td>
                <td className="py-1.5 pr-3 text-right text-fg-secondary">{formatTokens(call.output_tokens)}</td>
                <td className="py-1.5 pr-3 text-right text-fg-muted">
                  {call.duration_ms ? formatDuration(call.duration_ms) : '—'}
                </td>
                <td className="py-1.5 text-right text-fg-muted">${cost.usd.toFixed(4)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────

export function ProfilesPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<Record<string, ProfileDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles()
      .then((data) => {
        setProfiles(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleToggle = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detailData[id]) {
      setDetailLoading(id);
      try {
        const detail = await fetchProfileDetail(id);
        setDetailData((prev) => ({ ...prev, [id]: detail }));
      } catch (err) {
        console.error('Failed to load profile detail:', err);
      }
      setDetailLoading(null);
    }
  };

  if (loading)
    return (
      <div className="flex justify-center py-20">
        <Spinner className="text-primary-500" />
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">
        Agent profiles define identity, model, tools, and system prompt. Edit via{' '}
        <code className="text-xs bg-surface-muted px-1 rounded">apps/api/src/profiles/*.yaml</code>
      </p>

      <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="text-left px-3 py-2">Profile</th>
              <th className="text-left px-3 py-2">Model</th>
              <th className="text-center px-3 py-2 w-16">Tools</th>
              <th className="text-right px-3 py-2 w-20">Calls</th>
              <th className="text-right px-3 py-2 w-24">Tokens</th>
              <th className="text-right px-3 py-2 w-20">Avg Dur</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {profiles.map((p) => (
              <React.Fragment key={p.id}>
                <tr
                  className={`hover:bg-surface-sunken cursor-pointer transition-colors ${
                    expandedId === p.id ? 'bg-surface-sunken' : ''
                  }`}
                  onClick={() => handleToggle(p.id)}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Bot size={16} className="text-primary-fg flex-shrink-0" />
                      <div>
                        <div className="font-medium text-fg">{p.name}</div>
                        {p.description && (
                          <div className="text-xs text-fg-muted truncate max-w-xs">{p.description}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="secondary">{p.model ? `${p.model.provider}/${p.model.model}` : '—'}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <Badge variant="default">{p.tools.length}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right text-fg-secondary">
                    {p.usage ? p.usage.total_calls.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right text-fg-secondary">
                    {p.usage ? formatTokens(p.usage.total_input_tokens + p.usage.total_output_tokens) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right text-fg-muted">
                    {p.usage && p.usage.avg_duration_ms > 0 ? formatDuration(p.usage.avg_duration_ms) : '—'}
                  </td>
                </tr>
                {expandedId === p.id && (
                  <tr>
                    <td colSpan={6} className="px-4 py-3 bg-surface-sunken border-t border-edge">
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs font-semibold text-fg-muted mb-1">Model</div>
                            <div className="text-sm text-fg-secondary">
                              <span className="font-mono">{p.model?.provider ?? '—'}</span> /{' '}
                              <span className="font-mono">{p.model?.model ?? '—'}</span>
                            </div>
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-fg-muted mb-1">Behavior</div>
                            <div className="text-sm text-fg-secondary">max_steps: {p.max_steps ?? 8}</div>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-fg-muted mb-1">Tools</div>
                          <div className="flex gap-1.5 flex-wrap">
                            {p.tools.map((t) => (
                              <Badge key={t} variant="default">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        {/* Usage Statistics */}
                        {detailLoading === p.id ? (
                          <div className="flex justify-center py-4">
                            <Spinner className="text-fg-faint h-5 w-5" />
                          </div>
                        ) : detailData[p.id] ? (
                          <div className="space-y-3">
                            <div className="text-xs font-semibold text-fg-muted">Usage Statistics</div>
                            <UsageTimeBuckets detail={detailData[p.id]} />
                            <div className="text-xs font-semibold text-fg-muted mt-3">Recent Calls</div>
                            <RecentCallsTable detail={detailData[p.id]} />
                          </div>
                        ) : null}

                        {p.system_prompt && (
                          <div>
                            <div className="text-xs font-semibold text-fg-muted mb-1">System Prompt</div>
                            <pre className="text-xs text-fg-secondary bg-surface-raised border border-edge rounded-md p-3 max-h-60 overflow-y-auto whitespace-pre-wrap font-sans leading-relaxed">
                              {p.system_prompt}
                            </pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
