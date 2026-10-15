/** The outer document controls the inner frame's navigations as well as its resource loads. */
export const CARD_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
export const CARD_THEME_TOKENS = ['--gh-text', '--gh-surface', '--gh-line', '--gh-accent', '--gh-space-2'] as const;
const literal = (value: string) => JSON.stringify(value).replaceAll('<', '\\u003c');
const head = `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">`;
const bridge = `<script>
for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});
let sequence=0; const pending=new Map();
const tokens=${JSON.stringify(CARD_THEME_TOKENS)};
function context(ctx){if(!ctx)return;document.documentElement.style.colorScheme=ctx.theme==='dark'?'dark':'light';for(const key of tokens){const value=ctx.styles?.variables?.[key];if(typeof value==='string'&&value.length<=100&&/^[#a-zA-Z0-9().,% -]+$/.test(value))document.documentElement.style.setProperty(key,value);}}

window.addEventListener('message',event=>{if(event.source!==parent||event.data?.jsonrpc!=='2.0')return;if(event.data.method==='ui/notifications/host-context-changed'){context(event.data.params);return;}const item=pending.get(event.data.id);if(!item)return;pending.delete(event.data.id);event.data.error?item.reject(new Error(event.data.error.message)):item.resolve(event.data.result);});
window.greenhouse={query:(binding,cursor)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'query.'+binding,arguments:cursor?{cursor}:{}}},'*');})};
pending.set('initialize',{resolve:r=>context(r.hostContext),reject:()=>{}});parent.postMessage({jsonrpc:'2.0',id:'initialize',method:'ui/initialize'},'*');
</script>`;
export function cardDocument(html: string): string {
  const inner = `<!doctype html><html><head>${head}<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui;color:var(--gh-text,CanvasText);background:transparent}button{font:inherit}</style>${bridge}</head><body>${html}</body></html>`;
  return `<!doctype html><html><head>${head}<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="Card"></iframe><script>
const frame=document.querySelector('iframe');
window.addEventListener('message',event=>{if(event.source===frame.contentWindow)parent.postMessage(event.data,'*');else if(event.source===parent)frame.contentWindow.postMessage(event.data,'*');});
frame.srcdoc=${literal(inner)};
</script></body></html>`;
}
