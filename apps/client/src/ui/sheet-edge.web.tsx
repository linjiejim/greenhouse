/** Root route frames keep objects in the same router, presented as an inspector on wide screens. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, View, useWindowDimensions, type DimensionValue } from 'react-native';
import { useRouter } from 'expo-router';
import { useNavigationState } from 'expo-router/react-navigation';
import { SheetFrame } from './sheet-actions';
import { useTheme } from '../theme';
import { DIALOG_SIZES, Overlay, hasInteractiveOverlay, labelByHeading, trapTabIn } from './overlay.web';
import { useT } from '../lib/i18n';
import { INSPECTOR_MAX, INSPECTOR_MIN, INSPECTOR_WIDTH, wideLayout } from '../shell/wide-model';
import { boundedInspectorWidth, inspectorRoute, inspectorCount } from '../shell/inspector-model';
import { useInspector } from '../shell/inspector.web';
import { DialogFrameContext } from './dialog-frame';

type Route = { name: string; key: string; params?: object };
/** Every frame of a place follows its inspector's width: the main pane's margin and each inspector's own. */
const WIDTH_EVENT = 'greenhouse:inspector-width';
type InspectorWidth = { key: string; width: number };
/** The inspector edge's keyboard step (jim-uiux ResizeHandle). */
const WIDTH_STEP = 16;
/** Centered sheets that hold a document or a preview get the large dialog size. */
const LARGE_SHEETS = ['doc-new', 'peek/html', 'peek/diagram', 'table'];
export function sheetEdgeLayout(props: { children: React.ReactElement; route: Route }) {
  return <ScreenFrame route={props.route}>{props.children}</ScreenFrame>;
}
function ScreenFrame({ children, route }: { children: React.ReactNode; route: Route }) {
  const { width } = useWindowDimensions();
  const layout = wideLayout(width);
  const router = useRouter();
  const { hex: c, isDark } = useTheme();
  const t = useT();
  const state = useNavigationState((s) => s);
  const top = state.routes[state.index];
  const topParams = (top?.params ?? {}) as Record<string, string>;
  const params = (route.params ?? {}) as Record<string, string>;
  const isTop = top?.key === route.key;
  const promoted = params.main === '1';
  const object = inspectorRoute(route.name);
  const inspector = object && !promoted;
  const activeInspector = !!top && inspectorRoute(top.name) && topParams.main !== '1';
  const overlay =
    inspector ||
    [
      'me',
      'doc-new',
      'task-form',
      'tables/new-record',
      'notifications',
      'conversations',
      'move',
      'sheets/stations',
      'sheets/station-add',
      'sheets/feedback',
      'sheets/whats-new',
      'peek/html',
      'peek/diagram',
      'table',
    ].includes(route.name);
  const drawer = state.routes.find((r) => r.name === '(drawer)')?.state;
  const place = drawer?.routes[drawer.index ?? 0]?.name ?? '(home)';
  const widthKey = `greenhouse_inspector_width:${place === '(home)' ? 'chat' : place}`;
  const depth = inspectorCount(state.routes);
  const mainFrame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // NativeStack's web Screen hides every unfocused route from accessibility.
    // Our visible main pane remains usable alongside a wide inspector, so adapt
    // only its owning Screen; deeper inspectors and phone sheets stay hidden.
    // NativeStack drops aria-hidden when the route is shown again, so look for our inert as well
    const screen = mainFrame.current?.parentElement?.closest('[aria-hidden], [inert]');
    if (!screen) return;
    const main = activeInspector && layout.wide && state.routes[state.index - depth]?.key === route.key;
    const hidden = !(isTop || main);
    screen.setAttribute('aria-hidden', String(hidden));
    // hidden routes also leave the tab order, so focus cannot land behind a sheet
    screen.toggleAttribute('inert', hidden);
  }, [state, route.key, activeInspector, layout.wide, depth, isTop]);
  const docked = inspector && layout.wide && !layout.floatInspector;
  const frame = useRef<View>(null);
  const panel = useRef<View>(null);
  // a centered dialog or a phone sheet is modal; a wide inspector sits beside a usable main pane
  const modal = overlay && !promoted && (!inspector || !layout.wide);
  useEffect(() => {
    if (!modal || !isTop) return;
    const root = panel.current as unknown as HTMLElement | null;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!root.contains(document.activeElement)) root.focus();
    const unlabel = labelByHeading(root);
    const key = (event: KeyboardEvent) => {
      if (!hasInteractiveOverlay()) trapTabIn(root, event);
    };
    window.addEventListener('keydown', key, true);
    return () => {
      unlabel();
      window.removeEventListener('keydown', key, true);
      // the covered route leaves `inert` in the same commit; return focus to what opened the sheet
      requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.closest('[inert]') && !root.isConnected) previous.focus();
      });
    };
  }, [modal, isTop]);
  useLayoutEffect(() => {
    // The stack wraps every screen in full-size layers; beside a docked inspector they would
    // swallow clicks meant for the main pane, so they pass them through (the panel stays live).
    if (!docked || !isTop) return;
    const layers: HTMLElement[] = [];
    let node = (frame.current as unknown as HTMLElement | null)?.parentElement ?? null;
    while (node && layers.length < 6 && node.dataset.testid !== 'client-main') {
      layers.push(node);
      if (getComputedStyle(node).position === 'absolute') break;
      node = node.parentElement;
    }
    layers.forEach((layer) => (layer.style.pointerEvents = 'none'));
    return () => layers.forEach((layer) => (layer.style.pointerEvents = ''));
  }, [docked, isTop]);
  const readWidth = useCallback(() => {
    try {
      return Math.round(boundedInspectorWidth(Number(localStorage.getItem(widthKey)) || INSPECTOR_WIDTH));
    } catch {
      return INSPECTOR_WIDTH;
    }
  }, [widthKey]);
  const [panelWidth, setPanelWidth] = useState(readWidth);
  /** Show a width at once (the main pane beside a docked inspector follows it); store it once the change is done. */
  const resize = useCallback(
    (width: number, done: boolean) => {
      setPanelWidth(width);
      if (done)
        try {
          localStorage.setItem(widthKey, String(width));
        } catch {
          // storage refused: the width still holds until the page reloads
        }
      window.dispatchEvent(new CustomEvent<InspectorWidth>(WIDTH_EVENT, { detail: { key: widthKey, width } }));
    },
    [widthKey],
  );
  const close = useCallback(() => {
    if (router.canDismiss()) router.dismiss(inspector && layout.wide ? Math.max(1, depth) : 1);
    else router.replace('/');
  }, [router, inspector, layout.wide, depth]);
  useEffect(() => {
    if (!isTop || !(overlay || promoted)) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || hasInteractiveOverlay()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [isTop, overlay, promoted, close]);
  useEffect(() => {
    if (!isTop || !inspector) return;
    useInspector.setState({ last: { pathname: `/${route.name}`, params }, close });
    return () => {
      if (useInspector.getState().close === close) useInspector.setState({ close: null });
    };
    // The route key owns the params snapshot; text inside a document does not re-register it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTop, inspector, route.key, close]);
  useEffect(() => {
    // a drag carries its live width (stored only when it ends); anything else reads the stored one
    const changed = (event?: Event) => {
      const live = (event as CustomEvent<InspectorWidth | undefined> | undefined)?.detail;
      setPanelWidth(live?.key === widthKey ? live.width : readWidth());
    };
    changed();
    window.addEventListener(WIDTH_EVENT, changed);
    return () => window.removeEventListener(WIDTH_EVENT, changed);
  }, [readWidth, widthKey]);
  if (!overlay)
    return (
      <div
        ref={mainFrame}
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          marginRight: activeInspector && layout.wide && !layout.floatInspector ? panelWidth : 0,
        }}
      >
        {children}
      </div>
    );
  if (route.name === 'me' && layout.wide)
    return (
      <Overlay
        testID="settings-overlay"
        label={t('settings.title')}
        initialFocus="panel"
        size="xl"
        onClose={close}
        panelStyle={{ flexDirection: 'row' }}
      >
        <SheetFrame>{children}</SheetFrame>
      </Overlay>
    );

  return (
    <View
      ref={frame}
      pointerEvents="box-none"
      style={{
        flex: 1,
        display: object && !isTop ? 'none' : 'flex',
        alignItems: inspector && layout.wide ? 'flex-end' : 'center',
        justifyContent: layout.wide ? 'center' : 'flex-end',
      }}
    >
      {!inspector || !layout.wide || layout.floatInspector ? (
        <Pressable
          // a pointer affordance only: Esc and the sheet's own close button serve keyboards and screen readers
          aria-hidden
          tabIndex={-1}
          onPress={close}
          style={{ position: 'absolute', inset: 0, backgroundColor: inspector ? 'transparent' : c.scrim }}
        />
      ) : null}
      <View
        ref={panel}
        testID={inspector ? 'client-inspector' : 'client-sheet'}
        role={modal ? 'dialog' : undefined}
        aria-modal={modal || undefined}
        tabIndex={modal ? -1 : undefined}
        style={
          inspector || !layout.wide
            ? {
                width: layout.wide ? panelWidth : '100%',
                height: '100%',
                maxWidth: '100%',
                borderLeftWidth: 1,
                borderColor: c.separator,
                backgroundColor: c.secondaryGroupedBackground,
                boxShadow: isDark || !layout.wide || !layout.floatInspector ? undefined : '-8px 0 32px rgba(0,0,0,.10)',
              }
            : {
                // a centered sheet is a fixed-size dialog (src/ui/overlay.web.tsx DIALOG_SIZES)
                ...DIALOG_SIZES[LARGE_SHEETS.includes(route.name) ? 'lg' : 'md'],
                // RN-web passes calc() through; its types only know numbers and percentages
                maxWidth: 'calc(100% - 32px)' as DimensionValue,
                maxHeight: 'calc(100% - 32px)' as DimensionValue,
                borderWidth: 1,
                borderColor: c.separator,
                borderRadius: 12,
                overflow: 'hidden',
                backgroundColor: c.secondaryGroupedBackground,
                boxShadow: isDark ? undefined : '0 8px 32px rgba(0,0,0,.14)',
              }
        }
      >
        {inspector && layout.wide ? (
          <InspectorEdge
            label={t('client.inspectorWidth')}
            value={panelWidth}
            onValueChange={(width) => resize(width, false)}
            onValueCommit={(width) => resize(width, true)}
          />
        ) : null}
        <DialogFrameContext.Provider value={!inspector && layout.wide}>
          <SheetFrame>{children}</SheetFrame>
        </DialogFrameContext.Provider>
      </View>
    </View>
  );
}

