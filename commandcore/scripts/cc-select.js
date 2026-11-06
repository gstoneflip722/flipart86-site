/* ============================================================
   FlipAI CommandCore — Filter-Dropdowns (Phase 4.8.1, 2026-11-07)
   ------------------------------------------------------------
   Ersetzt die sichtbaren nativen <select class="filter-select"> durch eine
   eigene Select-only-Combobox nach dem WAI-ARIA-APG-Muster.
   Grund: native Ausklapplisten zeichnen Browser/Betriebssystem selbst
   (u. a. Safari, Brave/macOS) – Farben sind dort nicht zuverlässig steuerbar.

   Prinzip:
   - Das native <select> bleibt (versteckt) im DOM und ist weiterhin die
     Datenquelle für commandcore.js (Optionen, value, change-Listener).
   - Auswahl in der Combobox setzt select.value und löst 'change' aus,
     die bestehende Filterlogik bleibt dadurch unverändert.
   - Neue Optionen (Plattformwechsel) werden per MutationObserver übernommen;
     programmatische Wertänderungen (Reset) über CCSelect.syncAll().
   - Ohne JavaScript bleiben die nativen Selects sichtbar (Rückfall).
   ============================================================ */
(function () {
  'use strict';

  var instances = [];
  var uid = 0;

  function Combo(select) {
    this.select = select;
    this.id = select.id || ('cc-sel-' + (++uid));
    this.open = false;
    this.active = -1;
    this.typed = '';
    this.typedTimer = 0;
    this.build();
    this.rebuild();
    var self = this;
    new MutationObserver(function () { self.rebuild(); }).observe(select, { childList: true, subtree: true, characterData: true });
  }

  Combo.prototype.build = function () {
    var s = this.select, self = this;
    var label = s.getAttribute('aria-label') || '';

    var wrap = document.createElement('div');
    wrap.className = 'cc-select';

    var combo = document.createElement('div');
    combo.className = 'filter-select cc-combo';
    combo.id = this.id + '-combo';
    combo.setAttribute('role', 'combobox');
    combo.setAttribute('tabindex', '0');
    combo.setAttribute('aria-haspopup', 'listbox');
    combo.setAttribute('aria-expanded', 'false');
    combo.setAttribute('aria-controls', this.id + '-list');
    if (label) combo.setAttribute('aria-label', label);

    var value = document.createElement('span');
    value.className = 'cc-combo-value';
    combo.appendChild(value);

    var list = document.createElement('ul');
    list.className = 'cc-listbox';
    list.id = this.id + '-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '-1');
    if (label) list.setAttribute('aria-label', label);
    list.hidden = true;

    wrap.appendChild(combo);
    wrap.appendChild(list);
    s.parentNode.insertBefore(wrap, s);
    s.hidden = true;                      /* natives Select bleibt Datenquelle, aber unsichtbar */
    s.setAttribute('tabindex', '-1');
    s.setAttribute('aria-hidden', 'true');

    this.wrap = wrap; this.combo = combo; this.valueEl = value; this.list = list;

    combo.addEventListener('click', function () { self.open ? self.close() : self.show(self.selectedIndex()); });
    combo.addEventListener('keydown', function (e) { self.onKey(e); });
    combo.addEventListener('blur', function () { if (self.open) self.close(); });

    /* Fokus beim Klick auf eine Option auf der Combobox halten */
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var li = e.target.closest('[role="option"]');
      if (!li) return;
      self.choose(+li.getAttribute('data-i'));
      self.close();
      self.combo.focus({ preventScroll: true });
    });
    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest('[role="option"]');
      if (li) self.setActive(+li.getAttribute('data-i'), false);
    });
  };

  /* Optionen aus dem nativen Select übernehmen */
  Combo.prototype.rebuild = function () {
    var opts = this.select.options, list = this.list, value = this.valueEl;
    list.textContent = ''; value.textContent = '';
    for (var i = 0; i < opts.length; i++) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = this.id + '-opt-' + i;
      li.setAttribute('data-i', i);
      li.textContent = opts[i].textContent;
      list.appendChild(li);
      /* Alle Beschriftungen in einer Rasterzelle: Breite = längster Eintrag (wie natives Select),
         sichtbar ist nur die aktuelle Auswahl */
      var span = document.createElement('span');
      span.className = 'cc-combo-label';
      span.textContent = opts[i].textContent;
      value.appendChild(span);
    }
    if (this.open) this.close();
    this.sync();
  };

  Combo.prototype.selectedIndex = function () { return Math.max(0, this.select.selectedIndex); };

  /* Anzeige an den Wert des nativen Selects angleichen */
  Combo.prototype.sync = function () {
    var sel = this.selectedIndex();
    var lis = this.list.children, labels = this.valueEl.children;
    for (var i = 0; i < lis.length; i++) {
      var on = i === sel;
      lis[i].setAttribute('aria-selected', on ? 'true' : 'false');
      labels[i].classList.toggle('is-current', on);
      if (on) labels[i].removeAttribute('aria-hidden'); else labels[i].setAttribute('aria-hidden', 'true');
    }
    this.combo.classList.toggle('is-filtered', !!this.select.value);
  };

  Combo.prototype.choose = function (i) {
    var s = this.select;
    if (i < 0 || i >= s.options.length) return;
    if (s.selectedIndex !== i) {
      s.selectedIndex = i;
      s.dispatchEvent(new Event('change', { bubbles: true }));   /* bestehende Filterlogik */
    }
    this.sync();
  };

  Combo.prototype.setActive = function (i, scroll) {
    var lis = this.list.children;
    if (!lis.length) return;
    i = Math.max(0, Math.min(lis.length - 1, i));
    if (this.active >= 0 && lis[this.active]) lis[this.active].classList.remove('is-active');
    this.active = i;
    lis[i].classList.add('is-active');
    this.combo.setAttribute('aria-activedescendant', lis[i].id);
    if (scroll !== false) lis[i].scrollIntoView({ block: 'nearest' });
  };

  Combo.prototype.show = function (activeIndex) {
    if (this.open || !this.list.children.length) return;
    closeOthers(this);
    this.open = true;
    this.list.hidden = false;
    this.combo.setAttribute('aria-expanded', 'true');
    this.wrap.classList.add('is-open');
    this.place();
    this.setActive(activeIndex == null ? this.selectedIndex() : activeIndex);
  };

  Combo.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.list.hidden = true;
    this.combo.setAttribute('aria-expanded', 'false');
    this.combo.removeAttribute('aria-activedescendant');
    this.wrap.classList.remove('is-open', 'cc-up', 'cc-right');
    if (this.active >= 0 && this.list.children[this.active]) this.list.children[this.active].classList.remove('is-active');
    this.active = -1;
  };

  /* Liste vollständig sichtbar halten: Höhe begrenzen, ggf. nach oben bzw. rechtsbündig öffnen */
  Combo.prototype.place = function () {
    var w = this.wrap, l = this.list;
    w.classList.remove('cc-up', 'cc-right');
    var r = this.combo.getBoundingClientRect();
    var vh = window.innerHeight, vw = document.documentElement.clientWidth;
    var below = vh - r.bottom - 12, above = r.top - 12;
    var up = below < 200 && above > below;
    var space = up ? above : below;
    l.style.maxHeight = Math.max(140, Math.min(340, space)) + 'px';
    if (up) w.classList.add('cc-up');
    var lr = l.getBoundingClientRect();
    if (lr.right > vw - 8) w.classList.add('cc-right');
  };

  Combo.prototype.typeahead = function (ch) {
    var self = this;
    clearTimeout(this.typedTimer);
    this.typed += ch.toLowerCase();
    this.typedTimer = setTimeout(function () { self.typed = ''; }, 600);
    var lis = this.list.children, n = lis.length;
    if (!n) return;
    if (!this.open) this.show();          /* APG: Tippen öffnet die Liste und markiert den Treffer */
    var start = this.active;
    var from = this.typed.length === 1 ? start + 1 : start;
    for (var k = 0; k < n; k++) {
      var i = (from + k) % n;
      if (lis[i].textContent.toLowerCase().indexOf(this.typed) === 0) { this.setActive(i); return; }
    }
  };

  Combo.prototype.onKey = function (e) {
    var key = e.key, n = this.list.children.length;
    if (!this.open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        e.preventDefault(); this.show(); return;
      }
      if (key === 'Home') { e.preventDefault(); this.show(0); return; }
      if (key === 'End')  { e.preventDefault(); this.show(n - 1); return; }
    } else {
      switch (key) {
        case 'ArrowDown': e.preventDefault(); if (e.altKey) return; this.setActive(this.active + 1); return;
        case 'ArrowUp':
          e.preventDefault();
          if (e.altKey) { this.choose(this.active); this.close(); return; }
          this.setActive(this.active - 1); return;
        case 'Home': e.preventDefault(); this.setActive(0); return;
        case 'End': e.preventDefault(); this.setActive(n - 1); return;
        case 'PageDown': e.preventDefault(); this.setActive(this.active + 10); return;
        case 'PageUp': e.preventDefault(); this.setActive(this.active - 10); return;
        case 'Enter': case ' ':
          e.preventDefault(); this.choose(this.active); this.close(); return;
        case 'Escape':
          e.preventDefault(); e.stopPropagation(); this.close(); return;
        case 'Tab':
          this.choose(this.active); this.close(); return;   /* APG: Tab übernimmt die Auswahl, Fokus wandert weiter */
      }
    }
    /* Tipp-Suche (ohne '/' – reserviert für die Suche) */
    if (key.length === 1 && key !== '/' && key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.typeahead(key);
    }
  };

  function closeOthers(except) {
    instances.forEach(function (c) { if (c !== except) c.close(); });
  }

  /* Klick/Tippen außerhalb schließt */
  document.addEventListener('pointerdown', function (e) {
    instances.forEach(function (c) { if (c.open && !c.wrap.contains(e.target)) c.close(); });
  });
  window.addEventListener('resize', function () { closeOthers(null); });

  var selects = document.querySelectorAll('select.filter-select');
  for (var i = 0; i < selects.length; i++) instances.push(new Combo(selects[i]));

  window.CCSelect = {
    syncAll: function () { instances.forEach(function (c) { c.sync(); }); },
    instances: instances
  };
})();
