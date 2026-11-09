/*!
 * FlipArt86 Cinematic Hero – WebGL2-Renderer (Prototyp V1.1 – Cinematic Depth)
 *
 * Zwei Looks im selben Renderer:
 *   look 'v10' – exakt der gesicherte V1.0-Shaderpfad (Referenz/Vergleich)
 *   look 'v11' – Cinematic Depth: Tiefenebenen, Randlicht, Glanz auf Graten,
 *                Nebel zwischen den Schaedeln, kleinere Laserimpulse, PC ohne Ueberstrahlung
 *
 * Ein einziger Fullscreen-Pass rendert das UNVERAENDERTE Original plus
 * vier maskierte Effektebenen:
 *   1. Skull Awakening  – Relighting ueber Pseudo-Normalen (aus Luminanz),
 *                         wandernde Lichtpools, Sweep-Baender, Hervortreten/Zuruecksinken
 *   2. Volumetric Fog   – 3 periodische fBm-Schichten, nahtlos, Streulicht aus dem Bild
 *   3. Laser Pulse      – Kometenimpulse entlang der real nachgezeichneten Laserpfade
 *   4. RGB Pulse        – PC-Beleuchtung atmet, Lichtumlauf auf den Luefterringen
 * Alle zeitabhaengigen Werte werden in JS berechnet und als Uniforms uebergeben;
 * getState() liefert exakt diese Werte (fuer Diagnose und Tests).
 */
