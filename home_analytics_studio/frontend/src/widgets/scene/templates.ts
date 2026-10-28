import type { SceneTemplate } from './engine'

/*
 * Built-in scenes. They use exactly the same mechanism as custom code (HTML/SVG + CSS, values via
 * data-value / CSS variables), so "Als eigenen Code bearbeiten" yields a working starting point.
 * Only CSS that old TV browsers (Chrome 69) understand: no flex gap, no inset, no aspect-ratio.
 */

const SHARED_CSS = `/* Bausteine */
svg.scene{position:absolute;left:0;top:0}
.line{fill:none;stroke:var(--wall-stroke);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.wall{fill:var(--wall);stroke:var(--wall-stroke);stroke-width:3;stroke-linejoin:round}
.track{fill:none;stroke:var(--line);stroke-width:4;stroke-linecap:round}
.flow{fill:none;stroke-linecap:round;stroke-dasharray:2 16;opacity:0;transition:opacity .6s;
  -webkit-animation:flow 1.2s linear infinite;animation:flow 1.2s linear infinite}
@-webkit-keyframes flow{to{stroke-dashoffset:-36}}
@keyframes flow{to{stroke-dashoffset:-36}}
@-webkit-keyframes spin{to{-webkit-transform:rotate(360deg)}}
@keyframes spin{to{transform:rotate(360deg)}}
@-webkit-keyframes pulse{50%{opacity:.25}}
@keyframes pulse{50%{opacity:.25}}
.chip{position:absolute;-webkit-transform:translate(-50%,-50%);transform:translate(-50%,-50%);padding:6px 14px;border-radius:12px;
  background:var(--chip-bg);border:1px solid var(--line);text-align:center;white-space:nowrap;line-height:1.2}
.chip .t{font-size:14px;color:var(--muted);letter-spacing:.02em}
.chip .v{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums}
.chip .s{font-size:13px;color:var(--muted)}
.chip .s b{color:var(--text);font-weight:600}
.stats{position:absolute;padding:10px 16px;border-radius:14px;background:var(--chip-bg);border:1px solid var(--line);font-size:15px;line-height:1.7}
.stats .h{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.stats .row{display:-webkit-box;display:flex;-webkit-box-pack:justify;justify-content:space-between}
.stats .row b{margin-left:18px;font-variant-numeric:tabular-nums}
`

// ------------------------------------------------------------------ Haus mit Solaranlage

const rays = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6
  const p = (r: number) => `${(130 + Math.cos(a) * r).toFixed(1)} ${(95 + Math.sin(a) * r).toFixed(1)}`
  return `M ${p(46)} L ${p(62)}`
}).join(' ')

