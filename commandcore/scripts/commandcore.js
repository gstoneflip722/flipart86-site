/* FlipAI CommandCore — Web-Version · FlipArt86 · 2026-09-19 */
(function () {
  'use strict';

  let DATA = { chatgpt: [], claude: [], codex: [] };
  let platform = 'chatgpt';
  let searchVal = '';
  let filterCat = '';
  let filterStatus = '';
  let filterType = '';
  let favOnly = false;
  let FAVS = {};

  const docEl       = document.documentElement;
  const platBtns    = document.querySelectorAll('.plat-btn');
  const searchInput = document.getElementById('cc-search');
  const searchClear = document.getElementById('cc-search-clear');
  const selCat      = document.getElementById('cc-cat');
  const selStatus   = document.getElementById('cc-status');
  const selType     = document.getElementById('cc-type');
  const favToggle   = document.getElementById('cc-fav-toggle');
  const btnReset    = document.getElementById('cc-reset');
  const cmdList     = document.getElementById('cc-list');
  const emptyState  = document.getElementById('cc-empty');
  const statTotal   = document.getElementById('stat-total');
  const statMatch   = document.getElementById('stat-match');
  const statFav     = document.getElementById('stat-fav');
  const toast       = document.getElementById('cc-toast');
  let toastTimer    = null;

  function loadData() {
    fetch('data/commands.json')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(json) {
        DATA = json;
        initFavs();
        populateFilters();
        render();
      })
      .catch(function(err) {
        console.error('CommandCore: Daten konnten nicht geladen werden', err);
        emptyState.classList.add('visible');
        emptyState.querySelector('.empty-title').textContent = 'Daten konnten nicht geladen werden';
        emptyState.querySelector('.empty-sub').textContent = 'Bitte lokal über HTTP-Server öffnen.';
      });
  }

  function initFavs() {
    try {
      var saved = localStorage.getItem('cc_favs');
      if (saved) {
        var p = JSON.parse(saved);
        FAVS.chatgpt = new Set(p.chatgpt || []);
        FAVS.claude  = new Set(p.claude  || []);
        FAVS.codex   = new Set(p.codex   || []);
        return;
      }
    } catch(e) {}
    FAVS.chatgpt = new Set();
    FAVS.claude  = new Set();
    FAVS.codex   = new Set();
  }

  function saveFavs() {
    try {
      localStorage.setItem('cc_favs', JSON.stringify({
        chatgpt: Array.from(FAVS.chatgpt || []),
        claude:  Array.from(FAVS.claude  || []),
        codex:   Array.from(FAVS.codex   || [])
      }));
    } catch(e) {}
  }

  function isFav(id) { return (FAVS[platform] || new Set()).has(id); }

  function toggleFav(id) {
    var set = FAVS[platform] || (FAVS[platform] = new Set());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    saveFavs();
    updateFavChip();
    render();
  }

  function updateFavChip() {
    var count = (FAVS[platform] || new Set()).size;
    if (statFav) statFav.textContent = count;
  }

  function populateFilters() {
    var entries = DATA[platform] || [];
    var cats     = unique(entries.map(function(e){ return e.category; })).sort();
    var statuses = unique(entries.map(function(e){ return e.status;   })).sort();
    var types    = unique(entries.map(function(e){ return e.type;     })).sort();

    selCat.innerHTML    = '<option value="">Alle Kategorien</option>'  + cats.map(opt).join('');
    selStatus.innerHTML = '<option value="">Alle Status</option>'      + statuses.map(opt).join('');
    selType.innerHTML   = '<option value="">Alle Typen</option>'       + types.map(opt).join('');

    if (statTotal) statTotal.textContent = entries.length;
    updateFavChip();
  }

  function unique(arr) {
    var seen = {};
    return arr.filter(function(v) {
      if (!v || seen[v]) return false;
      seen[v] = true; return true;
    });
  }

  function opt(v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }

  function render() {
    var entries = DATA[platform] || [];
    var q = searchVal.trim().toLowerCase();

    var filtered = entries.filter(function(e) {
      if (filterCat    && e.category !== filterCat)    return false;
      if (filterStatus && e.status   !== filterStatus) return false;
      if (filterType   && e.type     !== filterType)   return false;
      if (favOnly && !isFav(e.id)) return false;
      if (q) {
        var hay = ((e.command || '') + ' ' + (e.description || '') + ' ' + (e.searchTerms || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    if (statMatch) statMatch.textContent = filtered.length;

    filtered.sort(function(a, b) {
      return (isFav(a.id) ? 0 : 1) - (isFav(b.id) ? 0 : 1);
    });

    cmdList.innerHTML = '';

    if (filtered.length === 0) {
      emptyState.classList.add('visible');
    } else {
      emptyState.classList.remove('visible');
      var frag = document.createDocumentFragment();
      filtered.forEach(function(e) { frag.appendChild(buildRow(e)); });
      cmdList.appendChild(frag);
    }
  }

  function buildRow(e) {
    var fav = isFav(e.id);
    var row = document.createElement('div');
    row.className = 'cmd-row' + (fav ? ' fav-row' : '');
    row.dataset.id = e.id;
    row.innerHTML =
      '<div class="cmd-cell cmd-cell-cmd" title="' + esc(e.command) + '">' +
        '<button class="btn-fav' + (fav?' fav-active':'') + '" title="' + (fav?'Favorit entfernen':'Favorit merken') + '" aria-label="' + (fav?'Favorit entfernen':'Favorit merken') + '" data-action="fav">' + (fav?'★':'☆') + '</button>' +
        '<span class="cmd-text" tabindex="0" role="button" title="Klicken zum Kopieren" aria-label="Befehl kopieren: ' + esc(e.command) + '" data-action="copy" data-val="' + esc(e.command) + '">' + esc(e.command) + '</span>' +
      '</div>' +
      '<div class="cmd-cell cmd-cell-desc">' + esc(e.description) + '</div>' +
      '<div class="cmd-cell cmd-cell-cat">'  + esc(e.category || '') + '</div>' +
      '<div class="cmd-cell cmd-cell-status"><span class="status-chip status-' + esc(e.status||'') + '">' + esc(e.status||'') + '</span></div>' +
      '<div class="cmd-cell cmd-cell-type"><span class="type-chip">' + esc(e.type||'') + '</span></div>';
    return row;
  }

  cmdList.addEventListener('click', function(e) {
    var row = e.target.closest('.cmd-row');
    if (!row) return;
    var id = row.dataset.id;
    var action = e.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'copy') {
      copyText(action.dataset.val);
      action.classList.add('copied');
      setTimeout(function(){ action.classList.remove('copied'); }, 1400);
    }
    if (action.dataset.action === 'fav') { toggleFav(id); }
  });

  /* Tastatur-Unterstützung: Enter/Leertaste auf fokussiertem Befehlstext */
  cmdList.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var copyEl = e.target.closest('[data-action="copy"]');
    if (!copyEl) return;
    e.preventDefault();
    copyText(copyEl.dataset.val);
    copyEl.classList.add('copied');
    setTimeout(function(){ copyEl.classList.remove('copied'); }, 1400);
  });

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function(){ fallbackCopy(text); });
    } else { fallbackCopy(text); }
    showToast('Kopiert: ' + text.substring(0, 48) + (text.length > 48 ? '…' : ''));
  }

  function fallbackCopy(text) {
    var el = document.createElement('textarea');
    el.value = text; el.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(el);
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.classList.remove('show'); }, 2000);
  }

  platBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      platform = this.dataset.p;
      platBtns.forEach(function(b){ b.classList.toggle('active', b.dataset.p === platform); });
      docEl.setAttribute('data-platform', platform);
      filterCat = ''; filterStatus = ''; filterType = '';
      selCat.value = ''; selStatus.value = ''; selType.value = '';
      populateFilters();
      render();
    });
  });

  searchInput.addEventListener('input', function() {
    searchVal = this.value;
    searchClear.classList.toggle('visible', searchVal.length > 0);
    render();
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      this.value = ''; searchVal = '';
      searchClear.classList.remove('visible'); render();
    }
  });
  searchClear.addEventListener('click', function() {
    searchInput.value = ''; searchVal = '';
    this.classList.remove('visible'); searchInput.focus(); render();
  });

  selCat.addEventListener('change',    function(){ filterCat    = this.value; render(); });
  selStatus.addEventListener('change', function(){ filterStatus = this.value; render(); });
  selType.addEventListener('change',   function(){ filterType   = this.value; render(); });

  favToggle.addEventListener('click', function() {
    favOnly = !favOnly;
    this.classList.toggle('active', favOnly);
    this.setAttribute('aria-pressed', favOnly);
    render();
  });

  function resetAll() {
    searchInput.value = ''; searchVal = '';
    searchClear.classList.remove('visible');
    filterCat = ''; filterStatus = ''; filterType = '';
    selCat.value = ''; selStatus.value = ''; selType.value = '';
    favOnly = false; favToggle.classList.remove('active');
    favToggle.setAttribute('aria-pressed', 'false');
    render();
  }
  btnReset.addEventListener('click', resetAll);
  document.getElementById('cc-empty-reset').addEventListener('click', resetAll);

  document.addEventListener('keydown', function(e) {
    if (e.key === '/' && document.activeElement !== searchInput && e.target.tagName !== 'INPUT') {
      e.preventDefault(); searchInput.focus();
    }
  });

  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  docEl.setAttribute('data-platform', platform);
  loadData();
})();