(function () {
  'use strict';

  var SD = window.SCENE_DATA;
  var TAU = Math.PI * 2;
  var IMG_W = SD.image.width, IMG_H = SD.image.height;
  var MAX_SK = 12;

  var PRESETS = {
    subtle:    { skull: 0.35, fog: 0.15, laser: 0.20, rgb: 0.20, parallax: 0.00, speed: 1.0 },
    cinematic: { skull: 0.75, fog: 0.25, laser: 0.40, rgb: 0.25, parallax: 0.15, speed: 0.8 },
    intense:   { skull: 0.90, fog: 0.55, laser: 0.75, rgb: 0.60, parallax: 0.35, speed: 1.0 },
    flipart86V11: { skull: 0.75, fog: 0.25, laser: 0.40, rgb: 0.25, parallax: 0.15, speed: 0.8 }
  };
  // Presets, die zusaetzlich einen Look festlegen (die anderen behalten den aktuellen Look)
  var PRESET_LOOK = { flipart86V11: 'v11' };
  var PRESET_LABEL = { subtle: 'Subtle', cinematic: 'Cinematic', intense: 'Intense', flipart86V11: 'FlipArt86 Cinematic V1.1' };
  var DEFAULT_PRESET = 'flipart86V11';
  var DEFAULT_LOOK = 'v11';
  // Interne Effektkurve V1.1 (Slider-Wert -> Shader-Staerke), visuell abgestimmt
  var CURVE_V11 = { skull: 1.0, fog: 1.0, laser: 1.0, rgb: 1.3 };   // RGB: Rolloff + Kernschutz erlauben mehr Pulsweite ohne Ueberstrahlung
  var CYCLE = 16; // Sekunden: kompletter Cinematic-Zyklus (Skull/Laser/RGB laufen darin exakt periodisch)

  // Pro Schaedel: [Phase im 16-s-Zyklus, Umlaufrichtung Licht, Sweep-Winkel (Grad), Gewicht]
  // IDs = Reihenfolge in tools/build_maps.py (1 = hinterster ... 11 = S2 Vordergrund)
  var SKULL_CFG = {
    1:  [0.75,  1, 40, 0.8],  // S10 links Hintergrund
    2:  [0.42, -1, 55, 0.7],  // S11 links oben Hintergrund
    3:  [0.92,  1, 35, 0.8],  // S8a rechts Hintergrund
    4:  [0.58, -1, 50, 0.8],  // S8b rechts unten Hintergrund
    5:  [0.26,  1, 30, 0.9],  // S5 oben rechts
    6:  [0.84, -1, 45, 0.9],  // S6 Mitte rechts
    7:  [0.50,  1, 60, 0.9],  // S4 oben Mitte
    8:  [0.17, -1, 38, 0.95], // S7 unten Mitte
    9:  [0.67,  1, 42, 1.0],  // S1 oben links
    10: [0.34, -1, 33, 1.0],  // S3 oben Mitte gross
    11: [0.00,  1, 48, 1.0]   // S2 Vordergrund
  };

  // V1.1-Choreografie: [Phase, Umlaufrichtung]. 11 gleich verteilte Phasen (1/11 Zyklus),
  // Reihenfolge wechselt vorne -> Mitte -> hinten. Ergebnis (simuliert + getestet, T16):
  // max. 3 Schaedel gleichzeitig > 80 %, nie zwei Vordergrundschaedel zugleich, Hoehepunkte >= 1,45 s auseinander.
  var SKULL_ORDER_V11 = [11, 8, 3, 10, 6, 1, 9, 7, 4, 5, 2];
  var SKULL_CFG_V11 = {};
  SKULL_ORDER_V11.forEach(function (id, i) { SKULL_CFG_V11[id] = [i / 11, i % 2 ? -1 : 1]; });
  function envV11(u) {            // langsamer Anstieg (35 %), laengeres Abklingen (45 %), Ruhe (20 %)
    var x;
    if (u < 0.35) { x = u / 0.35; return x * x * (3 - 2 * x); }
    if (u < 0.8) { x = (u - 0.35) / 0.45; return 1 - x * x * (3 - 2 * x); }
    return 0;
  }
  var FOG_BREATH_T = [32, 48, 24]; // sanfte Dichteaenderung je Nebelebene (s)

  // Nebelschichten: Skalierung, Periode (Rauscheinheiten), Loop-Dauer (s), Tiefe (Parallaxe)
  var FOG = [
    { scale: 1.5, per: 6,  T: 56, depth: 0.25 },
    { scale: 2.4, per: 8,  T: 36, depth: 0.55 },
    { scale: 3.8, per: 12, T: 22, depth: 1.00 }
  ];

  var LASER_T = [8, 8, 16];          // L1, L2, L3+L4 (durchgehender Pfad hinter dem PC)
  var LASER_PHASE = [0.0, 0.4, 0.15];
  var L3_GAP = 507;                  // px Weg hinter dem PC (L3-Ende x=1028 -> L4-Start x=1535)

  // ------------------------------------------------------------------ Shader
  var VS = '#version 300 es\n' +
    'void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));' +
    ' gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';

  var FS = [
    '#version 300 es',
    'precision highp float; precision highp int;',
    'uniform sampler2D uImg, uFx, uRelief, uLaser, uDetail;',
    'uniform vec2 uRes, uImgSize, uFocus;',
    'uniform float uSkullAmt, uFogAmt, uLaserAmt, uRgbAmt, uFogPhase;',
    'uniform int uBefore, uFogOct, uLook;',
    'uniform vec3 uFogBr;',
    'uniform float uRgbPhase, uGlintX;',
    'uniform vec4 uSkA[12]; uniform vec4 uSkB[12]; uniform vec4 uSkC[12];',
    'uniform vec4 uFogL[3];',
    'uniform vec4 uLas[4];',
    'uniform vec4 uFan[6]; uniform float uFanAng[6];',
    'uniform vec4 uRgb;',
    'out vec4 outColor;',
    'const float PI = 3.14159265;',
    'float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
    'float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    // periodisches Value-Noise (Periode per in x) -> nahtlose Nebel-Loops
    'float vnoise(vec2 p, float per){',
    '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);',
    '  float a = hash(vec2(x0, i.y)), b = hash(vec2(x1, i.y));',
    '  float c = hash(vec2(x0, i.y + 1.0)), d = hash(vec2(x1, i.y + 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }',
    'float fbm(vec2 p, float per){',
    '  float v = 0.0, a = 0.5, n = 0.0;',
    '  for (int o = 0; o < 5; o++){ if (o >= uFogOct) break; v += a * vnoise(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }',
    '  return v / n; }',
    'float pulseShape(float d){',          // d in px entlang des Lasers, + = vor dem Kopf
    '  float head = exp(-d * d / 800.0);',
    '  float tail = d < 0.0 ? 0.55 * exp(d / 150.0) : 0.0;',
    '  return max(head, tail); }',
    'void main(){',
    '  float sc = max(uRes.x / uImgSize.x, uRes.y / uImgSize.y);',
    '  vec2 disp = uImgSize * sc;',
    '  vec2 off = (uRes - disp) * uFocus;',
    '  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
    '  vec2 uv = clamp((p - off) / disp, 0.0, 1.0);',
    '  vec3 base = texture(uImg, uv).rgb;',
    '  if (uBefore == 1) { outColor = vec4(base, 1.0); return; }',
    '  vec3 col = base;',
    '  float lum = luma(base);',
    '  vec2 px = uv * uImgSize;',
    '  ivec2 ip = clamp(ivec2(px), ivec2(0), ivec2(uImgSize) - 1);',
    '  vec3 fx = texture(uFx, uv).rgb;',
    '  float greenness = base.g - 0.6 * max(base.r, base.b);',
    '  if (uLook == 0) {',                 // ===== V1.0-Look (unveraendert) =====
    // ---------------- 1. Skull Awakening
    '  if (uSkullAmt > 0.0 && fx.r > 0.002) {',
    '    int id = int(texelFetch(uRelief, ip, 0).b * 255.0 / 16.0 + 0.5);',
    '    if (id > 0 && id <= 12) {',
    '      vec4 A = uSkA[id - 1]; vec4 B = uSkB[id - 1]; vec4 C = uSkC[id - 1];',
    '      vec2 nr = texture(uRelief, uv).rg * 2.0 - 1.0;',
    '      vec3 N = vec3(nr, sqrt(max(1.0 - dot(nr, nr), 0.0)));',
    '      vec2 local = (px - A.xy) / A.z;',
    '      vec2 dl = local - B.yz;',
    '      vec3 Lv = normalize(vec3(-dl, 0.85));',
    '      float relief = clamp(dot(N, Lv) - Lv.z, -0.06, 0.45);',   // reiner Relief-Anteil (flach = 0), Schatten begrenzt
    '      vec3 Hh = normalize(Lv + vec3(0.0, 0.0, 1.0));',
    '      float spec = pow(max(dot(N, Hh), 0.0), mix(40.0, 14.0, A.w));',
    '      float pool = exp(-dot(dl, dl) / 0.30);',
    '      float sweep = exp(-pow((dot(local, C.xy) - B.w) / 0.38, 2.0));',
    '      float gate = smoothstep(0.035, 0.19, lum);',                // Augenhoehlen/Schatten bleiben dunkel
    '      float hiGate = smoothstep(0.09, 0.40, lum);',
    '      float e = B.x;',
    '      float depthK = 1.0 - 0.55 * A.w;',
    '      float k = uSkullAmt * fx.r * C.z;',
    '      float boost = depthK * (e * (1.15 * pool + 0.45 * sweep) + relief * 1.5 * (0.25 + 0.75 * e) + spec * (0.3 + 0.7 * pool) * 0.8 * e);',
    '      float dim = (1.0 - e) * 0.30 * (0.55 + 0.45 * A.w);',
    '      col *= max(1.0 + k * gate * boost, 0.0) * (1.0 - k * dim);',
    '      col += k * hiGate * depthK * e * (spec * (0.3 + 0.7 * pool) * 0.6 + pool * 0.22 + sweep * 0.08) * vec3(0.55, 1.0, 0.62) * lum;',
    '    }',
    '  }',
    // ---------------- 3. Laser Pulse
    '  if (uLaserAmt > 0.0) {',
    '    float band = texture(uLaser, uv).b;',
    '    if (band > 0.003) {',
    '      vec3 lt = texelFetch(uLaser, ip, 0).rgb;',
    '      float v = (floor(lt.r * 255.0 + 0.5) * 256.0 + floor(lt.g * 255.0 + 0.5)) / 65535.0 * 4.0;',
    '      int lid = int(floor(v));',
    '      float s = fract(v);',
    '      if (lid >= 0 && lid < 4) {',
    '        vec4 P = uLas[lid];',
    '        float pls = max(pulseShape((s - P.x) * P.w), pulseShape((s - P.y) * P.w));',
    '        float core = smoothstep(0.03, 0.28, greenness);',
    '        col += uLaserAmt * (pls * (base * core * band * 2.4 + vec3(0.42, 1.0, 0.58) * band * band * 0.22)',
    '                            + P.z * 0.35 * base * core * band);',
    '      }',
    '    }',
    '  }',
    // ---------------- 4. RGB Pulse
    '  if (uRgbAmt > 0.0 && fx.g > 0.002) {',
    '    float gness = smoothstep(0.05, 0.32, greenness);',
    '    float floorK = smoothstep(0.77, 0.83, uv.y);',
    '    float pulse = mix(uRgb.x, uRgb.y, floorK);',
    '    float fanHl = 0.0;',
    '    for (int k = 0; k < 6; k++) {',
    '      vec4 F = uFan[k];',
    '      vec2 e = (px - F.xy) / F.zw;',
    '      float r = length(e);',
    '      if (r < 1.4) {',
    '        float ring = smoothstep(1.35, 1.0, r) * smoothstep(0.35, 0.75, r);',
    '        float da = abs(mod(atan(e.y, e.x) - uFanAng[k] + PI, 2.0 * PI) - PI);',
    '        fanHl += ring * exp(-da * da / 0.30);',
    '      }',
    '    }',
    '    float k = uRgbAmt * fx.g * gness;',
    '    col *= 1.0 + k * (0.55 * pulse + 1.1 * fanHl);',
    '    col += k * vec3(0.0, 0.10, 0.30) * base.g * uRgb.z;',
    '  }',
    // ---------------- 2. Volumetric Fog (liegt vor allem)
    '  if (uFogAmt > 0.0) {',
    '    vec2 q0 = vec2(uv.x * uImgSize.x / uImgSize.y, uv.y);',
    '    float dens = 0.0;',
    '    for (int k = 0; k < 3; k++) {',
    '      vec4 L = uFogL[k];',
    '      vec2 q = q0 * L.z + L.xy;',
    '      q.y += 0.16 * sin(q.x * 2.0 * PI * 2.0 / L.w + uFogPhase + float(k) * 2.1);',
    '      float n = fbm(q, L.w);',
    '      float prof = k == 0 ? (0.35 + 0.65 * smoothstep(0.15, 0.85, uv.y))',
    '                 : (k == 1 ? exp(-pow((uv.y - 0.74) / 0.2, 2.0)) + 0.25 : smoothstep(0.3, 1.0, uv.y) * 0.9 + 0.1);',
    '      float w = k == 0 ? 0.55 : (k == 1 ? 0.5 : 0.35);',
    '      dens += w * smoothstep(0.44, 0.74, n) * prof;',
    '    }',
    '    vec3 scat = textureLod(uImg, uv, 5.0).rgb;',
    '    vec3 fogCol = vec3(0.025, 0.11, 0.06) + scat * vec3(0.55, 1.35, 0.75) * 1.35;',   // eigenes gruenes Streulicht
    '    float f = clamp(dens * uFogAmt * 2.3, 0.0, 0.85) * mix(0.35, 1.0, fx.b);',
    '    col = mix(col, fogCol, f * 0.7) + fogCol * f * 0.45;',
    '  }',
    '  } else {',                             // ===== V1.1 Cinematic Depth =====
    '  vec3 dt = texture(uDetail, uv).rgb;',   // R Grat/Glanz, G Abstand zur Silhouette (px/10), B atmosph. Tiefe
    // ---------------- 1. Skull Lighting V1.1
    '  if (uSkullAmt > 0.0 && fx.r > 0.002) {',
    '    int id = int(texelFetch(uRelief, ip, 0).b * 255.0 / 16.0 + 0.5);',
    '    if (id > 0 && id <= 12) {',
    '      vec4 A = uSkA[id - 1]; vec4 B = uSkB[id - 1];',
    '      float depth = A.w;',
    '      float front = 1.0 - smoothstep(0.2, 0.55, depth);',          // Vordergrund
    '      float back = smoothstep(0.7, 0.9, depth);',                   // Hintergrund
    '      float midL = clamp(1.0 - front - back, 0.0, 1.0);',           // mittlere Ebene
    '      vec2 nr = texture(uRelief, uv).rg * 2.0 - 1.0;',
    '      vec3 N = vec3(nr, sqrt(max(1.0 - dot(nr, nr), 0.0)));',
    '      vec2 local = (px - A.xy) / A.z;',
    '      vec2 dl = local - B.yz;',
    '      vec3 Lv = normalize(vec3(-dl, 0.85));',
    '      float relief = clamp(dot(N, Lv) - Lv.z, -0.06, 0.45);',
    '      float spec = pow(max(dot(N, normalize(Lv + vec3(0.0, 0.0, 1.0))), 0.0), mix(48.0, 10.0, depth));',
    '      float pool = exp(-dot(dl, dl) / mix(0.16, 0.5, depth));',    // vorne kleiner/schaerfer, hinten weich
    '      float forehead = smoothstep(0.15, -0.55, local.y);',
    '      float dIn = dt.g * 25.5;',
    '      vec2 outward = local / max(length(local), 1e-3);',
    '      vec2 ldir = B.yz / max(length(B.yz), 1e-3);',
    '      float rim = smoothstep(0.3, 2.0, dIn) * exp(-max(dIn - 2.5, 0.0) / 3.5) * pow(max(dot(outward, ldir), 0.0), 2.5);',
    '      float feather = smoothstep(0.0, 2.5, dIn);',                  // keine harten Maskenkanten
    '      float gate = smoothstep(0.035, 0.19, lum);',                  // Augenhoehlen bleiben dunkel
    '      float hiGate = smoothstep(0.08, 0.38, lum);',
    '      float e = B.x;',
    '      float layerI = front + 0.62 * midL + 0.38 * back;',
    '      float glint = dt.r * (0.25 + 0.75 * pool) * e;',              // Zaehne, Wangenknochen, Brauen
    '      float L = pool * e * (0.75 + 0.45 * forehead) + relief * 1.4 * (0.3 + 0.7 * e) + glint * (1.5 * front + 0.5 * midL);',
    '      float k = uSkullAmt * fx.r;',
    '      vec3 soft = textureLod(uImg, uv, 1.0 + 2.0 * depth).rgb;',   // weichere Lichtbasis fuer Mitte/Hintergrund
    '      vec3 litBase = mix(base, soft, 1.0 - front);',
    '      col *= 1.0 - k * (1.0 - e) * (0.14 + 0.14 * depth) * smoothstep(0.0, 14.0, dIn) * mix(0.25, 1.0, gate);',  // zuruecksinken nur auf Knochen, weich ab der Silhouette (keine sichtbare Maskenkante)
    '      col += k * gate * feather * layerI * L * litBase;',
    '      col += k * hiGate * layerI * (rim * (0.55 * front + 0.35 * midL + 0.2 * back) * (0.35 + 0.65 * e)',
    '             + spec * pool * e * front * 0.5 + glint * front * 0.35) * vec3(0.55, 1.0, 0.62) * lum * 1.6;',
    '    }',
    '  }',
    // ---------------- 3. Laser Pulse V1.1
    '  if (uLaserAmt > 0.0) {',
    '    float band = texture(uLaser, uv).b;',
    '    if (band > 0.003) {',
    '      vec3 lt = texelFetch(uLaser, ip, 0).rgb;',
    '      float v = (floor(lt.r * 255.0 + 0.5) * 256.0 + floor(lt.g * 255.0 + 0.5)) / 65535.0 * 4.0;',
    '      int lid = int(floor(v));',
    '      float s = fract(v);',
    '      if (lid >= 0 && lid < 4) {',
    '        vec4 P = uLas[lid];',
    '        float d1 = (s - P.x) * P.w, d2 = (s - P.y) * P.w;',
    '        float head = max(exp(-d1 * d1 / 98.0), exp(-d2 * d2 / 98.0));',            // kleiner heller Kern (sigma 7 px)
    '        float halo = max(exp(-d1 * d1 / 968.0), exp(-d2 * d2 / 968.0)) * 0.45;',   // weicher Hof (sigma 22 px)
    '        float tail = max(d1 < 0.0 ? exp(d1 / 90.0) : 0.0, d2 < 0.0 ? exp(d2 / 90.0) : 0.0) * 0.35;',
    '        float core = smoothstep(0.03, 0.28, greenness);',
    '        float lineC = band * band * mix(0.15, 1.0, core);',   // Farbanteil nur, wo das Original Laserlicht hat
    '        float ends = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.82, 1.0, s));',  // weich ein-/ausblenden (L1-Ende liegt in einer Augenhoehle)
    '        col += uLaserAmt * ends * (head * (base * core * band * 3.0 + vec3(0.7, 1.0, 0.75) * lineC * 0.55)',
    '                            + (halo + tail) * (base * core * band * 1.6 + vec3(0.42, 1.0, 0.58) * lineC * 0.16)',
    '                            + P.z * 0.25 * base * core * band);',
    '      }',
    '    }',
    '  }',
    // ---------------- 4. Gaming-PC V1.1 (mit Highlight-Rolloff gegen Ueberstrahlung)
    '  if (uRgbAmt > 0.0 && fx.g > 0.002) {',
    '    float gness = smoothstep(0.05, 0.32, greenness);',
    '    float floorK = smoothstep(0.77, 0.83, uv.y);',
    '    float pulse = sin(uRgbPhase - (px.y - 420.0) / 520.0 * 1.4 - abs(px.x - 1300.0) / 600.0 * 0.8) * mix(1.0, 0.75, floorK);',
    '    float fanHl = 0.0;',
    '    for (int k = 0; k < 6; k++) {',
    '      vec4 F = uFan[k];',
    '      vec2 e = (px - F.xy) / F.zw;',
    '      float r = length(e);',
    '      if (r < 1.4) {',
    '        float ring = smoothstep(1.3, 1.0, r) * smoothstep(0.4, 0.78, r);',
    '        float da = abs(mod(atan(e.y, e.x) - uFanAng[k] + PI, 2.0 * PI) - PI);',
    '        fanHl += ring * exp(-da * da / 0.20);',
    '      }',
    '    }',
    '    float glint = exp(-pow((px.x - uGlintX) / 26.0, 2.0)) * dt.r * (1.0 - floorK) * smoothstep(0.02, 0.2, lum);',
    '    float k = uRgbAmt * fx.g * (1.0 - smoothstep(0.8, 0.97, max(max(base.r, base.g), base.b)));',  // gesaettigte LED-Kerne nicht weiter aufhellen
    '    vec3 add = base * gness * k * (0.5 * pulse + 0.9 * fanHl) + vec3(0.6, 1.0, 0.75) * glint * k * 0.35',
    '             + k * gness * vec3(0.0, 0.08, 0.22) * base.g * uRgb.z;',
    '    vec3 head = max(1.0 - col, vec3(1e-3)) * 0.7;',       // Highlight-Rolloff: hoechstens 70 % des Restabstands zu Weiss
    '    col = col + head * (1.0 - exp(-max(add, 0.0) / head)) + min(add, 0.0);',  // kleine Zugaben ~linear, grosse komprimiert
    '  }',
    // ---------------- 2. Volumetric Fog V1.1 (zwischen den Schaedeln, lichtdurchlaessig)
    '  if (uFogAmt > 0.0) {',
    '    vec2 q0 = vec2(uv.x * uImgSize.x / uImgSize.y, uv.y);',
    '    float atm = dt.b;',
    '    float dens = 0.0;',
    '    for (int k = 0; k < 3; k++) {',
    '      vec4 L = uFogL[k];',
    '      vec2 q = q0 * L.z + L.xy;',
    '      q.y += 0.16 * sin(q.x * 2.0 * PI * 2.0 / L.w + uFogPhase + float(k) * 2.1);',
    '      float n = fbm(q, L.w);',
    '      float prof = k == 0 ? (0.3 + 0.7 * atm)',
    '                 : (k == 1 ? exp(-pow((uv.y - 0.72) / 0.22, 2.0)) * 0.8 + 0.35 * atm : smoothstep(0.35, 1.0, uv.y) * 0.8 + 0.15);',
    '      float w = k == 0 ? 0.6 : (k == 1 ? 0.5 : 0.32);',
    '      dens += w * smoothstep(0.46, 0.74, n) * prof * uFogBr[k];',
    '    }',
    '    dens *= mix(0.22, 1.35, atm);',                                 // nah wenig, Luecken/Hintergrund viel
    '    vec3 scatN = textureLod(uImg, uv, 3.5).rgb;',
    '    vec3 scatF = textureLod(uImg, uv, 6.0).rgb;',
    '    vec3 fogCol = vec3(0.02, 0.085, 0.05) + (scatF * 0.9 + scatN * 0.5) * vec3(0.55, 1.3, 0.75);',
    '    float f = clamp(dens * uFogAmt * 2.3, 0.0, 0.8) * mix(0.45, 1.0, fx.b);',
    '    float trans = smoothstep(0.15, 0.6, luma(scatN));',            // helles Licht dahinter scheint durch
    '    col = mix(col, fogCol, f * (0.62 - 0.25 * trans)) + fogCol * f * (0.38 + 0.3 * trans);',
    '  }',
    '  }',
    '  outColor = vec4(min(col, vec3(1.0)), 1.0);',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ Helfer
  // Laden mit Zeitlimit + Wiederholung. Hintergrund: Auf dem Entwicklungs-PC haengen einzelne
  // ~1-MB-Antworten lokaler Server sporadisch ~19 s und enden mit RST (bei Python UND Node
  // reproduziert, Ursache unterhalb der Server-Software). Statt 19 s zu warten: nach 2,5 s abbrechen.
  var LOAD_STATS = { retries: 0, timeouts: 0 };
  function imageFromUrl(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.decoding = 'async';
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('Bild nicht dekodierbar: ' + url)); };
      im.src = url;
    });
  }
  // Dekodierung ausserhalb des Hauptthreads: ImageBitmap wird im Hintergrund dekodiert, der spaetere
  // Textur-Upload kostet dann nur 2-4 ms statt 10-23 ms (gemessen). Die Optionen entsprechen exakt den
  // bisherigen Upload-Parametern (kein Premultiply; Datenkarten ohne Farbraum-Umrechnung).
  // Fallback: Bild-Element (aeltere Browser). Ergebnis ist pixelgleich (Hash-Test).
  function decodeBlob(blob, isData) {
    if (typeof window.createImageBitmap === 'function') {
      return window.createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: isData ? 'none' : 'default' })
        .catch(function () { return imageFromBlob(blob); });
    }
    return imageFromBlob(blob);
  }
  function imageFromBlob(blob) {
    var obj = URL.createObjectURL(blob);
    return imageFromUrl(obj).then(function (im) { URL.revokeObjectURL(obj); return im; });
  }
  function loadImage(src, attempt, isData) {
    attempt = attempt || 0;
    var url = attempt ? src + (src.indexOf('?') < 0 ? '?' : '&') + 'retry=' + attempt : src;
    var next = function (err) {
      if (attempt >= 4) throw new Error('Bild konnte nicht geladen werden: ' + src + ' (' + err.message + ')');
      LOAD_STATS.retries++;
      return loadImage(src, attempt + 1, isData);
    };
    if (!window.fetch || !window.AbortController || location.protocol === 'file:') {
      return imageFromUrl(url).catch(next);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { LOAD_STATS.timeouts++; ctrl.abort(); }, 2500);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (b) { clearTimeout(timer); return decodeBlob(b, isData); })
      .catch(function (err) { clearTimeout(timer); return next(err); });
  }
  function fract(x) { return x - Math.floor(x); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function round4(x) { return Math.round(x * 1e4) / 1e4; }

  function shader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);              // Status wird NICHT sofort abgefragt (wuerde blockieren)
    return sh;
  }
  // kurze Pause zwischen Init-Schritten, damit keine lange Hauptthread-Aufgabe entsteht
  function yieldTask() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ------------------------------------------------------------------ Engine
  function CinematicHero(root, opts) {
    opts = opts || {};
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.diag = !!opts.diag;
    this.adaptive = opts.adaptive !== false && !this.diag;
    // Einbettungs-Optionen (Website-Integration). Ohne Angabe: unveraendertes Prototyp-Verhalten.
    this.assetBase = opts.assetBase || 'assets/maps/';
    this.mapExt = opts.mapExt || '.png';
    this.imageSrc = opts.imageSrc || SD.image.src;
    this.powerPreference = opts.powerPreference || 'high-performance';
    this.maxDprDesktop = opts.maxDprDesktop || 2;
    this.maxDprMobile = opts.maxDprMobile || 1.5;
    this.destroyed = false;
    this.preset = DEFAULT_PRESET;
    this.look = DEFAULT_LOOK;
    this.params = Object.assign({}, PRESETS[DEFAULT_PRESET]);
    this.t = 0;
    this.running = false;
    this.before = false;
    this.initialized = false;
    this.error = null;
    this.frame = 0;
    this.fps = 0;
    this.qualityScale = 1;
    this._fpsAcc = { n: 0, t: 0 };
    this._slow = 0;
    this._raf = 0;
    this._last = 0;
    this._listeners = [];
    this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    this._skA = new Float32Array(MAX_SK * 4);
    this._skB = new Float32Array(MAX_SK * 4);
    this._skC = new Float32Array(MAX_SK * 4);
    this._fogL = new Float32Array(12);
    this._las = new Float32Array(16);
    this._fan = new Float32Array(24);
    this._fanAng = new Float32Array(6);
    this._rgb = new Float32Array(4);
    this._fogPhase = 0;
    this._fogBr = new Float32Array([1, 1, 1]);
    this._rgbPhase = 0;
    this._glintX = 0;

    this._tick = this._tick.bind(this);
  }

  CinematicHero.PRESETS = PRESETS;
  CinematicHero.PRESET_LOOK = PRESET_LOOK;
  CinematicHero.PRESET_LABEL = PRESET_LABEL;
  CinematicHero.VERSION = '1.1';
  CinematicHero.CYCLE = CYCLE;

  CinematicHero.prototype.on = function (fn) { this._listeners.push(fn); };
  CinematicHero.prototype._emit = function (type) {
    for (var i = 0; i < this._listeners.length; i++) { try { this._listeners[i](type, this); } catch (e) { console.error(e); } }
  };

  Object.defineProperty(CinematicHero.prototype, 'mobile', {
    get: function () { return this.isTouch || window.innerWidth < 760; }
  });
  Object.defineProperty(CinematicHero.prototype, 'parallaxEnabled', {
    get: function () { return !this.isTouch && window.innerWidth >= 760; }
  });

  CinematicHero.prototype.init = function () {
    var self = this;
    var gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: this.diag, powerPreference: this.powerPreference
    });
    if (!gl) return Promise.resolve(this._fail('WebGL2 ist in diesem Browser nicht verfuegbar – statisches Originalbild wird angezeigt.'));
    this.gl = gl;
    this.initTimings = { start: performance.now(), mode: typeof window.createImageBitmap === 'function' ? 'ImageBitmap' : 'Image' };

    return Promise.all([
      loadImage(this.imageSrc, 0, false),
      loadImage(this.assetBase + 'fx-maps' + this.mapExt, 0, true),
      loadImage(this.assetBase + 'relief' + this.mapExt, 0, true),
      loadImage(this.assetBase + 'laser' + this.mapExt, 0, true),
      loadImage(this.assetBase + 'detail' + this.mapExt, 0, true)
    ]).then(function (imgs) {
      if (self.destroyed) return null;            // inzwischen abgebaut (z. B. Zeitlimit) -> nicht starten
      self.initTimings.decodedAt = Math.round(performance.now() - self.initTimings.start);
      return self._setupGL(imgs);
    }).then(function (ok) {
      if (!ok || self.destroyed) return self;
      self._setupStatic();
      self._bindEvents();
      self.resize();
      self.initialized = true;
      if (self.reducedMotion) {
        // Reduzierte Bewegung: kein Autostart, ein ruhiges Standbild mit Effekten
        self.t = 3.2;
        self.render();
      } else {
        self.resume();
      }
      requestAnimationFrame(function () { self.root.classList.add('ch-ready'); });
      self.initTimings.readyAt = Math.round(performance.now() - self.initTimings.start);
      self._emit('init');
      return self;
    }).catch(function (err) { return self._fail(err.message || String(err)); });
  };

  CinematicHero.prototype._fail = function (msg) {
    this.error = msg;
    this.root.classList.add('ch-no-webgl');
    console.warn('[CinematicHero] ' + msg);
    this._emit('error');
    return this;
  };

  // Asynchrones GL-Setup in kurzen Schritten (vorher eine Hauptthread-Aufgabe von ~90-140 ms):
  //  1. Shader kompilieren/linken, mit KHR_parallel_shader_compile im Hintergrund abwarten
  //  2. jede Textur in einer eigenen kurzen Aufgabe hochladen
  // GL-Zustand, Upload-Parameter und Reihenfolge sind unveraendert -> identische Pixel.
  CinematicHero.prototype._setupGL = function (imgs) {
    var self = this, gl = this.gl;
    var vs = shader(gl, gl.VERTEX_SHADER, VS), fs = shader(gl, gl.FRAGMENT_SHADER, FS);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    var par = gl.getExtension('KHR_parallel_shader_compile');
    this.initTimings.parallelCompile = !!par;
    var linked = new Promise(function (resolve) {
      (function poll() {
        if (self.destroyed) return resolve();
        if (!par || gl.getProgramParameter(prog, par.COMPLETION_STATUS_KHR)) return resolve();
        setTimeout(poll, 4);
      })();
    });
    return linked.then(function () {
      if (self.destroyed) return false;
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        var log = gl.getProgramInfoLog(prog) || '';
        [vs, fs].forEach(function (sh) { if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) log += ' | Shader-Fehler: ' + gl.getShaderInfoLog(sh); });
        throw new Error('Programm-Link-Fehler: ' + log);
      }
      self.initTimings.linkedAt = Math.round(performance.now() - self.initTimings.start);
      self._setupProgram(prog);
      var units = [[0, false], [1, true], [2, true], [3, true], [4, true]];
      self.textures = [];
      var chain = Promise.resolve();
      units.forEach(function (u) {
        chain = chain.then(yieldTask).then(function () {
          if (self.destroyed) return;
          self.textures.push(self._uploadTexture(u[0], imgs[u[0]], u[1]));
          if (imgs[u[0]] && typeof imgs[u[0]].close === 'function') imgs[u[0]].close();   // Bitmap-Speicher freigeben
        });
      });
      return chain.then(yieldTask).then(function () {
        if (self.destroyed) return false;
        self._finishSetup();
        self.initTimings.uploadedAt = Math.round(performance.now() - self.initTimings.start);
        return true;
      });
    });
  };

  CinematicHero.prototype._setupProgram = function (prog) {
    var gl = this.gl;
    gl.useProgram(prog);
    this.prog = prog;
    gl.disable(gl.DITHER);   // deterministische Frames (wichtig fuer Pixelvergleiche)
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    var names = ['uImg', 'uFx', 'uRelief', 'uLaser', 'uRes', 'uImgSize', 'uFocus', 'uSkullAmt', 'uFogAmt',
      'uLaserAmt', 'uRgbAmt', 'uFogPhase', 'uBefore', 'uFogOct', 'uSkA', 'uSkB', 'uSkC', 'uFogL', 'uLas',
      'uFan', 'uFanAng', 'uRgb', 'uDetail', 'uLook', 'uFogBr', 'uRgbPhase', 'uGlintX'];
    this.u = {};
    for (var i = 0; i < names.length; i++) this.u[names[i]] = gl.getUniformLocation(prog, names[i]);

  };

  CinematicHero.prototype._uploadTexture = function (unit, img, isData) {
    var gl = this.gl;
    {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, isData ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (!isData) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      return t;
    }
  };

  CinematicHero.prototype._finishSetup = function () {
    var gl = this.gl;
    gl.uniform1i(this.u.uImg, 0);
    gl.uniform1i(this.u.uFx, 1);
    gl.uniform1i(this.u.uRelief, 2);
    gl.uniform1i(this.u.uLaser, 3);
    gl.uniform1i(this.u.uDetail, 4);
    gl.uniform2f(this.u.uImgSize, IMG_W, IMG_H);

    var self = this;
    this.canvas.addEventListener('webglcontextlost', function (e) {
      if (self.destroyed) return;                 // gewollter Abbau, kein Fehler
      e.preventDefault();
      self.pause();
      self._fail('WebGL-Kontext verloren – statisches Originalbild aktiv.');
    });
    var err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error('GL-Fehler bei der Initialisierung: 0x' + err.toString(16));
  };

  CinematicHero.prototype._setupStatic = function () {
    var gl = this.gl;
    for (var i = 0; i < SD.skulls.length && i < MAX_SK; i++) {
      var s = SD.skulls[i];
      var cfg = SKULL_CFG[s.id] || [i * 0.618 % 1, 1, 45, 0.8];
      this._skA.set([s.cx, s.cy, s.r, s.depth], i * 4);
      var a = cfg[2] * Math.PI / 180;
      this._skC.set([Math.cos(a), Math.sin(a), cfg[3], 0], i * 4);
    }
    for (var f = 0; f < SD.fans.length && f < 6; f++) {
      var F = SD.fans[f];
      this._fan.set([F.cx, F.cy, F.rx, F.ry], f * 4);
    }
    gl.uniform4fv(this.u.uSkA, this._skA);
    gl.uniform4fv(this.u.uSkC, this._skC);
    gl.uniform4fv(this.u.uFan, this._fan);
    this._laserLen = SD.lasers.map(function (l) { return l.lengthPx; });
  };

  CinematicHero.prototype._bindEvents = function () {
    var self = this;
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(this.root);
    else window.addEventListener('resize', function () { self.resize(); });
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      self.mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
      self.mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', function () { self.mouse.tx = 0; self.mouse.ty = 0; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (self._raf) cancelAnimationFrame(self._raf); self._raf = 0; }
      else { self._last = 0; self._kick(); }
      self._emit('visibility');
    });
    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    var onMq = function () { self.reducedMotion = mq.matches; if (mq.matches) self.pause(); self._emit('change'); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  };

  CinematicHero.prototype.focus = function () {
    return this.mobile ? [0.9, 0.5] : [0.86, 0.42];
  };

  CinematicHero.prototype.resize = function () {
    if (!this.gl) return;
    var cw = Math.max(1, this.root.clientWidth), ch = Math.max(1, this.root.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    var coverCss = Math.max(cw / IMG_W, ch / IMG_H);
    // Nicht feiner rendern als ~1,6 Canvas-Pixel pro Originalpixel (Quelle hat 1672 px Breite)
    var r = Math.min(dpr, this.mobile ? this.maxDprMobile : this.maxDprDesktop);
    r = Math.min(r, Math.max(1.6 / coverCss, 0.75)) * this.qualityScale;
    var w = Math.max(1, Math.round(cw * r)), h = Math.max(1, Math.round(ch * r));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.renderScale = r;
    this.gl.viewport(0, 0, w, h);
    this.requestRender();
    this._emit('resize');
  };

  // Effektive Staerken (Smartphone reduziert, Parallaxe nur mit Maus)
  CinematicHero.prototype.effective = function () {
    var p = this.params, m = this.mobile;
    var c = this.look === 'v11' ? CURVE_V11 : { skull: 1, fog: 1, laser: 1, rgb: 1 };
    return {
      skull: p.skull * (m ? 0.9 : 1) * c.skull,
      fog: p.fog * (m ? 0.7 : 1) * c.fog,
      laser: p.laser * (m ? 0.85 : 1) * c.laser,
      rgb: p.rgb * (m ? 0.8 : 1) * c.rgb,
      parallax: this.parallaxEnabled ? p.parallax : 0
    };
  };

  // Alle zeitabhaengigen Effektwerte fuer Zeit t berechnen (-> Uniforms + Diagnose)
  CinematicHero.prototype._compute = function (t) {
    var eff = this.effective();
    var mx = this.mouse.x * eff.parallax, my = this.mouse.y * eff.parallax;
    var i;
    for (i = 0; i < SD.skulls.length && i < MAX_SK; i++) {
      var id = SD.skulls[i].id;
      if (this.look === 'v11') {
        var c11 = SKULL_CFG_V11[id] || [i * 0.618 % 1, 1];
        var dep = SD.skulls[i].depth;
        var u11 = fract(t / CYCLE - c11[0]);
        var revs = dep < 0.3 ? 2 : 1;                                   // hinten langsamere Lichtbewegung
        var a11 = TAU * (t / CYCLE * revs * c11[1] + c11[0]);
        var pk = 0.35 * (1 - 0.6 * dep);                                // Parallaxe: vorne staerker
        this._skB[i * 4] = 0.12 + 0.88 * envV11(u11);
        this._skB[i * 4 + 1] = 0.72 * Math.cos(a11) + mx * pk;
        this._skB[i * 4 + 2] = -0.30 + 0.40 * Math.sin(a11) + 0.10 * Math.sin(2 * a11) + my * pk * 0.7;
        this._skB[i * 4 + 3] = 0;
        continue;
      }
      var cfg = SKULL_CFG[id] || [0, 1, 45, 0.8];
      var u = fract(t / CYCLE - cfg[0]);
      var emerge = Math.pow(0.5 - 0.5 * Math.cos(TAU * u), 1.5);       // Hervortreten 1x pro Zyklus
      var ang = TAU * (t / (CYCLE / 2) * cfg[1] + cfg[0]);             // Lichtumlauf 2x pro Zyklus
      var lx = 0.75 * Math.cos(ang) + mx * 0.35;
      var ly = -0.3 + 0.5 * Math.sin(ang) + my * 0.25;                 // bevorzugt Stirn (oben)
      var sweep = (u - 0.5) * 6.0;                                     // Sweep quert den Schaedel um den Hoehepunkt
      this._skB[i * 4] = emerge;
      this._skB[i * 4 + 1] = lx;
      this._skB[i * 4 + 2] = ly;
      this._skB[i * 4 + 3] = sweep;
    }
    for (i = 0; i < 3; i++) {
      var L = FOG[i];
      this._fogL[i * 4] = -fract(t / L.T) * L.per + mx * 0.12 * L.depth;      // nahtlos: Periode = per
      this._fogL[i * 4 + 1] = 0.06 * Math.sin(TAU * t / L.T + i) + my * 0.05 * L.depth;
      this._fogL[i * 4 + 2] = L.scale;
      this._fogL[i * 4 + 3] = L.per;
    }
    this._fogPhase = (TAU * t / 36) % TAU;
    for (i = 0; i < 3; i++) this._fogBr[i] = 0.8 + 0.2 * Math.sin(TAU * t / FOG_BREATH_T[i] + i * 1.9);
    this._rgbPhase = (TAU * t / 8) % TAU;
    this._glintX = 1000 + 620 * fract(t / CYCLE + 0.3);                 // Glanzlicht wandert ueber das Glasgehaeuse
    // Laser L1, L2
    for (i = 0; i < 2; i++) {
      var ph = fract(t / LASER_T[i] + LASER_PHASE[i]);
      this._las[i * 4] = -0.25 + 1.5 * ph;
      this._las[i * 4 + 1] = -0.25 + 1.5 * fract(ph + 0.5);
      this._las[i * 4 + 2] = 0.5 + 0.5 * Math.sin(TAU * t / CYCLE + i * 1.7);
      this._las[i * 4 + 3] = this._laserLen[i];
    }
    // L3 + L4 als ein durchgehender Weg (Impuls laeuft hinter dem PC weiter)
    var l3 = this._laserLen[2], l4 = this._laserLen[3], tot = l3 + L3_GAP + l4;
    var g = 0.5 + 0.5 * Math.sin(TAU * t / CYCLE + 3.4);
    for (var j = 0; j < 2; j++) {
      var D = -150 + (tot + 300) * fract(t / LASER_T[2] + LASER_PHASE[2] + j * 0.5);
      this._las[8 + j] = D / l3;
      this._las[12 + j] = (D - l3 - L3_GAP) / l4;
    }
    this._las[10] = g; this._las[11] = l3;
    this._las[14] = g; this._las[15] = l4;
    // RGB
    this._rgb[0] = Math.sin(TAU * t / 8);
    this._rgb[1] = Math.sin(TAU * (t - 0.6) / 8);
    this._rgb[2] = 0.5 + 0.5 * Math.sin(TAU * t / CYCLE);
    this._rgb[3] = 0;
    for (i = 0; i < 6; i++) {
      var dir = i < 3 ? 1 : -1;
      this._fanAng[i] = (TAU * (t / 8 * dir + i * 0.23)) % TAU;
    }
    return eff;
  };

  CinematicHero.prototype.render = function () {
    if (!this.initialized) return;
    var gl = this.gl, u = this.u;
    var eff = this._compute(this.t);
    var fc = this.focus();
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uFocus, fc[0], fc[1]);
    gl.uniform1i(u.uBefore, this.before ? 1 : 0);
    gl.uniform1i(u.uLook, this.look === 'v11' ? 1 : 0);
    gl.uniform3fv(u.uFogBr, this._fogBr);
    gl.uniform1f(u.uRgbPhase, this._rgbPhase);
    gl.uniform1f(u.uGlintX, this._glintX);
    gl.uniform1i(u.uFogOct, this.mobile ? 3 : 4);
    gl.uniform1f(u.uSkullAmt, eff.skull);
    gl.uniform1f(u.uFogAmt, eff.fog);
    gl.uniform1f(u.uLaserAmt, eff.laser);
    gl.uniform1f(u.uRgbAmt, eff.rgb);
    gl.uniform1f(u.uFogPhase, this._fogPhase);
    gl.uniform4fv(u.uSkB, this._skB);
    gl.uniform4fv(u.uFogL, this._fogL);
    gl.uniform4fv(u.uLas, this._las);
    gl.uniform1fv(u.uFanAng, this._fanAng);
    gl.uniform4fv(u.uRgb, this._rgb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frame++;
  };

  CinematicHero.prototype._shouldLoop = function () {
    return this.initialized && !document.hidden && !this.before && this.running;
  };

  CinematicHero.prototype._kick = function () {
    if (!this._raf && this.initialized && !document.hidden) this._raf = requestAnimationFrame(this._tick);
  };

  CinematicHero.prototype.requestRender = function () { this._needsRender = true; this._kick(); };

  CinematicHero.prototype._tick = function (now) {
    this._raf = 0;
    var dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 0;
    this._last = now;
    if (this.running && !this.before) this.t += dt * this.params.speed;
    var k = 1 - Math.exp(-dt * 3.5);
    if (this.running && !this.before) {
      this.mouse.x += (this.mouse.tx - this.mouse.x) * k;
      this.mouse.y += (this.mouse.ty - this.mouse.y) * k;
    }
    this.render();
    this._needsRender = false;
    // FPS
    if (dt > 0) {
      this._fpsAcc.n++; this._fpsAcc.t += dt;
      if (this._fpsAcc.t >= 0.5) {
        this.fps = this._fpsAcc.n / this._fpsAcc.t;
        this._fpsAcc.n = 0; this._fpsAcc.t = 0;
        this._adapt();
      }
    }
    if (this._shouldLoop()) this._raf = requestAnimationFrame(this._tick);
    else this._last = 0;
  };

  // Adaptive Aufloesung: bei dauerhaft < 40 fps Renderskala senken (nicht im Diagnosemodus)
  CinematicHero.prototype._adapt = function () {
    if (!this.adaptive || !this.running) return;
    if (this.fps < 40) this._slow++; else this._slow = 0;
    if (this._slow >= 6 && this.qualityScale > 0.6) {
      this.qualityScale = Math.max(0.6, this.qualityScale * 0.85);
      this._slow = 0;
      this.resize();
    }
  };

  // ------------------------------------------------------------------ Steuerung
  CinematicHero.prototype.resume = function () {
    if (!this.initialized) return;
    this.running = true;
    this._last = 0;
    this._kick();
    this._emit('change');
  };
  CinematicHero.prototype.pause = function () {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._last = 0;
    if (this.initialized) this.render();
    this._emit('change');
  };
  CinematicHero.prototype.toggle = function () { if (this.running) this.pause(); else this.resume(); };

  // Vollstaendiger Abbau (Kill-Switch/Rollback): Loop stoppen, GPU-Kontext freigeben.
  CinematicHero.prototype.destroy = function () {
    this.running = false;
    this.destroyed = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this.initialized = false;
    if (this.gl) {
      var ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    this._emit('destroy');
  };

  CinematicHero.prototype.setBefore = function (on) {
    this.before = !!on;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._last = 0;
    if (this.initialized) this.render();
    if (!this.before) this._kick();
    this._emit('change');
  };

  CinematicHero.prototype.setParams = function (p) {
    for (var k in p) if (Object.prototype.hasOwnProperty.call(this.params, k)) {
      var v = +p[k];
      this.params[k] = k === 'speed' ? Math.min(3, Math.max(0.05, v)) : clamp01(v);
    }
    this._detectPreset();
    this.requestRender();
    if (!this.running && this.initialized) this.render();
    this._emit('change');
  };
  CinematicHero.prototype._detectPreset = function () {
    var found = null;
    for (var name in PRESETS) {
      if (PRESET_LOOK[name] && PRESET_LOOK[name] !== this.look) continue;
      var same = true;
      for (var key in PRESETS[name]) if (Math.abs(PRESETS[name][key] - this.params[key]) > 1e-6) same = false;
      if (same && (!found || PRESET_LOOK[name])) found = name;      // Look-Preset hat Vorrang
    }
    this.preset = found;
  };
  CinematicHero.prototype.setLook = function (look) {
    if (look !== 'v10' && look !== 'v11') throw new Error('Unbekannter Look: ' + look);
    this.look = look;
    this._detectPreset();
    if (this.initialized) this.render();
    this.requestRender();
    this._emit('change');
  };
  CinematicHero.prototype.applyPreset = function (name) {
    if (!PRESETS[name]) throw new Error('Unbekanntes Preset: ' + name);
    if (PRESET_LOOK[name]) this.look = PRESET_LOOK[name];
    this.setParams(PRESETS[name]);
    this.preset = name;                                              // explizit gewaehltes Preset anzeigen
    this._emit('change');
  };
  CinematicHero.prototype.reset = function () {
    this.before = false;
    this.mouse.x = this.mouse.y = this.mouse.tx = this.mouse.ty = 0;
    this.applyPreset(DEFAULT_PRESET);
    if (!this.reducedMotion) this.resume(); else this.render();
  };

  // ------------------------------------------------------------------ Diagnose-API
  CinematicHero.prototype.layout = function () {
    var W = this.canvas.width, H = this.canvas.height, fc = this.focus();
    var s = Math.max(W / IMG_W, H / IMG_H);
    return { W: W, H: H, scale: s, offX: (W - IMG_W * s) * fc[0], offY: (H - IMG_H * s) * fc[1] };
  };
  CinematicHero.prototype.imageRectToCanvas = function (r) {
    var L = this.layout();
    var x0 = Math.max(0, Math.floor(L.offX + r[0] * L.scale)), y0 = Math.max(0, Math.floor(L.offY + r[1] * L.scale));
    var x1 = Math.min(L.W, Math.ceil(L.offX + r[2] * L.scale)), y1 = Math.min(L.H, Math.ceil(L.offY + r[3] * L.scale));
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  };
  CinematicHero.prototype.canvasToImage = function (x, y) {
    var L = this.layout();
    return [(x + 0.5 - L.offX) / L.scale, (y + 0.5 - L.offY) / L.scale];
  };
  // Rendert den aktuellen Zustand und liest Pixel (top-down RGBA). rect = Bildpixel [x0,y0,x1,y1] oder null = alles
  // opts.render === false: liest das aktuell ANGEZEIGTE Bild ohne neu zu rendern
  // (nur im Diagnosemodus zuverlaessig, dort ist preserveDrawingBuffer aktiv).
  CinematicHero.prototype.capture = function (rect, opts) {
    var gl = this.gl;
    if (!opts || opts.render !== false) this.render();
    var c = rect ? this.imageRectToCanvas(rect) : [0, 0, this.canvas.width, this.canvas.height];
    var w = c[2], h = c[3];
    var buf = new Uint8Array(w * h * 4);
    gl.readPixels(c[0], this.canvas.height - c[1] - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    var out = new Uint8Array(w * h * 4), row = w * 4;
    for (var y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return { x: c[0], y: c[1], w: w, h: h, data: out };
  };
  CinematicHero.prototype.renderAt = function (t) { this.t = t; this.render(); };
  CinematicHero.prototype.setMouse = function (x, y, immediate) {
    this.mouse.tx = x; this.mouse.ty = y;
    if (immediate) { this.mouse.x = x; this.mouse.y = y; }
    this.requestRender();
    if (!this.running && this.initialized) this.render();
  };

  CinematicHero.prototype.getState = function () {
    var eff = this.initialized ? this._compute(this.t) : this.effective();
    var i, skulls = [], fog = [], lasers = [], fans = [];
    if (this.initialized) {
      for (i = 0; i < SD.skulls.length; i++) {
        skulls.push({ id: SD.skulls[i].id, name: SD.skulls[i].name, emerge: round4(this._skB[i * 4]),
          light: [round4(this._skB[i * 4 + 1]), round4(this._skB[i * 4 + 2])], sweep: round4(this._skB[i * 4 + 3]) });
      }
      for (i = 0; i < 3; i++) fog.push({ x: round4(this._fogL[i * 4]), y: round4(this._fogL[i * 4 + 1]), loopSeconds: FOG[i].T });
      for (i = 0; i < 4; i++) lasers.push({ id: i + 1, head1: round4(this._las[i * 4]), head2: round4(this._las[i * 4 + 1]), glow: round4(this._las[i * 4 + 2]) });
      for (i = 0; i < 6; i++) fans.push(round4(this._fanAng[i]));
    }
    var layers = [];
    if (this.initialized && !this.before) {
      if (eff.skull > 0) layers.push('skull');
      if (eff.fog > 0) layers.push('fog');
      if (eff.laser > 0) layers.push('laser');
      if (eff.rgb > 0) layers.push('rgb');
    }
    return {
      initialized: this.initialized, error: this.error, running: this.running, before: this.before,
      hidden: document.hidden, reducedMotion: this.reducedMotion, mobile: this.mobile, touch: this.isTouch,
      version: CinematicHero.VERSION, look: this.look, loadStats: Object.assign({}, LOAD_STATS),
      initTimings: this.initTimings ? Object.assign({}, this.initTimings, { start: undefined }) : null,
      parallaxEnabled: this.parallaxEnabled, preset: this.preset, params: Object.assign({}, this.params),
      effective: eff, activeLayers: layers, t: round4(this.t), cyclePosition: round4(fract(this.t / CYCLE)),
      frame: this.frame, fps: Math.round(this.fps * 10) / 10,
      canvas: { w: this.canvas.width, h: this.canvas.height, renderScale: round4(this.renderScale || 0), quality: round4(this.qualityScale) },
      mouse: { x: round4(this.mouse.x), y: round4(this.mouse.y) },
      skulls: skulls, fog: fog, lasers: lasers,
      rgb: { pulse: round4(this._rgb[0]), reflection: round4(this._rgb[1]), hue: round4(this._rgb[2]), fanAngles: fans,
        wavePhase: round4(this._rgbPhase), glintX: Math.round(this._glintX * 10) / 10 },
      fogBreath: [round4(this._fogBr[0]), round4(this._fogBr[1]), round4(this._fogBr[2])]
    };
  };

  window.CinematicHeroEngine = CinematicHero;
})();