const SOLAR_HTML = `<svg class="scene" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <radialGradient id="sunG"><stop offset="0" stop-color="#fff7c2"/><stop offset=".6" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/></radialGradient>
    <linearGradient id="panelG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#172554"/></linearGradient>
    <linearGradient id="shineG" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="panelClip"><rect x="10" y="-17" width="180" height="14"/></clipPath>
    <clipPath id="batClip"><rect x="711" y="358" width="48" height="88" rx="4"/></clipPath>
  </defs>
  <path class="line" d="M 20 452 H 940"/>

  <!-- Sonne -->
  <g class="sun"><path class="rays" d="${rays}"/><circle cx="130" cy="95" r="36" fill="url(#sunG)"/></g>
  <path class="beam" d="M 162 116 L 398 238"/><path class="beam" d="M 168 104 L 470 190"/>

  <!-- Strommast -->
  <g class="mast line">
    <path d="M 150 452 L 164 205 M 190 452 L 176 205 M 164 205 H 176"/>
    <path d="M 152 420 L 186 380 M 188 420 L 154 380 M 155 380 L 184 340 M 185 380 L 157 340 M 158 340 L 181 300 M 182 340 L 160 300 M 160 300 L 179 260 M 180 300 L 162 260 M 162 260 L 177 222 M 178 260 L 163 222"/>
    <path d="M 128 222 H 212 M 140 246 H 200"/>
  </g>

  <!-- Haus -->
  <rect class="wall" x="598" y="196" width="22" height="60"/>
  <rect class="wall" x="380" y="290" width="280" height="162"/>
  <path class="wall roof" d="M 355 292 L 520 170 L 685 292 Z"/>
  <rect class="win" x="395" y="305" width="50" height="40" rx="3"/><rect class="win" x="595" y="305" width="50" height="40" rx="3"/>
  <path class="line thin" d="M 420 305 V 345 M 395 325 H 445 M 620 305 V 345 M 595 325 H 645"/>

  <!-- Solarmodule auf dem Dach -->
  <g transform="translate(368 278) rotate(-36.5)">
    <rect class="panel" x="10" y="-17" width="56" height="14" rx="1.5"/><rect class="panel" x="72" y="-17" width="56" height="14" rx="1.5"/><rect class="panel" x="134" y="-17" width="56" height="14" rx="1.5"/>
    <path class="panel-grid" d="M 38 -17 V -3 M 100 -17 V -3 M 162 -17 V -3 M 10 -10 H 66 M 72 -10 H 128 M 134 -10 H 190"/>
    <g clip-path="url(#panelClip)"><rect class="shine" x="-40" y="-20" width="40" height="20" fill="url(#shineG)"/></g>
    <rect class="panel-glow" x="10" y="-17" width="180" height="14"/>
  </g>

  <!-- Batterie -->
  <g class="opt-bat">
    <rect class="wall" x="723" y="344" width="24" height="8" rx="2"/>
    <rect class="wall" x="705" y="352" width="60" height="100" rx="8"/>
    <g clip-path="url(#batClip)"><rect class="bat-fill" x="711" y="358" width="48" height="88"/></g>
    <path class="bolt bat-bolt" d="M 740 372 L 728 402 H 738 L 732 428 L 746 394 H 736 Z"/>
  </g>

  <!-- Wallbox und Auto -->
  <g class="opt-car">
    <rect class="wall" x="812" y="372" width="24" height="52" rx="5"/>
    <circle class="car-led" cx="824" cy="386" r="4"/>
    <path class="line" d="M 824 424 C 824 448, 846 448, 856 432"/>
    <path class="wall" d="M 852 440 V 422 Q 856 410 870 408 L 886 394 Q 891 389 900 389 H 924 Q 934 389 939 397 L 946 408 Q 955 411 955 424 V 440 Z"/>
    <path class="line thin" d="M 892 396 H 922 L 932 408 H 884 Z"/>
    <circle class="wheel" cx="874" cy="442" r="10"/><circle class="wheel" cx="934" cy="442" r="10"/>
    <path class="bolt car-bolt" d="M 906 414 L 898 428 H 905 L 901 440 L 912 424 H 905 Z"/>
  </g>

  <!-- Energieflüsse -->
  <path class="track" d="M 442 212 C 450 280, 520 300, 520 362"/>
  <path class="track" d="M 196 222 C 290 230, 330 400, 444 400"/>
  <path class="track opt-battery" d="M 596 392 C 640 392, 660 400, 705 400"/>
  <path class="track opt-car-flow" d="M 596 414 C 660 470, 760 470, 812 414"/>
  <path class="flow f-pv" d="M 442 212 C 450 280, 520 300, 520 362"/>
  <path class="flow f-grid" d="M 196 222 C 290 230, 330 400, 444 400"/>
  <path class="flow f-bat" d="M 596 392 C 640 392, 660 400, 705 400"/>
  <path class="flow f-car" d="M 596 414 C 660 470, 760 470, 812 414"/>
</svg>

<div class="chip" style="left:520px;top:126px"><div class="t">Solar</div><div class="v" data-value="pv"></div>
  <div class="s opt-pv_today">heute <b data-value="pv_today"></b></div></div>

<div class="chip" style="left:170px;top:496px">
  <div class="t"><span data-show-if="!grid < 0">Netzbezug</span><span data-show-if="grid < 0">Einspeisung</span></div>
  <div class="v" data-value="grid"></div></div>

<div class="chip hub" style="left:520px;top:400px"><div class="t">Verbrauch</div><div class="v" data-value="home"></div>
  <div class="s opt-autarky">Autarkie <b data-value="autarky"></b></div></div>

<div class="chip opt-bat" style="left:735px;top:496px">
  <div class="t">Batterie <span data-show-if="battery > 5">· lädt</span><span data-show-if="battery < -5">· entlädt</span></div>
  <div class="v"><span class="opt-battery_soc" data-value="battery_soc"></span></div>
  <div class="s opt-battery"><b data-value="battery"></b></div></div>

<div class="chip opt-car" style="left:892px;top:496px"><div class="t">E-Auto</div><div class="v" data-value="car"></div></div>

<div class="stats" style="right:18px;top:16px">
  <div class="h"><span data-range></span></div>
  <div class="row opt-pv_today"><span>Solarertrag</span><b data-value="pv_today"></b></div>
  <div class="row opt-home_today"><span>Verbrauch</span><b data-value="home_today"></b></div>
  <div class="row opt-import_today"><span>Netzbezug</span><b data-value="import_today"></b></div>
  <div class="row opt-export_today"><span>Einspeisung</span><b data-value="export_today"></b></div>
</div>`

