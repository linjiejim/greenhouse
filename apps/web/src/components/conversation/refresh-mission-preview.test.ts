/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/auth', () => ({ authFetch: vi.fn() }));
vi.mock('../../lib/api/cloud-agent', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api/cloud-agent')>();
  return { ...actual, getCloudAgentRun: vi.fn() };
});

import { refreshOpenMissionPreview } from './refresh-mission-preview';
import { useSidePaneStore } from '../../stores/side-pane-store';
import { getCloudAgentRun } from '../../lib/api/cloud-agent';
import { authFetch } from '../../lib/auth';

const getRun = vi.mocked(getCloudAgentRun);
const fetchMock = vi.mocked(authFetch);

function artifact(id: number, path: string, size = 1000) {
  return { id, path, size_bytes: size, content_type: 'text/html', sha256: 'x', created_at: '' };
}
function runWith(artifacts: ReturnType<typeof artifact>[]) {
  return { run: {} as never, artifacts, approvals: [] };
}
function respond(body: string) {
  fetchMock.mockResolvedValue({ ok: true, text: async () => body } as Response);
}
function topEntry() {
  const s = useSidePaneStore.getState();
  return s.stack[s.stack.length - 1];
}

describe('refreshOpenMissionPreview', () => {
  beforeEach(() => {
    useSidePaneStore.setState({ stack: [], isOpen: false, hostMounted: false });
    getRun.mockReset();
    fetchMock.mockReset();
  });

  it('swaps fresh bytes into an open preview of the regenerated file', async () => {
    useSidePaneStore
      .getState()
      .open({ kind: 'html', code: '<p>old</p>', title: 'deck.html', sourcePath: 'reports/deck.html' });
    getRun.mockResolvedValue(runWith([artifact(9, 'reports/deck.html')]));
    respond('<p>new</p>');

    await refreshOpenMissionPreview('run-2');

    expect(getRun).toHaveBeenCalledWith('run-2');
    expect(topEntry()).toMatchObject({ kind: 'html', code: '<p>new</p>', sourcePath: 'reports/deck.html' });
  });

  it('does nothing when the pane is closed', async () => {
    // Stack retains the entry but isOpen is false — do not yank it back open.
    useSidePaneStore.setState({
      stack: [{ kind: 'html', code: '<p>old</p>', sourcePath: 'reports/deck.html' }],
      isOpen: false,
    });
    await refreshOpenMissionPreview('run-2');
    expect(getRun).not.toHaveBeenCalled();
    expect(topEntry()).toMatchObject({ code: '<p>old</p>' });
  });

  it('does nothing when this run did not regenerate the open file', async () => {
    useSidePaneStore.getState().open({ kind: 'html', code: '<p>old</p>', sourcePath: 'reports/deck.html' });
    getRun.mockResolvedValue(runWith([artifact(9, 'other/summary.html')]));

    await refreshOpenMissionPreview('run-2');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(topEntry()).toMatchObject({ code: '<p>old</p>' });
  });

  it('ignores an inline preview that carries no source path', async () => {
    useSidePaneStore.getState().open({ kind: 'html', code: '<p>inline</p>' });
    await refreshOpenMissionPreview('run-2');
    expect(getRun).not.toHaveBeenCalled();
  });

  it('skips a regenerated file that is too large to preview', async () => {
    useSidePaneStore.getState().open({ kind: 'html', code: '<p>old</p>', sourcePath: 'reports/deck.html' });
    getRun.mockResolvedValue(runWith([artifact(9, 'reports/deck.html', 50 * 1024 * 1024)]));

    await refreshOpenMissionPreview('run-2');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(topEntry()).toMatchObject({ code: '<p>old</p>' });
  });
});
