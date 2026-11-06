/* ============================================================
   FlipArt86 – Galerie: 3D-Karussell (Phase 4.6)
   ------------------------------------------------------------
   Quelle: Design/UI_Mockups/FlipArt86_Circular_Carousel_Demo_V2.html
   (Phase 4.3, V2). Bewegungslogik unverändert übernommen:
   Ring-Geometrie, Snap, Momentum, Autoplay, Beleuchtung, Pointer/Touch.

   Anpassungen für die Galerie:
   - Daten: aktuelle Serie aus galerie.html (currentFiltered aus GALLERY),
     gleiche Reihenfolge wie das Raster – keine eigene Bildliste.
   - Großansicht: bestehende Galerie-Lightbox (openLightbox).
   - Variable Werkanzahl je Serie, Kartengröße aus der Bühnenbreite.
   - DE/EN über scripts/lang.js (Ereignis 'flipart86:lang').
   - Standardansicht (Phase 4.6.1): 3D-Karussell; Rasteransicht per Umschalter.
   - Fallback: ohne CSS-3D-Unterstützung bleibt nur das Raster.
   Benötigt die globalen Funktionen/Variablen aus galerie.html:
   openLightbox, currentFiltered, currentIndex, lastFocus, glView.
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var car = $('gl-car'), stage = $('gl-car-stage'), ring = $('gl-car-ring');
  var viewSw = $('gl-view'), dlg = $('lightbox');
  var glStage = document.querySelector('.gl-stage');
  if (!car || !stage || !ring || !viewSw || !dlg || !glStage || typeof openLightbox !== 'function') return;

  var supports3d = !!(window.CSS && CSS.supports && CSS.supports('transform-style', 'preserve-3d'));
  if (!supports3d) return;                      /* Fallback: Raster bleibt die einzige Ansicht */

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var VIEW_KEY = 'flipart86_gallery_view';

  /* ---- Parameter (Bewegung unverändert gegenüber V2) ---- */
  var CFG = {
    cardW: 220, gap: 25, perspective: 2500,     /* Referenzmaße; werden mit der Kartengröße skaliert */
    autoSpeed: 14, momentum: 0.6, snap: true, pauseOnHover: true, focusOnClick: true,
    fillH: 0.88,                                /* Anteil der Bühnenhöhe für die vordere Karte */
    maxCardW: 640,                              /* Auflösungsgrenze (CSS-px) */
    minItems: 3                                 /* darunter kein Ring -> Raster */
  };
  var DEG = Math.PI / 180, K_SNAP = 7, TAU = Math.max(0.12, CFG.momentum * 0.8);

  var items = [], N = 0, STEP = 36, cards = [], built = false, active3d = false;
  var theta = 0, vel = 0, glide = false, target = null;
  var dragging = false, hovered = false, focused = false, inView = true;
  var autoplay = !reduced.matches, resumeAt = 0, userAction = false, activeIdx = -1, R = 377;
  /* Phase 4.6.1: Das Karussell ist bei jedem Aufruf Standard. Die gewählte Ansicht gilt
     nur für den aktuellen Seitenaufruf (bleibt beim Serienwechsel erhalten) und wird
     nicht gespeichert. Ein Wert aus Phase 4.6 wird entfernt. */
  var pref = 'carousel';
  try { localStorage.removeItem(VIEW_KEY); } catch (e) {}

  /* Übersetzung aus scripts/lang.js (deutsche Fallbacks, solange lang.js noch nicht geladen ist) */
  function T(key, fb) {
    var all = (typeof FLIPART86_I18N !== 'undefined') ? FLIPART86_I18N : null;
    var L = all && all[window.FLIPART86_LANG || 'de'];
    return (L && L[key]) || fb;
  }

  /* ---- Karten aufbauen ---- */
  function build() {
    ring.textContent = ''; cards = []; activeIdx = -1; lastShadeKey = '';
    N = items.length; STEP = 360 / Math.max(N, 1);
    theta = 0; vel = 0; glide = false; target = null;
    items.forEach(function (d, i) {
      var c = document.createElement('div');
      c.className = 'gl-car-card';
      c.setAttribute('role', 'group');
      c.setAttribute('data-i', i);
      var img = document.createElement('img');
      img.src = d.src; img.alt = d.title || '';
      if (d.w && d.h) { img.width = d.w; img.height = d.h; }
      img.decoding = 'async'; img.draggable = false;
      if (i > 2 && i < N - 2) img.setAttribute('fetchpriority', 'low');   /* vordere Karten zuerst */
      var sh = document.createElement('span'); sh.className = 'gl-car-shade';
      c.appendChild(img); c.appendChild(sh);
      ring.appendChild(c);
      cards.push({ el: c, shade: sh, back: false });
    });
    built = true;
    label();
    layout();
  }

  function label() {
    stage.setAttribute('aria-roledescription', T('gallery_car_role', 'Karussell'));
    var of = T('gallery_car_of', 'von'), slide = T('gallery_car_slide', 'Folie');
    cards.forEach(function (c, i) {
      c.el.setAttribute('aria-roledescription', slide);
      c.el.setAttribute('aria-label', (i + 1) + ' ' + of + ' ' + N + ': ' + (items[i].title || ''));
    });
    syncAutoBtn();
  }

  /* ---- Geometrie (V2) ----
     R = (w + g) / (2·tan(π/N));  Karte i: rotateY(i·360/N) translateZ(R);
     Ring: translateZ(-R) rotateY(theta) -> vorderste Karte liegt bei z=0.
     Kartenbreite aus Bühnenhöhe (fillH), Bühnenbreite und Auflösungsgrenze. */
  function layout() {
    if (!active3d || !built) return;
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    var cwH = (H * CFG.fillH) / 1.5;
    var cwW = W < 700 ? W * 0.58 : W * 0.30;
    var cw = Math.round(Math.max(110, Math.min(cwH, cwW, CFG.maxCardW)));
    var scale = cw / CFG.cardW;
    R = (cw + CFG.gap * scale) / (2 * Math.tan(Math.PI / N));
    car.style.setProperty('--cw', cw + 'px');
    car.style.setProperty('--ch', Math.round(cw * 1.5) + 'px');
    stage.style.perspective = Math.round(CFG.perspective * scale) + 'px';
    cards.forEach(function (c, i) {
      c.el.style.transform = 'rotateY(' + (i * STEP) + 'deg) translateZ(' + R.toFixed(1) + 'px)';
    });
    render(true);
  }

  /* Beleuchtung (V2): t = cos(Winkel), u = (1-t)/2, Abdunklung = 0.80 · u^1.6 */
  var lastShadeKey = '';
  function render(force) {
    ring.style.transform = 'translateZ(' + (-R).toFixed(1) + 'px) rotateY(' + theta.toFixed(3) + 'deg)';
    var key = Math.round(theta * 10);
    if (!force && key === lastShadeKey) return;
    lastShadeKey = key;
    for (var i = 0; i < N; i++) {
      var t = Math.cos((i * STEP + theta) * DEG);
      var c = cards[i];
      var u = (1 - t) / 2;
      c.shade.style.setProperty('--s', (0.80 * Math.pow(u, 1.6)).toFixed(3));
      var back = t < 0;
      if (back !== c.back) { c.back = back; c.el.classList.toggle('back', back); }
    }
    updateActive();
  }

  function mod(a, n) { return ((a % n) + n) % n; }
  function nearestSlot(th) { return Math.round(th / STEP) * STEP; }

  function updateActive() {
    if (!N) return;
    var idx = mod(Math.round(-theta / STEP), N);
    if (idx === activeIdx) return;
    if (activeIdx >= 0 && cards[activeIdx]) cards[activeIdx].el.classList.remove('is-active');
    activeIdx = idx;
    cards[idx].el.classList.add('is-active');
    $('gl-car-count').textContent = (idx + 1) + ' / ' + N;
    $('gl-car-title').textContent = items[idx].title || '';
  }

  /* ---- Animationsschleife (V2) ---- */
  var raf = 0, last = 0, wakeTimer = 0;
  function schedule() { if (active3d && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  function idleOk() {
    return active3d && autoplay && !reduced.matches && !dragging && !hovered && !focused && !dlg.open &&
           inView && !document.hidden;
  }
  function autoActive() { return idleOk() && performance.now() >= resumeAt; }
  function wakeAt(ms) { clearTimeout(wakeTimer); wakeTimer = setTimeout(schedule, Math.max(0, ms)); }

  function tick(now) {
    raf = 0;
    if (!active3d) return;
    var dt = Math.min(0.05, (now - last) / 1000); last = now;
    var again = false;
    if (dragging) {
      again = false;
    } else if (target !== null) {
      theta += (target - theta) * (1 - Math.exp(-dt * K_SNAP));
      if (Math.abs(target - theta) < 0.02) { theta = target; target = null; settled(); }
      again = true;
    } else if (glide) {
      theta += vel * dt; vel *= Math.exp(-dt / TAU);
      if (Math.abs(vel) < (CFG.snap ? 70 : 8)) {
        glide = false;
        if (CFG.snap) target = nearestSlot(theta + vel * 0.15); else vel = 0;
      }
      again = true;
    } else if (autoActive()) {
      theta -= CFG.autoSpeed * dt; again = true;
    } else if (idleOk()) {
      wakeAt(resumeAt - performance.now());
    }
    render(false);
    if (again) schedule();
  }

  function settled() {
    if (userAction) {
      userAction = false;
      $('gl-car-live').textContent = (items[activeIdx].title || '') + ', ' + (activeIdx + 1) + ' ' + T('gallery_car_of', 'von') + ' ' + N;
    }
  }

  function goTo(th) {
    glide = false; vel = 0; userAction = true;
    resumeAt = performance.now() + 3000;
    if (reduced.matches) { theta = th; target = null; render(false); settled(); return; }
    target = th; schedule();
  }
  function step(delta) {
    var base = target !== null ? target : nearestSlot(theta);
    goTo(base - delta * STEP);
  }
  function centerCard(i) {
    var m = Math.round((theta + i * STEP) / 360);
    goTo(360 * m - i * STEP);
  }

  /* ---- Großansicht: bestehende Galerie-Lightbox ---- */
  function openLb(i) {
    if (dlg.open || i < 0) return;
    lastFocus = stage;                          /* Fokus kehrt nach dem Schließen zur Bühne zurück */
    openLightbox(i);
  }
  dlg.addEventListener('close', function () {
    if (!active3d) return;
    if (typeof currentIndex === 'number' && currentIndex < N && currentIndex !== activeIdx) centerCard(currentIndex);
    resumeAt = performance.now() + 3000; schedule();
  });

  /* ---- Maus/Touch (V2) ---- */
  var down = null, samples = [];
  function degPerPx() { return (180 / Math.PI) / R; }
  stage.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, th: theta, moved: false, card: e.target.closest ? e.target.closest('.gl-car-card') : null, id: e.pointerId };
    samples = [{ t: performance.now(), th: theta }];
    glide = false; vel = 0; target = null;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener('pointermove', function (e) {
    if (!down || e.pointerId !== down.id) return;
    var dx = e.clientX - down.x;
    if (!down.moved && Math.abs(dx) > 6) { down.moved = true; dragging = true; stage.classList.add('dragging'); }
    if (!down.moved) return;
    theta = down.th + dx * degPerPx();
    var now = performance.now();
    samples.push({ t: now, th: theta });
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
    render(false);
  });
  function endPointer(e) {
    if (!down || e.pointerId !== down.id) return;
    var d = down; down = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
    var wasDrag = dragging; dragging = false; stage.classList.remove('dragging');
    resumeAt = performance.now() + 3000;
    if (wasDrag) {
      userAction = true;
      var a = samples[0], b = samples[samples.length - 1];
      var v = b.t > a.t ? (b.th - a.th) / ((b.t - a.t) / 1000) : 0;
      v = Math.max(-560, Math.min(560, v));
      if (reduced.matches) { theta = nearestSlot(theta); render(false); settled(); return; }
      if (Math.abs(v) > 90) { vel = v; glide = true; }
      else if (CFG.snap) { target = nearestSlot(theta); }
      schedule();
    } else if (e.type === 'pointerup') {
      if (d.card && CFG.focusOnClick) {
        var i = +d.card.getAttribute('data-i');
        if (i !== activeIdx) centerCard(i);
        else if (target === null && !glide) openLb(i);          /* zentriertes Werk -> Großansicht */
      } else if (target === null && !glide && CFG.snap) {
        target = nearestSlot(theta); schedule();                 /* Klick daneben: sauber einrasten */
      }
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('pointerenter', function (e) {
    if (!CFG.pauseOnHover || e.pointerType !== 'mouse') return;
    hovered = true;
    if (CFG.snap && target === null && !glide && !dragging && !reduced.matches) { target = nearestSlot(theta); schedule(); }
  });
  stage.addEventListener('pointerleave', function (e) {
    if (e.pointerType !== 'mouse') return;
    hovered = false; resumeAt = performance.now() + 800; schedule();
  });

  /* Tastaturfokus im Karussell pausiert den Autoplay (auf das Karussell begrenzt) */
  function isFocusVisible(el) { try { return el.matches(':focus-visible'); } catch (err) { return false; } }
  car.addEventListener('focusin', function (e) { if (isFocusVisible(e.target)) focused = true; });
  car.addEventListener('focusout', function () {
    setTimeout(function () {
      var a = document.activeElement;
      focused = !!(a && car.contains(a) && isFocusVisible(a));
      if (!focused) { resumeAt = performance.now() + 800; schedule(); }
    }, 0);
  });

  stage.addEventListener('keydown', function (e) {
    if (!N) return;
    if (e.key.indexOf('Arrow') === 0 || e.key === 'Home' || e.key === 'End') focused = true;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); centerCard(0); }
    else if (e.key === 'End') { e.preventDefault(); centerCard(N - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLb(activeIdx); }
  });
  $('gl-car-prev').addEventListener('click', function () { step(-1); });
  $('gl-car-next').addEventListener('click', function () { step(1); });
  $('gl-car-zoom').addEventListener('click', function () { lastFocus = this; if (!dlg.open) openLightbox(activeIdx); });

  /* ---- Autoplay-Schalter ---- */
  var autoBtn = $('gl-car-auto');
  function syncAutoBtn() {
    autoBtn.setAttribute('aria-pressed', String(autoplay && !reduced.matches));
    autoBtn.disabled = reduced.matches;
    autoBtn.title = reduced.matches ? T('gallery_car_auto_off', 'Autoplay ist wegen reduzierter Bewegung deaktiviert') : '';
  }
  autoBtn.addEventListener('click', function () { autoplay = !autoplay; syncAutoBtn(); resumeAt = 0; schedule(); });
  var onReduce = function () {
    if (reduced.matches) { autoplay = false; glide = false; target = null; vel = 0; theta = nearestSlot(theta); if (active3d) render(false); }
    syncAutoBtn();
  };
  if (reduced.addEventListener) reduced.addEventListener('change', onReduce); else if (reduced.addListener) reduced.addListener(onReduce);

  /* ---- Ansicht: Raster / 3D-Karussell ---- */
  var viewBtns = viewSw.querySelectorAll('.gl-view-b');
  function setView(v, save) {
    if (save) pref = v;
    var can3d = items.length >= CFG.minItems;
    var want3d = v === 'carousel' && can3d;
    active3d = want3d;
    glView = want3d ? 'carousel' : 'grid';
    glStage.classList.toggle('is-3d', want3d);
    for (var b = 0; b < viewBtns.length; b++) {
      var bv = viewBtns[b].getAttribute('data-view');
      viewBtns[b].setAttribute('aria-pressed', bv === glView ? 'true' : 'false');
      if (bv === 'carousel') viewBtns[b].disabled = !can3d;
    }
    if (want3d) {
      if (!built) build(); else layout();
      resumeAt = performance.now() + 600; schedule();
    } else {
      dragging = false; down = null; stage.classList.remove('dragging');
    }
  }
  for (var vb = 0; vb < viewBtns.length; vb++) {
    viewBtns[vb].addEventListener('click', function () {
      var v = this.getAttribute('data-view');
      if (v !== glView) setView(v, true);
    });
  }

  /* Serienwechsel (aus selectCategory in galerie.html) */
  function setItems(list) {
    items = (list || []).slice();
    built = false;
    setView(pref, false);
  }

  /* ---- Umgebung ---- */
  document.addEventListener('flipart86:lang', function () { if (built) label(); else syncAutoBtn(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { resumeAt = performance.now() + 400; schedule(); } });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { inView = en[0].isIntersecting; if (inView) schedule(); }, { threshold: 0.05 }).observe(stage);
  }
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(stage);
  else window.addEventListener('resize', layout);

  /* ---- Init ---- */
  viewSw.hidden = false;
  syncAutoBtn();
  setItems(typeof currentFiltered !== 'undefined' ? currentFiltered : []);

  window.GLCarousel = {
    setItems: setItems,
    setView: function (v) { setView(v, true); },
    get state() { return { view: glView, n: N, active: activeIdx, theta: theta, target: target, R: R, autoplay: autoplay }; }
  };
})();
