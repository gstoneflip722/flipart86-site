/*!
 * FlipArt86 Cinematic Hero V1.2 – Website-Adapter
 *
 * Einzige Einbindung in index.html:  <script src="scripts/cinematic-hero-site.js" defer></script>
 *
 * Verhalten:
 *  - startet erst NACH dem load-Event im Leerlauf (Hero-Bild bleibt LCP, kein Einfluss auf den ersten Paint)
 *  - laedt Szenedaten, Renderer und CSS erst, wenn die Animation wirklich laufen soll
 *  - legt EIN Canvas in den bestehenden .hx-frame (zwischen Hero-Bild und Bloom-Ebene) und
 *    uebernimmt damit Geometrie, Bildausschnitte, Masken und Zoom von Hero V2.1 unveraendert
 *  - nutzt das bestehende Hero-Bild assets/web/hero-bg-001.webp (keine Bildkopie)
 *  - pausiert, wenn der Hero nicht sichtbar oder der Tab verborgen ist
 *  - Fallback: bei jedem Problem wird das Canvas entfernt -> normales Hero-Bild bleibt
 *
 * Deaktivieren (ohne Codeaenderung an der Seite):
 *  - CONFIG.enabled = false                         (globaler Kill-Switch in dieser Datei)
 *  - <html data-cinematic="off">                    (im Markup)
 *  - window.FLIPART86_CINEMATIC = false              (vor diesem Skript)
 *  - ?cinematic=0 in der URL                         (Test/Support)
 *  - localStorage 'flipart86_cinematic' = 'off'      (fuer einen spaeteren Besucher-Schalter)
 * Automatisch aus bei: prefers-reduced-motion, Save-Data, fehlendem WebGL2.
 */
(function () {
  'use strict';

  var CONFIG = {
    enabled: true,
    scriptBase: 'scripts/',
    styleHref: 'styles/cinematic-hero.css',
    assetBase: 'assets/cinematic-hero/',
    mapExt: '.webp',
    imageSrc: 'assets/web/hero-bg-001.webp',
    preset: 'flipart86V12',
    initTimeoutMs: 12000,
    idleTimeoutMs: 1500
  };

  var state = { status: 'idle', reason: null, error: null, startedAt: null, readyAt: null, autoPaused: false };
  var engine = null, canvas = null, frame = null, hero = null, io = null;

  function disabledReason() {
    var d = document.documentElement;
    if (!CONFIG.enabled) return 'config';
    if (window.FLIPART86_CINEMATIC === false) return 'global-flag';
    if (d.getAttribute('data-cinematic') === 'off') return 'html-attribute';
    if (/[?&]cinematic=0\b/.test(location.search)) return 'url';
    try { if (localStorage.getItem('flipart86_cinematic') === 'off') return 'stored-preference'; } catch (e) { /* optional */ }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced-motion';
    var c = navigator.connection;
    if (c && c.saveData) return 'save-data';
    if (!('WebGL2RenderingContext' in window)) return 'no-webgl2';
    return null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Skript nicht ladbar: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadStyle(href) {
    if (document.querySelector('link[data-cinematic-css]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-cinematic-css', '');
    document.head.appendChild(l);
  }

  function teardown(status, reason) {
    if (io) { io.disconnect(); io = null; }
    if (engine) { try { engine.destroy(); } catch (e) { /* ignorieren */ } engine = null; }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    if (frame) frame.classList.remove('ch-ready', 'ch-no-webgl');
    state.status = status;
    if (reason) state.reason = reason;
  }

  function watchVisibility() {
    if (!('IntersectionObserver' in window)) return;
    io = new IntersectionObserver(function (entries) {
      if (!engine || !engine.initialized) return;
      var visible = entries[0].isIntersecting;
      if (!visible && engine.running) { state.autoPaused = true; engine.pause(); }
      else if (visible && state.autoPaused) { state.autoPaused = false; engine.resume(); }
    });
    io.observe(hero);
  }

  function start() {
    var reason = disabledReason();
    if (reason) { state.status = 'disabled'; state.reason = reason; return Promise.resolve(state); }
    hero = document.getElementById('main-content');
    frame = hero && hero.querySelector('.hx-frame');
    var img = frame && frame.querySelector('img:not(.hx-bloom)');
    if (!img) { state.status = 'unavailable'; state.reason = 'hero-markup'; return Promise.resolve(state); }

    state.status = 'loading'; state.startedAt = performance.now();
    loadStyle(CONFIG.styleHref);
    var scriptsReady = (window.SCENE_DATA && window.CinematicHeroEngine) ? Promise.resolve() :   // bei erneutem enable() nicht doppelt laden
      loadScript(CONFIG.scriptBase + 'cinematic-hero-scene.js')
        .then(function () { return loadScript(CONFIG.scriptBase + 'cinematic-hero.js'); });
    return scriptsReady
      .then(function () {
        canvas = document.createElement('canvas');
        canvas.className = 'hx-cinematic';
        canvas.setAttribute('aria-hidden', 'true');
        img.insertAdjacentElement('afterend', canvas);       // unter der Bloom-Ebene, ueber dem Bild
        engine = new window.CinematicHeroEngine(frame, {
          assetBase: CONFIG.assetBase, mapExt: CONFIG.mapExt, imageSrc: CONFIG.imageSrc,
          powerPreference: 'default', maxDprDesktop: 2, maxDprMobile: 1
        });
        var timeout = new Promise(function (resolve) {
          setTimeout(function () { resolve('timeout'); }, CONFIG.initTimeoutMs);
        });
        return Promise.race([engine.init(), timeout]);
      })
      .then(function (res) {
        if (res === 'timeout') throw new Error('Initialisierung zu langsam');
        if (!engine || engine.error || !engine.initialized) throw new Error(engine && engine.error || 'Initialisierung fehlgeschlagen');
        engine.applyPreset(CONFIG.preset);
        engine.resume();
        state.status = 'running'; state.readyAt = performance.now();
        watchVisibility();
        var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        var onMq = function () { if (mq.matches) teardown('disabled', 'reduced-motion'); };
        if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
        return state;
      })
      .catch(function (err) {
        state.error = err && err.message || String(err);
        teardown('fallback', 'error');
        return state;
      });
  }

  function schedule() {
    var go = function () { start(); };
    var idle = function () {
      if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: CONFIG.idleTimeoutMs });
      else setTimeout(go, 200);
    };
    if (document.readyState === 'complete') idle();
    else window.addEventListener('load', idle, { once: true });
  }

  // Oeffentliche, bewusst kleine API (z. B. fuer einen spaeteren, diskreten Besucher-Schalter)
  window.FlipArt86Cinematic = {
    version: '1.1',
    state: state,
    get engine() { return engine; },
    disable: function (remember) {
      if (remember) { try { localStorage.setItem('flipart86_cinematic', 'off'); } catch (e) { /* optional */ } }
      teardown('disabled', 'api');
    },
    enable: function () {
      try { localStorage.removeItem('flipart86_cinematic'); } catch (e) { /* optional */ }
      if (state.status !== 'running' && state.status !== 'loading') { state.reason = null; return start(); }
      return Promise.resolve(state);
    }
  };

  schedule();
})();
