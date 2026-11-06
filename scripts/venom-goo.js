/* ============================================================
   FlipArt86 – Venom Goo Buttons (Phase 4.5.5/4.5.6, lokale Integration)
   Technik: Venom-Goo-Demo V4.2 (Design/UI_Mockups/FlipArt86_Venom_Goo_Buttons_Demo_V4-2_Overlay.html),
   ohne Customizer, Presets, Persistenz und Klick-Simulation.

   - Fäden entstehen nur nach echtem Kontakt (Zeiger >= 0,1 s auf dem Button) und anschließendem Wegziehen.
     Keine Fernanziehung, kein Autoplay. Rückzug bei Überschreiten der maximalen Fadenlänge (reach),
     bei Stillstand / Zurückbewegen (0,35 s) oder wenn der Zeiger das Fenster verlässt.
   - Button-Körper im Canvas des Buttons (hinter dem Text); Fäden außerhalb des Körpers in EINER fixierten,
     transparenten Overlay-Ebene (pointer-events: none, z-index 19: über den Abschnitten, unter Header/Menüs).
     Dadurch werden Fäden nicht an overflow:hidden von Hero, Drop-Karte oder Software-Karten abgeschnitten.
     Buttons im Header (Navigation) rendern lokal, da der Header nicht abschneidet und im Vordergrund liegt.
   - Buttons in Dialogen ([role="dialog"] / <dialog>, z. B. Impressum & Kontakt): eigene Fadenebene IM scrollenden
     Dialogfenster (position:fixed, z-index:-1 -> über dem Fensterhintergrund, unter Text und Bedienelementen),
     Zeichnung auf die Fensterfläche begrenzt. Dieselbe WebGL-Engine, kein zweiter Renderer.
   - Ein WebGL-Kontext, ein rAF-Loop nur bei Interaktion; Ruhezustand ohne Frames.
   - Fallbacks: Touch / kein Hover-Zeiger, schwaches Gerät, kein WebGL, Shader-Fehler, langsame Frames
     -> normale Buttons; Kontextverlust -> normale Buttons, danach wieder aktiv; Reduced Motion -> statisch.
   - Debug: ?goo=off (Effekt aus), ?goo=force (Wächter für langsame Frames aus), window.VenomGoo.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------------
     CONFIG – Preset "Flip Preset Venom" (vom Nutzer im Customizer V4.2 eingestellt, unverändert übernommen).
     Pro Button später möglich:  overrides: { hero1: { gooColor: '#7dff1f' } }  (Button-IDs: data-goo-id)
     Hinweis: bgColor ist ein Customizer-Feld für die Demo-Seite; auf der Website gilt weiterhin --bg (identisch #07080a).
     --------------------------------------------------------------- */
  var CONFIG = {
    name: 'Flip Preset Venom',
    format: 'flipart86-venom-goo-customizer',
    version: 1,
    global: {
      gooColor: '#2ff37a',
      bgColor: '#07080a',
      textAuto: true,
      textColor: '#08100b',
      surface: 'auto',
      tone: 'dark',
      stickiness: 0.26,
      anchor: 0.54,
      elasticity: 252,
      viscosity: 18.6,
      damping: 19.3,
      retract: 3.3,
      strands: 6,
      minor: 2,
      reach: 296,
      stretch: 1.1,
      speed: 0.65,
      gravity: 1450,
      thickness: 3.4,
      bridge: 0.65,
      separation: 1,
      gloss: 1.35,
      glow: 0.06,
      reaction: 1.5,
      overlay: true,
      autoplay: false
    },
    overrides: {}
  };
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  /* Werte werden 1:1 verwendet (keine Normalisierung); Overrides überschreiben nur einzelne Felder. */
  function resolve(id) {
    var o = {}, k, g = CONFIG.global, ov = Object.prototype.hasOwnProperty.call(CONFIG.overrides, id) ? CONFIG.overrides[id] : null;
    for (k in g) if (Object.prototype.hasOwnProperty.call(g, k)) o[k] = g[k];
    if (ov) for (k in ov) if (Object.prototype.hasOwnProperty.call(ov, k)) o[k] = ov[k];
    return o;
  }
  var paused = false;   /* kein Pause-Schalter auf der Website (Tab-Pause über visibilitychange) */

  /* ---------- Farben ---------- */
  function hex01(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function mul(a, f) { return [a[0] * f, a[1] * f, a[2] * f]; }
  function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function derive(p, baseMode) {
    var g = hex01(p.gooColor), surf = p.surface === 'auto' ? baseMode : (p.surface === 'dark' ? 1 : 0), d = { surf: surf };
    if (surf === 0) { d.c0 = mul(g, 0.33); d.c1 = g; d.c2 = mix(g, [1, 1, 1], 0.82); d.edge = mul(g, 0.06); d.rim = g; d.text = lum(g) > 0.5 ? '#08100b' : '#f4fff8'; }
    else { d.c0 = [0.008, 0.010, 0.012]; d.c1 = [0.05, 0.062, 0.068]; d.c2 = mix(g, [1, 1, 1], 0.35); d.edge = [0, 0, 0]; d.rim = g; d.text = '#eef1ee'; }
    if (!p.textAuto) d.text = p.textColor;
    return d;
  }

  /* ---------- Engine ---------- */
  var qs = location.search;
  var FORCE = /[?&]goo=force/.test(qs);
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-goo]'));
  var stats = { state: 'init', reason: '', frames: 0, running: false, active: 0, avgMs: 0, slow: 0, buttons: nodes.length, dpr: 1 };
  var statusEl = document.getElementById('goo-status');
  function say() { /* keine Statusanzeige auf der Website */ }

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var hoverOK = window.matchMedia('(hover: hover) and (pointer: fine)');
  var NK = 5, NSMAX = 12, FR = [0, .22, .5, .76, 1], RT = [1.7, 1.25, 0.95, 0.72, 0.5];
  var gl = null, glc = null, prog, U = {}, loseExt = null, engineOn = false, lost = false, MAXSEG = 0;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  stats.dpr = dpr;
  var segA = null, segR = null, bbox = new Float32Array(4);

  function disable(reason) {
    engineOn = false; stats.state = 'off'; stats.reason = reason; stats.running = false;
    layers.forEach(function (L) { if (L.cv.parentNode) L.cv.parentNode.removeChild(L.cv); }); layers = [];
    btns.forEach(function (b) { if (b.cv.parentNode) b.cv.parentNode.removeChild(b.cv); });
    nodes.forEach(function (n) { n.classList.remove('vb-ready'); n.classList.remove('vb'); n.style.removeProperty('color'); });
    say();
  }

  var VS = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';
  /* V4: Stränge = Catmull-Rom-Kurven (glatt, kein Polylinien-Knick), unterteilt in verjüngte Kapseln.
     Material: schwarze, glänzende Flüssigkeit mit schmaler grüner Spiegelung; grüner Button-Körper geht im Hals in Schwarz über. */
  function buildFS(M) {
    return [
      'precision highp float;',
      'uniform vec2 uRes; uniform float uDpr; uniform vec4 uBody; uniform float uRad; uniform float uK; uniform float uKs;',
      'uniform int uN; uniform vec4 uSeg[' + M + ']; uniform vec2 uR[' + M + ']; uniform vec4 uBB; uniform float uMode; uniform float uTone; uniform float uMask;',
      'uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uRim; uniform vec3 uEdge;',
      'uniform float uGloss; uniform float uShin; uniform float uGlow;',
      'float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }',
      'float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }',
      'vec2 thr(vec2 p){',
      '  if (uN == 0 || p.x < uBB.x || p.y < uBB.y || p.x > uBB.z || p.y > uBB.w) return vec2(1e5, 1.0);',
      '  float d = 1e5, dm = 1e5, r = 1.0;',
      '  for (int i = 0; i < ' + M + '; i++){ if (i >= uN) break;',
      '    vec4 s = uSeg[i]; vec2 pa = p - s.xy, ba = s.zw - s.xy;',
      '    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);',
      '    float rad = mix(uR[i].x, uR[i].y, h);',
      '    float dd = length(pa - ba * h) - rad;',
      '    if (dd < dm) { dm = dd; r = rad; }',
      '    d = smin(d, dd, uKs);',
      '  }',
      '  return vec2(d, r);',
      '}',
      'float field(vec2 p){ return smin(sdBox(p - uBody.xy, uBody.zw, uRad), thr(p).x, uK); }',
      'void main(){',
      '  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;',
      '  float db = sdBox(p - uBody.xy, uBody.zw, uRad);',
      '  vec2 t = thr(p);',
      '  float dm = min(db, t.x);',
      '  float cut = max(uK * 1.3, uGlow > 0.001 ? 30.0 : 0.0);',
      '  if (dm > cut) { gl_FragColor = vec4(0.0); return; }',
      '  float d = smin(db, t.x, uK);',
      '  float e = 1.0;',
      '  vec2 g = vec2(field(p + vec2(e, 0.0)) - d, field(p + vec2(0.0, e)) - d) / e;',
      '  g = normalize(g + vec2(1e-5));',
      '  float depth = -d;',
      '  float Rb = max(uBody.w * 0.95, 8.0);',
      '  float wB = clamp(0.5 + 0.5 * (t.x - db) / 6.0, 0.0, 1.0);',
      '  float Rt = mix(t.y + 0.6, Rb, wB);',
      '  float tt = clamp(depth / Rt, 0.0, 1.0);',
      '  float s = 1.0 - tt;',
      '  vec3 N = normalize(vec3(g * s, sqrt(max(1.0 - s * s, 0.0)) + 0.06));',
      '  vec3 L = normalize(vec3(-0.34, -0.66, 0.68));',
      '  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));',
      '  float diff = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);',
      '  float nh = max(dot(N, H), 0.0);',
      '  float spec = pow(nh, uShin), spec2 = pow(nh, 10.0);',
      '  float up = clamp(-N.y, 0.0, 1.0);',
      '  float edge = 1.0 - smoothstep(0.0, min(2.6, Rt * 0.42), depth);',
      '  vec3 col;',
      '  if (uMode < 0.5) {',
      '    col = mix(uC0, uC1, smoothstep(0.12, 0.95, diff));',
      '    col += uC2 * (spec * 0.9 + spec2 * 0.22) * uGloss + uC1 * up * 0.07;',
      '    col = mix(col, uEdge, edge * 0.82);',
      '  } else {',
      '    col = mix(uC0, uC1, diff);',
      '    col += uC2 * (spec * 0.85 + spec2 * 0.10) * uGloss + uRim * up * 0.06;',
      '    float rim = (1.0 - smoothstep(0.0, min(3.2, Rt * 0.7), depth)) * smoothstep(-0.2, 0.9, -g.y + 0.35);',
      '    col += uRim * rim * 0.22;',
      '    col = mix(col, vec3(0.0), edge * 0.35);',
      '  }',
      '  if (uTone > 0.5) {',
      '    vec3 ct = vec3(0.010, 0.014, 0.013) + vec3(0.016, 0.026, 0.022) * diff;',
      '    ct += mix(vec3(1.0), uRim, 0.45) * pow(nh, 110.0) * 1.1 * uGloss;',
      '    ct += uRim * pow(nh, 18.0) * 0.06 * uGloss;',
      '    float fl = pow(1.0 - N.z, 2.0) * smoothstep(0.0, 0.8, dot(g, normalize(vec2(0.6, 0.8))));',
      '    ct += uRim * fl * 0.30;',
      '    col = mix(ct, col, 1.0 - smoothstep(1.0, 15.0, db));',
      '  }',
      '  float a = 1.0 - smoothstep(-0.8, 0.8, d);',
      '  float gl = uGlow * exp(-max(d, 0.0) / 7.0) * (1.0 - a) * 0.55;',
      '  float mk = uMask > 0.5 ? smoothstep(-1.4, -0.2, db) : 1.0;',
      '  gl_FragColor = vec4(col * a + uRim * gl, a + gl) * mk;',
      '}'
    ].join('\n');
  }

  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { stats.shaderLog = gl.getShaderInfoLog(s); return null; } return s; }
  function initGL() {
    var mv = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 16;
    MAXSEG = Math.max(0, Math.min(72, Math.floor((mv - 24) / 2)));
    if (MAXSEG < 24) return false;
    segA = new Float32Array(MAXSEG * 4); segR = new Float32Array(MAXSEG * 2); stats.maxSeg = MAXSEG;
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, buildFS(MAXSEG));
    if (!vs || !fs) return false;
    prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes', 'uDpr', 'uBody', 'uRad', 'uK', 'uKs', 'uN', 'uSeg', 'uR', 'uBB', 'uMode', 'uTone', 'uMask', 'uC0', 'uC1', 'uC2', 'uRim', 'uEdge', 'uGloss', 'uShin', 'uGlow'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    return true;
  }

  var btns = [];
  var ptr = null, tnow = 0;
  var raf = 0, last = 0, slowRun = 0;

  function smooth(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function hs(s, n) { var x = Math.sin((s + 1) * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); }
  function marginFull(p) { return clamp(Math.round(p.reach + 40), 60, 460); }
  function marginRest(p) { return p.glow > 0.001 ? 32 : 8; }
  function infl(p) { return p.reach * 1.1; }
  var SUBMAX = 8, ARM_S = 0.1, HOLD_S = 0.35;
  function release(st) { st.mode = 3; st.armed = false; }
  function inRect(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

  function makeBtn(el) {
    var cv = document.createElement('canvas');
    cv.className = 'vb-cv'; cv.setAttribute('aria-hidden', 'true');
    el.classList.add('vb'); el.appendChild(cv);
    var st = { local: true, layer: null, bodyDirty: true, ovRect: null, rect: null, id: el.getAttribute('data-goo-id'), el: el, cv: cv, ctx: cv.getContext('2d'), baseMode: el.getAttribute('data-goo') === 'secondary' ? 1 : 0,
      preview: /^pv/.test(el.getAttribute('data-goo-id') || ''), phase: /pvB/.test(el.getAttribute('data-goo-id') || '') ? 2.4 : 0,
      w: 0, h: 0, r: 8, M: 32, Mfull: 100, mUsed: -1, grow: 0, active: false, visible: true, pts: [], cur: [], gs: [], sd: [], mode: 0, armed: false, cIn: 0, lastPull: 0, prevD: 0, broken: {}, pulls: 0, lmx: undefined, lmy: undefined, nB: 0, p: null, d: null, prox: 0, dist: 0 };
    for (var s = 0; s < NSMAX; s++) {
      var ch = []; for (var k = 0; k < NK; k++) ch.push({ x: 0, y: 0, vx: 0, vy: 0, init: false });
      st.pts.push(ch); st.cur.push(new Float32Array((SUBMAX + 1) * 3)); st.gs.push(0);
      st.sd.push({ len: hs(s, 1), lag: 0.75 + 0.5 * hs(s, 2), thr: 0.22 * hs(s, 3), bend: Math.sin(s * 0.9 + 1.3), up: 0.5 + hs(s, 6), dn: 0.55 + 0.7 * hs(s, 7), sw: 0.7 + 0.6 * hs(s, 8) });
    }
    if ('MutationObserver' in window) new MutationObserver(function () { if (cv.parentNode !== el) el.appendChild(cv); }).observe(el, { childList: true });
    return st;
  }
  function resetNodes(st) { st.pts.forEach(function (c) { c.forEach(function (q) { q.init = false; q.vx = q.vy = 0; }); }); }

  /* Canvas-Rand des Button-Canvas: lokal (Header) wie bisher dynamisch; bei Overlay-Buttons nur Körper (klein, fix) */
  function cvMargin(st) { return st.local ? st.M : marginRest(st.p); }
  function useOverlay(st) { return !!st.layer; }
  function measure(st) {
    var cs = getComputedStyle(st.el), w = st.el.offsetWidth, h = st.el.offsetHeight, r = parseFloat(cs.borderTopLeftRadius) || 8, cm = cvMargin(st);
    if (w === st.w && h === st.h && Math.abs(r - st.r) < 0.5 && st.mUsed === cm) return false;
    st.w = w; st.h = h; st.r = Math.min(r, h / 2); st.mUsed = cm; st.bodyDirty = true;
    var cw = w + 2 * cm, ch = h + 2 * cm;
    st.cv.style.left = -cm + 'px'; st.cv.style.top = -cm + 'px';
    st.cv.style.width = cw + 'px'; st.cv.style.height = ch + 'px';
    st.cv.width = Math.round(cw * dpr); st.cv.height = Math.round(ch * dpr);
    return true;
  }
  function simSize(st) { return [Math.round((st.w + 2 * st.M) * dpr), Math.round((st.h + 2 * st.M) * dpr)]; }
  function ensureGL() {
    var mw = 0, mh = 0;
    btns.forEach(function (b) { mw = Math.max(mw, b.cv.width); mh = Math.max(mh, b.cv.height); if (useOverlay(b) && b.w) { var z = simSize(b); mw = Math.max(mw, z[0]); mh = Math.max(mh, z[1]); } });
    if (glc.width < mw || glc.height < mh) { glc.width = Math.max(glc.width, mw); glc.height = Math.max(glc.height, mh); }
  }
  function glPass(st, M, wpx, hpx, nB, mask) {
    var p = st.p, d = st.d;
    gl.viewport(0, 0, wpx, hpx); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uRes, wpx, hpx); gl.uniform1f(U.uDpr, dpr);
    gl.uniform4f(U.uBody, M + st.w / 2, M + st.h / 2, st.w / 2, st.h / 2);
    gl.uniform1f(U.uRad, st.r);
    gl.uniform1f(U.uK, Math.max(4, st.h * (0.05 + 0.20 * p.anchor)));            /* Verankerung: Hals zwischen Körper und Faden */
    gl.uniform1f(U.uKs, 1.6 + (1 - p.separation) * (1 - p.separation) * 8);      /* Verrundung Faden–Faden / Brücken */
    gl.uniform1i(U.uN, nB); gl.uniform4fv(U.uSeg, segA); gl.uniform2fv(U.uR, segR); gl.uniform4f(U.uBB, bbox[0], bbox[1], bbox[2], bbox[3]);
    gl.uniform1f(U.uMode, d.surf); gl.uniform1f(U.uTone, p.tone === 'dark' ? 1 : 0); gl.uniform1f(U.uMask, mask);
    gl.uniform3fv(U.uC0, d.c0); gl.uniform3fv(U.uC1, d.c1); gl.uniform3fv(U.uC2, d.c2); gl.uniform3fv(U.uRim, d.rim); gl.uniform3fv(U.uEdge, d.edge);
    gl.uniform1f(U.uGloss, p.gloss); gl.uniform1f(U.uShin, 32 + 32 * p.gloss); gl.uniform1f(U.uGlow, p.glow);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    stats.draws = (stats.draws || 0) + 1;
  }
  /* ---- Fadenebenen: fixierte, transparente 2D-Canvas (pointer-events:none).
     Seite: eine Ebene am <body> (z-index 19, über den Abschnitten, unter Header/Menüs/Dialogen).
     Dialog: eine Ebene im ersten abschneidenden Container des Dialogs (z. B. .imp-window), z-index -1. ---- */
  var layers = [];
  function sizeLayer(L) {
    var w = document.documentElement.clientWidth, h = window.innerHeight;
    var W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (W !== L.W || H !== L.H) { L.W = W; L.H = H; L.cv.width = W; L.cv.height = H; L.cv.style.width = w + 'px'; L.cv.style.height = h + 'px'; btns.forEach(function (b) { if (b.layer === L) b.ovRect = null; }); }
  }
  function getLayer(host, inDialog) {
    for (var i = 0; i < layers.length; i++) if (layers[i].host === host) return layers[i];
    var c = document.createElement('canvas'); c.className = inDialog ? 'vg-overlay vg-layer' : 'vg-overlay'; c.setAttribute('aria-hidden', 'true');
    host.appendChild(c);
    var L = { host: host, cv: c, ctx: c.getContext('2d'), W: 0, H: 0, clip: inDialog ? host : null };
    layers.push(L); sizeLayer(L); return L;
  }
  function layerFor(st) {
    if (!CONFIG.global.overlay || st.el.closest('header')) return null;          /* lokal rendern */
    var dlg = st.el.closest('dialog,[role="dialog"]');
    if (!dlg) return getLayer(document.body, false);
    var host = null, n = st.el.parentElement;
    while (n && n !== dlg) { var cs = getComputedStyle(n); if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') { host = n; break; } n = n.parentElement; }
    return getLayer(host || dlg, true);
  }
  function ovSize() { layers.forEach(sizeLayer); }
  function ovClear(st) { var L = st.layer; if (L && st.ovRect) { L.ctx.clearRect(st.ovRect[0], st.ovRect[1], st.ovRect[2], st.ovRect[3]); } st.ovRect = null; }
  function ovClearAll() { layers.forEach(function (L) { L.ctx.clearRect(0, 0, L.W, L.H); }); btns.forEach(function (b) { b.ovRect = null; }); }
  function draw(st) {
    if (!st.d || !st.w || !st.cv.width) return;
    if (!useOverlay(st)) {                                   /* lokal: Körper + Fäden im Button-Canvas (wie V4/V5) */
      glPass(st, st.M, st.cv.width, st.cv.height, st.nB, 0);
      st.ctx.clearRect(0, 0, st.cv.width, st.cv.height);
      st.ctx.drawImage(glc, 0, glc.height - st.cv.height, st.cv.width, st.cv.height, 0, 0, st.cv.width, st.cv.height);
      return;
    }
    if (st.bodyDirty) {                                      /* Körper im Button-Canvas (bleibt hinter dem Text) */
      var cm = cvMargin(st);
      glPass(st, cm, st.cv.width, st.cv.height, 0, 0);
      st.ctx.clearRect(0, 0, st.cv.width, st.cv.height);
      st.ctx.drawImage(glc, 0, glc.height - st.cv.height, st.cv.width, st.cv.height, 0, 0, st.cv.width, st.cv.height);
      st.bodyDirty = false;
    }
    ovClear(st);
    if (st.nB > 0 && st.rect) {                              /* Fäden außerhalb des Körpers in die Overlay-Ebene */
      var z = simSize(st), W = z[0], H = z[1];
      if (glc.width < W || glc.height < H) ensureGL();
      glPass(st, st.M, W, H, st.nB, 1);
      var bx = Math.max(bbox[0], 0), by = Math.max(bbox[1], 0), bx2 = Math.min(bbox[2], st.w + 2 * st.M), by2 = Math.min(bbox[3], st.h + 2 * st.M);
      var sx = Math.floor(bx * dpr), sy = Math.floor(by * dpr), sw = Math.ceil(bx2 * dpr) - sx, shh = Math.ceil(by2 * dpr) - sy;
      if (sw <= 0 || shh <= 0) return;
      var dx = Math.round((st.rect.left - st.M) * dpr) + sx, dy = Math.round((st.rect.top - st.M) * dpr) + sy;
      var L = st.layer, cx2 = L.ctx;
      if (L.clip) { var cr = L.clip.getBoundingClientRect(); cx2.save(); cx2.beginPath(); cx2.rect(Math.round(cr.left * dpr), Math.round(cr.top * dpr), Math.round(cr.width * dpr), Math.round(cr.height * dpr)); cx2.clip(); }
      cx2.drawImage(glc, sx, glc.height - H + sy, sw, shh, dx, dy, sw, shh);
      if (L.clip) cx2.restore();
      st.ovRect = [dx - 1, dy - 1, sw + 2, shh + 2];
    }
  }
  function renderStatic(st) { st.nB = 0; st.bodyDirty = true; draw(st); }
  function toRest(st) {
    if (!useOverlay(st)) {
      var rest = marginRest(st.p);
      if (st.M !== rest) { st.M = rest; resetNodes(st); measure(st); ensureGL(); }
    } else resetNodes(st);
    renderStatic(st);
  }

  /* Simulation. Jeder Strang: Wurzel fest im Körper, Spitze folgt dem (gefächerten) Zeigerpunkt mit weicher, stark gedämpfter Feder;
     innere Knoten folgen der tatsächlichen Spitze (Nachlauf, "Peitscheneffekt") -> gleitende, trägheitsbehaftete Kurven. */
  function step(st, dt0, rect, pp) {
    st.rect = rect;
    var p = st.p, M = st.M;
    var dt = dt0 * p.speed;
    var hx = st.w / 2, hy = st.h / 2, cx = M + hx, cy = M + hy;
    var reach = p.reach, PULLMAX = reach, now = tnow, dxy = -1, inside = false;
    /* V5-Zustaende: 0 Ruhe | 1 Kontakt (Zeiger auf dem Button) | 2 Ziehen (nach Kontakt weggezogen) | 3 Rueckzug */
    if (pp && st.visible && !reduce.matches && !paused) {
      var pmx = pp.x - (rect.left - M), pmy = pp.y - (rect.top - M);
      inside = pp.x >= rect.left && pp.x <= rect.right && pp.y >= rect.top && pp.y <= rect.bottom;
      var ddx = Math.max(Math.abs(pmx - cx) - hx, 0), ddy = Math.max(Math.abs(pmy - cy) - hy, 0);
      dxy = Math.hypot(ddx, ddy);
      if (inside) { if (st.mode !== 1) { st.mode = 1; st.cIn = now; } if (now - st.cIn >= ARM_S) st.armed = true; }
      else if (st.mode === 1) {
        if (st.armed || now - st.cIn >= ARM_S) { st.mode = 2; st.lastPull = now; st.prevD = 0; st.broken = {}; st.pulls++; }
        else { st.mode = 0; st.armed = false; }                 /* nur durchgerauscht: kein Ziehen */
      }
      if (st.mode === 2) {
        st.lmx = pmx; st.lmy = pmy;
        if (dxy > st.prevD + 0.4) { st.lastPull = now; st.prevD = dxy; } else if (dxy < st.prevD) st.prevD = dxy;
        if (dxy > PULLMAX || now - st.lastPull > HOLD_S) release(st);   /* Ziehbereich verlassen oder Zeiger steht / geht zurueck */
      }
    } else if (st.mode === 1) { st.mode = 0; st.armed = false; }
    else if (st.mode === 2) release(st);
    st.dist = dxy;
    var mx = st.lmx, my = st.lmy;
    if (mx === undefined) { mx = cx; my = cy - 1; }
    var retr = p.retract * (1.25 - 0.5 * p.stickiness);
    var NS = p.strands, NM = p.minor, NT = NS + NM, gmax = 0, s, k, j, mainS = Math.floor(NS / 2), pulling = 0;
    for (s = 0; s < NT; s++) {
      var sd = st.sd[s];
      var brk = s === mainS ? 1 : Math.min(s < NS ? 1 : 0.85, (s < NS ? 0.5 + 0.5 * sd.len : 0.35 + 0.4 * sd.len) * (0.55 + 0.45 * p.reaction));
      if (st.mode === 2 && !st.broken[s] && dxy > PULLMAX * brk) st.broken[s] = true;      /* Nebenstrang reisst ab */
      var tg0 = (st.mode === 2 && !st.broken[s]) ? 1 : 0;
      if (tg0) pulling++;
      st.gs[s] += (tg0 - st.gs[s]) * (1 - Math.exp(-dt * (tg0 > st.gs[s] ? 14 * sd.up : retr * sd.dn)));
      if (st.gs[s] < 0.003 && tg0 === 0) st.gs[s] = 0;
      if (st.gs[s] > gmax) gmax = st.gs[s];
    }
    if (st.mode === 2 && !pulling) release(st);
    for (s = NT; s < NSMAX; s++) st.gs[s] = 0;
    st.grow = gmax;

    var vx = mx - cx, vy = my - cy, len = Math.hypot(vx, vy) || 1, dx = vx / len, dy = vy / len;
    var tx = Math.abs(dx) < 1e-4 ? 1e9 : hx / Math.abs(dx), ty = Math.abs(dy) < 1e-4 ? 1e9 : hy / Math.abs(dy), te = Math.min(tx, ty);
    var ex = cx + dx * (te - hy * 0.55), ey = cy + dy * (te - hy * 0.55), px = -dy, py = dx;
    var edgeDist = Math.max(len - te, 0);
    var mid = (NS - 1) / 2, edgeLim = Math.min((te === tx) ? hy : hx, 130) * 0.88, span = 2 * edgeLim * (0.6 + 0.4 * p.separation), stepOff = NS > 1 ? span / (NS - 1) : 0;
    var k0 = 0.1 + 0.45 * p.separation;          /* Spitzen laufen am Zeiger zusammen */
    var kb = p.elasticity * 0.5, cc = p.damping, grav = p.gravity, kIn = 2.3 - 1.6 * (p.viscosity - 4) / 24;
    var maxV = 0, h3 = dt / 3, nSeg = 0, TH = p.thickness * (0.85 + 0.3 * p.stickiness);
    var sub = Math.max(4, Math.min(SUBMAX, Math.floor((MAXSEG - 14) / NT)));
    var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    function ext(x, y) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    var lim = { f: 0, max: 0 };
    function integrate(q, tgx, tgy, kk) {
      if (!q.init) { q.x = tgx; q.y = tgy; q.vx = 0; q.vy = 0; q.init = true; }
      for (var sub3 = 0; sub3 < 3; sub3++) {
        q.vx += (kk * (tgx - q.x) - cc * q.vx) * h3;
        q.vy += (kk * (tgy - q.y) - cc * q.vy + grav * lim.f) * h3;
        q.x += q.vx * h3; q.y += q.vy * h3;
      }
      var ex2 = tgx - q.x, ey2 = tgy - q.y, dd = Math.hypot(ex2, ey2);
      if (dd > lim.max) { q.x = tgx - ex2 / dd * lim.max; q.y = tgy - ey2 / dd * lim.max; }      /* Maximale Dehnung */
      maxV = Math.max(maxV, Math.abs(q.vx) + Math.abs(q.vy));
    }
    for (s = 0; s < NT; s++) {
      var sd2 = st.sd[s], gs = st.gs[s], chain = st.pts[s], cur = st.cur[s], minorS = s >= NS;
      var thF = minorS ? 0.5 : 1, R0u = TH * 1.3 * thF, R1u = TH * 0.36 * thF;
      var off = (minorS ? (Math.floor((s - NS + 0.5) * Math.max(NS - 1, 1) / Math.max(NM, 1)) + 0.5 - mid) : (s - mid)) * stepOff, rx = clamp(ex + px * off, M + 4, M + st.w - 4), ry = clamp(ey + py * off, M + 4, M + st.h - 4);   /* Wurzel immer im Koerper */
      var aimx = mx + px * off * k0, aimy = my + py * off * k0, avx = aimx - rx, avy = aimy - ry, avl = Math.hypot(avx, avy) || 1;
      var sdx = avx / avl, sdy = avy / avl, spx = -sdy, spy = sdx;
      var lf = Math.min(1, gs * 1.15), Ls = Math.min(avl, reach + hy) * lf;      /* Strang reicht bis zum Zeiger */
      var swy = Math.sin(tnow * 1.15 * p.speed + s * 0.8 + sd2.sw * 2.0) * (3 + Ls * 0.07) * sd2.sw * lf * (st.mode === 2 ? 0.35 : 1);     /* langsames, weiches Pendeln */
      var bendOff = sd2.bend * Ls * 0.10;
      var tipx = rx + sdx * Ls, tipy = ry + sdy * Ls, kS = kb * sd2.lag;
      lim.max = p.stretch * (0.22 * Ls + 6);
      chain[0].x = rx; chain[0].y = ry; chain[0].vx = chain[0].vy = 0; chain[0].init = true;       /* Wurzel sitzt fest im Körper */
      if (gs === 0) { for (k = 1; k < NK; k++) { chain[k].x = rx; chain[k].y = ry; chain[k].vx = chain[k].vy = 0; chain[k].init = true; } continue; }   /* unsichtbarer Strang: ruht ohne Physik */
      lim.f = 1; integrate(chain[4], tipx + spx * (swy + bendOff * 0.3), tipy + spy * (swy + bendOff * 0.3), kS * 0.9);
      var tipN = chain[4];
      for (k = 3; k >= 1; k--) {
        var f = FR[k], lat = swy * f * f + bendOff * Math.sin(Math.PI * f);
        lim.f = f;
        integrate(chain[k], rx + (tipN.x - rx) * f + spx * lat, ry + (tipN.y - ry) * f + spy * lat, kS * kIn);
      }
      /* glatte Kurve (Catmull-Rom) durch die 5 Knoten, unterteilt in `sub` Kapseln, Radius verjüngt mit kleiner Tropfenspitze */
      var sc = smooth(0, 0.5, gs);
      for (j = 0; j <= sub; j++) {
        var g4 = 4 * j / sub, i = Math.min(3, Math.floor(g4)), t = g4 - i, t2 = t * t, t3 = t2 * t;
        var q0 = chain[Math.max(i - 1, 0)], q1 = chain[i], q2 = chain[i + 1], q3 = chain[Math.min(i + 2, 4)];
        var cxp = 0.5 * (2 * q1.x + (-q0.x + q2.x) * t + (2 * q0.x - 5 * q1.x + 4 * q2.x - q3.x) * t2 + (-q0.x + 3 * q1.x - 3 * q2.x + q3.x) * t3);
        var cyp = 0.5 * (2 * q1.y + (-q0.y + q2.y) * t + (2 * q0.y - 5 * q1.y + 4 * q2.y - q3.y) * t2 + (-q0.y + 3 * q1.y - 3 * q2.y + q3.y) * t3);
        var u = j / sub, rr = (R0u + (R1u - R0u) * Math.pow(u, 0.7) + TH * 0.3 * thF * smooth(0.78, 1, u)) * sc * (1 + p.anchor * 0.9 * (1 - smooth(0, 0.22, u)));
        cur[j * 3] = cxp; cur[j * 3 + 1] = cyp; cur[j * 3 + 2] = Math.max(0.5, rr);
      }
      if (gs > 0.02) {
        for (j = 0; j < sub && nSeg < MAXSEG; j++) {
          var o4 = nSeg * 4, o2 = nSeg * 2;
          segA[o4] = cur[j * 3]; segA[o4 + 1] = cur[j * 3 + 1]; segA[o4 + 2] = cur[j * 3 + 3]; segA[o4 + 3] = cur[j * 3 + 4];
          segR[o2] = cur[j * 3 + 2]; segR[o2 + 1] = cur[j * 3 + 5]; nSeg++;
          ext(cur[j * 3], cur[j * 3 + 1]);
        }
        ext(cur[sub * 3], cur[sub * 3 + 1]);
      }
    }
    /* kleine organische Brücken zwischen benachbarten Strängen */
    if (p.bridge > 0) for (s = 0; s < NS - 1; s++) {
      var gb = Math.min(st.gs[s], st.gs[s + 1]);
      if (gb < 0.35 || hs(s, 13) > p.bridge * 1.1 || nSeg + 2 > MAXSEG) continue;
      var ib = Math.round(sub * (0.28 + 0.27 * hs(s, 14))), ca = st.cur[s], cb = st.cur[s + 1];
      var ax = ca[ib * 3], ay = ca[ib * 3 + 1], bxp = cb[ib * 3], byp = cb[ib * 3 + 1], dd2 = Math.hypot(bxp - ax, byp - ay);
      if (dd2 > 90) continue;
      var bgw = smooth(0.35, 0.8, gb), rb = 0.55 * Math.min(ca[ib * 3 + 2], cb[ib * 3 + 2]) * bgw + 0.4;
      var mxp = (ax + bxp) / 2 + dx * dd2 * 0.18, myp = (ay + byp) / 2 + dy * dd2 * 0.18;
      var ob = nSeg * 4, ob2 = nSeg * 2;
      segA[ob] = ax; segA[ob + 1] = ay; segA[ob + 2] = mxp; segA[ob + 3] = myp; segR[ob2] = rb; segR[ob2 + 1] = rb * 0.8; nSeg++;
      ob += 4; ob2 += 2;
      segA[ob] = mxp; segA[ob + 1] = myp; segA[ob + 2] = bxp; segA[ob + 3] = byp; segR[ob2] = rb * 0.8; segR[ob2 + 1] = rb; nSeg++;
      ext(mxp, myp);
    }
    var was = st.active;
    st.active = gmax > 0 || maxV > 0.6;
    if (!st.active && st.mode === 3) st.mode = 0;
    if (!st.active && was) { toRest(st); return; }
    if (!st.active) { if (st.mode === 0 && !useOverlay(st) && st.M !== marginRest(p)) toRest(st); return; }
    st.nB = nSeg;
    var pad = TH * 3 + 14 + (p.glow > 0.001 ? 30 : 0);
    bbox[0] = bx0 - pad; bbox[1] = by0 - pad; bbox[2] = bx1 + pad; bbox[3] = by1 + pad;
    draw(st);
  }

  /* Loop nur bei Bedarf: kein Zeiger in der Nähe + keine aktiven Stränge -> kein weiterer Frame */
  function schedule() { if (!raf && engineOn && !lost && !document.hidden && !paused) { stats.running = true; last = performance.now(); raf = requestAnimationFrame(loop); } }

  function autoOn() { return CONFIG.global.autoplay && !reduce.matches && !paused; }
  function pointerFor(st, rect, now) {
    /* Autoplay (nur Vorschau): simulierter Kontakt -> Wegziehen -> Stillstand -> Rueckzug */
    if (st.preview && autoOn() && !(ptr && (inRect(rect, ptr.x, ptr.y) || st.mode === 2))) {
      var P = 3.4 / st.p.speed, t = (now / 1000 + st.phase) / P, cyc = Math.floor(t), u = t - cyc;
      var ang = Math.PI * (0.15 + 0.7 * ((cyc * 0.37 + st.phase) % 1)), R = Math.min(st.p.reach * 0.8, 180);
      var bx = rect.left + rect.width / 2, by = rect.top + rect.height / 2, ex = Math.cos(ang) * (rect.width / 2 + R), ey = -Math.abs(Math.sin(ang)) * (rect.height / 2 + R);
      var k = u < 0.22 ? 0 : (u < 0.7 ? smooth(0.22, 0.7, u) : 1);
      return { x: bx + ex * k, y: by + ey * k, virt: true };
    }
    return ptr;
  }

  function loop(now) {
    raf = 0;
    if (paused) { stats.running = false; return; }
    var raw = now - last, dt = Math.min(0.033, raw / 1000); last = now; tnow = now / 1000;
    var t0 = performance.now(), any = false, act = 0;
    ovClearAll();
    for (var i = 0; i < btns.length; i++) {
      var st = btns[i]; if (!st.visible && !st.active && !st.mode) continue;
      var rect = st.el.getBoundingClientRect();
      if (!rect.width && !rect.height) {                            /* ausgeblendet (z. B. Dialog geschlossen): Zustand verwerfen */
        if (st.active || st.mode) { st.mode = 0; st.armed = false; st.active = false; st.gs.fill(0); st.grow = 0; st.nB = 0; resetNodes(st); ovClear(st); }
        continue;
      }
      var pp = pointerFor(st, rect, now);
      var inside = !!pp && inRect(rect, pp.x, pp.y), auto = st.preview && autoOn();
      if (!st.active && !st.mode && !inside && !auto) continue;     /* keine Fernwirkung: nur Kontakt startet */
      if (st.M !== st.Mfull) { st.M = st.Mfull; resetNodes(st); }
      if (measure(st)) { ensureGL(); renderStatic(st); }
      step(st, dt, rect, pp);
      if (st.active) act++;
      if (st.active || st.mode === 2 || st.mode === 3 || auto || (st.mode === 1 && !st.armed)) any = true;
    }
    var ms = performance.now() - t0;
    stats.frames++; stats.active = act; stats.avgMs = stats.avgMs * 0.9 + ms * 0.1;
    if (act && !FORCE) { if (raw > 45) slowRun++; else slowRun = Math.max(0, slowRun - 2); if (slowRun > 40) { stats.slow = slowRun; disable('slow'); return; } } else slowRun = 0;
    if (any) schedule(); else stats.running = false;
  }

  /* ---------- Start der Engine ---------- */
  function startEngine() {
    if (/[?&]goo=off/.test(qs)) return disable('param');
    if (!hoverOK.matches) return disable('touch');
    if (!FORCE && ((navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) || (navigator.deviceMemory && navigator.deviceMemory <= 2))) return disable('weak-device');
    glc = document.createElement('canvas');
    try { gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'low-power' }); } catch (e) {}
    if (!gl) return disable('no-webgl');
    loseExt = gl.getExtension('WEBGL_lose_context');
    if (!initGL()) return disable('shader');
    btns = nodes.map(makeBtn);
    btns.forEach(function (st) { st.layer = layerFor(st); st.local = !st.layer; });
    btns.forEach(function (st) { st.p = resolve(st.id); st.d = derive(st.p, st.baseMode); st.Mfull = marginFull(st.p); st.M = useOverlay(st) ? st.Mfull : marginRest(st.p); measure(st); });
    ensureGL();
    btns.forEach(function (st) { renderStatic(st); st.el.classList.add('vb-ready'); st.el.style.setProperty('color', st.d.text, 'important'); });
    engineOn = true;
    stats.state = reduce.matches ? 'static' : 'on'; stats.reason = reduce.matches ? 'reduced-motion' : 'WebGL'; say();

    /* Zeigerbewegung weckt den Loop nur, wenn ein Button beruehrt wird oder bereits aktiv ist (keine Fernanziehung) */
    function needFrame(q) { for (var i = 0; i < btns.length; i++) { var b = btns[i]; if (b.mode || b.active) return true; if (b.visible && b.w && inRect(b.el.getBoundingClientRect(), q.x, q.y)) return true; } return false; }
    window.addEventListener('pointermove', function (e) { if (e.pointerType === 'touch' || reduce.matches) return; ptr = { x: e.clientX, y: e.clientY }; stats.ptr = ptr.x + ',' + ptr.y; if (needFrame(ptr)) schedule(); }, { passive: true });
    document.documentElement.addEventListener('pointerleave', function () { ptr = null; schedule(); });
    window.addEventListener('blur', function () { ptr = null; schedule(); });
    document.addEventListener('scroll', function () { if (btns.some(function (b) { return b.active || b.mode; })) schedule(); }, { passive: true, capture: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stats.running = false; else schedule(); });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { es.forEach(function (en) { btns.forEach(function (b) { if (b.el === en.target) b.visible = en.isIntersecting; }); }); schedule(); }, { rootMargin: '170px' });
      btns.forEach(function (b) { io.observe(b.el); });
    }
    function refreshAll() { var ch = false; btns.forEach(function (b) { if (measure(b)) ch = true; }); if (ch) { ensureGL(); btns.forEach(function (b) { if (!b.active) renderStatic(b); }); } }
    if ('ResizeObserver' in window) { var ro = new ResizeObserver(refreshAll); btns.forEach(function (b) { ro.observe(b.el); }); }
    window.addEventListener('resize', function () { ovSize(); refreshAll(); schedule(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refreshAll);
    window.addEventListener('load', refreshAll);
    setTimeout(refreshAll, 400);

    glc.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); lost = true; stats.running = false; ovClearAll();
      btns.forEach(function (b) { b.cv.style.display = 'none'; b.el.classList.remove('vb-ready'); b.el.style.removeProperty('color'); });
      stats.state = 'lost'; say();
    });
    glc.addEventListener('webglcontextrestored', function () {
      if (!initGL()) return disable('shader');
      lost = false; ensureGL();
      btns.forEach(function (b) { b.cv.style.display = ''; b.active = false; b.mode = 0; b.grow = 0; b.gs.fill(0); b.mUsed = -1; measure(b); renderStatic(b); b.el.classList.add('vb-ready'); b.el.style.setProperty('color', b.d.text, 'important'); });
      stats.state = reduce.matches ? 'static' : 'on'; say();
    });
    if (reduce.addEventListener) reduce.addEventListener('change', function () {
      stats.state = reduce.matches ? 'static' : 'on'; say();
      if (reduce.matches) { btns.forEach(function (b) { b.grow = 0; b.active = false; renderStatic(b); }); }
    });
    stats.loseContext = function () { if (loseExt) loseExt.loseContext(); return !!loseExt; };
    stats.restoreContext = function () { if (loseExt) loseExt.restoreContext(); return !!loseExt; };
    stats.dump = function () {
      return btns.map(function (b) { var mv = 0; b.pts.forEach(function (c) { c.forEach(function (q) { mv = Math.max(mv, Math.abs(q.vx) + Math.abs(q.vy)); }); });
        return { id: b.id, grow: +b.grow.toFixed(4), active: b.active, nB: b.nB, maxV: +mv.toFixed(3), M: b.M, text: b.d && b.d.text, surf: b.d && b.d.surf, mode: b.mode, armed: b.armed, pulls: b.pulls, dist: Math.round(b.dist), local: b.local, layer: b.layer ? (b.layer.clip ? 'dialog' : 'page') : 'local', ovRect: b.ovRect }; });
    };
    /* Test-Hook: Knotenpositionen (für Schwerkraft-/Elastizitätsmessungen) */
    stats.nodes = function (id) { var b = btns.filter(function (x) { return x.id === id; })[0]; return b ? b.pts.map(function (c) { return c.map(function (q) { return [+q.x.toFixed(1), +q.y.toFixed(1)]; }); }) : null; };
  }


  window.VenomGoo = {
    config: CONFIG, stats: stats, resolve: resolve,
    loseContext: function () { return stats.loseContext ? stats.loseContext() : false; },
    restoreContext: function () { return stats.restoreContext ? stats.restoreContext() : false; },
    dump: function () { return stats.dump ? stats.dump() : []; },
    nodes: function (id) { return stats.nodes ? stats.nodes(id) : null; }
  };
  if (!nodes.length) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startEngine); else startEngine();
})();
