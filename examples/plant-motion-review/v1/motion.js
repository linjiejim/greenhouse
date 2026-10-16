import {PRESETS, FIT} from './catalogue.js';
import {withHue} from './geometry.js';

export const STATES = ['idle','thinking','speaking','done','error','waiting','sleep','hello'];
export const LABELS = ['待机','思考','说话','完成','出错','等待','休眠','问好'];
export const META = [
 ['sprout','新芽','Greeny','轻轻呼吸，三片叶子向你打招呼'],
 ['ivy','常春藤','Ivy','舒缓地侧倾，留一点好奇'],
 ['sage','鼠尾草','Sage','慢半拍的沉静回应'],
 ['basil','罗勒','Basil','清爽、轻快的点头'],
 ['fern','蕨','卷卷','小小卷芽，温柔地晃一晃'],
 ['clover','紫色三叶草','叶叶','圆润的叶片，雀跃但克制'],
 ['monstera','龟背竹','Monstera','宽叶微摆，从容地回应'],
 ['ginkgo','银杏','Ginkgo','像一把小扇，慢慢舒展'],
 ['maple','枫','枫枫','带一点俏皮的轻倾'],
 ['echeveria','石莲花','Echeveria','稳稳的花心，安静地呼吸'],
 ['opuntia','仙人掌','仙仙','小幅点头，枝片轻轻抬起'],
 ['lotus','莲','Lotus','花瓣缓缓收拢与展开'],
 ['eucalyptus','尤加利','Eucalyptus','细长枝干，轻柔地摇摆'],
 ['lavender','薰衣草','薰薰','花穗轻晃，节奏柔和'],
 ['sunflower','向日葵','葵葵','奶油色笑脸，明亮地回应'],
 ['dandelion','蒲公英','蒲蒲','轻盈地漂浮，带一点好奇'],
];
// All states share these numeric channels and the same SVG nodes. Retargeting
// never resets the clock or the current interpolated values.
const base = {rot:0,y:0,sx:1,sy:1,fold:0,lookX:0,lookY:0,eye:3.5,curve:0,mouth:0.6,smile:2.5,width:3.6,brow:0,energy:0.55,talk:0,wave:0};
export const TARGETS = {
 idle:{...base},
 thinking:{...base,rot:-2.7,lookX:2.3,lookY:-2,eye:3.1,smile:.5,width:2.7,energy:.12},
 speaking:{...base,y:-.3,eye:3.8,mouth:.6,smile:1.5,width:4,talk:1,energy:.48},
 done:{...base,eye:.45,curve:-2.4,mouth:2,smile:3.8,width:4.2,energy:0},
 error:{...base,lookY:.6,eye:2.9,brow:1,width:2.6,mouth:.3,smile:-.6,energy:0},
 waiting:{...base,eye:4.1,mouth:1.3,smile:1,width:2.1,energy:.28},
 sleep:{...base,rot:2.5,y:1.4,sy:.99,eye:.28,curve:1.8,mouth:.2,smile:.7,width:2.2,fold:.23,energy:.15},
 hello:{...base,eye:3.9,mouth:1.3,smile:3.5,width:4,energy:0,wave:0},
};
const ns='http://www.w3.org/2000/svg';
function el(tag,attrs={},parent){const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);parent?.append(n);return n;}
const n=v=>Math.round(v*1000)/1000;
const seed=s=>[...s].reduce((v,c)=>(v*31+c.charCodeAt(0))>>>0,0);
let serial=0;
const active=new Set();
export const runtime={paused:false,hidden:document.hidden,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,speed:1,theme:'light',tint:'plant',time:0,frames:0,draws:0,lastCost:0};
let frame=0,last=0;
const observers=new IntersectionObserver(entries=>{for(const entry of entries){const a=entry.target.avatarInstance;if(a){a.visible=entry.isIntersecting;if(a.visible){a.dirty=true;wake();}}}}, {rootMargin:'40px'});
export function wake(){if(!frame&&!runtime.hidden)frame=requestAnimationFrame(tick);}
function tick(now){frame=0;const dt=last?Math.min((now-last)/1000,.25):0;last=now;const running=!runtime.paused&&!runtime.hidden&&!runtime.reduced;
 const start=performance.now();if(running)runtime.time+=dt*runtime.speed;
 for(const a of active){if(!a.visible||a.suspended)continue;if((running&&!a.static)||a.dirty)a.draw(running?dt*runtime.speed:0);}
 runtime.frames++;runtime.lastCost=performance.now()-start;
 document.dispatchEvent(new CustomEvent('motion-frame',{detail:{dt:running?dt*runtime.speed:0}}));
 if(running&&[...active].some(a=>a.visible&&!a.suspended&&!a.static))wake();else last=0;
}
export function settings(patch){Object.assign(runtime,patch);for(const a of active){if('theme'in patch||'tint'in patch)a.paint();a.dirty=true;}wake();}
document.addEventListener('visibilitychange',()=>{runtime.hidden=document.hidden;last=0;if(runtime.hidden&&frame){cancelAnimationFrame(frame);frame=0;}else wake();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{runtime.reduced=e.matches;for(const a of active){if(e.matches)a.current={...TARGETS[a.state]};a.dirty=true;}document.dispatchEvent(new Event('motion-preference'));wake();});
const colorCache=new Map();
function recolor(hex,tint){if(tint==='plant')return hex;const key=hex+tint;if(!colorCache.has(key))colorCache.set(key,withHue(hex,{sky:245,violet:300,rose:355,coral:40,gold:85,teal:190}[tint]));return colorCache.get(key);}
export class Avatar {
 constructor(host,plant,{state='idle',size=144,static:still=false,key=''}={}){
  this.host=host;this.plant=plant;this.p=PRESETS[plant];this.state=state;this.current={...TARGETS[state]};this.target=TARGETS[state];this.static=still;this.size=size;this.visible=true;this.suspended=false;this.dirty=true;
  const idx=META.findIndex(x=>x[0]===plant);this.phase=(seed(plant+key)%997)/997*Math.PI*2;this.period=4.1+(idx*7%13)*.15;this.amplitude=['echeveria','sunflower','opuntia','lotus'].includes(plant)?.2:plant==='eucalyptus'?1.1:.45+(idx%4)*.16;this.entered=runtime.time;this.waking=false;this.blinkCount=0;this.blinkRng=seed(plant+key+'blink')||1;this.nextBlink=runtime.time+this.nextBlinkGap();this.blinkStart=-10;
  this.svg=el('svg',{viewBox:'-8 -8 116 116',role:'img','aria-label':`${META[idx][1]} · ${LABELS[STATES.indexOf(state)]}`,'data-plant':plant,'data-instance':++serial,'data-state':state},host);
  this.disc=el('circle',{cx:50,cy:50,r:49,fill:this.p.palette.light.disc},this.svg);
  this.fit=el('g',{},this.svg);this.pose=el('g',{'data-rig':'pose'},this.fit);
  this.layers=this.p.layers.map(l=>{let group=el('g',{'data-rig':l.part||'body'},this.pose);let path=el('path',{d:l.d,fill:l.stroke?'none':'currentColor','fill-rule':l.fillRule||'nonzero','stroke-linecap':'round','stroke-linejoin':'round',...(l.stroke?{stroke:'currentColor','stroke-width':l.stroke}:{})},group);return{l,group,path};});
  this.face=el('g',{'data-rig':'face'},this.pose);this.eyes=[el('path',{},this.face),el('path',{},this.face)];this.brows=[el('path',{fill:'none','stroke-width':1.7,'stroke-linecap':'round'},this.face),el('path',{fill:'none','stroke-width':1.7,'stroke-linecap':'round'},this.face)];
  this.mouth=el('path',{'stroke-width':1.25,'stroke-linecap':'round','stroke-linejoin':'round'},this.face);
  host.avatarInstance=this;observers.observe(host);active.add(this);this.resize(size);this.paint();this.draw(0);wake();
 }
 nextBlinkGap(){let x=this.blinkRng;x^=x<<13;x^=x>>>17;x^=x<<5;this.blinkRng=x>>>0;return 3+3*this.blinkRng/4294967296;}
 setState(state){if(!TARGETS[state]||state===this.state)return;this.waking=this.state==='sleep';this.state=state;this.entered=runtime.time;this.target=TARGETS[state];this.svg.dataset.state=state;this.svg.setAttribute('aria-label',`${META.find(x=>x[0]===this.plant)[1]} · ${LABELS[STATES.indexOf(state)]}`);this.dirty=true;if(this.static||runtime.reduced){this.current={...this.target};this.draw(0);}wake();}
 resize(size){this.size=size;this.svg.style.width=size+'px';this.svg.style.height=size+'px';const lod=size<=20?'glyph':size<=44?'avatar':'portrait',code={glyph:'g',avatar:'a',portrait:'p'}[lod];this.svg.dataset.lod=lod;const [r,dx,dy]=FIT[this.plant][lod],scale=41/r;this.fit.setAttribute('transform',`translate(50 50) scale(${scale}) translate(${-50+dx} ${-50+dy})`);for(const {l,group}of this.layers)group.style.display=l.lods.includes(code)?'':'none';this.mouth.style.display=lod==='glyph'?'none':'';this.dirty=true;wake();}
 paint(){const palette={...this.p.palette[runtime.theme]};for(const k of ['disc','body','shade','light'])palette[k]=recolor(palette[k],runtime.tint);this.disc.setAttribute('fill',palette.disc);for(const {l,path}of this.layers){path.style.color=palette[l.tone];path.setAttribute('opacity',l.op??1);}this.ink=palette.ink;for(const e of this.eyes)e.setAttribute('fill',this.ink);for(const b of this.brows)b.setAttribute('stroke',this.ink);this.mouth.setAttribute('fill',this.ink);this.mouth.setAttribute('stroke',this.ink);}
 draw(dt){this.dirty=false;runtime.draws++;const c=this.current,elapsed=runtime.time-this.entered;const goal={...this.target};
  if(this.state==='done'&&elapsed<.9)goal.y=-2*Math.sin(Math.PI*elapsed/.9);
  if(this.state==='error'&&elapsed<.85){goal.rot=2.8*Math.sin(Math.PI*elapsed/.85);goal.sy=1-.014*Math.sin(Math.PI*elapsed/.85);}
  if(this.state==='hello'&&elapsed<1.2){goal.rot=2.5*Math.sin(elapsed/1.2*Math.PI*4)*(1-elapsed/1.2);goal.wave=Math.sin(elapsed/1.2*Math.PI*4)*(1-elapsed/1.2);}
  if(!this.static&&!runtime.reduced&&!runtime.paused)for(const k in c){const slow=this.state==='sleep'||(this.waking&&elapsed<.65);const tau=slow?(k==='eye'||k==='curve'?.18:k==='fold'?.2:.15):.085;c[k]+=(goal[k]-c[k])*(1-Math.exp(-dt/tau));}
  const still=this.static||runtime.reduced, t=still?0:runtime.time, phase=still?0:this.phase, freq=2*Math.PI/this.period;
  const sw=still?0:Math.sin(t*freq+phase), sway=sw*c.energy*this.amplitude, breathe=still?0:Math.sin(t*freq*.72+phase)*.003*c.energy;
  const [px,py]=this.p.pivot;this.pose.setAttribute('transform',runtime.reduced?'translate(0 0)':`translate(0 ${n(c.y+sw*c.energy*.5)}) translate(${px} ${py}) rotate(${n(c.rot+sway)}) scale(${n(c.sx-breathe)} ${n(c.sy+breathe)}) translate(${-px} ${-py})`);
  for(const {l,group}of this.layers){if(l.part){const part=this.p.parts[l.part];const waving=still?0:c.wave*(l.part==='r'?3.5:.7);const rot=runtime.reduced?0:part.fold*c.fold+waving+sway*.5;group.setAttribute('transform',`rotate(${n(rot)} ${part.at.join(' ')})`);}else if(l.organ){const organ=l.organ;const motion=still?0:Math.sin(t*freq+phase-organ.phase)*c.energy*organ.gain;group.setAttribute('transform',`rotate(${n(motion)} ${organ.at.join(' ')})`);}}
  this.face.setAttribute('transform',`translate(${n(c.lookX)} ${n(c.lookY)})`);
  const face=this.p.face,s=face.scale||1,gap=Math.max(face.gap,this.size<=20?8.8:7),eyeW=(this.size<=20?3.9:2.9)*s;
  if(!still&&t>=this.nextBlink){this.blinkStart=t;this.blinkCount++;this.nextBlink=t+this.nextBlinkGap();}
  const blinkPhase=t-this.blinkStart,blink=still?1:blinkPhase>=0&&blinkPhase<.18?Math.abs(blinkPhase/.09-1):1;
  const eyeH=Math.max(.24,c.eye*blink)*s;
  this.eyes.forEach((eye,i)=>{const x=face.x+(i?gap:-gap),y=face.y,curve=c.curve*s;eye.setAttribute('d',`M${n(x-eyeW)} ${y} C${n(x-eyeW)} ${n(y+curve-eyeH*1.33)} ${n(x+eyeW)} ${n(y+curve-eyeH*1.33)} ${n(x+eyeW)} ${y} C${n(x+eyeW)} ${n(y+curve+eyeH*1.33)} ${n(x-eyeW)} ${n(y+curve+eyeH*1.33)} ${n(x-eyeW)} ${y}Z`);const dir=i?1:-1;this.brows[i].setAttribute('d',`M${n(x-3)} ${n(y-7-dir)} Q${x} ${n(y-8.5)} ${n(x+3)} ${n(y-7+dir)}`);this.brows[i].setAttribute('opacity',n(c.brow));});
  const phrase=(t+phase)%1.68,syllables=2+(seed(this.plant)%3),durations=[.21,.29,.18,.26];let cursor=0,syllable=0;for(let i=0;i<syllables;i++){const end=cursor+durations[i];if(phrase>=cursor&&phrase<end)syllable=Math.pow(Math.sin((phrase-cursor)/durations[i]*Math.PI),1.5)*(2.2+i%2*.7);cursor=end;}
  const talk=still?c.talk*1.9:c.talk*syllable;const x=face.x,y=face.y+8*s,w=c.width*s,open=Math.max(.2,c.mouth+talk)*s;
  this.mouth.setAttribute('d',`M${n(x-w)} ${y} Q${x} ${n(y+c.smile-open*.7)} ${n(x+w)} ${y} Q${x} ${n(y+c.smile+open*1.5)} ${n(x-w)} ${y}Z`);
 }
 dispose(){observers.unobserve(this.host);active.delete(this);this.svg.remove();delete this.host.avatarInstance;}
}
export function diagnostics(){return {instances:active.size,visible:[...active].filter(a=>a.visible&&!a.suspended&&!a.static).length,static:[...active].filter(a=>a.static).length,...runtime};}
