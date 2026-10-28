/**
 * ```mermaid fenced block — the diagram drawn by Mermaid itself (flowcharts,
 * sequence / state / class / ER diagrams, Gantt…) inside a WebView, themed
 * with the app palette and sized to the drawing (scaled to the column width,
 * capped in height). Tap → the full-screen viewer (`/peek/diagram`, pinch to
 * zoom). Bad syntax → the source as a plain code block.
 *
 * Mermaid ships inside the app (assets/web/mermaid.min.txt, MERMAID_VERSION from
 * node_modules/mermaid/dist/mermaid.min.js): read once, injected before the page
 * loads, so diagrams draw offline and never depend on a CDN.
 * `securityLevel: 'strict'` disables click / href directives (the source is
 * model output), and the page has no bridge into the app beyond reporting
 * its height. Web parity: MermaidBlock (same strict mode, same fallback).
 */
import { useEffect, useMemo, useState } from 'react';
import { Asset } from 'expo-asset';
import { readAssetText } from '../../lib/asset-text';
import mermaidAsset from '../../../assets/web/mermaid.min.txt';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { WebFrame as WebView, type WebViewMessageEvent } from '../../ui/web-frame';
import { putHandoff } from '../../lib/handoff';
import { useT } from '../../lib/i18n';
import { type HexPalette, makeStyles, radius, space, squircle, useTheme } from '../../theme';
import { Icon, Spinner } from '../../ui/core';
import { loadMermaidFont } from './mermaid-font';
import { richSegment } from '../rich';
import { CodeBlock } from './code';

export const MERMAID_VERSION = '11.17.2';

type MermaidLib = { source: string; font: string };
let mermaidSource: Promise<MermaidLib> | null = null;

/** The bundled Mermaid and the diagram font CSS, read once per launch. */
export function loadMermaid(): Promise<MermaidLib> {
  mermaidSource ??= (async () => {
    const [[asset], font] = await Promise.all([Asset.loadAsync(mermaidAsset), loadMermaidFont()]);
    return { source: await readAssetText(asset!.localUri ?? asset!.uri), font };
  })().catch((error: unknown) => {
    mermaidSource = null;
    throw error;
  });
  return mermaidSource;
}

/** The bundled Mermaid and font, or null while they load; `failed` when they cannot be read. */
export function useMermaid(): { source: string | null; font: string; failed: boolean } {
  const [state, setState] = useState<{ source: string | null; font: string; failed: boolean }>({
    source: null,
    font: '',
    failed: false,
  });
  useEffect(() => {
    let alive = true;
    loadMermaid().then(
      (lib) => alive && setState({ ...lib, failed: false }),
      () => alive && setState({ source: null, font: '', failed: true }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Tallest an inline diagram gets before it's scaled down (the viewer has no cap). */
const INLINE_MAX_H = 440;

/** A JSON literal that's safe inside an inline <script> (no `</script>` break-out). */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The page that renders one diagram in `font` (useMermaid). `zoom`: the viewer (fit width, no height cap, pinch). */
export function mermaidHtml(code: string, hex: HexPalette, isDark: boolean, font: string, zoom = false): string {
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
<style>${font}
html,body{margin:0;padding:0;background:transparent;-webkit-text-size-adjust:100%}
#d{display:flex;justify-content:center;align-items:center;box-sizing:border-box;padding:${zoom ? 16 : 0}px${zoom ? ';min-height:80vh' : ''}}</style></head>
<body><div id="d"></div><script>(function(){
var CODE=${js(code)},CFG=${js(config)},MAXH=${maxH};
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
if(typeof mermaid==='undefined'){post({type:'error'});return}
document.fonts.load('14px Nunito').then(render,render)})();</script></body></html>`;
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
  const lib = useMermaid();
  const source = useMemo(() => ({ html: mermaidHtml(code, hex, isDark, lib.font) }), [code, hex, isDark, lib.font]);

  if (state === 'failed' || lib.failed) return <CodeBlock lang="mermaid" code={code} />;

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
        {lib.source ? (
          <WebView
            source={source}
            injectedJavaScriptBeforeContentLoaded={lib.source}
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
        ) : null}
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
