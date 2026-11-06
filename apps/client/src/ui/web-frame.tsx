import React, { useEffect, useRef } from 'react';
import { WebView, type WebViewProps } from 'react-native-webview';
import type { FrameBridge } from './frame-bridge';
import { openLink } from '../lib/links';

/** Schemes a plugin page may send the member to outside it. */
const OUTSIDE = /^(https?|mailto|tel):$/i;
export function WebFrame({ bridge, ...props }: WebViewProps & { bridge?: FrameBridge }) {
  const frame = useRef<WebView>(null);
  useEffect(() => {
    if (bridge?.outgoing)
      frame.current?.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(bridge.outgoing)}}));true;`,
      );
  }, [bridge?.outgoing]);
  return (
    <WebView
      {...props}
      ref={frame}
      // Plugin pages play their media in place (a video does not leave the page) and may go full screen.
      {...(bridge ? { allowsInlineMediaPlayback: true, allowsFullscreenVideo: true } : null)}
      onLoad={bridge ? () => bridge.onLoad?.() : props.onLoad}
      // The plugin page stays on its own origin; a link out of it (or a new window it opens) goes
      // to the in-app browser instead, as the web's sandboxed iframe lets it open a tab.
      onShouldStartLoadWithRequest={
        bridge
          ? (request) => {
              let url: URL;
              try {
                url = new URL(request.url);
              } catch {
                return false;
              }
              if (url.origin === bridge.origin) return true;
              if (request.isTopFrame !== false && OUTSIDE.test(url.protocol)) void openLink(url.toString());
              return false;
            }
          : props.onShouldStartLoadWithRequest
      }
      onOpenWindow={
        bridge
          ? (event) => {
              let target: URL;
              try {
                target = new URL(event.nativeEvent.targetUrl);
              } catch {
                return;
              }
              if (OUTSIDE.test(target.protocol)) void openLink(target.toString());
            }
          : props.onOpenWindow
      }
      injectedJavaScriptBeforeContentLoaded={
        bridge
          ? `window.parent.postMessage=function(data){window.ReactNativeWebView.postMessage(JSON.stringify(data));};true;`
          : props.injectedJavaScriptBeforeContentLoaded
      }
      onMessage={(event) => {
        if (bridge) {
          let origin = '';
          try {
            origin = new URL(event.nativeEvent.url).origin;
          } catch {
            /* refuse opaque navigation */
          }
          bridge.onMessage(event.nativeEvent.data, origin);
        } else props.onMessage?.(event);
      }}
    />
  );
}
export type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
