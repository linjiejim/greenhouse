/** Root route frames keep objects in the same router, presented as an inspector on wide screens. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useNavigationState } from 'expo-router/react-navigation';
import { SheetFrame } from './sheet-actions';
import { useTheme } from '../theme';
import { Overlay, hasInteractiveOverlay } from './overlay.web';
import { wideLayout } from '../shell/wide-model';
import { boundedInspectorWidth, inspectorRoute, inspectorCount } from '../shell/inspector-model';
import { useInspector } from '../shell/inspector.web';

type Route = { name: string; key: string; params?: object };
export function sheetEdgeLayout(props: { children: React.ReactElement; route: Route }) {
  return <ScreenFrame route={props.route}>{props.children}</ScreenFrame>;
}
function ScreenFrame({ children, route }: { children: React.ReactNode; route: Route }) {
  const { width } = useWindowDimensions();
  const layout = wideLayout(width);
  const router = useRouter();
  const { hex: c, isDark } = useTheme();
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
    const screen = mainFrame.current?.parentElement?.closest('[aria-hidden]');
    if (!screen) return;
    const main = activeInspector && layout.wide && state.routes[state.index - depth]?.key === route.key;
    screen.setAttribute('aria-hidden', String(!(isTop || main)));
  }, [state, route.key, activeInspector, layout.wide, depth, isTop]);
  const docked = inspector && layout.wide && !layout.floatInspector;
  const frame = useRef<View>(null);
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
      return boundedInspectorWidth(Number(localStorage.getItem(widthKey)) || 400);
    } catch {
      return 400;
    }
  }, [widthKey]);
  const [panelWidth, setPanelWidth] = useState(readWidth);
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
    const changed = () => setPanelWidth(readWidth());
    changed();
    window.addEventListener('greenhouse:inspector-width', changed);
    return () => window.removeEventListener('greenhouse:inspector-width', changed);
  }, [readWidth]);
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
        initialFocus="panel"
        onClose={close}
        panelStyle={{
          position: 'fixed',
          inset: 0,
          maxWidth: 'none',
          maxHeight: 'none',
          minWidth: 0,
          display: 'flex',
          padding: 0,
          overflow: 'hidden',
        }}
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
          accessibilityLabel="Close"
          onPress={close}
          style={{ position: 'absolute', inset: 0, backgroundColor: inspector ? 'transparent' : c.scrim }}
        />
      ) : null}
      <View
        testID={inspector ? 'client-inspector' : 'client-sheet'}
        style={{
          width: layout.wide ? (inspector ? panelWidth : 560) : '100%',
          height: inspector || !layout.wide ? '100%' : '90%',
          maxWidth: '100%',
          borderLeftWidth: 1,
          borderColor: c.separator,
          backgroundColor: c.secondaryGroupedBackground,
          boxShadow: isDark || !layout.wide || !layout.floatInspector ? undefined : '-8px 0 32px rgba(0,0,0,.10)',
        }}
      >
        {inspector && layout.wide ? (
          <div
            role="separator"
            aria-label="Inspector width"
            aria-orientation="vertical"
            tabIndex={0}
            aria-valuemin={360}
            aria-valuemax={520}
            aria-valuenow={panelWidth}
            style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, zIndex: 2, cursor: 'col-resize' }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const next = boundedInspectorWidth(panelWidth + (e.key === 'ArrowLeft' ? 16 : -16));
                setPanelWidth(next);
                try {
                  localStorage.setItem(widthKey, String(next));
                } catch {
                  return;
                }
                window.dispatchEvent(new Event('greenhouse:inspector-width'));
              }
            }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const next = boundedInspectorWidth(window.innerWidth - e.clientX);
              setPanelWidth(next);
              try {
                localStorage.setItem(widthKey, String(next));
              } catch {
                return;
              }
              window.dispatchEvent(new Event('greenhouse:inspector-width'));
            }}
          />
        ) : null}
        <SheetFrame>{children}</SheetFrame>
      </View>
    </View>
  );
}
