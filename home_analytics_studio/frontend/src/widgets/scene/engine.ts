import type { Source, Stat } from '../../api/types'
import { autoDecimals, formatNumber } from '../../utils/format'
import type { DataRequest } from '../types'
import { evaluate } from './expr'
import { SCENE_TEMPLATES, templateById } from './templates'

export type VarFormat = 'power' | 'energy' | 'temp' | 'percent' | 'number' | 'text'

export interface SceneVar {
  /** identifier used in code: {{key}}, var(--key), data-value="key" */
  key: string
  label: string
  format?: VarFormat
  source?: Source
  /** derived value, evaluated when no source is set */
  expr?: string
  /** default statistic when a source is picked */
  stat?: Stat
  /** scale for animations: value between min and max → 0…1 */
  min?: number
  max?: number
  /** "active" threshold (class key-an); default 5 W for power, otherwise 0 */
  on?: number
  decimals?: number | null
  unit?: string
  invert?: boolean
  /** show the absolute value (direction is shown by the animation) */
  abs?: boolean
  hint?: string
  advanced?: boolean
}

export interface SceneLabel {
  id: string
  title?: string
  source?: Source
  format?: VarFormat
  decimals?: number | null
  unit?: string
  x: number
  y: number
  size?: number
  color?: string
}

export interface SceneTemplate {
  id: string
  name: string
  description: string
  w: number
  h: number
  html: string
  css: string
  vars: SceneVar[]
}

export interface SceneCode {
  html: string
  css: string
  w: number
  h: number
  allowJs?: boolean
}

export interface VarPayload {
  /** numeric value (null = no value) */
  v: number | null
  /** formatted text incl. unit */
  t: string
  /** formatted number without unit */
  x: string
  /** normalized 0…1 for animations */
  n: number
  on: boolean
  neg: boolean
  has: boolean
}

export const KEY_RE = /^[a-z][a-z0-9_]*$/

const DEFAULT_RANGE: Record<VarFormat, [number, number]> = {
  power: [0, 5000],
  energy: [0, 20],
  temp: [0, 60],
  percent: [0, 100],
  number: [0, 100],
  text: [0, 1],
}

export function sceneCode(cfg: Record<string, any>): SceneCode {
  if (cfg.template === 'custom' || !templateById(cfg.template)) {
    const c = cfg.custom || {}
    return { html: c.html || '', css: c.css || '', w: Number(c.w) || 960, h: Number(c.h) || 540, allowJs: !!c.allowJs }
  }
  const t = templateById(cfg.template)!
  return { html: t.html, css: t.css, w: t.w, h: t.h }
}

/** Effective variables: template defaults merged with the user's bindings, or custom variables; plus free labels. */
export function sceneVars(cfg: Record<string, any>): SceneVar[] {
  const t = cfg.template !== 'custom' ? templateById(cfg.template) : undefined
  let vars: SceneVar[]
  if (t) {
    const bind: Record<string, Partial<SceneVar>> = cfg.bind || {}
    vars = t.vars.map((v) => {
      const b = bind[v.key] || {}
      const out: SceneVar = { ...v }
      for (const k of ['source', 'min', 'max', 'on', 'decimals', 'unit', 'invert'] as const) {
        if (b[k] !== undefined && b[k] !== null && b[k] !== '') (out as any)[k] = b[k]
      }
      if (b.source === null) delete out.source
      return out
    })
  } else {
    vars = ((cfg.custom?.vars as SceneVar[]) || []).filter((v) => v && KEY_RE.test(v.key))
  }
  for (const l of (cfg.labels as SceneLabel[]) || []) {
    if (!l?.id) continue
    vars.push({ key: labelKey(l.id), label: l.title || '', source: l.source, format: l.format || 'number', decimals: l.decimals, unit: l.unit })
  }
  return vars
}

export const labelKey = (id: string) => `lbl_${id.replace(/[^a-z0-9_]/gi, '').toLowerCase()}`

export function isLiveVar(v: SceneVar): boolean {
  const s = v.source
  if (!s?.id || s.type !== 'entity') return false
  return v.format === 'text' || (s.stat || v.stat || 'auto') === 'current'
}

