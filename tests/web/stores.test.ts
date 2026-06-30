/**
 * Zustand store unit tests — auth-store, ui-store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '../../apps/web/src/stores/auth-store';
import { useUIStore } from '../../apps/web/src/stores/ui-store';
import { useProfileStore } from '../../apps/web/src/stores/profile-store';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      authState: 'checking',
      currentUser: null,
    });
  });

  it('starts in checking state', () => {
    expect(useAuthStore.getState().authState).toBe('checking');
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it('login sets user and authenticated state', () => {
    const user = { id: 'u1', nickname: 'Jim', role: 'admin' as const, profiles: [] };
    useAuthStore.getState().login(user);
    expect(useAuthStore.getState().authState).toBe('authenticated');
    expect(useAuthStore.getState().currentUser?.nickname).toBe('Jim');
  });

  it('logout clears user and sets needs-login', () => {
    useAuthStore.getState().login({ id: 'u1', nickname: 'Test', role: 'member' as const, profiles: [] });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().authState).toBe('needs-login');
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it('updateUser merges partial updates', () => {
    useAuthStore.getState().login({ id: 'u1', nickname: 'Old', role: 'member' as const, profiles: [] });
    useAuthStore.getState().updateUser({ nickname: 'New' });
    expect(useAuthStore.getState().currentUser?.nickname).toBe('New');
    expect(useAuthStore.getState().currentUser?.id).toBe('u1');
  });
});

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      navOpen: false,
      myProfileOpen: false,
      preferencesOpen: false,
      currentSessionTitle: '',
      currentSessionProfileId: 'default',
      currentSessionTags: [],
      currentChatSessionId: null,
      sessionListVersion: 0,
    });
  });

  it('starts with all panels closed', () => {
    const state = useUIStore.getState();
    expect(state.navOpen).toBe(false);
    expect(state.myProfileOpen).toBe(false);
    expect(state.preferencesOpen).toBe(false);
  });

  it('toggles individual panels', () => {
    useUIStore.getState().setNavOpen(true);
    expect(useUIStore.getState().navOpen).toBe(true);
    expect(useUIStore.getState().myProfileOpen).toBe(false);
  });

  it('closeAll closes everything', () => {
    useUIStore.getState().setNavOpen(true);
    useUIStore.getState().setMyProfileOpen(true);
    useUIStore.getState().setPreferencesOpen(true);
    useUIStore.getState().closeAll();
    const state = useUIStore.getState();
    expect(state.navOpen).toBe(false);
    expect(state.myProfileOpen).toBe(false);
    expect(state.preferencesOpen).toBe(false);
  });

  it('setCurrentSessionInfo sets title, profileId and tags', () => {
    const tags = [{ id: 1, name: 'bug', color: '#e53e3e' }];
    useUIStore.getState().setCurrentSessionInfo('My Chat', 'team', tags);
    const state = useUIStore.getState();
    expect(state.currentSessionTitle).toBe('My Chat');
    expect(state.currentSessionProfileId).toBe('team');
    expect(state.currentSessionTags).toEqual(tags);
  });

  it('setCurrentSessionInfo defaults tags to empty array', () => {
    useUIStore.getState().setCurrentSessionInfo('Title', 'default');
    expect(useUIStore.getState().currentSessionTags).toEqual([]);
  });

  it('setCurrentSessionInfo replaces previous tags', () => {
    useUIStore.getState().setCurrentSessionInfo('T', 'default', [{ id: 1, name: 'a', color: '#000' }]);
    expect(useUIStore.getState().currentSessionTags).toHaveLength(1);
    useUIStore.getState().setCurrentSessionInfo('T', 'default', []);
    expect(useUIStore.getState().currentSessionTags).toEqual([]);
  });

  it('bumpSessionListVersion increments monotonically', () => {
    expect(useUIStore.getState().sessionListVersion).toBe(0);
    useUIStore.getState().bumpSessionListVersion();
    expect(useUIStore.getState().sessionListVersion).toBe(1);
    useUIStore.getState().bumpSessionListVersion();
    expect(useUIStore.getState().sessionListVersion).toBe(2);
  });
});

describe('useProfileStore', () => {
  beforeEach(() => {
    useProfileStore.setState({
      profiles: [],
      availableTools: [],
      loading: false,
      initialized: false,
    });
  });

  it('starts empty and uninitialized', () => {
    const state = useProfileStore.getState();
    expect(state.profiles).toEqual([]);
    expect(state.availableTools).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.initialized).toBe(false);
  });

  it('clear resets all state', () => {
    useProfileStore.setState({
      profiles: [{ id: 'default', name: 'Default', tools: [], model: { provider: 'test', model: 'test' } }] as any,
      initialized: true,
      loading: true,
    });
    useProfileStore.getState().clear();
    const state = useProfileStore.getState();
    expect(state.profiles).toEqual([]);
    expect(state.initialized).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('fetchProfiles is idempotent when initialized', async () => {
    // Mark as initialized with some profiles
    useProfileStore.setState({
      profiles: [{ id: 'default', name: 'Default', tools: [], model: { provider: 'test', model: 'test' } }] as any,
      initialized: true,
    });
    // fetchProfiles without force should be a no-op
    await useProfileStore.getState().fetchProfiles();
    expect(useProfileStore.getState().profiles).toHaveLength(1);
  });

  it('prevents concurrent fetches', () => {
    useProfileStore.setState({ loading: true });
    // Should return immediately without changing state
    useProfileStore.getState().fetchProfiles(true);
    expect(useProfileStore.getState().loading).toBe(true);
  });
});