const opt = (keys: string[], sel: string) => `html${keys.map((k) => `:not(.has-${k})`).join('')} ${sel}{display:none}`

const SOLAR_CSS = `${SHARED_CSS}
/* Sonne: Helligkeit folgt der Solarleistung */
.sun{opacity:.3;transition:opacity 1s}
html.pv-an .sun{opacity:calc(.45 + var(--pv) * .55)}
.rays{fill:none;stroke:#fbbf24;stroke-width:4;stroke-linecap:round;transform-origin:130px 95px;
  -webkit-animation:spin 40s linear infinite;animation:spin 40s linear infinite;animation-play-state:var(--pv-play)}
.beam{fill:none;stroke:#fde68a;stroke-width:3;stroke-dasharray:8 14;opacity:0;-webkit-animation:flow 1.6s linear infinite;animation:flow 1.6s linear infinite}
html.pv-an .beam{opacity:calc(.25 + var(--pv) * .6)}

.thin{stroke-width:2}
.roof{fill:var(--wall-strong)}
.win{fill:#fde68a;opacity:calc(.12 + var(--home) * .75);transition:opacity 1s}
.panel{fill:url(#panelG);stroke:#93c5fd;stroke-width:1}
.panel-grid{fill:none;stroke:#93c5fd;stroke-width:.7;opacity:.6}
.panel-glow{fill:#fde68a;opacity:calc(var(--pv) * .35)}
.shine{opacity:0;-webkit-animation:shine 3.5s ease-in-out infinite;animation:shine 3.5s ease-in-out infinite}
html.pv-an .shine{opacity:1}
@-webkit-keyframes shine{to{-webkit-transform:translateX(240px)}}
@keyframes shine{to{transform:translateX(240px)}}

.bat-fill{fill:#34d399;transform-origin:735px 446px;-webkit-transform:scaleY(var(--battery_soc));transform:scaleY(var(--battery_soc));transition:transform 1s}
.bolt{fill:#fbbf24;opacity:0}
html.battery-an:not(.battery-neg) .bat-bolt,html.car-an .car-bolt{opacity:1;-webkit-animation:pulse 1.4s ease-in-out infinite;animation:pulse 1.4s ease-in-out infinite}
.wheel{fill:var(--wall-stroke)}
.car-led{fill:var(--muted)}
html.car-an .car-led{fill:#34d399}

/* Flüsse: Dicke und Tempo folgen der Leistung, Richtung dem Vorzeichen */
.f-pv{stroke:#fbbf24;stroke-width:calc(5px + var(--pv) * 6px);animation-duration:var(--pv-dur)}
.f-grid{stroke:#60a5fa;stroke-width:calc(5px + var(--grid) * 6px);animation-duration:var(--grid-dur)}
html.grid-neg .f-grid{stroke:#34d399;animation-direction:reverse}
.f-bat{stroke:#a78bfa;stroke-width:calc(5px + var(--battery) * 6px);animation-duration:var(--battery-dur)}
html.battery-neg .f-bat{animation-direction:reverse}
.f-car{stroke:#22d3ee;stroke-width:calc(5px + var(--car) * 6px);animation-duration:var(--car-dur)}
html.pv-an .f-pv,html.grid-an .f-grid,html.battery-an .f-bat,html.car-an .f-car{opacity:1}
.hub{min-width:150px}

/* nicht zugeordnete Teile ausblenden */
${opt(['battery', 'battery_soc'], '.opt-bat')}
${opt(['battery'], '.opt-battery')}
${opt(['battery_soc'], '.opt-battery_soc')}
${opt(['car'], '.opt-car')}
${opt(['car'], '.opt-car-flow')}
${opt(['autarky'], '.opt-autarky')}
${['pv_today', 'home_today', 'import_today', 'export_today'].map((k) => opt([k], `.opt-${k}`)).join('\n')}
${opt(['pv_today', 'home_today', 'import_today', 'export_today'], '.stats')}
`

