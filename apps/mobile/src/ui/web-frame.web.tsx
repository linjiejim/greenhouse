import React, { useEffect, useMemo, useRef } from 'react';
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
      sandbox={bridge ? 'allow-scripts allow-same-origin allow-downloads' : 'allow-scripts allow-downloads'}
      onLoad={bridge?.onLoad}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      src={source && 'uri' in source ? source.uri : undefined}
      style={{
        border: 0,
        width: '100%',
        height: '100%',
        flex: 1,
        ...(StyleSheet.flatten(style) as React.CSSProperties),
      }}
    />
  );
}
export type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
