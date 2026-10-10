/**
 * Renders widget avatars to PNG. The widget extension can't draw SVG, so the
 * app draws each face it needs (./model.ts `ArtJob`) with react-native-svg,
 * off screen, and `toDataURL` rasterizes it at the screen's scale (RNSVG draws
 * the SVG tree straight into a UIGraphicsImageRenderer — nothing is captured
 * from the screen). The PNG goes to the App Group through modules/widget-bridge.
 *
 * <WidgetArtHost/> is mounted once in app/_layout.tsx (iOS only); it renders
 * nothing visible and only holds views while a batch is being drawn.
 * `renderWidgetArt()` resolves with the keys that were written — a face that
 * fails or times out is left out, and the widget draws its fallback. A job may ask
 * for another size (`points`): the Live Activity's faces (src/live-activity).
 */

import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { parse } from 'react-native-svg';
import { widgetArtSupported, writeWidgetArt } from '../../modules/widget-bridge';
import { ART_POINTS, type ArtJob } from './model';

/** A face not drawn by then is skipped (the host isn't mounted, the view never laid out). */
const JOB_TIMEOUT_MS = 4000;

interface Pending {
  job: ArtJob;
  done: (ok: boolean) => void;
}

let queue: readonly Pending[] = [];
let hostMounted = false;
const listeners = new Set<() => void>();

function setQueue(next: readonly Pending[]) {
  queue = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Faces being drawn, by key: a second publish asking for the same face waits on the first. */
const inFlight = new Map<string, Promise<boolean>>();

function drawOne(job: ArtJob): Promise<boolean> {
  const running = inFlight.get(job.key);
  if (running) return running;
  const drawn = new Promise<boolean>((resolve) => {
    let settled = false;
    const entry: Pending = {
      job,
      done: (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inFlight.delete(job.key);
        setQueue(queue.filter((p) => p !== entry));
        resolve(ok);
      },
    };
    const timer = setTimeout(() => entry.done(false), JOB_TIMEOUT_MS);
    setQueue([...queue, entry]);
  });
  inFlight.set(job.key, drawn);
  return drawn;
}

/** Draw `jobs` and store them; resolves with the keys that made it to the App Group. */
export async function renderWidgetArt(jobs: readonly ArtJob[]): Promise<Set<string>> {
  if (!hostMounted || !widgetArtSupported || jobs.length === 0) return new Set();
  const results = await Promise.all(jobs.map(async (job) => ((await drawOne(job)) ? job.key : null)));
  return new Set(results.filter((key): key is string => key !== null));
}

export function WidgetArtHost(): React.ReactElement | null {
  const pending = useSyncExternalStore(subscribe, () => queue);
  const mounted = useCallback((view: View | null) => {
    hostMounted = view !== null;
  }, []);
  if (Platform.OS !== 'ios') return null;
  return (
    <View ref={mounted} style={styles.host} pointerEvents="none" accessibilityElementsHidden>
      {pending.map((p) => (
        <Face key={p.job.key} job={p.job} done={p.done} />
      ))}
    </View>
  );
}

function Face({ job, done }: { job: ArtJob; done: (ok: boolean) => void }) {
  const points = job.points ?? ART_POINTS;
  const svg = useRef<Svg>(null);
  const ast = useMemo(() => {
    try {
      return parse(job.svg);
    } catch {
      return null;
    }
  }, [job.svg]);
  const drawn = useRef(false);
  useEffect(() => {
    if (!ast) done(false);
  }, [ast, done]);
  const onLayout = () => {
    if (drawn.current) return;
    drawn.current = true;
    // One frame for the native SVG tree to finish mounting under the view.
    requestAnimationFrame(() => {
      const view = svg.current;
      if (!view) {
        done(false);
        return;
      }
      view.toDataURL((base64?: string) => done(Boolean(base64) && writeWidgetArt(job.key, base64 as string)), {
        width: points,
        height: points,
      });
    });
  };
  if (!ast) return null;
  return (
    <View style={[styles.face, { width: points, height: points }]} onLayout={onLayout} collapsable={false}>
      <Svg ref={svg} {...ast.props} width={points} height={points}>
        {ast.children}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // Off screen, laid out (RNSVG needs a mounted view), never seen or touched.
  host: { position: 'absolute', left: -10_000, top: 0, width: ART_POINTS },
  face: { width: ART_POINTS, height: ART_POINTS },
});
