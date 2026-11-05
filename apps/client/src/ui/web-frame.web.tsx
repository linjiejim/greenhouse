import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { FrameBridge } from './frame-bridge';
import type { WebViewProps } from 'react-native-webview';
/** Opaque-origin sandbox. Preview scripts have no access to station cookies or storage. */
export function WebFrame({
  source,
  onMessage,
  injectedJavaScriptBeforeContentLoaded,
  style,
  bridge,
}: WebViewProps & { bridge?: FrameBridge }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const callback = useRef(onMessage);
  callback.current = onMessage;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (bridge) {
        if (event.origin === bridge.origin) bridge.onMessage(event.data, event.origin);
        return;
      }
      if (typeof event.data !== 'string') return;
      callback.current?.({ nativeEvent: { data: event.data } } as never);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [bridge]);
  useEffect(() => {
    if (bridge?.outgoing) frame.current?.contentWindow?.postMessage(bridge.outgoing, bridge.origin);
  }, [bridge?.outgoing, bridge?.origin]);
  const frameSrc = useMemo(() => {
    if (!source || !('uri' in source) || !source.uri) return undefined;
    if (!bridge || window.location.origin !== 'tauri://localhost') return source.uri;
    const url = new URL(source.uri);
    url.searchParams.set('host_origin', 'tauri://localhost');
    return url.href;
  }, [source, bridge]);
  // A plugin page stays hidden until its document has loaded: before its styles and the bridge's
  // theme apply, a frame paints the browser's white canvas, a flash on a dark host.
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>();
  const html = source && 'html' in source ? source.html : undefined;
  const srcDoc = useMemo(() => {
    if (html === undefined) return undefined;
    const script = `<script>window.ReactNativeWebView={postMessage:function(data){parent.postMessage(String(data),'*')}};${(injectedJavaScriptBeforeContentLoaded ?? '').replace(/<\/script/gi, '<\\/script')}</script>`;
    return html.replace(/<head([^>]*)>/i, (match) => match + script) === html
      ? script + html
      : html.replace(/<head([^>]*)>/i, (match) => match + script);
  }, [html, injectedJavaScriptBeforeContentLoaded]);
  return (
    <iframe
      ref={frame}
      title={bridge?.title ?? 'Greenhouse preview'}
      sandbox={bridge ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads' : 'allow-scripts allow-downloads'}
      // Plugin frames may play video full screen; previews may not.
      allow={bridge ? 'fullscreen' : undefined}
      allowFullScreen={bridge ? true : undefined}
      onLoad={() => {
        setLoadedSrc(frameSrc);
        bridge?.onLoad?.();
      }}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      src={frameSrc}
      style={{
        border: 0,
        width: '100%',
        height: '100%',
        flex: 1,
        ...(StyleSheet.flatten(style) as React.CSSProperties),
        ...(bridge && loadedSrc !== frameSrc ? { visibility: 'hidden' as const } : null),
      }}
    />
  );
}
export type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
