/**
 * ```mermaid fenced block — the diagram drawn by Mermaid itself (flowcharts,
 * sequence / state / class / ER diagrams, Gantt…) inside a WebView, themed
 * with the app palette and sized to the drawing (scaled to the column width,
 * capped in height). Tap → the full-screen viewer (`/peek/diagram`, pinch to
 * zoom). Bad syntax, or no network to fetch Mermaid → the source as a plain
 * code block (what this block was before).
 *
 * Mermaid is pinned (MERMAID.version) and fetched from jsDelivr, then
 * npmmirror (reachable in mainland China), with Subresource Integrity — only
 * that exact file can run; WebKit's cache keeps it after the first diagram.
 * `securityLevel: 'strict'` disables click / href directives (the source is
 * model output), and the page has no bridge into the app beyond reporting
 * its height. Web parity: MermaidBlock (same strict mode, same fallback).
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { putHandoff } from '../../../lib/handoff';
import { useT } from '../../../lib/i18n';
import { type HexPalette, makeStyles, radius, space, squircle, useTheme } from '../../../theme';
import { Icon, Spinner } from '../../../ui/core';
import { NUNITO_WEB_FONT_CSS } from '../../../ui/brand-web-font.generated';
import { richSegment } from '../rich';
import { CodeBlock } from './code';

export const MERMAID = {
  version: '11.17.2',
  // sha384 of dist/mermaid.min.js 11.17.2 (identical on every npm CDN)
  integrity: 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2',
  sources: [
    'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js',
    'https://registry.npmmirror.com/mermaid/11.17.2/files/dist/mermaid.min.js',
  ],
};

/** Tallest an inline diagram gets before it's scaled down (the viewer has no cap). */
const INLINE_MAX_H = 440;

/** A JSON literal that's safe inside an inline <script> (no `</script>` break-out). */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The page that renders one diagram. `zoom`: the viewer (fit width, no height cap, pinch). */
export function mermaidHtml(code: string, hex: HexPalette, isDark: boolean, zoom = false): string {
  const config = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'Nunito, system-ui, sans-serif',
    themeCSS: `.node > rect:not([rx]), .node > rect[rx="0"], rect.actor { rx: ${radius.md}px; ry: ${radius.md}px; }`,
    themeVariables: {
      darkMode: isDark,
      background: hex.background,
      primaryColor: hex.secondaryBackground,
      primaryTextColor: hex.label,
      primaryBorderColor: hex.accent,
      secondaryColor: hex.background,
      secondaryTextColor: hex.label,
      secondaryBorderColor: hex.opaqueSeparator,
      tertiaryColor: hex.background,
      tertiaryTextColor: hex.label,
      tertiaryBorderColor: hex.opaqueSeparator,
      mainBkg: hex.secondaryBackground,
      nodeBorder: hex.accent,
      lineColor: hex.gray,
      textColor: hex.label,
      titleColor: hex.label,
      clusterBkg: hex.background,
      clusterBorder: hex.opaqueSeparator,
      edgeLabelBackground: hex.background,
      fontSize: '14px',
      fontFamily: 'Nunito, system-ui, sans-serif',
    },
  };
  const maxH = zoom ? 0 : INLINE_MAX_H;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,${zoom ? 'maximum-scale=6,user-scalable=yes' : 'maximum-scale=1,user-scalable=no'}">
<style>${NUNITO_WEB_FONT_CSS}
html,body{margin:0;padding:0;background:transparent;-webkit-text-size-adjust:100%}
#d{display:flex;justify-content:center;align-items:center;box-sizing:border-box;padding:${zoom ? 16 : 0}px${zoom ? ';min-height:80vh' : ''}}</style></head>
<body><div id="d"></div><script>(function(){
var CODE=${js(code)},CFG=${js(config)},SRC=${js(MERMAID.sources)},SRI=${js(MERMAID.integrity)},MAXH=${maxH};
function post(m){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(m))}
var d=document.getElementById('d');
function fit(){var svg=d.querySelector('svg');if(!svg)return;var vb=svg.viewBox&&svg.viewBox.baseVal;
var w=vb&&vb.width?vb.width:svg.getBoundingClientRect().width,h=vb&&vb.height?vb.height:svg.getBoundingClientRect().height;
var room=d.clientWidth-(${zoom ? 32 : 0}),s=Math.min(1,room/w);if(MAXH)s=Math.min(s,MAXH/h);
svg.removeAttribute('style');svg.setAttribute('width',Math.floor(w*s));svg.setAttribute('height',Math.floor(h*s));
post({type:'size',height:Math.ceil(d.getBoundingClientRect().height)})}
function render(){try{mermaid.initialize(CFG)}catch(e){post({type:'error'});return}
mermaid.render('gh-mermaid',CODE).then(function(r){d.innerHTML=r.svg;fit();window.addEventListener('resize',fit)})
.catch(function(){post({type:'error'})})}
function load(i){if(i>=SRC.length){post({type:'error'});return}var s=document.createElement('script');
s.src=SRC[i];s.integrity=SRI;s.crossOrigin='anonymous';s.onload=function(){document.fonts.load('14px Nunito').then(render,render)};s.onerror=function(){load(i+1)};
document.head.appendChild(s)}
load(0)})();</script></body></html>`;
}

export function MermaidBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('mermaid', raw), [raw]);
  if (seg?.type !== 'mermaid') return <CodeBlock lang="mermaid" code={raw} />;
  return <Mermaid code={seg.code} />;
}

function Mermaid({ code }: { code: string }) {
  const { colors: c, hex, isDark } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [height, setHeight] = useState(0);
  const source = useMemo(() => ({ html: mermaidHtml(code, hex, isDark) }), [code, hex, isDark]);

  if (state === 'failed') return <CodeBlock lang="mermaid" code={code} />;

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data) as { type: string; height?: number };
      if (m.type === 'size' && m.height) {
        setHeight(m.height);
        setState('ready');
      } else if (m.type === 'error') setState('failed');
    } catch {
      // not ours
    }
  };
  const open = () => router.push({ pathname: '/peek/diagram', params: { k: putHandoff('diagram', code) } });

  return (
    <Pressable
      onPress={open}
      disabled={state !== 'ready'}
      accessibilityRole="button"
      accessibilityLabel={t('chat.diagram')}
      accessibilityHint={t('chat.fullscreen')}
      style={styles.card}
    >
      <View style={{ height: state === 'ready' ? height : 120 }} pointerEvents="none">
        <WebView
          source={source}
          originWhitelist={['*']}
          onMessage={onMessage}
          scrollEnabled={false}
          bounces={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          style={[styles.web, state !== 'ready' && styles.hidden]}
          containerStyle={styles.web}
        />
        {state === 'loading' ? (
          <View style={styles.loading}>
            <Spinner />
          </View>
        ) : null}
      </View>
      {state === 'ready' ? (
        <View style={styles.expand} pointerEvents="none">
          <Icon name="expand" size={14} weight="medium" color={c.secondaryLabel} />
        </View>
      ) : null}
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginVertical: space.sm + 2,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    overflow: 'hidden',
    ...squircle,
  },
  web: { flex: 1, backgroundColor: 'transparent' },
  hidden: { opacity: 0 },
  loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  expand: { position: 'absolute', top: space.sm, right: space.sm + 2 },
}));
