/**
 * My Profiles — Settings sub-page for managing custom Agent profiles.
 *
 * Available to all internal users.
 * Super users can mark profiles as shared.
 * Uses ProfileEditorDrawer for create/edit experience.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Badge, Spinner, ConfirmDialog, EmptyState, ListToolbar, toast } from '../../components/ui';
import { Plus, Pencil, Trash2, Globe, GitFork, Bot } from '../../lib/icons';
import { SproutyAvatar } from '../../components/sprouty/index.js';
import { profileToSprouty, isSpecialistProfile } from '../../components/chat/profile-selector';
import * as api from '../../lib/api';
import { useAuthStore, useProfileStore } from '../../stores';
import { ProfileEditorDrawer } from '../../components/chat/profile-editor';

export function MyProfilesPage() {
  const { currentUser } = useAuthStore();
  const { refresh: refreshProfiles, availableTools, fetchTools: loadTools } = useProfileStore();
  const isSuper = currentUser?.role === 'super';

  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [systemProfiles, setSystemProfiles] = useState<api.Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<api.Profile | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<api.Profile | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileList, allProfiles] = await Promise.all([
        api.fetchCustomProfiles().catch(() => []),
        api.fetchProfiles().catch(() => []),
      ]);
      setProfiles(profileList || []);
      setSystemProfiles((allProfiles || []).filter((p) => !p.is_custom));
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    loadTools();
  }, [loadData, loadTools]);

  const openCreate = () => {
    setEditingProfile(null);
    setDrawerOpen(true);
  };

  const openEdit = (profile: api.Profile) => {
    setEditingProfile(profile);
    setDrawerOpen(true);
  };

  const handleSave = async (input: api.CustomProfileInput, editId?: number) => {
    if (editId !== undefined) {
      await api.updateCustomProfile(editId, input);
      toast('Profile updated', 'success');
    } else {
      await api.createCustomProfile(input);
      toast('Profile created', 'success');
    }
    loadData();
    refreshProfiles();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const numId = parseInt(deleteTarget.id.replace('custom:', ''), 10);
      await api.deleteCustomProfile(numId);
      toast('Profile deleted', 'success');
      setDeleteTarget(null);
      loadData();
      refreshProfiles();
    } catch (err: any) {
      toast(err.message || 'Failed to delete', 'error');
    }
  };

  const handleFork = async (sourceId: string) => {
    try {
      const forked = await api.forkProfile(sourceId);
      setEditingProfile(forked);
      setDrawerOpen(true);
      loadData();
      refreshProfiles();
    } catch (err: any) {
      toast(err.message || 'Failed to fork profile', 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const myProfiles = profiles.filter((p) => p.user_id === currentUser?.id);
  const sharedProfiles = profiles.filter((p) => p.user_id !== currentUser?.id && p.is_shared);

  const createButton = (
    <Button onClick={openCreate} size="sm">
      <Plus size={14} className="mr-1" />
      Create agent
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar
        hint="Custom agents with your own system prompts and tool configurations."
        count={
          myProfiles.length > 0 ? `${myProfiles.length} ${myProfiles.length === 1 ? 'agent' : 'agents'}` : undefined
        }
        actions={createButton}
      />

      {/* Fork from System Profile */}
      {systemProfiles.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-fg-muted mb-2 uppercase tracking-wider">Fork from Template</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {systemProfiles
              .filter((p) => isSpecialistProfile(p) || p.id === 'team')
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleFork(p.id)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-edge bg-surface-raised hover:border-primary-edge hover:bg-primary-subtle/30 transition-colors text-left group"
                >
                  <SproutyAvatar {...profileToSprouty(p)} state="idle" size="xs" animate={false} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg-secondary truncate">{p.name}</div>
                    <div className="text-[10px] text-fg-faint">{p.tools.length} tools</div>
                  </div>
                  <GitFork
                    size={13}
                    className="text-fg-faint group-hover:text-primary-fg flex-shrink-0 transition-colors"
                  />
                </button>
              ))}
          </div>
        </div>
      )}

      {/* My Profiles */}
      {myProfiles.length === 0 && sharedProfiles.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No custom agents yet"
          description="Create an agent with your own system prompt and tools, or fork a template above."
          action={createButton}
        />
      ) : (
        <>
          {myProfiles.length > 0 && (
            <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-sunken text-fg-muted">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Base</th>
                    <th className="text-center px-4 py-2 font-medium">Tools</th>
                    <th className="text-center px-4 py-2 font-medium hidden lg:table-cell">Calls</th>
                    <th className="text-center px-4 py-2 font-medium hidden md:table-cell">Shared</th>
                    <th className="text-center px-4 py-2 font-medium w-20">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {myProfiles.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-sunken transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <SproutyAvatar
                            variant="custom"
                            color={(p as any).avatar?.color}
                            accessories={(p as any).avatar?.accessories}
                            leafStyle={(p as any).avatar?.leafStyle}
                            state="idle"
                            size="xs"
                            animate={false}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-fg-secondary truncate" title={p.name}>
                              {p.name}
                            </div>
                            {p.description && (
                              <div className="text-xs text-fg-faint truncate max-w-[300px]" title={p.description}>
                                {p.description}
                              </div>
                            )}
                            {p.forked_from && (
                              <div className="text-[10px] text-primary-fg mt-0.5">↳ from {p.forked_from}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell">
                        <Badge variant="secondary">{p.base_profile_id || 'default'}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-center text-fg-muted">{p.tools.length}</td>
                      <td className="px-4 py-2.5 text-center text-fg-faint hidden lg:table-cell">
                        {p.usage?.total_calls || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center hidden md:table-cell">
                        {p.is_shared && <Globe size={14} className="inline text-primary-fg" />}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEdit(p)}
                            className="p-1 text-fg-muted hover:text-primary-fg rounded transition-colors"
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(p)}
                            className="p-1 text-fg-muted hover:text-danger rounded transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Shared by others */}
          {sharedProfiles.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-fg-muted mb-2 uppercase tracking-wider">Shared Profiles</h3>
              <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-edge">
                    {sharedProfiles.map((p) => (
                      <tr key={p.id} className="hover:bg-surface-sunken transition-colors">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <Globe size={14} className="text-primary-fg flex-shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-fg-secondary truncate" title={p.name}>
                                {p.name}
                              </div>
                              {p.description && (
                                <div className="text-xs text-fg-faint truncate max-w-[300px]" title={p.description}>
                                  {p.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 hidden md:table-cell">
                          <Badge variant="secondary">{p.base_profile_id || 'default'}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-center text-fg-muted">{p.tools.length} tools</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Profile Editor Drawer */}
      <ProfileEditorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        profile={editingProfile}
        availableTools={availableTools}
        isSuper={isSuper}
        onSave={handleSave}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Profile"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
      />
    </div>
  );
}