export function sceneRequests(cfg: Record<string, any>): DataRequest[] {
  const range = cfg.range || 'today'
  return sceneVars(cfg)
    .filter((v) => v.source?.id && !isLiveVar(v))
    .map((v) => ({ kind: 'scalar' as const, source: { ...v.source!, stat: v.source!.stat || v.stat }, range, key: `v_${v.key}` }))
}

/** Entities the scene reads (for live subscription and event-driven refresh). */
export function sceneSources(cfg: Record<string, any>): Source[] {
  return sceneVars(cfg)
    .map((v) => v.source)
    .filter((s): s is Source => !!s?.id)
}

export interface RawValue {
  v: number | null
  s?: string | null
  unit?: string | null
}

const ON_STATES = new Set(['on', 'true', 'open', 'heat', 'heating', 'running', 'an', 'ein', 'home'])
const OFF_STATES = new Set(['off', 'false', 'closed', 'idle', 'aus', 'standby', 'not_home'])

/** Live state string → number (also on/off). */
export function stateNumber(state: string | null | undefined): number | null {
  if (state == null || state === '') return null
  const n = Number(state)
  if (Number.isFinite(n)) return n
  const s = state.toLowerCase()
  if (ON_STATES.has(s)) return 1
  if (OFF_STATES.has(s)) return 0
  return null
}

function convert(v: number, unit: string | null | undefined, format: VarFormat | undefined): number {
  const u = (unit || '').trim()
  if (format === 'power') {
    if (u === 'kW') return v * 1000
    if (u === 'MW') return v * 1e6
  }
  if (format === 'energy') {
    if (u === 'Wh') return v / 1000
    if (u === 'MWh') return v * 1000
  }
  return v
}

function formatVar(v: number, def: SceneVar, srcUnit: string | null | undefined): { t: string; x: string } {
  const fmt = (d: number) => formatNumber(v, { decimals: d })
  const dec = def.decimals == null || (def.decimals as unknown) === '' ? null : Number(def.decimals)
  const withUnit = (x: string, unit: string) => {
    const u = def.unit != null && def.unit !== '' ? (def.unit === '-' ? '' : def.unit) : unit
    return { t: u ? `${x} ${u}` : x, x }
  }
  switch (def.format) {
    case 'power':
      if (Math.abs(v) >= 1000 && dec == null) return withUnit(formatNumber(v / 1000, { decimals: 2 }), 'kW')
      return withUnit(fmt(dec ?? 0), 'W')
    case 'energy': {
      const a = Math.abs(v)
      return withUnit(fmt(dec ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2)), 'kWh')
    }
    case 'temp':
      return withUnit(fmt(dec ?? 1), '°C')
    case 'percent':
      return withUnit(fmt(dec ?? 0), '%')
    default:
      return withUnit(fmt(dec ?? autoDecimals(v)), srcUnit || '')
  }
}

/** Turns raw values into what the scene needs (formatted text, 0…1 scale, flags). Pure → unit-tested. */
export function computeScene(vars: SceneVar[], raw: Record<string, RawValue | undefined>): Record<string, VarPayload> {
  const scope: Record<string, number | null> = {}
  const out: Record<string, VarPayload> = {}
  for (const def of vars) {
    const r = def.source?.id ? raw[def.key] : undefined
    let v: number | null = null
    let text: string | null = null
    let unit: string | null | undefined = r?.unit
    if (def.source?.id) {
      v = r?.v ?? null
      if (v != null) {
        v = convert(v, unit, def.format)
        if (def.invert) v = -v
      }
      if (def.format === 'text') text = r?.s ?? null
    } else if (def.expr) {
      v = evaluate(def.expr, scope)
      unit = null
    }
    scope[def.key] = v
    const shown = v != null && def.abs ? Math.abs(v) : v
    let t = '–'
    let x = '–'
    if (def.format === 'text') {
      t = x = text ?? (v != null ? formatNumber(v) : '–')
    } else if (shown != null) {
      ;({ t, x } = formatVar(shown, def, unit))
    }
    const [dmin, dmax] = DEFAULT_RANGE[def.format || 'number']
    const min = def.min ?? dmin
    const max = def.max ?? dmax
    const base = v == null ? 0 : def.format === 'power' || def.abs ? Math.abs(v) : v
    const n = v == null || max === min ? 0 : Math.min(1, Math.max(0, (base - min) / (max - min)))
    const thr = def.on ?? (def.format === 'power' ? 5 : 0)
    const has = v != null || (def.format === 'text' && !!text)
    out[def.key] = {
      v,
      t,
      x,
      n: Math.round(n * 1000) / 1000,
      on: v != null && Math.abs(v) > thr,
      neg: v != null && v < 0 && Math.abs(v) > thr,
      has,
    }
  }
  return out
}

