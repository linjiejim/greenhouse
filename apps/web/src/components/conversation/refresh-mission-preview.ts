/**
 * refreshOpenMissionPreview — after a mission run settles, if the side pane is
 * showing an HTML artifact that this run just regenerated, swap in the fresh
 * bytes so the preview reflects the edit.
 *
 * This is the missing bridge between two mechanisms that otherwise never talk:
 * the mission settle path (which only reloads the transcript) and the side-pane
 * store (which holds HTML bytes with a `sourcePath` identity). The "push new
 * bytes into an open pane" primitive already exists — `openSidePane` replaces a
 * non-entity entry in place — so all this adds is the trigger and the match.
 *
 * Matching is by `sourcePath` (the artifact's full path, e.g. "reports/deck.html"),
 * the one identity stable across regenerations: run id and artifact id both
 * change every run. If the settled run did not touch the open file, nothing
 * happens; if the user closed or swapped the pane while the bytes were in
 * flight, the re-check drops the stale update rather than yanking the view.
 */

import { authFetch } from '../../lib/auth';
import { cloudAgentArtifactDownloadUrl, getCloudAgentRun, isPreviewableHtmlArtifact } from '../../lib/api/cloud-agent';
import { openSidePane, useSidePaneStore } from '../../stores/side-pane-store';

export async function refreshOpenMissionPreview(settledRunId: string): Promise<void> {
  const top = openHtmlPaneEntry();
  if (!top) return;
  const sourcePath = top.sourcePath!;

  let run: Awaited<ReturnType<typeof getCloudAgentRun>>;
  try {
    run = await getCloudAgentRun(settledRunId);
  } catch {
    return; // no run detail — leave the current preview untouched
  }

  const artifact = run.artifacts.find((a) => a.path === sourcePath && isPreviewableHtmlArtifact(a.path, a.size_bytes));
  if (!artifact) return; // this run did not regenerate the file on screen

  try {
    const res = await authFetch(cloudAgentArtifactDownloadUrl(settledRunId, artifact.id));
    if (!res.ok) return;
    const code = await res.text();
    // The fetch is async: re-confirm the same file is still open before swapping.
    if (openHtmlPaneEntry()?.sourcePath !== sourcePath) return;
    openSidePane({ kind: 'html', code, title: top.title, sourcePath });
  } catch {
    // Network hiccup — the manual refresh button and the new artifact card
    // both still work; don't disturb what's shown.
  }
}

/** The open pane's top entry iff it is an HTML preview with a source path. */
function openHtmlPaneEntry(): { kind: 'html'; code: string; title?: string; sourcePath?: string } | null {
  const state = useSidePaneStore.getState();
  if (!state.isOpen) return null;
  const top = state.stack[state.stack.length - 1];
  if (!top || top.kind !== 'html' || !top.sourcePath) return null;
  return top;
}