/**
 * The inspector's left edge (jim-uiux 1.5.0 ResizeHandle): an 8 px strip (`.gh-resize-handle`,
 * src/shell/client.css) that a pointer drags or the arrow keys move 16 px a step; Home / End go to the
 * narrowest / widest, a double-click back to the default. `onValueChange` runs while dragging, only to
 * redraw; `onValueCommit` once a change is done (pointer up, a key, a double-click), to store it.
 */
function InspectorEdge({
  label,
  value,
  onValueChange,
  onValueCommit,
}: {
  label: string;
  value: number;
  onValueChange: (width: number) => void;
  onValueCommit: (width: number) => void;
}) {
  const clamp = (width: number) => Math.round(boundedInspectorWidth(width));
  const drag = useRef<{ at: number; from: number; now: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // focus given by a press, not the keyboard: the browser calls it focus-visible, but the accent
  // line would then stay lit after every drag. It shows again on the first key.
  const [pressed, setPressed] = useState(false);
  // the page's cursor before a drag, put back however the drag ends
  const pageCursor = useRef<string | null>(null);
  const restoreCursor = () => {
    if (pageCursor.current === null) return;
    document.documentElement.style.cursor = pageCursor.current;
    pageCursor.current = null;
  };
  const latestCommit = useRef(onValueCommit);
  useEffect(() => {
    latestCommit.current = onValueCommit;
  });
  useEffect(
    () => () => {
      // closed or reflowed mid-drag (Escape, a narrower window): keep the width it reached, give the cursor back
      const live = drag.current;
      if (!live) return;
      drag.current = null;
      if (pageCursor.current !== null) document.documentElement.style.cursor = pageCursor.current;
      latestCommit.current(live.now);
    },
    [],
  );
  const commit = (width: number) => {
    // mid-drag the pointer owns the width: a key or a double-click now would be undone on release
    if (drag.current) return;
    const next = clamp(width);
    onValueChange(next);
    onValueCommit(next);
  };
  const end = () => {
    if (!drag.current) return;
    const last = drag.current.now;
    drag.current = null;
    setDragging(false);
    restoreCursor();
    onValueCommit(last);
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={INSPECTOR_MIN}
      aria-valuemax={INSPECTOR_MAX}
      aria-valuenow={value}
      tabIndex={0}
      className="gh-resize-handle"
      data-dragging={dragging || undefined}
      data-pressed={pressed || undefined}
      onBlur={() => setPressed(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // take focus (the arrow keys work next) without selecting text on the way
        e.currentTarget.focus({ preventScroll: true });
        setPressed(true);
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { at: e.clientX, from: value, now: value };
        setDragging(true);
        // the resize cursor stays when the pointer runs ahead of the strip
        restoreCursor();
        pageCursor.current = document.documentElement.style.cursor;
        document.documentElement.style.cursor = 'col-resize';
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        // the strip is on the panel's left edge: moving left widens it
        const next = clamp(drag.current.from - (e.clientX - drag.current.at));
        if (next === drag.current.now) return;
        drag.current.now = next;
        onValueChange(next);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => commit(INSPECTOR_WIDTH)}
      onKeyDown={(e) => {
        setPressed(false);
        if (e.key === 'ArrowLeft') commit(value + WIDTH_STEP);
        else if (e.key === 'ArrowRight') commit(value - WIDTH_STEP);
        else if (e.key === 'Home') commit(INSPECTOR_MIN);
        else if (e.key === 'End') commit(INSPECTOR_MAX);
        else return;
        e.preventDefault();
        // the inspector's lists and the page bind arrows too: the edge keeps the keys it handled
        e.stopPropagation();
      }}
    />
  );
}