// ------------------------------------------------------------------ Wärmepumpe

const fins = Array.from({ length: 9 }, (_, i) => `<rect class="fin" x="${696 + i * 15}" y="324" width="9" height="92" rx="3"/>`).join('')
const vents = Array.from({ length: 8 }, (_, i) => `M 200 ${326 + i * 13} H 252`).join(' ')
const heat = [716, 760, 804].map((x, i) => `<path class="heat" style="animation-delay:${i * 0.8}s" d="M ${x} 306 q -9 -10 0 -20 q 9 -10 0 -20 q -9 -10 0 -20"/>`).join('')
const air = [338, 370, 402].map((y) => `<path class="air" d="M 30 ${y} q -9 8 0 16 q 9 8 0 16"/>`).join('')

const HP_HTML = `<svg class="scene" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="tankG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>
  </defs>
  <path class="line" d="M 20 452 H 940"/>

  <!-- Haus -->
  <rect class="wall" x="320" y="136" width="610" height="316"/>
  <path class="wall roof" d="M 300 138 L 625 35 L 950 138 Z"/>

  <!-- Außeneinheit -->
  <rect class="wall" x="40" y="300" width="230" height="150" rx="12"/>
  <path class="line" d="M 60 450 V 458 M 250 450 V 458"/>
  <circle class="grill" cx="120" cy="375" r="56"/><circle class="grill" cx="120" cy="375" r="40"/><circle class="grill" cx="120" cy="375" r="24"/>
  <g class="fan">
    <path class="blade" d="M 120 375 C 108 350, 124 326, 140 334 C 140 352, 130 366, 120 375 Z"/>
    <path class="blade" transform="rotate(120 120 375)" d="M 120 375 C 108 350, 124 326, 140 334 C 140 352, 130 366, 120 375 Z"/>
    <path class="blade" transform="rotate(240 120 375)" d="M 120 375 C 108 350, 124 326, 140 334 C 140 352, 130 366, 120 375 Z"/>
    <circle class="hubc" cx="120" cy="375" r="8"/>
  </g>
  <path class="line thin" d="${vents}"/>
  <circle class="led" cx="252" cy="314" r="5"/>
  ${air}

  <!-- Strom zur Wärmepumpe -->
  <path class="track" d="M 155 236 V 300"/>
  <path class="flow f-el" d="M 155 236 V 300"/>

  <!-- Rohre: Wärmepumpe ↔ Puffer -->
  <path class="pipe hot" d="M 270 330 H 500"/><path class="pipe cold" d="M 500 420 H 270"/>
  <path class="flow f-vl" d="M 270 330 H 500"/><path class="flow f-rl" d="M 500 420 H 270"/>

  <!-- Puffer -->
  <rect class="tank" x="500" y="225" width="76" height="220" rx="30"/>

  <!-- Heizkreis -->
  <path class="pipe hot" d="M 576 300 H 700 V 324"/><path class="pipe cold" d="M 820 416 V 436 H 576"/>
  <path class="flow f-hk" d="M 576 300 H 700 V 324"/><path class="flow f-hk2" d="M 820 416 V 436 H 576"/>
  <rect class="wall" x="690" y="320" width="140" height="100" rx="6"/>${fins}
  ${heat}

  <!-- Warmwasser -->
  <g class="opt-dhw">
    <path class="pipe hot" d="M 576 255 H 865"/><path class="pipe cold" d="M 865 432 H 846 V 446 H 576"/>
    <path class="flow f-ww" d="M 576 255 H 865"/><path class="flow f-ww2" d="M 865 432 H 846 V 446 H 576"/>
    <rect class="tank" x="865" y="230" width="52" height="212" rx="22"/>
  </g>
</svg>

<div class="chip" style="left:155px;top:56px"><div class="t">Außen</div><div class="v" data-value="outdoor_temp"></div></div>
<div class="chip opt-mode" style="left:155px;top:128px"><div class="t">Betrieb</div><div class="v small" data-value="mode"></div></div>
<div class="chip" style="left:155px;top:204px"><div class="t">Strom</div><div class="v" data-value="hp_power"></div></div>

<div class="chip opt-cop" style="left:625px;top:96px"><div class="t">COP aktuell</div><div class="v" data-value="cop"></div></div>
<div class="chip opt-flow_temp" style="left:405px;top:296px"><div class="t">Vorlauf</div><div class="v" data-value="flow_temp"></div></div>
<div class="chip opt-return_temp" style="left:405px;top:386px"><div class="t">Rücklauf</div><div class="v" data-value="return_temp"></div></div>
<div class="chip opt-buffer_temp" style="left:538px;top:196px"><div class="t">Puffer</div><div class="v" data-value="buffer_temp"></div></div>
<div class="chip opt-heat_power" style="left:760px;top:196px"><div class="t">Wärme</div><div class="v" data-value="heat_power"></div></div>
<div class="chip opt-room_temp" style="left:760px;top:290px"><div class="t">Raum</div><div class="v small" data-value="room_temp"></div></div>
<div class="chip opt-dhw_temp" style="left:890px;top:196px"><div class="t">Warmwasser</div><div class="v" data-value="dhw_temp"></div></div>

<div class="chip opt-energy_today" style="left:330px;top:498px"><div class="t">Strom <span data-range></span></div><div class="v" data-value="energy_today"></div></div>
<div class="chip opt-heat_today" style="left:520px;top:498px"><div class="t">Wärme <span data-range></span></div><div class="v" data-value="heat_today"></div></div>
<div class="chip opt-jaz_today" style="left:710px;top:498px"><div class="t">Arbeitszahl <span data-range></span></div><div class="v" data-value="jaz_today"></div></div>`