// ------------------------------------------------------------------ sandboxed document

const BASE_CSS = `
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:var(--text);font-family:var(--font),system-ui,sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
#has-stage{position:absolute;left:0;top:0;transform-origin:0 0;overflow:visible}
#has-labels{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.has-label{position:absolute;-webkit-transform:translate(-50%,-50%);transform:translate(-50%,-50%);text-align:center;white-space:nowrap;line-height:1.15;padding:4px 10px;border-radius:10px;background:var(--chip-bg);border:1px solid var(--line)}
.has-label-t{font-size:.6em;color:var(--muted)}
.has-label-v{font-weight:700;font-variant-numeric:tabular-nums}
html.edit .has-label{pointer-events:auto;cursor:move;outline:2px dashed var(--accent);outline-offset:2px;touch-action:none}
html.no-anim *,html.no-anim *:before,html.no-anim *:after{-webkit-animation:none!important;animation:none!important;transition:none!important}
[data-show-if]:not(.has-if-ok){display:none!important}
`

/** ES5 – runs unchanged in old TV browsers. Receives values via postMessage, never touches the network. */
const BOOTSTRAP = `(function(){
var stage=document.getElementById('has-stage'),W=+stage.getAttribute('data-w'),H=+stage.getAttribute('data-h'),root=document.documentElement;
var labelsEl=document.createElement('div');labelsEl.id='has-labels';stage.appendChild(labelsEl);
var last=null,dragging=null,edit=false;
function fit(){var s=Math.min(window.innerWidth/W,window.innerHeight/H)||1;var x=(window.innerWidth-W*s)/2,y=(window.innerHeight-H*s)/2;stage.style.width=W+'px';stage.style.height=H+'px';stage.style.webkitTransform=stage.style.transform='translate('+x+'px,'+y+'px) scale('+s+')';}
window.addEventListener('resize',fit);fit();
var RE=/\\{\\{\\s*([a-z][a-z0-9_]*)(\\.number)?\\s*\\}\\}/g;
(function walk(n){if(n.nodeType===3){var s=n.nodeValue;if(!RE.test(s))return;RE.lastIndex=0;var f=document.createDocumentFragment(),i=0,m;while((m=RE.exec(s))){if(m.index>i)f.appendChild(document.createTextNode(s.slice(i,m.index)));var sp=document.createElement('span');sp.setAttribute(m[2]?'data-number':'data-value',m[1]);f.appendChild(sp);i=m.index+m[0].length;}if(i<s.length)f.appendChild(document.createTextNode(s.slice(i)));n.parentNode.replaceChild(f,n);return;}
if(n.nodeType===1&&(n.tagName==='SCRIPT'||n.tagName==='STYLE'))return;var c=n.childNodes;for(var k=c.length-1;k>=0;k--)walk(c[k]);})(stage);
var CRE=/^\\s*(!?)\\s*([a-z][a-z0-9_]*)\\s*(?:(>=|<=|==|!=|>|<)\\s*(-?[0-9.]+))?\\s*$/;
function cond(expr,vars){var m=CRE.exec(expr||'');if(!m)return false;var d=vars[m[2]];var r;if(!m[3])r=!!(d&&d.on);else{if(!d||d.v===null)return false;var a=d.v,b=parseFloat(m[4]);r=m[3]==='>'?a>b:m[3]==='<'?a<b:m[3]==='>='?a>=b:m[3]==='<='?a<=b:m[3]==='=='?a===b:a!==b;}return m[1]?!r:r;}
function each(sel,fn){var l=stage.querySelectorAll(sel);for(var i=0;i<l.length;i++)fn(l[i]);}
function labels(list,vars){if(dragging)return;while(labelsEl.firstChild)labelsEl.removeChild(labelsEl.firstChild);
for(var i=0;i<list.length;i++){var l=list[i],d=vars[l.key]||{t:'–'};var el=document.createElement('div');el.className='has-label';el.setAttribute('data-id',l.id);el.style.left=(l.x*W)+'px';el.style.top=(l.y*H)+'px';el.style.fontSize=(l.size||26)+'px';if(l.color)el.style.color=l.color;
if(l.title){var t=document.createElement('div');t.className='has-label-t';t.textContent=l.title;el.appendChild(t);}var v=document.createElement('div');v.className='has-label-v';v.textContent=d.t;el.appendChild(v);labelsEl.appendChild(el);}}
function apply(m){last=m;edit=!!m.edit;var th=m.theme||{};for(var k in th)root.style.setProperty('--'+k,th[k]);
var cls=[],vars=m.vars||{};for(var key in vars){var d=vars[key];root.style.setProperty('--'+key,String(d.n));root.style.setProperty('--'+key+'-pct',(d.n*100)+'%');root.style.setProperty('--'+key+'-dur',(2.6-2.2*d.n).toFixed(2)+'s');root.style.setProperty('--'+key+'-play',d.on?'running':'paused');
if(d.has)cls.push('has-'+key);if(d.on)cls.push(key+'-an');if(d.neg)cls.push(key+'-neg');}
if(!m.anim)cls.push('no-anim');if(edit)cls.push('edit');root.className=cls.join(' ');
each('[data-value]',function(e){var d=vars[e.getAttribute('data-value')];e.textContent=d?d.t:'–';});
each('[data-number]',function(e){var d=vars[e.getAttribute('data-number')];e.textContent=d?d.x:'–';});
each('[data-range]',function(e){e.textContent=m.range||'';});
each('[data-show-if]',function(e){if(cond(e.getAttribute('data-show-if'),vars))e.classList.add('has-if-ok');else e.classList.remove('has-if-ok');});
each('[data-class-if]',function(e){var p=e.getAttribute('data-class-if').split(':');if(p.length<2)return;var c=p[0].trim();if(!c)return;if(cond(p.slice(1).join(':'),vars))e.classList.add(c);else e.classList.remove(c);});
labels(m.labels||[],vars);window.HAS=vars;try{window.dispatchEvent(new CustomEvent('has:values',{detail:vars}));}catch(e){}}
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var m=e.data;if(m&&m.type==='has-values')apply(m);});
labelsEl.addEventListener('pointerdown',function(e){if(!edit)return;var el=e.target;while(el&&el!==labelsEl&&!el.getAttribute('data-id'))el=el.parentNode;if(!el||el===labelsEl)return;e.preventDefault();dragging=el;try{el.setPointerCapture(e.pointerId);}catch(x){}});
function pos(e){var r=stage.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};}
labelsEl.addEventListener('pointermove',function(e){if(!dragging)return;var p=pos(e);dragging.style.left=(p.x*W)+'px';dragging.style.top=(p.y*H)+'px';});
function up(e){if(!dragging)return;var p=pos(e),id=dragging.getAttribute('data-id');dragging=null;window.parent.postMessage({type:'has-label-move',id:id,x:Math.round(p.x*1000)/1000,y:Math.round(p.y*1000)/1000},'*');}
labelsEl.addEventListener('pointerup',up);labelsEl.addEventListener('pointercancel',up);
window.parent.postMessage({type:'has-ready'},'*');
})();`

function nonce(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds the sandboxed document. Isolation: the iframe gets sandbox="allow-scripts" without
 * allow-same-origin (opaque origin → no cookies, storage or API access) and a CSP that blocks all
 * network requests (connect-src none) and – unless enabled – any script except our bootstrap.
 */
export function buildSrcdoc(code: SceneCode): string {
  const n = nonce()
  const scriptSrc = code.allowJs ? "'unsafe-inline'" : `'nonce-${n}'`
  const csp = `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data: blob: http: https:; font-src data:; media-src data:`
  const css = code.css.replace(/<\/style/gi, '<\\/style')
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${BASE_CSS}</style><style>${css}</style></head><body>` +
    `<div id="has-stage" data-w="${code.w}" data-h="${code.h}">${code.html}</div>` +
    `<script nonce="${n}">${BOOTSTRAP}</script></body></html>`
  )
}

export const TEMPLATE_OPTIONS = [
  ...SCENE_TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
  { value: 'custom', label: 'Eigener Code (HTML / CSS / SVG)' },
]
