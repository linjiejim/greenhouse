import React, { useEffect, useRef } from 'react';
import { WebView, type WebViewProps } from 'react-native-webview';
import type { FrameBridge } from './frame-bridge';
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
      onLoad={bridge ? () => bridge.onLoad?.() : props.onLoad}
      onShouldStartLoadWithRequest={
        bridge
          ? (request) => {
              try {
                return new URL(request.url).origin === bridge.origin;
              } catch {
                return false;
              }
            }
          : props.onShouldStartLoadWithRequest
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