const HP_CSS = `${SHARED_CSS}
.thin{stroke-width:2}
.roof{fill:var(--wall-strong)}
.v.small{font-size:19px}
.grill{fill:none;stroke:var(--wall-stroke);stroke-width:2;opacity:.6}
.blade{fill:var(--muted);opacity:.85}
.hubc{fill:var(--wall-stroke)}
/* Lüfter dreht schneller, je mehr Strom die Wärmepumpe aufnimmt */
.fan{transform-origin:120px 375px;-webkit-animation:spin var(--hp_power-dur) linear infinite;animation:spin var(--hp_power-dur) linear infinite;animation-play-state:var(--hp_power-play)}
.led{fill:var(--muted)}
html.hp_power-an .led{fill:#34d399}
.air{fill:none;stroke:#7dd3fc;stroke-width:3;stroke-linecap:round;opacity:0}
html.hp_power-an .air{-webkit-animation:air 1.8s ease-in infinite;animation:air 1.8s ease-in infinite}
@-webkit-keyframes air{0%{opacity:0;-webkit-transform:translateX(0)}40%{opacity:.9}100%{opacity:0;-webkit-transform:translateX(-26px)}}
@keyframes air{0%{opacity:0;transform:translateX(0)}40%{opacity:.9}100%{opacity:0;transform:translateX(-26px)}}

.pipe{fill:none;stroke-width:10;stroke-linecap:round;stroke-linejoin:round}
.pipe.hot{stroke:#ef4444;opacity:calc(.35 + var(--flow_temp) * .5)}
.pipe.cold{stroke:#3b82f6;opacity:.45}
.tank{fill:url(#tankG);fill-opacity:.55;stroke:var(--wall-stroke);stroke-width:3}
.fin{fill:var(--wall-strong);stroke:var(--wall-stroke);stroke-width:1.5}
.heat{fill:none;stroke:#f97316;stroke-width:3;stroke-linecap:round;opacity:0}
html.heat_power-an .heat,html:not(.has-heat_power).hp_power-an .heat{-webkit-animation:rise 2.4s ease-out infinite;animation:rise 2.4s ease-out infinite}
@-webkit-keyframes rise{0%{opacity:0;-webkit-transform:translateY(8px)}40%{opacity:.9}100%{opacity:0;-webkit-transform:translateY(-22px)}}
@keyframes rise{0%{opacity:0;transform:translateY(8px)}40%{opacity:.9}100%{opacity:0;transform:translateY(-22px)}}

.f-el{stroke:#fbbf24;stroke-width:7;animation-duration:var(--hp_power-dur)}
.f-vl,.f-hk,.f-ww{stroke:#fecaca;stroke-width:5}
.f-rl,.f-hk2,.f-ww2{stroke:#bfdbfe;stroke-width:5}
html.hp_power-an .f-el,html.hp_power-an .f-vl,html.hp_power-an .f-rl{opacity:1}
html.heat_power-an .f-hk,html.heat_power-an .f-hk2,
html:not(.has-heat_power).hp_power-an .f-hk,html:not(.has-heat_power).hp_power-an .f-hk2,
html.dhw_active-an .f-ww,html.dhw_active-an .f-ww2{opacity:1}

${['mode', 'cop', 'flow_temp', 'return_temp', 'buffer_temp', 'heat_power', 'room_temp', 'dhw_temp', 'energy_today', 'heat_today', 'jaz_today'].map((k) => opt([k], `.opt-${k}`)).join('\n')}
${opt(['dhw_temp', 'dhw_active'], '.opt-dhw')}
`

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    id: 'house_solar',
    name: 'Haus mit Solaranlage',
    description: 'Sonne, PV-Module, Netz, Batterie und E-Auto mit animierten Energieflüssen',
    w: 960,
    h: 540,
    html: SOLAR_HTML,
    css: SOLAR_CSS,
    vars: [
      { key: 'pv', label: 'Solarleistung', format: 'power', stat: 'current', max: 10000, hint: 'Max. für Animation = Anlagenleistung in W (z. B. 10 kWp → 10000)' },
      { key: 'grid_import', label: 'Netzbezug (W)', format: 'power', stat: 'current', advanced: true, hint: 'nur wenn Bezug und Einspeisung getrennte Sensoren sind' },
      { key: 'grid_export', label: 'Einspeisung (W)', format: 'power', stat: 'current', advanced: true },
      { key: 'grid', label: 'Netzleistung (+ Bezug / − Einspeisung)', format: 'power', stat: 'current', abs: true, max: 8000, expr: 'coalesce(grid_import, 0) - coalesce(grid_export, 0)', hint: 'leer = aus getrennten Sensoren unter „Weitere Zuordnungen“' },
      { key: 'battery', label: 'Batterieleistung (+ Laden / − Entladen)', format: 'power', stat: 'current', abs: true, max: 5000 },
      { key: 'battery_soc', label: 'Batterie-Ladestand', format: 'percent', stat: 'current' },
      { key: 'car', label: 'Wallbox / E-Auto Ladeleistung', format: 'power', stat: 'current', max: 11000 },
      { key: 'home', label: 'Hausverbrauch', format: 'power', stat: 'current', max: 6000, expr: 'max(0, coalesce(pv, 0) + coalesce(grid, 0) - coalesce(battery, 0))', hint: 'leer = berechnet aus Solar + Netz − Batterie' },
      { key: 'autarky', label: 'Autarkie (aktuell)', format: 'percent', advanced: true, expr: 'if(home > 0, 100 * (1 - min(max(grid, 0), home) / home), null)', hint: 'leer = berechnet' },
      { key: 'pv_today', label: 'Solarertrag (Zähler kWh)', format: 'energy', stat: 'auto' },
      { key: 'home_today', label: 'Verbrauch (Zähler kWh)', format: 'energy', stat: 'auto' },
      { key: 'import_today', label: 'Netzbezug (Zähler kWh)', format: 'energy', stat: 'auto' },
      { key: 'export_today', label: 'Einspeisung (Zähler kWh)', format: 'energy', stat: 'auto' },
    ],
  },
  {
    id: 'heat_pump',
    name: 'Wärmepumpe',
    description: 'Außeneinheit mit Lüfter, Puffer, Heizkörper und Warmwasser, mit Temperaturen und Arbeitszahl',
    w: 960,
    h: 540,
    html: HP_HTML,
    css: HP_CSS,
    vars: [
      { key: 'hp_power', label: 'Stromaufnahme Wärmepumpe', format: 'power', stat: 'current', max: 3000, on: 30, hint: 'steuert Lüfter und Rohrflüsse; Max. = höchste Leistungsaufnahme' },
      { key: 'heat_power', label: 'Wärmeleistung', format: 'power', stat: 'current', max: 9000, on: 50 },
      { key: 'cop', label: 'COP aktuell', format: 'number', decimals: 1, advanced: true, expr: 'if(hp_power > 50, heat_power / hp_power, null)', hint: 'leer = Wärmeleistung ÷ Stromaufnahme' },
      { key: 'outdoor_temp', label: 'Außentemperatur', format: 'temp', stat: 'current', min: -15, max: 35 },
      { key: 'flow_temp', label: 'Vorlauftemperatur', format: 'temp', stat: 'current', min: 20, max: 60 },
      { key: 'return_temp', label: 'Rücklauftemperatur', format: 'temp', stat: 'current', min: 20, max: 60 },
      { key: 'buffer_temp', label: 'Puffertemperatur', format: 'temp', stat: 'current', min: 20, max: 60 },
      { key: 'dhw_temp', label: 'Warmwassertemperatur', format: 'temp', stat: 'current', min: 20, max: 60 },
      { key: 'room_temp', label: 'Raumtemperatur', format: 'temp', stat: 'current', min: 15, max: 25 },
      { key: 'mode', label: 'Betriebsart (Text)', format: 'text', stat: 'current' },
      { key: 'dhw_active', label: 'Warmwasserbereitung aktiv (an/aus)', format: 'number', stat: 'current', advanced: true, hint: 'animiert den Warmwasser-Kreis' },
      { key: 'energy_today', label: 'Stromverbrauch (Zähler kWh)', format: 'energy', stat: 'auto' },
      { key: 'heat_today', label: 'Erzeugte Wärme (Zähler kWh)', format: 'energy', stat: 'auto' },
      { key: 'jaz_today', label: 'Arbeitszahl im Zeitraum', format: 'number', decimals: 1, advanced: true, expr: 'if(energy_today > 0, heat_today / energy_today, null)', hint: 'leer = Wärme ÷ Strom im Zeitraum' },
    ],
  },
]

export function templateById(id: string | undefined): SceneTemplate | undefined {
  return SCENE_TEMPLATES.find((t) => t.id === id)
}
