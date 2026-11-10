/* unCommander — two-pane file manager for the unRAID webGUI.
 * Core rule: never stat a file you are not about to draw. Listings arrive as
 * names + types only; sizes, dates and perms are fetched for visible rows. */
(function () {
  'use strict';
  const root = document.getElementById('uc');
  /* touch or mouse? (row hover shading is for mice only - see .uc-touch in the CSS) */
  root.addEventListener('touchstart', () => root.classList.add('uc-touch'), { passive: true, capture: true });
  /* iPad (Safari, and Firefox, which is Safari inside): a press-and-hold starts
   * selecting text - with the rows unselectable it grabbed the whole page. No
   * text selection from a finger, except in text boxes and in windows' text. */
  const selOk = t => t && t.closest && t.closest('input, textarea, [contenteditable="true"], .uc-dlg .dlg-body');
  document.addEventListener('selectstart', e => {
    if (!root.classList.contains('uc-touch')) return;
    const t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if ((root.contains(t) || t === document.body || t === document.documentElement) && !selOk(t)) e.preventDefault();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!root.classList.contains('uc-touch')) return;
    const s = getSelection(); if (!s || s.isCollapsed) return;
    const n = s.anchorNode && (s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode);
    let menuOpen = false; try { menuOpen = !ctxEl.hidden; } catch (e) {}
    if (!selOk(n) && (root.contains(n) || n === document.body || n === document.documentElement || menuOpen)) s.removeAllRanges();
  });
  root.addEventListener('touchstart', () => document.documentElement.classList.add('uc-noselect'), { passive: true, capture: true });
  /* true while the terminal was the last thing clicked: then Ctrl+C / X / V belong to it, never to the panes */
  let termLast = false;
  /* ---------- the terminal at the bottom ----------
   * unRAID's own web terminal, under the two panes and as wide as both. Hide
   * keeps it running (until the page is reloaded); Exit logs off. */
  {
    const tEl = root.querySelector('.uc-term'), tFr = tEl && tEl.querySelector('.ut-frame'), tBtn = root.querySelector('.uc-termbtn');
    const relayout = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    /* type into the terminal, as if from the keyboard */
    const send = data => {
      try {
        const t = tFr.contentWindow && tFr.contentWindow.term;
        if (!t) throw new Error('no terminal');
        if (typeof t.input === 'function') t.input(data, true); else t._core.coreService.triggerDataEvent(data, true);
        t.focus && t.focus(); tFr.focus();
        return true;
      } catch (e) { toast("Couldn't type into the terminal - click into it and type it there", true); return false; }
    };
    /* pasted text: as a paste (the shell knows it's a paste, so a long script isn't run line by line as it arrives) */
    const sendPaste = data => {
      try { const t = tFr.contentWindow && tFr.contentWindow.term; if (t && typeof t.paste === 'function') { t.paste(data); t.focus && t.focus(); tFr.focus(); return true; } } catch (e) {}
      return send(data);
    };
    /* Ctrl+V inside the terminal: a paste (the terminal on its own sends Ctrl+V to the shell, which does nothing useful) */
    const hookKeys = (n = 0) => {
      let t = null; try { t = tFr.contentWindow && tFr.contentWindow.term; } catch (e) {}
      if (!t || typeof t.attachCustomKeyEventHandler !== 'function') { if (n < 50) setTimeout(() => hookKeys(n + 1), 200); return; }
      t.attachCustomKeyEventHandler(e => !(e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v'));
      /* the paste box hint: the terminal's own dim text colour (its text colour half way to its background) */
      try {
        const th = (t.options && t.options.theme) || {}, hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null; };
        const f = hex(th.foreground) || [255, 255, 255], b = hex(th.background) || [0, 0, 0];
        tEl.style.setProperty('--ut-dim', '#' + f.map((v, i) => Math.round((v + b[i]) / 2).toString(16).padStart(2, '0')).join(''));
      } catch (e) {}
    };
    /* the connection dropped (the browser paused the page when you switched apps, or the server went away):
     * ttyd then shows "Connection Closed". Load the terminal again as soon as the page is in front - the new
     * session shows the earlier one above it. Only when it really is closed, so a running command isn't cut. */
    let tDead = false, tTries = 0;
    const closedNow = () => {
      try {
        const d = tFr.contentDocument; if (!d || !d.body) return false;
        /* ttyd's message box (no class name of its own) - not text in the terminal itself */
        const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode());) if (/^\s*(connection closed|press .{0,4} to reconnect)/i.test(n.nodeValue) && !(n.parentElement && n.parentElement.closest('.xterm-rows, .xterm-accessibility, .xterm-helpers'))) return true;
      } catch (e) {}
      return false;
    };
    const revive = () => {
      if (!tDead || tEl.hidden || document.visibilityState !== 'visible' || !/^https?:/.test(tFr.src)) return;
      if (++tTries > 5) return;                                  // the server really is gone - leave it on "Connection Closed"
      tDead = false; tFr.src = tFr.src;
    };
    const watchClose = () => {
      try {
        const d = tFr.contentDocument; if (!d || !d.body) return;
        new MutationObserver(() => { if (!tDead && closedNow()) { tDead = true; setTimeout(revive, 1500); } }).observe(d.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!tDead && closedNow()) tDead = true; setTimeout(revive, 300); } });
    window.addEventListener('focus', () => { if (!tDead && closedNow()) tDead = true; setTimeout(revive, 300); });
    setInterval(() => { if (!tEl.hidden && closedNow()) { tDead = true; revive(); } else if (!tEl.hidden && tTries && !closedNow()) tTries = 0; }, 5000);
    if (tFr) tFr.addEventListener('load', () => { hookKeys(); watchClose(); });
    /* the folder in the header, as clickable parts: a click goes there in the terminal */
    const setDir = d => {
      const el = tEl.querySelector('.ut-dir'), segs = d.split('/').filter(Boolean);
      el.innerHTML = `<button type="button" class="ut-seg" data-d="/">/</button>` + segs.map((x, i) => `<button type="button" class="ut-seg" data-d="${esc('/' + segs.slice(0, i + 1).join('/'))}">${esc(x)}</button>`).join('<i>/</i>');
      el.title = d;
    };
    const show = on => { store.set('termOpen', on); tEl.hidden = !on; root.classList.toggle('uc-termon', on); tBtn.classList.toggle('on', on); relayout(); if (on) setTimeout(() => { try { tFr.focus(); tFr.contentWindow.focus(); } catch (e) {} }, 60); };
    if (tEl && tBtn) {
      tBtn.addEventListener('click', async () => {
        tBtn.blur();
        if (!tEl.hidden) return show(false);
        if (!tFr.getAttribute('src') || tFr.getAttribute('src') === 'about:blank') {
          const P = typeof A === 'function' ? A() : null, cwd = P && P.mode === 'dir' ? P.path : '/root';
          try { const r = await api('term_start', { cwd }); tFr.src = r.url; setDir(cwd); }
          catch (e) { return toast(e.message, true); }
        }
        show(true);
      });
      tEl.querySelector('.ut-hide').addEventListener('click', () => show(false));
      tEl.querySelector('.ut-clear').addEventListener('click', e => { e.currentTarget.blur(); send('clear\r'); });
      /* paste w/ edit: a box to paste into (or type), fix the command up with the mouse, Enter runs it.
       * It stays open for the next one; Up brings back the last one run. */
      const pbox = tEl.querySelector('.ut-pbox'), pta = tEl.querySelector('.ut-pta'), ran = [];
      let ri = -1;
      const pfit = () => { pta.style.height = 'auto'; pta.style.height = Math.min(220, Math.max(38, pta.scrollHeight + 2)) + 'px'; };
      const pclose = () => { pbox.hidden = true; pta.value = ''; relayout(); };
      const prun = () => {
        const t = pta.value.replace(/\s+$/, ''); if (!t) return;
        if (sendPaste(t)) { send('\r'); ran.unshift(t); ri = -1; pta.value = ''; pfit(); setTimeout(() => pta.focus(), 50); }
      };
      tEl.querySelector('.ut-paste').addEventListener('click', async e => {
        e.currentTarget.blur();
        pbox.hidden = false; relayout();
        if (!pta.value && navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) { try { pta.value = (await navigator.clipboard.readText()).replace(/\s+$/, ''); } catch (er) {} }
        pfit(); pta.focus();
      });
      pta.addEventListener('input', pfit);
      pta.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); return pclose(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return prun(); }
        /* Up / Down at the very start or end: the commands run from here */
        if ((e.key === 'ArrowUp' && pta.selectionStart === 0) || (e.key === 'ArrowDown' && pta.selectionEnd === pta.value.length && ri >= 0)) {
          const n = ri + (e.key === 'ArrowUp' ? 1 : -1); if (n >= ran.length) return;
          e.preventDefault(); ri = n; pta.value = n < 0 ? '' : ran[n]; pfit();
        }
      });
      tEl.querySelector('.ut-prun').addEventListener('click', prun);
      tEl.querySelector('.ut-pcan').addEventListener('click', pclose);
      tEl.querySelector('.ut-dir').addEventListener('click', e => {
        const b = e.target.closest('[data-d]'); if (!b) return;
        const d = b.dataset.d;
        if (send(`cd -- '${d.replace(/'/g, "'\\''")}'\r`)) setDir(d);
      });
      /* open before the page was reloaded: open again - the earlier session shows above the new prompt */
      setTimeout(() => { if (store.get('termOpen', false) && tEl.hidden) tBtn.click(); }, 400);
      tEl.querySelector('.ut-exit').addEventListener('click', () => { tFr.src = 'about:blank'; show(false); setTimeout(() => api('term_stop', {}).catch(() => {}), 800); });
      /* clicking into the terminal (its frame takes the focus - this page only sees the blur) or its header */
      window.addEventListener('blur', () => setTimeout(() => { if (document.activeElement === tFr) termLast = true; }, 0));
      document.addEventListener('pointerdown', e => { termLast = !tEl.hidden && tEl.contains(e.target); }, true);
      /* Ctrl+V with the terminal's header focused: the text goes into the terminal, not into a folder */
      document.addEventListener('paste', e => {
        if (!termLast || tEl.hidden || e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
        const t = e.clipboardData && e.clipboardData.getData('text'); if (!t) return;
        e.preventDefault(); sendPaste(t);
      });
    }
  }
  /* opened from the Home Screen: no address bar, so a Reload button of our own */
  if ((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone) {
    const rb = root.querySelector('.uc-reloadbtn');
    if (rb) { rb.hidden = false; rb.addEventListener('click', () => location.reload()); }
    /* remembered by this Home Screen app only: after its login, unRAID's Main page sends it back here (UnCommanderWebApp.page) */
    try { if (document.body.classList.contains('uc-solo') || root.classList.contains('uc-solo') || /\/uncommander\.php/.test(location.pathname)) localStorage.setItem('uc.webapp', '1'); } catch (e) {}
  }
  root.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && e.movementX + e.movementY !== 0) root.classList.remove('uc-touch'); }, { passive: true });
  if (!root) return;
  /* Show script errors on the page itself - an iPad has no console to look at. */
  const errBar = msg => {
    try {
      let bar = document.getElementById('uc-errbar');
      if (!bar) {
        bar = document.createElement('div'); bar.id = 'uc-errbar';
        bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:100000;background:#b42318;color:#fff;font:13px/1.4 -apple-system,sans-serif;padding:8px 36px 8px 12px;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.3);white-space:pre-wrap;word-break:break-word';
        bar.addEventListener('click', () => bar.remove());
        document.body.appendChild(bar);
      }
      bar.textContent = (bar.textContent ? bar.textContent + '\n' : 'unCommander hit an error (tap to close) - please send this to the developer:\n') + msg;
    } catch (e) {}
  };
  const errText = (e, where) => `${where ? where + ': ' : ''}${e && e.name ? e.name + ': ' : ''}${(e && e.message) || e}${e && e.line ? ' (line ' + e.line + ')' : ''}${e && e.stack ? ' @ ' + String(e.stack).split('\n').slice(0, 2).join(' | ') : ''} · ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '')}`;
  const benign = m => /ResizeObserver|AbortError|aborted|Script error\.?$/i.test(String(m || ''));
  window.addEventListener('error', ev => { if ((ev.filename && !/uncommander/.test(ev.filename)) || benign(ev.message) || benign(ev.error && ev.error.name)) return; errBar(errText(ev.error || ev.message, `line ${ev.lineno}:${ev.colno}`)); });
  /* only unCommander's own: unRAID's page (Connect, its web components) has errors of its own that aren't ours to report */
  window.addEventListener('unhandledrejection', ev => { const r = ev.reason, st = r && r.stack ? String(r.stack) : '';
    if (benign(r && (r.name || r.message)) || (st && !/\/uncommander\//.test(st)) || (r && /ApolloError|GraphQL/i.test(r.name || ''))) return; errBar(errText(r, 'async')); });
  const API = '/plugins/uncommander/include/api.php';
  const CSRF = root.dataset.csrf || (window.csrf_token || '');
  let ROW = 25;
  let booting = true;          // true until both panes have loaded once
  const UP_ICON = '<svg class="up" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 3 7.5h3.3V13.5h3.4V7.5H13z"/></svg>';
  let SET = window.UC_SETTINGS || { bookmarks: [], css: '', sounds: {}, trash_days: 7 };
  const $ = (s, el = root) => el.querySelector(s);
  const $$ = (s, el = root) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* ---------- this browser tab ----------
   * Every unCommander tab keeps its own panes (folders, Back/Forward, ticks, open tree
   * folders, views, active pane). The first one is "main" and uses the same saved names as
   * always; one opened with New tab gets an id in its address (?uctab=...), kept for the life
   * of the browser tab. Settings, the playlist, the player and History are shared by all. */
  let TAB = 'main', WIN_Q = '', WIN_T = '';
  try {
    const u = new URL(location.href), q = u.searchParams.get('uctab'), okId = x => !!x && /^[a-z0-9]{6,20}$/.test(x);
    /* an application window: ?ucwin=... stays in its address, so a browser that brings the window
     * back after a restart (and forgets its name) still knows it, and its tabs */
    WIN_Q = okId(u.searchParams.get('ucwin')) ? u.searchParams.get('ucwin') : '';
    if (!WIN_Q && /^uc-win-[a-z0-9]{6,20}$/.test(window.name || '')) { WIN_Q = window.name.slice(7); u.searchParams.set('ucwin', WIN_Q); history.replaceState(history.state, '', u.pathname + u.search + u.hash); }
    if (WIN_Q && window.name !== 'uc-win-' + WIN_Q) window.name = 'uc-win-' + WIN_Q;
    /* Settings > General "Tab row in every unCommander tab": an ordinary browser tab gets the row too */
    if (!WIN_Q && localStorage.getItem('uc.tabrowAll') === 'true') {
      let w = sessionStorage.getItem('uc.win');
      if (okId(q) || !okId(w)) { w = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); sessionStorage.setItem('uc.win', w); }
      WIN_T = w;
    }
    if (okId(q)) { sessionStorage.setItem('uc.tab', q); u.searchParams.delete('uctab'); history.replaceState(history.state, '', u.pathname + u.search + u.hash); }
    let v = sessionStorage.getItem('uc.tab');
    if (!okId(v) && (WIN_Q || WIN_T)) { const w = JSON.parse(localStorage.getItem('uc.win.' + (WIN_Q || WIN_T)) || 'null'); if (w && okId(w.cur)) v = w.cur; }
    if (okId(v)) TAB = v;
  } catch (e) {}
  const TAB_KEY = /^(?:(?:path|trail|hist|fwd|sel|tree|gal)[01]|active|mus|tabname)$/;
  const tabKey = (k, id = TAB) => id !== 'main' && TAB_KEY.test(k) ? `uc.t.${id}.${k}` : 'uc.' + k;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(tabKey(k)); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(tabKey(k), JSON.stringify(v)); } catch (e) {} },
  };

  /* ---------- API ---------- */
  async function api(action, params = {}, signal) {
    const body = new URLSearchParams({ action, csrf_token: CSRF });
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    let r;
    try { r = await fetch(API, { method: 'POST', body, credentials: 'same-origin', signal }); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      const n = new Error('Lost contact with the server (no connection)'); n.offline = true; throw n;   // Safari says "Load failed"
    }
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('Server error (' + r.status + ')'); }
    if (j.error) throw new Error(j.error);
    return j;
  }

  /* ---------- formatting ---------- */
  function fmtSize(n) {
    if (n == null) return '—';
    const u = ['B', 'K', 'M', 'G', 'T', 'P']; let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)) + u[i];
  }
  function fmtBytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(t) {
    if (!t) return '—';
    /* m/dd-hh:mm, 24-hour — e.g. 8/11-14:05 (the full date is in the tooltip) */
    const d = new Date(t * 1000), z = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${z(d.getDate())}-${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const join = (dir, n) => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + n;
  const parent = p => p.replace(/\/[^/]+\/?$/, '') || '/';
  const base = p => p.replace(/\/+$/, '').split('/').pop();
  function glob(pat) {
    const re = pat.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + re + '$', 'i');
  }

  /* ---------- state ---------- */
  const panes = [0, 1].map(i => ({
    i, path: store.get('path' + i, i ? '/mnt' : '/mnt/user'),
    mode: 'dir', all: [], items: [], stats: new Map(), sel: new Set(), cursor: 0,
    loading: false, error: null, free: null, trash: false, findInfo: null,
    el: $(`.uc-pane[data-pane="${i}"]`), crumb: $(`.uc-crumb[data-pane="${i}"]`),
    pathEl: $(`.uc-path[data-pane="${i}"]`), trailEl: $(`.uc-path[data-pane="${i}"] .uc-trail`), trail: store.get('trail' + i, ''),
  }));
  let active = store.get('active', 0);
  let sortKey = store.get('sort', 'name'), sortRev = store.get('rev', false);
  let showHidden = store.get('hidden', false);
  let srvSkew = 0;                                  // the server's clock minus this device's (for "changed lately")
  const recentMins = () => +store.get('recentMins', 0) || 0;          // Settings > General: mark what changed lately (this device)
  const filterMode = () => store.get('typeMode', 'jump') === 'filter'; // Settings > Keyboard: typing jumps or filters (this device)
  const rtickOn = () => !!store.get('rtick', false) && !store.get('ctxOff', false);   // Settings > Keyboard: right-click ticks (this device)
  /* ---------- F-keys: which key does what (Settings > Keyboard, this device) ---------- */
  const FK_KEYS = ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];
  const FK_ACTS = { view: 'View', edit: 'Edit', rename: 'Rename', copy: 'Copy', move: 'Move', mkdir: 'New Folder', delete: 'Delete', find: 'Find', perms: 'Perms',
    props: 'Properties', newfile: 'New File', brename: 'Batch rename', compress: 'Compress', extract: 'Extract', sizes: 'Folder sizes', compare: 'Compare', undo: 'Undo', history: 'History' };
  const FK_LONG = { copy: 'Copy to the other pane', move: 'Move to the other pane', mkdir: 'New folder', perms: 'Owner and permissions', newfile: 'New file' };
  const FK_PRESETS = {
    uc:  ['unCommander', 'F2 View · F3 Edit · F4 Rename', { F2: 'view', F3: 'edit', F4: 'rename', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'delete', F9: 'find', F10: 'perms' }],
    win: ['Windows / Midnight Commander', 'F2 Rename · F3 View · F4 Edit', { F2: 'rename', F3: 'view', F4: 'edit', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'delete', F9: 'find', F10: 'perms' }],
  };
  function fkSaved() { const v = store.get('fkeys', null); return v && v.map && typeof v.map === 'object' ? v : { preset: 'uc', map: FK_PRESETS.uc[2] }; }
  function fkMap() { return fkSaved().map; }
  function fkKeyOf(a) { const m = fkMap(); return FK_KEYS.find(k => m[k] === a) || ''; }
  /* Copy and Move point at the other pane */
  function fkArrows() {
    const ar = active === 0 ? '🠊' : '🠈';
    ['copy', 'move'].forEach(a => $$(`.uc-fk-page[data-page="f"] [data-act="${a}"] .t`).forEach(t => { t.textContent = active === 0 ? `${FK_ACTS[a]} ${ar}` : `${ar} ${FK_ACTS[a]}`; }));
  }
  /* the F-key row of the button bar, in key order */
  function renderFk() {
    const pg = $('.uc-fk-page[data-page="f"]'); if (!pg) return;
    $$('.uc-fk[data-act]:not(.uc-restore)', pg).forEach(b => b.remove());
    const rs = $('.uc-restore', pg), m = fkMap();
    FK_KEYS.forEach(k => {
      const a = m[k]; if (!a || !FK_ACTS[a]) return;
      const b = document.createElement('button');
      b.className = 'uc-fk' + (a === 'delete' ? ' danger' : ''); b.dataset.act = a;
      b.innerHTML = `<span class="k">${k}</span>` + (a === 'copy' || a === 'move' ? `<span class="t">${FK_ACTS[a]}</span>` : esc(FK_ACTS[a]));
      b.addEventListener('click', () => act(a));
      pg.insertBefore(b, rs);
    });
    fkArrows();
    try { applyPractice(); arcKeys(); } catch (e) {}
  }
  const A = () => panes[active], B = () => panes[1 - active];
  const fullPath = (p, it) => it.abs || join(p.path, it.n);

  /* ---------- columns each pane shows ---------- */
  const COL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"/><circle cx="5" cy="3.5" r="1.4" fill="currentColor"/><circle cx="10.5" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="12.5" r="1.4" fill="currentColor"/></svg>';
  const COLS = [['size', 'Size', '46px'], ['disk', 'Disk', '62px'], ['date', 'Date', '72px'], ['mode', 'Mode', '34px']];
  /* Disk is off unless switched on, and only shows where it means something:
   * /mnt/user (and search results, which can be anywhere). */
  const colWanted = (c, k) => k === 'disk' ? c.disk === true : c[k] !== false;
  const userView = p => p.mode !== 'dir' || /^\/mnt\/user0?(\/|$)/.test(p.path || '');
  const showsDisk = p => colWanted(store.get('cols' + p.i, {}), 'disk') && userView(p) && !p.arc;
  function applyCols(p) {
    const c = store.get('cols' + p.i, {});
    let tmpl = '36px minmax(0,1fr)';
    for (const [k, , w] of COLS) {
      const on = colWanted(c, k) && (k !== 'disk' || userView(p));
      p.el.classList.toggle('hide-' + k, !on); if (on) tmpl += ` calc(${w} * var(--fs, 1))`;   // widths grow with the text size
    }
    p.el.style.setProperty('--cols', tmpl);
  }
  function drawColPop(p) {
    const c = store.get('cols' + p.i, {});
    p.colPop.innerHTML = `<div class="h">Show columns</div>
      <div class="r fixed"><span>Name</span><span class="sub">always</span></div>
      ${COLS.map(([k, l]) => `<div class="r" data-col="${k}" role="switch" aria-checked="${colWanted(c, k)}"><span>${l}${k === 'disk' ? ' <span class="sub">· which disk or pool it\'s on (/mnt/user only)</span>' : ''}</span><span class="uc-sw ${colWanted(c, k) ? 'on' : ''}"></span></div>`).join('')}
      <div class="ft">Tap a column title to sort, as before. Hidden columns give their room to the names. Each pane remembers its own choice.</div>`;
  }
  function toggleColPop(p, show) {
    panes.forEach(q => { if (q !== p || !show) { q.colPop.hidden = true; q.colBtn.classList.remove('on'); } });
    if (show) { drawColPop(p); p.colPop.hidden = false; p.colBtn.classList.add('on'); }
  }
  document.addEventListener('click', e => { if (!e.target.closest('.uc-colpop, .uc-colbtn')) panes.forEach(q => { if (q.colPop && !q.colPop.hidden) toggleColPop(q, false); }); });

  /* ---------- pane skeleton ---------- */
  for (const p of panes) {
    p.el.innerHTML = `
      <div class="uc-box">
      <div class="uc-pane-head"><span class="uc-headl"><button class="uc-back" disabled title="Back to the folder you were in before" aria-label="Back"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button><span class="side"></span><button class="uc-fwd" disabled title="Forward" aria-label="Forward"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button><span class="act"></span></span><button class="uc-endfind" hidden title="Leave the search results and go back to the folder">✕ Close results</button><button class="uc-cancel" hidden title="Stop waiting for this folder">✕ Cancel</button><span class="count"></span><span class="hfree"></span><span class="uc-galsz" hidden title="Tile size"><button type="button" data-gs="s">S</button><button type="button" data-gs="m">M</button><button type="button" data-gs="l">L</button></span><button type="button" class="uc-galbtn" hidden aria-label="Gallery view"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="9.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/></svg></button><button type="button" class="uc-musbtn" hidden aria-label="Music library"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12V3.2l7.5-1.6v8.6"/><circle cx="4.2" cy="12" r="1.9"/><circle cx="11.7" cy="10.2" r="1.9"/></svg></button><button type="button" class="uc-endmus" hidden title="Back to the normal two panes (both stay where they are)">✕ Close music library</button></div>
      <div class="uc-arcbar" hidden><span class="ab-t"></span><button type="button" class="uc-arcclose" title="Go back to the folder the archive is in">✕ Close archive</button></div>
      <div class="uc-cols">
        <div data-k="sel" class="col-sel"></div><div data-k="name" class="col-name">Name</div><div data-k="size" class="col-size" style="text-align:right">Size</div><div data-k="disk" class="col-disk" title="Which disk or pool it's on">Disk</div>
        <div data-k="mtime" class="col-date">Date</div><div data-k="perm" class="col-mode">Mode</div>
        <button class="uc-colbtn" title="Show or hide columns" aria-label="Show or hide columns">${COL_ICON}</button>
        <section class="uc-colpop" hidden></section>
      </div>
      <div class="uc-list"><div class="uc-spacer-v"></div></div>
      </div>
      <div class="uc-pane-foot"><span class="selinfo"></span><span class="freeinfo"></span></div>`;
    p.list = $('.uc-list', p.el);
    p.colBtn = $('.uc-colbtn', p.el); p.colPop = $('.uc-colpop', p.el);
    applyCols(p);
    p.colBtn.addEventListener('click', e => { e.stopPropagation(); setActive(p.i); toggleColPop(p, p.colPop.hidden); });
    p.colPop.addEventListener('click', e => {
      e.stopPropagation();
      const r = e.target.closest('[data-col]'); if (!r) return;
      const c = store.get('cols' + p.i, {}), k = r.dataset.col; c[k] = !colWanted(c, k);
      store.set('cols' + p.i, c); sound.play('click');
      applyCols(p); drawColPop(p); drawRows(p); queueStat(p);
    });
    p.spacer = $('.uc-spacer-v', p.el);
    $('.uc-endfind', p.el).addEventListener('click', () => load(p, p.findInfo.start));
    $('.uc-arcclose', p.el).addEventListener('click', e => { e.stopPropagation(); if (p.arc) load(p, parent(p.arc.file), base(p.arc.file)); });
    $('.uc-galbtn', p.el).addEventListener('click', e => { e.stopPropagation(); setActive(p.i); galSet(p, !p.gal); });
    $('.uc-galsz', p.el).addEventListener('click', e => { const b = e.target.closest('[data-gs]'); if (!b) return; e.stopPropagation();
      store.set('galSize', b.dataset.gs); p.el.style.setProperty('--tile', galSize()[0] + 'px'); p.galItems = null; drawRows(p); galScroll(p); });
    $('.uc-cancel', p.el).addEventListener('click', () => cancelLoad(p));
    $('.uc-musbtn', p.el).addEventListener('click', e => { e.stopPropagation(); setActive(p.i); mus ? musExit() : musEnter(p); });
    $('.uc-endmus', p.el).addEventListener('click', e => { e.stopPropagation(); musExit(); });
    p.list.addEventListener('error', e => { const t = e.target; if (t.classList && t.classList.contains('tl-cover')) { const s2 = document.createElement('span'); s2.className = 'tl-ic dir'; s2.innerHTML = GI.dir; t.replaceWith(s2); } }, true);
    p.hist = store.get('hist' + p.i, []); p.fwd = store.get('fwd' + p.i, []);
    $('.uc-back', p.el).addEventListener('click', e => { e.stopPropagation(); goBack(p); });
    $('.uc-fwd', p.el).addEventListener('click', e => { e.stopPropagation(); goForward(p); });
    p.list.addEventListener('scroll', () => { if (p.gal || p.mt) return; drawRows(p); queueStat(p); }, { passive: true });
    /* Clicking a row of the other pane makes it active. Done after the click:
     * redrawing the rows on mousedown would swallow the click itself, so the
     * first click only switched panes instead of also picking the row. */
    p.el.addEventListener('mousedown', e => {
      if (e.button === 0 && active !== p.i && e.target.closest('.uc-list .uc-row')) { p.actLater = true; return; }
      setActive(p.i);
    });
    p.el.addEventListener('mouseup', () => { if (p.actLater) { p.actLater = false; setTimeout(() => setActive(p.i), 0); } });
    p.list.addEventListener('click', e => onRowClick(p, e));
    /* Remember whether the last press was a finger or a mouse — taps get
     * tablet behaviour (tap to pick, tap again to open). */
    p.list.addEventListener('pointerdown', e => { p.pointer = e.pointerType; });
    /* iPad Safari runs in "desktop" mode and can report finger taps as mouse
     * pointers — but it can't fake touch events, so those are the real tell. */
    p.list.addEventListener('touchstart', () => { p.touchAt = Date.now(); }, { passive: true });
    p.list.addEventListener('dblclick', e => {
      const r = e.target.closest('.uc-row'); if (!r || e.target.closest('.col-sel') || e.target.closest('.tcar') || e.target.closest('.tl-play') || e.target.closest('.tl-add')) return;
      if (tabletTap(p)) return;
      if (Date.now() - (p.navAt || 0) < 450 || Date.now() - (p.dblAt || 0) < 600) return;   // already opened (first click on a folder, or the second click)
      openItem(p, +r.dataset.idx);
    });
    $$('.uc-cols > div', p.el).forEach(h => h.addEventListener('click', () => {
      const k = h.dataset.k; if (k === 'sel' || k === 'disk') return;
      if (k === sortKey) sortRev = !sortRev; else { sortKey = k; sortRev = false; }
      saveSort(); panes.forEach(applySort);
    }));
    p.crumb.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const v = p.crumb.value.trim(); stopEdit(p); load(p, v); root.focus(); }
      if (e.key === 'Escape') { stopEdit(p); root.focus(); }
      e.stopPropagation();
    });
    p.crumb.addEventListener('focus', () => setActive(p.i));
    p.crumb.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== p.crumb) stopEdit(p); }, 150));
    /* Breadcrumbs: tap a name to go there. Dragging (or long-pressing on a
     * tablet) selects the text for copying instead, so a click that ends with
     * text selected doesn't navigate. */
    let crumbTimer = null;
    p.trailEl.addEventListener('click', e => {
      setActive(p.i);
      const seg = e.target.closest('.tr-seg');
      if (!seg) return startEdit(p);
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && p.trailEl.contains(sel.anchorNode)) return;
      clearTimeout(crumbTimer);
      crumbTimer = setTimeout(() => {           // wait a moment: a double-click selects a name instead
        const s2 = window.getSelection();
        if (s2 && !s2.isCollapsed && p.trailEl.contains(s2.anchorNode)) return;
        sound.play('click');
        load(p, seg.dataset.path);
      }, 230);
    });
    p.trailEl.addEventListener('dblclick', () => clearTimeout(crumbTimer));
    $('[data-path="edit"]', p.pathEl).addEventListener('click', () => { setActive(p.i); startEdit(p); });
    $('[data-path="copy"]', p.pathEl).addEventListener('click', () => { setActive(p.i); copyText(p.mode === 'find' ? p.findInfo.start : p.path); });
  }

  /* ---------- path bar: breadcrumbs, typing a path, copying ---------- */
  function renderTrail(p) {
    if (p.mode === 'find') { p.pathEl.classList.remove('uc-outside'); p.el.classList.remove('uc-outside'); p.trailEl.innerHTML = `<span class="tr-find">Find: ${esc(p.findInfo.label)}</span>`; return; }
    const here = p.path;
    const full = p.trail && p.trail.startsWith(here === '/' ? '/' : here + '/') ? p.trail : here;
    const segs = full.split('/').filter(Boolean);
    const outside = sysOn() && here !== '/mnt' && !here.startsWith('/mnt/');
    p.pathEl.classList.toggle('uc-outside', outside); p.el.classList.toggle('uc-outside', outside);
    let html = sysOn() ? `<span class="tr-seg tr-root${here === '/' ? ' here' : ''}" data-path="/" title="/ - the whole system">/</span>`
      : `<span class="tr-seg tr-root" data-path="/mnt" title="/mnt - shares, disks, pools and Unassigned Devices">/</span>`, acc = '';
    segs.forEach((s, k) => {
      acc += '/' + s;
      const ahead = acc.length > here.length;
      if (k) html += `<span class="tr-sep${ahead ? ' ahead' : ''}">/</span>`;
      html += `<span class="tr-seg${ahead ? ' ahead' : ''}${acc === here ? ' here' : ''}" data-path="${esc(acc)}">${esc(s)}</span>`;
    });
    p.trailEl.innerHTML = html;
    if (p.arc) { const as = $(`.tr-seg[data-path="${CSS.escape(p.arc.file)}"]`, p.trailEl); if (as) { as.classList.add('arc'); as.title = 'An archive, open like a folder (read-only)'; } }
    const cur = $('.tr-seg.here', p.trailEl);
    if (cur) p.trailEl.scrollLeft = Math.max(0, cur.offsetLeft + cur.offsetWidth - p.trailEl.clientWidth + 40);
  }
  function startEdit(p) {
    p.pathEl.classList.add('editing');
    p.crumb.value = p.mode === 'find' ? p.findInfo.start : p.path;
    p.crumb.focus(); p.crumb.select();
  }
  function stopEdit(p) { p.pathEl.classList.remove('editing'); }
  /* navigator.clipboard only exists on https pages; unRAID is often plain
   * http, so fall back to the old copy command. */
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Copied ' + t); return; } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    toast(ok ? 'Copied ' + t : "Couldn't copy - select the path and copy it instead", !ok);
  }

  /* the pane's Back button: the folder it showed before this one */
  async function goBack(p) {
    setActive(p.i);
    while (p.hist.length && p.hist[p.hist.length - 1] === p.path) p.hist.pop();
    const prev = p.hist.pop(); store.set('hist' + p.i, p.hist);
    if (!prev) { draw(p); return; }
    if (p.mode === 'dir') { p.fwd.push(p.path); store.set('fwd' + p.i, p.fwd); }
    p.goingBack = true;
    try { await load(p, prev); } finally { p.goingBack = false; }
  }
  async function goForward(p) {
    setActive(p.i);
    const next = p.fwd.pop(); store.set('fwd' + p.i, p.fwd);
    if (!next) { draw(p); return; }
    if (p.mode === 'dir' && p.path !== next) { p.hist.push(p.path); store.set('hist' + p.i, p.hist); }
    p.goingBack = true;               // same rule: don't record this as a new step
    try { await load(p, next); } finally { p.goingBack = false; }
  }
  function setActive(i) {
    if (active === i && panes[i].el.classList.contains('active')) return;
    active = i; store.set('active', i); if (!booting) tabShowName();
    panes.forEach(p => {
      p.el.classList.toggle('active', p.i === i);
      p.crumb.classList.toggle('active', p.i === i);
      p.pathEl.classList.toggle('active', p.i === i);
      $('.side', p.el).textContent = p.i ? 'Right' : 'Left';
      $('.act', p.el).textContent = p.i === i ? '· active' : '';
      drawRows(p);
    });
    arcKeys();
    if (cmpOn) tickCompare();
    if (clipBar && clipBar.isConnected) drawClip();
    fkArrows();
    try { if (filterMode()) { jumpBox.value = panes[i].flt || ''; jumpBox.classList.toggle('filtering', !!panes[i].flt); } } catch (e) {}
    updateChrome();
  }

  /* ---------- loading ---------- */
  /* Only the newest navigation in a pane counts: opening another folder (or a
   * shortcut, or ..) while one is still loading replaces it instead of queuing
   * behind it. A slow folder shows "Opening… 5 s" with a Cancel button. */
  const LOAD_TIMEOUT = 60000;
  async function load(p, path, focusName) {
    path = (path || '/').replace(/\/+$/, '') || '/';
    /* the array is stopped: shares, disks and pools aren't there - /mnt instead, and back here when it starts */
    if (SET.array === false && ARR_PATH.test(path)) {
      if (!p.arrayWant) p.arrayWant = path;
      if (!booting) toast('The array is stopped - shares, disks and pools come back when it starts');
      path = '/mnt';
    }
    if (p.ctl) p.ctl.abort();
    const ctl = p.ctl = new AbortController(), seq = p.seq = (p.seq || 0) + 1;
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; ctl.abort(); }, LOAD_TIMEOUT);
    p.navAt = Date.now();
    p.loading = true; p.error = null; if (!p.quiet) { draw(p); waitStart(p, path); }
    const t0 = performance.now();
    try {
      let r = await api('list', Object.assign({ path }, watchOn() ? { watch: '1' } : {}, path === '/' && sysOn() ? { sys: '1' } : {}), ctl.signal);
      if (seq !== p.seq) return;
      /* inside an archive: it's read once (a big .tar.gz can take a while - no time limit, Esc stops waiting) */
      if (r.pending) clearTimeout(killer);
      while (r.pending) {
        $('.count', p.el).textContent = `Reading ${base(r.arc.file)}…${r.entries ? ' ' + r.entries.toLocaleString() + ' items so far' : ''}`;
        await new Promise(res => setTimeout(res, 400));
        if (seq !== p.seq) return;
        r = await api('list', { path }, ctl.signal);
        if (seq !== p.seq) return;
      }
      if (r.need_password) {
        p.loading = false; waitStop(p); p.ctl = null; draw(p); updateChrome();
        return arcPassword(p, r.arc.file, path, focusName, r.why);
      }
      if (r.now) srvSkew = r.now * 1000 - Date.now();
      const was = p.mode === 'dir' ? p.path : null;
      if (cmpOn && r.path !== was) endCompare(true);
      if (!booting && was !== null && r.path !== was)
        sound.play(was !== '/' && was.startsWith(r.path === '/' ? '/' : r.path + '/') ? 'back' : 'open');
      else if (!booting && was === null) sound.play('open');
      p.mode = 'dir'; p.findInfo = null;
      /* history for the pane's Back button (not when going back itself) */
      if (was !== null && r.path !== was && !p.goingBack) {
        p.hist.push(was); if (p.hist.length > 50) p.hist.shift(); store.set('hist' + p.i, p.hist);
        p.fwd = []; store.set('fwd' + p.i, p.fwd);      // a new path drops the "forward" trail, like a browser
      }
      if (r.path !== was) { p.flt = ''; p.hidTicks = new Set(); try { if (p === A() && filterMode()) { jumpBox.value = ''; jumpBox.classList.remove('filtering', 'miss'); } } catch (e) {} }
      p.path = r.path; noteTouched(r.path); p.sig = r.sig || null; p.free = r.free; p.trash = r.trash; p.origins = r.origins || null; p.ud = null; p.udMap = null;
      /* keep the deeper folders you came from (shown greyed) while you're
       * somewhere above them; going anywhere else starts a new trail */
      if (!(p.trail && (p.trail === r.path || p.trail.startsWith(r.path === '/' ? '/' : r.path + '/')))) p.trail = r.path;
      store.set('trail' + p.i, p.trail);
      p.all = r.items.map(([n, t, abs]) => abs ? { n, t, abs } : { n, t });
      p.root = !!r.root;
      p.stats = new Map(); p.dirSizes = new Map(); p.locs = new Map(); p.sel.clear(); p.cursor = 0; p.armed = null;
      p.arc = r.arc || null; p.el.classList.toggle('in-arc', !!p.arc); p.pathEl.classList.toggle('in-arc', !!p.arc);
      arcShow(p);
      if (r.stats) for (const [k, v] of Object.entries(r.stats)) p.stats.set(k, v);       // inside an archive: sizes and dates come with the list
      /* the folder tree: a refresh keeps the folders that were open; coming back to the page opens them again */
      let reopen = [];
      if (SET.tree && !p.root) {
        if (booting && !p.treeRestored) { const sv = store.get('tree' + p.i, null); if (sv && sv.path === r.path && Array.isArray(sv.open)) reopen = sv.open; }
        else if (r.path === was) reopen = [...(p.tree || new Map()).keys()];
      }
      p.treeRestored = true;
      p.tree = new Map();
      if (reopen.length) { await treeFetch(p, reopen.slice(0, 200)); if (seq !== p.seq) return; }
      if (!booting || reopen.length) saveTree(p);
      applyCols(p);
      if (!(p.arrayWant && SET.array === false)) store.set('path' + p.i, p.path);      // kept: where to go back to when the array starts
      if (!p.quiet) { if (p === A() && document.activeElement !== jumpBox) clearJump(); p.list.scrollTop = 0; }
      await applySort(p, true);
      if (/^\/mnt\/(remotes|disks)(\/|$)/.test(p.path)) udLoad(p);
      if (focusName) { const ix = p.items.findIndex(it => it.n === focusName && !it.depth); if (ix >= 0) moveCursor(p, ix, true); }
      /* first load after coming back to the page: put the ticks and cursor back */
      if (booting && !p.selRestored) {
        p.selRestored = true;
        const saved = store.get('sel' + p.i, null);
        if (saved && saved.path === p.path) {
          const want = new Set(saved.names || []);
          p.items.forEach((it, i) => { if (!it.up && want.has(it.abs || it.n)) p.sel.add(i); });
          if (saved.cursor) { const ix = p.items.findIndex(it => (it.abs || it.n) === saved.cursor); if (ix >= 0) moveCursor(p, ix, true); }
        }
      }
      const total = performance.now() - t0;
      if (!booting && total > 3000) {
        const srv = (r.ms || 0) / 1000;
        toast(`That folder took ${(total / 1000).toFixed(1)} s to open. ` + (srv > total / 2000
          ? `The server spent ${srv.toFixed(1)} s reading it - usually a disk spinning up.`
          : `The server read it in ${srv.toFixed(1)} s, so the request waited behind other work on the server.`));
      }
    } catch (e) {
      if (seq !== p.seq) return;
      if (e.name === 'AbortError' && !timedOut) { /* cancelled */ }
      else {
        p.error = timedOut ? `No answer from the server after ${LOAD_TIMEOUT / 1000} s for ${path}` : e.message;
        toast(p.error, true);
      }
      if (!p.all.length) { p.items = []; }
    } finally {
      clearTimeout(killer);
    }
    if (seq !== p.seq) return;
    p.ctl = null; waitStop(p);
    p.loading = false; draw(p); updateChrome(); if (!booting) { try { tabShowName(); } catch (e) {} }
    if (mus && !p.error) musAfterLoad(p);
    /* a refresh of the same folders (after a copy, say) re-runs the compare */
    if (cmpOn && !p.error) { clearTimeout(cmpRedo); cmpRedo = setTimeout(() => { if (cmpOn && !panes.some(q => q.loading)) startCompare(true); }, 250); }
  }
  let cmpRedo = 0;
  function cancelLoad(p) {
    if (!p.loading) return;
    if (p.ctl) p.ctl.abort();
    p.ctl = null; p.seq = (p.seq || 0) + 1;
    waitStop(p); p.loading = false; draw(p); updateChrome();
    toast('Stopped waiting. The folder may still be busy on the server (a disk spinning up?).');
  }
  function waitStart(p, path) {
    waitStop(p);
    const t0 = Date.now();
    p.waitTimer = setTimeout(function tick() {
      const sec = Math.round((Date.now() - t0) / 1000);
      p.el.classList.add('busy');
      $('.uc-cancel', p.el).hidden = false;
      $('.count', p.el).textContent = `Opening ${base(path) || '/'}…${sec >= 1 ? ' ' + sec + ' s' : ''}`;
      p.waitTimer = setTimeout(tick, 1000);
    }, 400);
  }
  function waitStop(p) {
    clearTimeout(p.waitTimer); p.waitTimer = null;
    p.el.classList.remove('busy');
    $('.uc-cancel', p.el).hidden = true;
  }

  /* ---------- the folder tree (Settings > General): a caret opens a folder in place ---------- */
  function treeOn(p) { return !!(SET.tree || (mus && !mus.pair && p.i === 0)) && p.mode === 'dir' && !p.root && !cmpOn && !p.gal && !p.mt; }
  function saveTree(p) { if (p.mode === 'dir') store.set('tree' + p.i, { path: p.path, open: [...(p.tree || new Map()).keys()].slice(0, 200) }); }
  async function treeFetch(p, paths) {
    await Promise.all(paths.map(async path => {
      const depth = path.slice(p.path.length + (p.path === '/' ? 0 : 1)).split('/').length;
      try {
        const r = await api('list', { path });
        p.tree.set(path, r.items.map(([n, t]) => ({ n, t, abs: join(path, n), depth })));
      } catch (e) { p.tree.delete(path); }
    }));
  }
  async function treeToggle(p, i, want) {
    const it = p.items[i];
    if (!it || it.up || !itDir(p, it) || !treeOn(p)) return false;
    const path = fullPath(p, it), open = p.tree.has(path);
    if (want != null && want === open) return false;
    if (open) {
      for (const k of [...p.tree.keys()]) if (k === path || k.startsWith(path + '/')) p.tree.delete(k);
      const cur = p.items[p.cursor];
      if (cur && fullPath(p, cur).startsWith(path + '/')) p.cursor = i;
      for (const k of [...p.sel]) { const x = p.items[k]; if (x && fullPath(p, x).startsWith(path + '/')) p.sel.delete(k); }
      sound.play('tap');
    } else {
      p.tree.set(path, []); sound.play('tap');
      const seq = p.seq;
      await treeFetch(p, [path]);
      if (seq !== p.seq) return true;
    }
    saveTree(p); applySort(p);
    return true;
  }

  function filtered(p) {
    const f = p.flt && p.mode === 'dir' && !p.root ? p.flt.toLowerCase() : '';
    return p.all.filter(it => (showHidden || p.mode !== 'dir' || !it.n.startsWith('.')) && (!f || base(it.n).toLowerCase().includes(f)));
  }

  async function applySort(p, fresh) {
    const keep = !fresh && p.items[p.cursor] ? p.items[p.cursor] : null;
    const tkey = it => it.abs || it.n;
    const ticks = fresh ? null : new Set([...[...p.sel].map(i => p.items[i]).filter(it => it && !it.up).map(tkey), ...(p.hidTicks || [])]);
    if (p.root && p.mode === 'dir') { p.items = filtered(p); p.cursor = Math.min(p.cursor, Math.max(0, p.items.length - 1)); draw(p); return; }   // "/" keeps its own order
    let items = filtered(p);
    /* Sorting by size/date needs every stat. Show the list straight away (in
     * name order) and re-sort when the details arrive, instead of waiting. */
    const missing = sortKey !== 'name' && items.some(it => !it.up && !p.stats.has(it.abs || it.n));
    const st = it => p.stats.get(it.abs || it.n) || {};
    const isDir = it => it.t === 'd' || (it.t === 'l' && st(it).d);
    const cmp = {
      name: (a, b) => collator.compare(a.n, b.n),
      size: (a, b) => (dirSize(p, a) ?? st(a).s ?? -1) - (dirSize(p, b) ?? st(b).s ?? -1) || collator.compare(a.n, b.n),
      mtime: (a, b) => (st(a).m ?? 0) - (st(b).m ?? 0) || collator.compare(a.n, b.n),
      perm: (a, b) => collator.compare(`${st(a).p} ${st(a).o}:${st(a).g}`, `${st(b).p} ${st(b).o}:${st(b).g}`) || collator.compare(a.n, b.n),
    }[sortKey];
    const order = (a, b) => (isDir(b) - isDir(a)) || (sortRev ? -cmp(a, b) : cmp(a, b));
    items.sort(order);
    if (treeOn(p) && p.tree.size) {
      const grow = (list) => list.flatMap(it => {
        const kids = isDir(it) && p.tree.get(it.abs || join(p.path, it.n));
        return kids ? [it, ...grow(kids.filter(k => showHidden || !k.n.startsWith('.')).sort(order))] : [it];
      });
      items = grow(items);
    }
    if (p.mode === 'dir' && p.path !== '/' && (sysOn() || p.path !== '/mnt')) items.unshift({ n: '..', t: 'd', up: true });   // the top: /mnt, or / in the system view
    if (p.mode === 'find') items.unshift({ n: '..', t: 'd', up: true, exit: true });
    p.items = items;
    p.cursor = keep ? Math.max(0, items.indexOf(keep)) : Math.min(p.cursor, Math.max(0, items.length - 1));
    if (ticks && ticks.size) {
      p.sel.clear(); items.forEach((it, i) => { if (!it.up && ticks.has(tkey(it))) p.sel.add(i); });
      /* filtering: what's ticked but filtered out stays ticked, set aside - it comes back with the filter off */
      const shown = new Set(items.map(tkey)); p.hidTicks = p.flt ? new Set([...ticks].filter(k => !shown.has(k))) : new Set();
    } else p.hidTicks = new Set();
    draw(p);
    if (missing || (sortKey !== 'name' && items.some(it => it.depth && !p.stats.has(it.abs)))) {
      const seq = p.seq;
      statAll(p, items, seq).then(() => { if (p.seq === seq) applySort(p); }, () => { if (p.seq === seq) draw(p); });
    }
  }

  /* Sorting by anything but name needs every stat — fetched in chunks. */
  async function statAll(p, items, seq) {
    const need = items.filter(it => !it.up && !p.stats.has(it.abs || it.n)).map(it => it.abs || it.n);
    if (!need.length) return;
    const foot = $('.freeinfo', p.el);
    for (let i = 0; i < need.length; i += 400) {
      $('.count', p.el).textContent = `reading details ${Math.min(i + 400, need.length)} / ${need.length}…`;
      const r = await api('stat', { path: p.path, names: need.slice(i, i + 400) });
      if (p.seq !== seq) return;
      for (const [k, v] of Object.entries(r.stats)) p.stats.set(k, v || {});
    }
  }

  /* ---------- lazy stat for visible rows ---------- */
  const statTimers = new Map();
  function queueStat(p) {
    clearTimeout(statTimers.get(p.i));
    statTimers.set(p.i, setTimeout(() => statVisible(p), 60));
  }
  /* Disk column, filled in for the rows on screen like sizes and dates. */
  async function locVisible(p) {
    if (!showsDisk(p)) return;
    if (!p.locs) p.locs = new Map();
    const [a, b] = visibleRange(p), need = [];
    for (let i = a; i < b; i++) {
      const it = p.items[i]; if (!it || it.up) continue;
      const k = it.abs || it.n; if (!p.locs.has(k)) { need.push(k); p.locs.set(k, null); }
    }
    if (!need.length) return;
    const path = p.path;
    try {
      const r = await api('locate', { path, names: need });
      if (p.path !== path) return;
      for (const k of need) p.locs.set(k, r.locs[k] || []);
      drawRows(p);
    } catch (e) { need.forEach(k => p.locs.delete(k)); }
  }
  function diskCell(p, it) {
    const l = p.locs && p.locs.get(it.abs || it.n);
    if (!l) return '';
    if (!l.length) return '<span class="muted">—</span>';
    const lab = d => d.replace(/^disk(\d+)$/, 'd$1');
    const shown = l.length > 2 ? [...l.slice(0, 1).map(lab), `+${l.length - 1}`] : l.map(lab);
    return `<span title="${esc(l.join(', '))}">${shown.map(x => `<span class="d${/^(d\d+|\+\d+)$/.test(x) ? '' : ' pool'}">${esc(x)}</span>`).join('')}</span>`;
  }
  async function openWhere(p, it) {
    const path = fullPath(p, it);
    let r;
    try { r = await api('where', { path }); } catch (e) { return toast(e.message, true); }
    const rows = r.where, q = B();
    const lab = d => d.replace(/^disk(\d+)$/, 'disk $1');
    const isDir = rows.some(w => w.dir);
    const empties = rows.filter(w => w.dir && !w.files);
    openDlg(`Where is ${esc(it.n)}?`, `
      <div class="muted mono">${esc(path)}</div>
      <div class="wh-list">${rows.map((w, i) => `<div class="wh-row">
        <span class="wh-d ${/^disk\d+$/.test(w.disk) ? '' : 'pool'}">${esc(lab(w.disk))}</span>
        <span class="wh-info">${w.dir ? (w.files || w.dirs ? `${w.files.toLocaleString()} file${w.files === 1 ? '' : 's'}${w.dirs ? ` in ${w.dirs.toLocaleString()} folder${w.dirs === 1 ? '' : 's'}` : ''} · ${fmtBytes(w.bytes)}${w.more ? '+ (stopped counting at 50,000)' : ''}` : '<b class="wh-empty">empty folder</b>') : `${fmtBytes(w.bytes)}${w.mtime ? ' · ' + fmtDate(w.mtime) : ''}`}
          <br><span class="mono muted">${esc(w.path)}</span></span>
        <button class="uc-btn" data-open="${i}" title="Open this disk's copy in the other pane">Open →</button></div>`).join('')}</div>
      ${empties.length && rows.length > 1 ? `<div class="warnbox">On ${empties.map(w => esc(lab(w.disk))).join(', ')} this is just an <b>empty folder</b> - nothing is stored there. That's usually harmless leftover from moving files between disks, and /mnt/user shows the folders merged as one.</div>` : ''}
      ${isDir ? '<div class="muted">Through /mnt/user these copies appear as one folder with everything merged. Open → shows one disk\'s copy in the other pane.</div>' : ''}`,
      [{ label: 'Close', primary: true }], 'pm-dlg');
    $$('[data-open]', dlg).forEach(b => b.addEventListener('click', () => {
      const w = rows[+b.dataset.open];
      closeDlg(); load(q, w.dir ? w.path : parent(w.path), w.dir ? null : base(w.path));
    }));
  }
  async function statVisible(p) {
    locVisible(p);
    const [a, b] = visibleRange(p);
    const need = [];
    for (let i = a; i < b; i++) {
      const it = p.items[i]; if (!it || it.up) continue;
      const k = it.abs || it.n; if (!p.stats.has(k)) { need.push(k); p.stats.set(k, null); }
    }
    if (!need.length) return;
    const path = p.path;
    try {
      const r = await api('stat', { path, names: need });
      if (p.path !== path) return;
      for (const [k, v] of Object.entries(r.stats)) p.stats.set(k, v || {});
      drawRows(p); updateSelInfo(p);
    } catch (e) { need.forEach(k => p.stats.delete(k)); }
  }

  /* ---------- drawing ---------- */
  function visibleRange(p) {
    const top = p.list.scrollTop, h = p.list.clientHeight || 400;
    return [Math.max(0, Math.floor(top / ROW) - 5), Math.min(p.items.length, Math.ceil((top + h) / ROW) + 5)];
  }
  function draw(p) {
    if (p.gal && (p.mode !== 'dir' || p.root)) galSet(p, false);
    const mt = musTiles(p);
    if (mt !== !!p.mt) { p.mt = mt; p.galItems = null; p.el.classList.toggle('mus-tiles', mt); if (!p.gal) p.el.classList.toggle('gal', mt); if (mt) p.el.style.setProperty('--tile', galSize()[0] + 'px'); }
    p.spacer.style.height = p.gal || p.mt ? '' : (p.items.length * ROW) + 'px';
    musBtn(p); musStrip(p); musFacts(p); udStrip(p);
    const gb = $('.uc-galbtn', p.el);
    if (gb) { gb.hidden = (!p.gal && !galFits(p)) || !!mus; gb.classList.toggle('on', !!p.gal); gb.title = p.gal ? 'Back to the list' : 'Gallery view - pictures as tiles; the other pane shows the one you pick'; $('.uc-galsz', p.el).hidden = !p.gal && !p.mt; }
    const n = p.items.filter(it => !it.up).length;
    $('.count', p.el).textContent = p.loading ? 'loading…' : p.mode === 'find' ? `${n} search results` : `${n.toLocaleString()} items`;
    $('.uc-endfind', p.el).hidden = p.mode !== 'find';
    const bk = $('.uc-back', p.el), prev = p.hist[p.hist.length - 1];
    bk.disabled = !p.hist.length; bk.title = prev ? `Back to ${prev}` : 'Back to the folder you were in before';
    const fw = $('.uc-fwd', p.el), next = p.fwd[p.fwd.length - 1];
    fw.disabled = !p.fwd.length; fw.title = next ? `Forward to ${next}` : 'Forward (after going back)';
    if (!p.el.querySelector('.side').textContent) $('.side', p.el).textContent = p.i ? 'Right' : 'Left';
    if (document.activeElement !== p.crumb) p.crumb.value = p.mode === 'find' ? `Find: ${p.findInfo.label}` : p.path;
    renderTrail(p);
    drawRows(p); updateSelInfo(p); queueStat(p);
  }
  /* In a .uncommander-trash folder, show what each dated bin holds. */
  function binLabel(p, it) {
    const o = p.trash && p.origins && p.origins[it.n];
    if (!o) return '';
    const m = it.n.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/);
    const when = m ? `${+m[2]}/${m[3]} ${m[4]}:${m[5]}` : '';
    return `<span class="bin-name">${esc(base(o))}</span><span class="bin-meta">${when ? 'deleted ' + when + ' · ' : ''}from ${esc(parent(o))}</span>`;
  }
  function drawRows(p) {
    if (p.gal || p.mt) return drawGal(p);
    const [a, b] = visibleRange(p);
    const fine = finePointer() && !p.root, tree = treeOn(p);
    const rm = recentMins(), recentCut = rm && !p.root ? (Date.now() + srvSkew - rm * 60000) / 1000 : 0;
    let html = '';
    if (!p.items.length && !p.loading) {
      html = `<div class="uc-empty ${p.error ? 'uc-error' : ''}">${esc(p.error || (p.mode === 'find' ? 'No matches.' : 'This folder is empty.'))}</div>`;
    }
    for (let i = a; i < b; i++) {
      const it = p.items[i];
      const s = it.up ? null : p.stats.get(it.abs || it.n);
      const isDir = it.t === 'd' || (it.t === 'l' && s && s.d);
      const sel = p.sel.has(i);
      const cs = p.cmp && !it.up && !it.depth ? p.cmp.get(it.n) : null;
      const cm = it.up || !(clipSet && clipSet.size) ? null : clipMark(fullPath(p, it));
      const cls = 'uc-row' + (it.ghost ? ' ghost' : '') + (sel ? ' sel' : '') + (i === p.cursor ? ' cursor' : '') + (cs ? ' cmp-' + cs : '') + (p.flash && !it.up && !it.depth && p.flash.has(it.n) ? ' uc-new' : '') + (recentCut && s && s.m >= recentCut ? ' recent' : '') + (cm ? ' clip-' + cm : '') + (mus && mus.now && !it.up && fullPath(p, it) === mus.now ? ' mus-now' : '');
      const perm = s && s.p ? s.p : (it.up ? '—' : '');
      const odd = s && s.p && (s.o !== 'nobody' || s.g !== 'users');
      const dur = p.durs && !it.up && !it.depth ? p.durs.get(it.n) : null;
      html += `<div class="${cls}" data-idx="${i}" style="top:${i * ROW}px"${!it.up && fine ? ' draggable="true"' : ''}>
        <div class="col-sel">${it.up ? '' : `<span class="box${sel ? ' on' : ''}"></span>`}</div>
        <div class="nm col-name${isDir ? ' dir' : ''}${it.t === 'l' ? ' link' : ''}${it.up ? ' up' : ''}" title="${esc(it.n)}${s && s.l ? ' → ' + esc(s.l) : ''}">${it.up ? UP_ICON : ''}${tree && !it.up ? `<span class="tcar${isDir ? '' : ' none'}${isDir && p.tree.has(fullPath(p, it)) ? ' on' : ''}" style="margin-left:${(it.depth || 0) * 16}px"${isDir ? ' title="Show what\'s inside here"' : ''}>${isDir ? mi('chev') : ''}</span>` : ''}${it.exit ? 'Back to ' + esc(p.findInfo.start) : binLabel(p, it) || (cm ? `<span class="nm-t ${cm}">${esc(it.n)}</span>` : esc(it.n))}${cs && CMP_TAG[cs] ? `<span class="cmp-tag ${cs}">${CMP_TAG[cs]}</span>` : ''}${cm ? `<span class="clip-tag ${cm}">${cm === 'cut' ? '✂ cut' : cm === 'del' ? '🗑 to delete' : '⧉ copy'}</span>` : ''}${dur ? `<span class="mus-len">${fmtT(dur)}</span>` : ''}${p.ud && p.udMap ? udCell(p, it) : ''}</div>
        <div class="num col-size${isDir && dirSize(p, it) != null ? ' dsz' : ''}${!isDir && s && s.s >= 1e9 ? ' gb' : ''}">${it.up ? '—' : isDir && dirSize(p, it) != null ? fmtSize(dirSize(p, it)) : s ? (isDir ? '—' : fmtSize(s.s)) : ''}</div>
        <div class="col-disk">${it.up ? '' : diskCell(p, it)}</div>
        <div class="perm col-date" title="${s && s.m ? new Date(s.m * 1000).toLocaleString() : ''}">${it.up ? '—' : s ? fmtDate(s.m) : ''}</div>
        <div class="perm col-mode${odd ? ' odd' : ''}" title="${s && s.p ? esc(`${s.o}:${s.g} ${s.p}`) : ''}">${esc(perm)}</div>
      </div>`;
    }
    // keep spacer, replace rows
    p.spacer.innerHTML = html;
  }
  /* Ticked items survive leaving the page: saved per pane with its folder. */
  let selSaveT = 0;
  function saveSel() {
    clearTimeout(selSaveT);
    selSaveT = setTimeout(() => panes.forEach(p => {
      if (p.mode !== 'dir' || p.loading) return;
      const names = [...p.sel].map(i => p.items[i]).filter(it => it && !it.up).map(it => it.abs || it.n);
      const cur = p.items[p.cursor];
      store.set('sel' + p.i, { path: p.path, names: names.slice(0, 5000), cursor: cur && !cur.up ? cur.abs || cur.n : null });
    }), 250);
  }
  function updateSelInfo(p) {
    if (!booting) saveSel();
    const el = $('.selinfo', p.el);
    const total = p.items.filter(it => !it.up).length;
    const fltNote = p.flt ? ` · ${(p.hidTicks && p.hidTicks.size) ? `${p.hidTicks.size} more ticked but filtered out (left alone) · ` : ''}filter "${p.flt}"` : '';
    if (p.sel.size) {
      let bytes = 0, known = true;
      for (const i of p.sel) {
        const it = p.items[i], s = p.stats.get(it.abs || it.n), ds = dirSize(p, it);
        if (ds != null) bytes += ds; else if (s && s.s != null) bytes += s.s; else if (!(s && s.d)) known = false;
      }
      el.innerHTML = `Selected <b>${p.sel.size} of ${total.toLocaleString()}</b>${bytes ? ' · ' + fmtBytes(bytes) + (known ? '' : '+') : ''}`;
      /* the footer is hidden, so the pane header shows the selection instead of the item count */
      if (!p.loading) $('.count', p.el).textContent = `${p.sel.size} of ${total.toLocaleString()} selected${bytes ? ' · ' + fmtBytes(bytes) + (known ? '' : '+') : ''}${fltNote}`;
    } else {
      el.textContent = p.mode === 'find' ? `in ${p.findInfo.start}` : '';
      if (!p.loading && p.arc) $('.count', p.el).textContent = `${total.toLocaleString()} item${total === 1 ? '' : 's'} · read-only${fltNote}`;
      else if (!p.loading) $('.count', p.el).textContent = p.mode === 'find' ? `${total} search results` : p.flt ? `${total.toLocaleString()} of ${p.all.filter(it => showHidden || !it.n.startsWith('.')).length.toLocaleString()} items${fltNote}` : `${total.toLocaleString()} items`;
    }
    if (!p.loading) { if (p.arc) p.free = null; $('.freeinfo', p.el).textContent = p.free != null ? `${fmtBytes(p.free)} free` : ''; $('.hfree', p.el).textContent = p.free != null ? `${fmtBytes(p.free)} free` : ''; }
  }
  function updateChrome() {
    const p = A();
    try { tabShowName(); } catch (e) {}        // the browser's tab follows the active folder
    renderBookmarks();
    $('#uc-free').textContent = p.free != null ? `free ${fmtBytes(p.free)}` : 'free —';
    const restore = $('.uc-restore');
    restore.hidden = !p.trash;
  }

  /* Tap to pick, tap again to open: automatic for fingers and pens, or
   * forced on/off in Settings → Touch. */
  function tabletTap(p) {
    const mode = SET.tap_mode || 'auto';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return p.pointer === 'touch' || p.pointer === 'pen' || Date.now() - (p.touchAt || 0) < 1000;
  }

  /* ---------- cursor, selection ---------- */
  let lastClick = null;
  function onRowClick(p, e) {
    const r = e.target.closest('.uc-row'); if (!r) return;
    if (p.loading) return;   // a folder is opening; the old list is dimmed
    const i = +r.dataset.idx; const it = p.items[i];
    const ua = e.target.closest('[data-udact]');
    if (ua && it) { setActive(p.i); p.cursor = i; ua.disabled = true; ua.textContent = ua.dataset.udact === 'on' ? 'mounting…' : 'un-mounting…'; const x = udOf(p, it); return ua.dataset.udact === 'on' ? udMountRow(p, it, false) : x && udUnmount(p, x); }
    if (it && it.ghost && !e.target.closest('.col-sel')) { setActive(p.i); p.cursor = i; drawRows(p); return; }
    if (p.mt && it && !it.up && e.target.closest('.tl-add')) { setActive(p.i); return plAdd([fullPath(p, it)]); }
    if (p.mt && it && !it.up && e.target.closest('.tl-play')) { setActive(p.i); p.cursor = i; drawRows(p); return musPlayDir(fullPath(p, it)); }
    if (p.mt && it && !it.up && itDir(p, it) && e.target.closest('.tl-pic') && !e.target.closest('.col-sel') && !e.shiftKey && !e.ctrlKey && !e.metaKey) { p.cursor = i; return openItem(p, i); }
    if (e.target.closest('.tcar:not(.none)') && it && !it.up) { setActive(p.i); p.cursor = i; p.armed = null; treeToggle(p, i); return; }
    if (Date.now() - (p.navAt || 0) < 450) return;   // swallow the 2nd click of a double-click after we already navigated
    if (Date.now() - (p.list.lpAt || 0) < 800) return;  // that was a press-and-hold: the menu is open
    /* Disk cell: show what's on each disk (works by tap - no hover on a tablet) */
    if (e.target.closest('.col-disk') && it && !it.up && p.locs && (p.locs.get(it.abs || it.n) || []).length) { setActive(p.i); return openWhere(p, it); }
    /* Tablet: the first tap moves the cursor to the row (like the arrow keys
     * in mc); tapping that same row again opens it. Checkboxes still tick
     * on the first tap. */
    /* The checkbox column is its own tap zone: anywhere in it ticks or
     * unticks the box (shift for a range) and never picks or opens the row. */
    if (e.target.closest('.col-sel') && it && !it.up) {
      if (e.shiftKey && lastClick != null) selectRange(p, lastClick, i, !p.sel.has(i));
      else toggle(p, i);
      lastClick = i; p.armed = null;
      drawRows(p); updateSelInfo(p);
      return;
    }
    /* ".." (and "‹ Back to …" in search results) always goes up on a single
     * tap or click, anywhere on its row — it's never something you pick. */
    if (it && it.up && !e.shiftKey && !e.ctrlKey && !e.metaKey) { p.armed = null; return openItem(p, i); }
    if (tabletTap(p)) {
      if (p.armed === i) { p.armed = null; return openItem(p, i); }
      p.armed = i; p.cursor = i; lastClick = i;
      sound.play('tap');
      drawRows(p); updateSelInfo(p); musFollow(p);
      /* first times by finger: how it works, once each */
      if (!store.get('tapHint', false)) { store.set('tapHint', true); store.set('holdHint', true); toast('Tap again to open · press and hold for the menu (copy, rename, delete…)'); }
      else if (!store.get('holdHint', false)) { store.set('holdHint', true); toast('Tip: press and hold anything for its menu (copy, rename, delete…)'); }
      return;
    }
    /* A plain click on a folder's name opens it. The rest of the row only
     * moves the cursor, so a folder can still be picked for rename/copy. */
    const s = it && !it.up ? p.stats.get(it.abs || it.n) : null;
    const isDir = it && (it.up || it.t === 'd' || (it.t === 'l' && s && s.d));
    if (isDir && e.target.closest('.nm') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      p.cursor = i; lastClick = null;
      return openItem(p, i);
    }
    /* the second click of a double-click opens it. (Not the dblclick event: each click redraws the
     * rows, and a browser drops the dblclick when the row under the pointer was replaced in between.) */
    if (e.detail === 2 && it && !it.up && !e.shiftKey && !e.ctrlKey && !e.metaKey) { p.cursor = i; p.dblAt = Date.now(); drawRows(p); return openItem(p, i); }
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey && lastClick != null) selectRange(p, lastClick, i, !p.sel.has(i));
      else toggle(p, i);
      lastClick = i;
    } else if (e.shiftKey && lastClick != null) {
      selectRange(p, lastClick, i, true);
    } else {
      lastClick = i;
    }
    p.cursor = i; drawRows(p); updateSelInfo(p); musFollow(p);
    if (it && it.up) return;
  }
  function toggle(p, i) { if (p.items[i] && !p.items[i].up) { p.sel.has(i) ? p.sel.delete(i) : p.sel.add(i); } }
  function selectRange(p, a, b, on) {
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!p.items[i].up) on ? p.sel.add(i) : p.sel.delete(i);
  }
  function moveCursor(p, i, center) {
    p.armed = null;
    p.cursor = Math.max(0, Math.min(p.items.length - 1, i));
    musFollow(p);
    if (p.gal || p.mt) { drawRows(p); galScroll(p); return; }
    const top = p.cursor * ROW, h = p.list.clientHeight;
    if (center) p.list.scrollTop = Math.max(0, top - h / 2);
    else if (top < p.list.scrollTop) p.list.scrollTop = top;
    else if (top + ROW > p.list.scrollTop + h) p.list.scrollTop = top + ROW - h;
    drawRows(p); queueStat(p);
  }
  function openItem(p, i) {
    const it = p.items[i]; if (!it) return;
    if (it.up) return p.mode === 'find' ? load(p, p.findInfo.start) : load(p, parent(p.path), base(p.path));
    if (it.ghost) return udMountRow(p, it, true);          // not mounted: mount it, then go in
    const s = p.stats.get(it.abs || it.n);
    /* music library: a folder picked on the left opens on the right; the left stays on the artists */
    if (mus && p.i === 0 && itDir(p, it)) { p.cursor = i; drawRows(p); clearTimeout(musFollowT); return load(panes[1], fullPath(p, it)); }
    if (it.t === 'd' || (it.t === 'l' && s && s.d)) return load(p, fullPath(p, it));
    if (p.mode === 'find') return load(p, parent(it.abs), base(it.abs));
    if (it.t === 'l' && !s) return load(p, fullPath(p, it));
    /* an archive opens like a folder (read-only) - F3 still gives its plain list */
    if (it.t !== 'd' && ARCH_RE.test(it.n) && !p.root) return load(p, fullPath(p, it));
    act('view');
  }
  /* Operations act on the selection, or on the cursor row if nothing is ticked. */
  function targets(p = A()) {
    const idx = p.override || (p.sel.size ? [...p.sel].sort((a, b) => a - b) : [p.cursor]);
    const t = idx.map(i => p.items[i]).filter(it => it && !it.up).map(it => ({ it, path: fullPath(p, it) }));
    return dropInner(t);
  }
  /* with the tree open, a ticked folder and something ticked inside it: the folder brings it along */
  function dropInner(t) {
    if (!t.some(x => x.it && x.it.depth)) return t;
    const dirs = new Set(t.map(x => x.path));
    return t.filter(x => { for (let q = parent(x.path); q && q !== '/'; q = parent(q)) if (dirs.has(q)) return false; return true; });
  }

  /* ================= right-click menu, Copy / Cut / Paste, drag between panes =================
   * Right-click (or press and hold on a tablet) a row, the empty part of a
   * pane, or a breadcrumb for a menu of what fits it. Copy and Cut remember
   * items (nothing moves yet); Paste puts them in any folder, after a window
   * that lists each item and where it comes from. With a mouse, rows can be
   * dragged to the other pane or onto a folder. Everything lands in History. */
  /* (declared as functions/var: drawRows and setActive can run before this part of the file) */
  function finePointer() { return !root.classList.contains('uc-touch') && matchMedia('(hover: hover) and (pointer: fine)').matches; }
  const NO_EDIT = /\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|mpe?g|m2ts|vob|mp3|flac|aac|m4a|m4b|ogg|oga|opus|wav|wma|aiff?|ape|wv|mka|ac3|eac3|dts|mp2|amr|caf|dsf|dff|weba|iso|img|qcow2|vmdk|vdi|exe|dll|so|ko|bin|dat|db|sqlite3?|zip|rar|7z|gz|tgz|xz|bz2|zst|tar|jpe?g|png|gif|webp|bmp|ico|heic|heif|tiff?|avif|pdf|ttf|otf|woff2?)$/i;
  const itDir = (p, it) => it && (it.t === 'd' || (it.t === 'l' && (p.stats.get(it.abs || it.n) || {}).d));
  /* act() on given rows without touching the ticks: targets() reads p.override */
  function actOn(p, idx, name) {
    setActive(p.i);
    p.override = idx;
    try { return act(name); } finally { p.override = null; }
  }

  /* ---------- the menu itself (a bottom sheet on touch screens) ---------- */
  /* line icons, drawn like the rest of unCommander's */
  const MI = {
    view: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    edit: '<path d="M10.5 2.5l3 3-8 8h-3v-3z"/><path d="M9 4l3 3"/>',
    open: '<path d="M1.5 4v8.5h13V5.5H8L6.5 4z"/>',
    pane: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11M10 8h2.5M11.3 6.6 12.7 8l-1.4 1.4"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    cut: '<circle cx="4.5" cy="12" r="2"/><circle cx="11.5" cy="12" r="2"/><path d="M6 10.6 12 2.5M10 10.6 4 2.5"/>',
    paste: '<rect x="3" y="3" width="10" height="11.5" rx="1.5"/><path d="M6 3V1.8h4V3"/><path d="M5.5 7.2h5M5.5 10.2h3"/>',
    rename: '<rect x="1.5" y="5" width="13" height="6" rx="1.2"/><path d="M8.5 3v10M7 3h3M7 13h3"/>',
    key: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11 5l1.6 1.6M12.4 3.6l1.3 1.3"/>',
    zip: '<rect x="2" y="2.5" width="12" height="3" rx="1"/><path d="M3 5.5v8h10v-8M8 7.5v4M6.3 9.8 8 11.5l1.7-1.7"/>',
    unzip: '<rect x="2" y="2.5" width="12" height="3" rx="1"/><path d="M3 5.5v8h10v-8M8 11.5v-4M6.3 9.2 8 7.5l1.7 1.7"/>',
    size: '<path d="M3 13.5V9M8 13.5V3M13 13.5V6.5"/>',
    find: '<circle cx="7" cy="7" r="4.5"/><path d="M10.3 10.3 14 14"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.3v4.2M8 4.8v.2"/>',
    link: '<path d="M6.5 9.5l3-3M7 4.6l1.3-1.3a2.8 2.8 0 0 1 4 4L11 8.6M9 11.4l-1.3 1.3a2.8 2.8 0 0 1-4-4L5 7.4"/>',
    trash: '<path d="M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.5h7l.7-9.5M6.5 6.5V11M9.5 6.5V11"/>',
    restore: '<path d="M3 6.5h7a3.5 3.5 0 0 1 0 7H6M5.5 4 3 6.5 5.5 9"/>',
    newdir: '<path d="M1.5 4v8.5h13V5.5H8L6.5 4zM8 7.5V11M6.25 9.25h3.5"/>',
    newfile: '<path d="M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M8.25 7.5v4.5M6 9.75h4.5"/>',
    check: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8.2l2 2 4-4.4"/>',
    pattern: '<path d="M8 2.5v11M3.2 5.2l9.6 5.6M12.8 5.2 3.2 10.8"/>',
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M12.5 1.8v2.9H9.6"/>',
    compare: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
    hidden: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    move: '<path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/>',
    enter: '<path d="M13 3v5.5H3.5M6.5 5.5l-3 3 3 3"/>',
    download: '<path d="M8 2v8.5M4.8 7.3 8 10.5l3.2-3.2M2.5 11v2.5h11V11"/>',
    upload: '<path d="M8 10.5V2M4.8 5.2 8 2l3.2 3.2M2.5 11v2.5h11V11"/>',
    chev: '<path d="M6 3.5 10.5 8 6 12.5"/>'
  };
  const mi = k => MI[k] ? `<svg viewBox="0 0 16 16" aria-hidden="true">${MI[k]}</svg>` : '';

  const ctxEl = document.createElement('div');
  ctxEl.className = 'uc-ctx'; ctxEl.hidden = true; ctxEl.setAttribute('role', 'menu');
  const ctxVeil = document.createElement('div'); ctxVeil.className = 'uc-ctx-veil'; ctxVeil.hidden = true;
  root.append(ctxVeil, ctxEl);
  let ctxItems = [], ctxAt = 0;
  function closeMenu() { ctxEl.hidden = true; ctxVeil.hidden = true; ctxEl.classList.remove('sheet'); }
  function showMenu(x, y, head, items) {
    try { getSelection().removeAllRanges(); } catch (e) {}      // iPad: a press-and-hold also selects the text under the finger
    ctxItems = items.filter(Boolean);
    while (ctxItems[0] === '-') ctxItems.shift();
    while (ctxItems[ctxItems.length - 1] === '-') ctxItems.pop();
    /* a finger: a floating menu by the finger on a tablet (bigger rows, tap
     * outside to close); only a phone-sized screen gets the sheet from the bottom */
    const touch = !finePointer();
    const sheet = touch && Math.min(innerWidth, innerHeight) < 600;
    const keys = finePointer();
    ctxEl.innerHTML = `<div class="ctx-h"><span class="dot" aria-hidden="true">🟢</span><span class="t">${esc(head)}</span></div>` + ctxItems.map((m, n) => m === '-' ? '<hr>'
      : `<button type="button" role="menuitem" data-n="${n}" class="${m.hl ? 'hl' : ''}${m.danger ? ' danger' : ''}${m.lock ? ' locked' : ''}" ${m.off ? 'disabled' : ''}>
          <span class="ic">${mi(m.ic)}</span><span class="lb">${esc(m.label)}${m.sub ? `<small>${esc(m.sub)}</small>` : ''}</span>${m.lock ? '<span class="sc">🔒</span>' : keys && m.sc ? `<span class="sc">${m.sc}</span>` : ''}</button>`).join('')
      + (sheet ? '<button type="button" class="ctx-cancel">Cancel</button>' : '');
    ctxEl.classList.toggle('sheet', sheet); ctxEl.classList.toggle('touch', touch && !sheet);
    ctxEl.style.width = '';
    ctxEl.hidden = false; ctxVeil.hidden = !touch; ctxVeil.classList.toggle('clear', !sheet); ctxAt = Date.now();
    /* where (0,0) really is for this fixed box - a page box with a transform
     * or filter moves it, which pushed the menu off the bottom of the window */
    ctxEl.style.left = '0px'; ctxEl.style.top = '0px'; ctxEl.style.bottom = 'auto';
    const o = ctxEl.getBoundingClientRect();
    if (!sheet) {
      ctxEl.style.maxHeight = (innerHeight - 12) + 'px';
      const w = ctxEl.offsetWidth, h = Math.min(ctxEl.offsetHeight, innerHeight - 12);
      /* by a finger: just right of it (or left, near the right edge), so the finger doesn't cover it */
      const fx = touch ? (x + 16 + w > innerWidth - 6 ? x - 16 - w : x + 16) : x;
      ctxEl.style.left = (Math.max(6, Math.min(fx, innerWidth - w - 6)) - o.left) + 'px';
      ctxEl.style.top = (Math.max(6, Math.min(touch ? y - 20 : y, innerHeight - h - 6)) - o.top) + 'px';
      if (touch) return sound.play('click');
      const f = $('button[data-n]:not(:disabled)', ctxEl); if (f) f.focus({ preventScroll: true });
    } else {
      ctxEl.style.maxHeight = '';
      ctxEl.style.left = -o.left + 'px'; ctxEl.style.width = innerWidth + 'px';
      ctxEl.style.top = (innerHeight - ctxEl.offsetHeight - o.top) + 'px';
    }
    sound.play('click');
  }
  ctxEl.addEventListener('click', e => {
    if ((ctxEl.classList.contains('sheet') || ctxEl.classList.contains('touch')) && Date.now() - ctxAt < 450) return;   // the finger that opened it is still lifting
    if (e.target.closest('.ctx-cancel')) return closeMenu();
    const b = e.target.closest('button[data-n]'); if (!b || b.disabled) return;
    const m = ctxItems[+b.dataset.n]; closeMenu(); root.focus({ preventScroll: true });
    if (m.lock) return toast(`Practice mode is on, so ${m.lock} is turned off. You can switch it off in Settings > Safety.`, true);
    if (m.run) m.run();
  });
  ctxVeil.addEventListener('click', () => { if (Date.now() - ctxAt > 450) closeMenu(); });   // not the lift of the finger that opened it
  ctxEl.addEventListener('keydown', e => {
    const bs = $$('button[data-n]:not(:disabled)', ctxEl), i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); root.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (bs[i + 1] || bs[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (bs[i - 1] || bs[bs.length - 1]).focus(); }
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', e => { if (!ctxEl.hidden && !ctxEl.contains(e.target) && !ctxVeil.contains(e.target) && Date.now() - ctxAt > 300) closeMenu(); }, true);
  addEventListener('resize', () => { if (!ctxEl.classList.contains('sheet')) closeMenu(); });
  const lockIf = (what) => SET.practice ? what : null;

  /* ---------- Copy / Cut: the clipboard, and the cart ----------
   * Each item remembers whether it was copied or cut, whether it's ticked
   * (only ticked ones are pasted) and, for a folder, which of its contents
   * were unticked. Normally a new Copy or Cut replaces what's there (like
   * Windows); with Settings > Safety > "Collect from several folders" on,
   * it adds to the list instead - a cart filled from anywhere. */
  var clip = (() => {
    const c = store.get('clip', null);
    if (!c || !Array.isArray(c.items)) return null;
    c.items = c.items.map(x => ({ path: x.path, name: x.name, dir: !!x.dir, mode: x.mode || c.mode || 'copy', on: x.on !== false, skip: Array.isArray(x.skip) ? x.skip : [] }));
    return c.items.length ? { items: c.items } : null;
  })();
  var clipSet = new Set(clip ? clip.items.map(x => x.path) : []);
  /* the pill: [copy/move half] • [delete half] | Paste into … | ✕ - each half only when it has items */
  const SVG24 = (inner, sw, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const BIG = {
    clip: '<rect x="5.5" y="4" width="13" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 10h6M9 14h6M9 18h3"/>',
    trash: '<path d="M3.5 6h17"/><path d="M8.5 6V4.2c0-.7.5-1.2 1.2-1.2h4.6c.7 0 1.2.5 1.2 1.2V6"/><path d="M5.5 6l1 13.6c.1 1 .9 1.9 2 1.9h7c1.1 0 1.9-.9 2-1.9L18.5 6"/><path d="M10 10.5v6.5M14 10.5v6.5"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
    cut: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.2 15.8L19 4M15.8 15.8L5 4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'
  };
  const big = (k, sw = 2, cls = '') => SVG24(BIG[k], sw, cls);
  var clipBar = document.createElement('div');
  clipBar.className = 'uc-clip'; clipBar.hidden = true;
  clipBar.innerHTML = `<button type="button" class="uc-clip-what" aria-expanded="false" title="Items to copy or move - see the list">${big('clip', 1.9, 'ci')}<span class="bdg n-x"></span><span class="w from"></span><span class="cmp c-c">${big('copy', 2)}<b></b></span><span class="cmp c-k">${big('cut', 2)}<b></b></span></button>`
    + `<span class="uc-clip-dot" aria-hidden="true">•</span>`
    + `<button type="button" class="uc-clip-del" aria-expanded="false" title="Items tagged for delete - see them">${big('trash', 2.1, 'ct')}<span class="bdg red n-d"></span><span class="w">to delete</span><b class="cmp n-d2"></b></button>`
    + `<button type="button" class="uc-clip-go"></button><button type="button" class="uc-clip-x" title="Empty the whole list - nothing on the disks changes" aria-label="Empty the list">${big('x', 3)}</button>`;
  $('.uc-appbar .uc-sep').after(clipBar);
  const cartEl = document.createElement('div');
  cartEl.className = 'uc-cart'; cartEl.hidden = true;
  cartEl.innerHTML = `<div class="kt-head"><span class="kt-tabs"></span><button type="button" class="uc-btn kt-empty">Empty list</button><button type="button" class="kt-close" aria-label="Close">✕</button></div>
    <div class="kt-body"></div><div class="kt-foot"></div>`;
  root.appendChild(cartEl);
  let cartView = 'x';                       // which list the panel shows: x = copy/move, d = delete
  const isDel = x => x.mode === 'del';
  const xferAll = () => clip ? clip.items.filter(x => !isDel(x)) : [];
  const delAll = () => clip ? clip.items.filter(isDel) : [];
  const ticked = () => xferAll().filter(x => x.on);          // what Paste takes
  const tagged = () => delAll().filter(x => x.on);           // what "Delete tagged" takes
  function setClip(c) {
    clip = c && c.items.length ? c : null;
    clipSet = new Set(clip ? clip.items.map(x => x.path) : []);
    store.set('clip', clip); drawClip(); panes.forEach(p => drawRows(p));
  }
  const saveClip = () => setClip(clip);
  const cnt = (on, all) => on === all ? all.toLocaleString() : `${on}/${all}`;
  function drawClip() {
    clipBar.hidden = !clip;
    if (!clip) { cartEl.hidden = true; fitBar(); return; }
    const xs = xferAll(), ds = delAll(), on = ticked(), dOn = tagged().length;
    const folders = new Set(xs.map(x => parent(x.path))).size;
    const nCut = on.filter(x => x.mode === 'cut').length, nCopy = on.length - nCut;
    const p = A(), here = p.mode === 'dir' && !p.root ? p.path : null;
    const what = $('.uc-clip-what', clipBar), del = $('.uc-clip-del', clipBar), go = $('.uc-clip-go', clipBar);
    what.hidden = !xs.length; del.hidden = !ds.length; go.hidden = !xs.length;
    $('.uc-clip-dot', clipBar).hidden = !(xs.length && ds.length);
    $('.n-x', what).textContent = cnt(on.length, xs.length);
    $('.n-x', what).classList.toggle('mix', !!(nCopy && nCut));       // some to copy, some to move: half and half
    $('.from', what).textContent = `from ${folders} folder${folders === 1 ? '' : 's'}`;
    $('.c-c b', what).textContent = nCopy; $('.c-c', what).hidden = !nCopy && !!nCut;
    $('.c-k b', what).textContent = nCut; $('.c-k', what).hidden = !nCut;
    $('.n-d', del).textContent = cnt(dOn, ds.length); $('.n-d2', del).textContent = dOn;
    go.innerHTML = `Paste<span class="w">&nbsp;into ${here ? esc(base(here) || here) : '…'}</span>`;
    go.title = `Paste the ticked items into ${here || "the active pane's folder"} (Ctrl+V)`;
    go.disabled = !on.length;
    fitBar();
    what.setAttribute('aria-expanded', !cartEl.hidden && cartView === 'x');
    del.setAttribute('aria-expanded', !cartEl.hidden && cartView === 'd');
    if (!cartEl.hidden) drawCart();
  }
  const openCart = v => {
    if (!cartEl.hidden && cartView === v) { cartEl.hidden = true; return drawClip(); }
    cartView = v; cartEl.hidden = false; drawClip();
  };
  $('.uc-clip-what', clipBar).addEventListener('click', () => openCart('x'));
  $('.uc-clip-del', clipBar).addEventListener('click', () => openCart('d'));
  $('.uc-clip-go', clipBar).addEventListener('click', () => pasteHere(A()));
  const emptyClip = () => { setClip(null); toast('List emptied - nothing on the disks was changed'); };
  $('.uc-clip-x', clipBar).addEventListener('click', emptyClip);
  $('.kt-empty', cartEl).addEventListener('click', emptyClip);
  $('.kt-close', cartEl).addEventListener('click', () => { cartEl.hidden = true; drawClip(); });
  $('.kt-tabs', cartEl).addEventListener('click', e => { const t = e.target.closest('[data-view]'); if (t) { cartView = t.dataset.view; drawClip(); } });
  $('.kt-foot', cartEl).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.classList.contains('kt-rm')) { const n = ticked().length; clip.items = clip.items.filter(x => isDel(x) || !x.on); saveClip(); toast(`Took ${n} item${n === 1 ? '' : 's'} off the list`); }
    else if (b.classList.contains('kt-untag')) { const n = tagged().length; clip.items = clip.items.filter(x => !isDel(x) || !x.on); saveClip(); toast(`Untagged ${n} item${n === 1 ? '' : 's'} - nothing was deleted`); }
    else if (b.classList.contains('kt-paste')) { cartEl.hidden = true; pasteHere(A()); }
    else if (b.classList.contains('kt-del')) deleteTagged();
  });
  document.addEventListener('pointerdown', e => { if (!cartEl.hidden && !cartEl.contains(e.target) && !clipBar.contains(e.target) && !e.target.closest('.uc-modal')) { cartEl.hidden = true; drawClip(); } }, true);

  /* the list as a folder tree: one header line per folder (single-child chains
   * folded into one line), items under it; a collected folder opens to show
   * what's inside, so single files can be left behind */
  const cartOpen = new Set(), cartShut = new Set(), cartLs = new Map();
  async function cartList(path) {
    if (cartLs.has(path)) return cartLs.get(path);
    cartLs.set(path, null);
    try { const r = await api('list', { path }); cartLs.set(path, r.items.map(([n, t]) => ({ n, d: t === 'd' })).sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n, undefined, { numeric: true }))); }
    catch (e) { cartLs.set(path, []); }
    if (!cartEl.hidden) drawCart();
    return cartLs.get(path);
  }
  function drawCart() {
    if (!clip) { cartEl.hidden = true; return; }
    const xs = xferAll(), ds = delAll();
    if (cartView === 'd' && !ds.length) cartView = 'x';
    if (cartView === 'x' && !xs.length) cartView = 'd';
    const D = cartView === 'd', list = D ? ds : xs;
    cartEl.classList.toggle('del', D);
    const top = { kids: new Map(), items: [], path: '' };
    for (const c of list) {
      let t = top, at = '';
      for (const seg of parent(c.path).split('/').filter(Boolean)) {
        at += '/' + seg;
        if (!t.kids.has(seg)) t.kids.set(seg, { name: seg, path: at, kids: new Map(), items: [] });
        t = t.kids.get(seg);
      }
      t.items.push(c);
    }
    const squash = t => { for (const [k, ch] of [...t.kids]) { let c = ch; while (!c.items.length && c.kids.size === 1) { const g = [...c.kids.values()][0]; c = { ...g, name: c.name + '/' + g.name }; } t.kids.set(k, c); squash(c); } };
    squash(top);
    /* the top chain (/mnt/user/...) reads better as one full path */
    let start = top;
    while (!start.items.length && start.kids.size === 1) start = [...start.kids.values()][0];
    const all = t => [...t.items, ...[...t.kids.values()].flatMap(all)];
    const box = l => { const n = l.filter(c => c.on).length; return n === l.length ? 'on' : n ? 'part' : ''; };
    const chk = (cls, attrs) => `<span class="kt-cb ${cls}" ${attrs} role="checkbox" tabindex="0"></span>`;
    const sub = (c, path, rel, d, gone) => {
      const ls = cartLs.get(path);
      if (ls === undefined) { cartList(path); return `<div class="kt-s kt-wait" style="--d:${d}">Loading…</div>`; }
      if (ls === null) return `<div class="kt-s kt-wait" style="--d:${d}">Loading…</div>`;
      if (!ls.length) return `<div class="kt-s kt-wait" style="--d:${d}">Empty folder</div>`;
      return ls.map(k => {
        const r = rel + k.n, off = gone || c.skip.includes(r), part = !off && c.skip.some(x => x.startsWith(r + '/')), key = c.path + '\n' + r, open = k.d && cartOpen.has(key);
        return `<div class="kt-s${off ? ' off' : ''}" style="--d:${d}">${k.d ? `<button type="button" class="kt-car${open ? ' on' : ''}" data-cop="${esc(key)}">${mi('chev')}</button>` : '<span class="kt-nocar"></span>'}
          ${chk(gone ? 'dis' : off ? '' : part ? 'part' : 'on', gone ? '' : `data-csk="${esc(key)}"`)}<span class="kt-n${k.d ? ' dir' : ''}">${esc(k.n)}${k.d ? '/' : ''}</span></div>${open ? sub(c, join(path, k.n), r + '/', d + 1, off) : ''}`;
      }).join('');
    };
    const leaf = (c, d) => {
      const open = !D && c.dir && cartOpen.has(c.path);
      return `<div class="kt-i${c.on ? '' : ' off'}" style="--d:${d}">${!D && c.dir ? `<button type="button" class="kt-car${open ? ' on' : ''}" data-cop="${esc(c.path)}" title="Show what's inside - untick files to leave them behind">${mi('chev')}</button>` : '<span class="kt-nocar"></span>'}
        ${chk(!c.on ? '' : c.skip.length && !D ? 'part' : 'on', `data-cit="${esc(c.path)}"`)}
        <span class="kt-n${c.dir ? ' dir' : ''}" title="${esc(c.path)}">${esc(c.name)}${c.dir ? '/' : ''}${!D && c.dir && c.skip.length ? `<small>${c.skip.length} inside left out</small>` : ''}</span>
        ${D ? `<button type="button" class="kt-ib kt-back" data-cmode="copy" data-p="${esc(c.path)}" title="Untag it and put it back on the copy list" aria-label="Back to the copy list">${big('back', 2.2)}</button>`
          : `<span class="kt-mode"><button type="button" class="${c.mode === 'copy' ? 'on' : ''}" data-cmode="copy" data-p="${esc(c.path)}">Copy</button><button type="button" class="${c.mode === 'cut' ? 'on cut' : ''}" data-cmode="cut" data-p="${esc(c.path)}" ${SET.practice ? 'disabled title="Practice mode is on"' : ''}>Cut</button></span>`
            + (SET.collect ? `<button type="button" class="kt-ib kt-tag" data-cmode="del" data-p="${esc(c.path)}" title="Tag for delete - moves it to the delete list" aria-label="Tag ${esc(c.name)} for delete" ${SET.practice ? 'disabled' : ''}>${big('trash', 2.1)}</button>` : '')}
        <button type="button" class="kt-x" data-crm="${esc(c.path)}" aria-label="Take ${esc(c.name)} off the list">✕</button></div>${open ? sub(c, c.path, '', d + 1, false) : ''}`;
    };
    const fline = (f, d, label) => { const items = all(f), folded = cartShut.has(f.path);
      return `<div class="kt-f" style="--d:${d}" title="${esc(f.path)}"><button type="button" class="kt-car${folded ? '' : ' on'}" data-cfold="${esc(f.path)}">${mi('chev')}</button>
          ${chk(box(items), `data-cf="${esc(f.path)}"`)}<span class="kt-fn">${esc(label)}/</span><span class="kt-cnt">${items.length}</span></div>`
        + (folded ? '' : drawF(f, d + 1) + f.items.map(c => leaf(c, d + 1)).join('')); };
    const drawF = (t, d) => [...t.kids.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(f => fline(f, d, f.name)).join('');
    const body = start === top ? drawF(top, 0) + top.items.map(c => leaf(c, 0)).join('') : fline(start, 0, start.path);
    const tab = (v, ic, label, n) => `<button type="button" class="kt-tab ${v}${cartView === v ? ' on' : ''}" data-view="${v}">${ic}${label} <span class="bdg${v === 'd' ? ' red' : ''}">${n}</span></button>`;
    $('.kt-tabs', cartEl).innerHTML = (xs.length ? tab('x', big('clip', 1.9), 'Copy / Move', xs.length) : '') + (ds.length ? tab('d', big('trash', 2.1), 'Delete', ds.length) : '');
    $('.kt-body', cartEl).innerHTML = body;
    const p = A(), here = p.mode === 'dir' && !p.root ? p.path : null;
    if (!D) {
      const on = ticked().length, n = xs.length;
      $('.kt-foot', cartEl).innerHTML = `<span class="kt-hint">Only ticked items are pasted; the rest wait here. Copy leaves the original in place, Cut moves it.${SET.collect ? ' The trash can moves an item to the delete list.' : ''}</span>
        <button type="button" class="uc-btn kt-rm" ${on ? '' : 'disabled'}>Remove ticked</button><span class="sp"></span>
        <button type="button" class="uc-btn primary kt-paste" ${on && here ? '' : 'disabled'}>${here ? `Paste ${on === n ? (n === 1 ? '' : 'all ') : on + ' '}into ${esc(base(here) || here)}` : 'Open a folder to paste into'}</button>`;
    } else {
      const on = tagged().length;
      $('.kt-foot', cartEl).innerHTML = `<span class="kt-hint">Nothing is deleted until you press the red button - Paste never touches these. ↩ puts an item back on the copy list.</span>
        <button type="button" class="uc-btn kt-untag" ${on ? '' : 'disabled'}>Untag ticked</button><span class="sp"></span>
        <button type="button" class="uc-btn primary danger kt-del" ${on && !SET.practice ? '' : 'disabled'} ${SET.practice ? 'title="Practice mode is on"' : ''}>Delete ${on} tagged…</button>`;
    }
  }
  $('.kt-body', cartEl).addEventListener('click', e => {
    const g = a => e.target.closest(`[${a}]`);
    const m = g('data-cmode'), rm = g('data-crm'), it = g('data-cit'), cf = g('data-cf'), fold = g('data-cfold'), op = g('data-cop'), sk = g('data-csk');
    const find = path => clip.items.find(x => x.path === path);
    const inView = c => (cartView === 'd') === isDel(c);
    if (m) { if (m.disabled) return; const c = find(m.dataset.p);
      if (c) { const was = c.mode, to = m.dataset.cmode; c.mode = to; c.on = true;
        if (to === 'del' && was !== 'del') { c.skip = []; toast(`${c.name} moved to the delete list - nothing is deleted yet`); }
        else if (was === 'del' && to !== 'del') toast(`${c.name} is back on the copy list`); } }
    else if (rm) clip.items = clip.items.filter(x => x.path !== rm.dataset.crm);
    else if (it) { const c = find(it.dataset.cit); if (c) c.on = !c.on; }
    else if (cf) { const under = clip.items.filter(c => inView(c) && c.path.startsWith(cf.dataset.cf + '/')); const to = !under.every(c => c.on); under.forEach(c => { c.on = to; }); }
    else if (fold) { const k = fold.dataset.cfold; cartShut.has(k) ? cartShut.delete(k) : cartShut.add(k); return drawCart(); }
    else if (op) { const k = op.dataset.cop; cartOpen.has(k) ? cartOpen.delete(k) : cartOpen.add(k); return drawCart(); }
    else if (sk) { const [cp, r] = sk.dataset.csk.split('\n'); const c = find(cp);
      if (c) { if (c.skip.includes(r)) c.skip = c.skip.filter(x => x !== r); else { c.skip = c.skip.filter(x => !x.startsWith(r + '/')); c.skip.push(r); } c.on = true; } }
    else return;
    saveClip();
  });
  $('.kt-body', cartEl).addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('.kt-cb')) { e.preventDefault(); e.target.click(); } e.stopPropagation(); });
  drawClip();

  /* Delete tagged: the same window as F8, for items from any folder; one History step */
  function deleteTagged() {
    const t = tagged().map(c => ({ path: c.path, it: { t: c.dir ? 'd' : 'f', n: c.name } }));
    if (!t.length) return;
    if (SET.practice) return toast('Practice mode is on, so deleting is turned off. You can switch it off in Settings > Safety.', true);
    const n = t.length, desc = n === 1 ? `"${t[0].it.n}"` : `${n.toLocaleString()} tagged items`;
    const sysDel = t.some(x => !inShares(x.path));
    const inTrash = SET.trash === false || sysDel || t.some(x => x.path.includes('/.uncommander-trash/'));
    const TRASH_NOTE = 'They go to <span class="mono">.uncommander-trash</span> on their own share or disk — instant, and History can bring them back.';
    cartEl.hidden = true; drawClip();
    openDlg(inTrash ? `Permanently delete ${desc}?` : `Delete ${desc}?`,
      `${delList({}, t)}<div class="${inTrash && !sysDel ? 'warnbox' : 'muted'} del-note">${sysDel ? 'Some of these are outside <span class="mono">/mnt</span> and <span class="mono">/boot</span>, where there is no trash, so this removes them for good.' : inTrash ? (SET.trash === false ? 'The trash is switched off (Settings > Trash), so this removes them for good. There is no undo.' : 'Some of these are already in the trash. This removes them for good.') : TRASH_NOTE}</div>
      ${inTrash ? '' : `<label class="st-radio del-forever"><input type="checkbox" class="f-forever"><span><b>Delete permanently - skip the trash</b><br>
        <span class="muted">Removed for good straight away: no trash copy, no Undo.</span></span></label>`}`,
      [{ label: 'Cancel' }, { label: inTrash ? 'Delete forever' : 'Delete', primary: true, danger: true, run: async () => {
        const forever = !inTrash && $('.f-forever', dlg).checked;
        const paths = t.map(x => x.path);
        const r = await api('trash', { paths, forever: forever ? 1 : 0, label: `${forever ? 'Deleted for good' : 'Deleted'} ${n === 1 ? t[0].it.n : n + ' tagged items'}` });
        const gone = new Set(paths);
        clip && (clip.items = clip.items.filter(x => !gone.has(x.path) && ![...gone].some(g => x.path.startsWith(g + '/'))));
        saveClip();
        const msg = `Deleted ${r.count} item${r.count === 1 ? '' : 's'}`;
        if (r.bins && r.bins.length) done(msg, r.hist); else toast(msg);
        refreshBoth();
      } }]);
    const fv = $('.f-forever', dlg);
    if (fv) fv.addEventListener('change', () => {
      const note = $('.del-note', dlg), btn = $$('.dlg-foot .uc-btn', dlg).pop();
      note.className = (fv.checked ? 'warnbox warn' : 'muted') + ' del-note';
      note.innerHTML = fv.checked ? '<b>This cannot be undone.</b> These are deleted for good - they will not go to the trash.' : TRASH_NOTE;
      btn.textContent = fv.checked ? 'Delete forever' : 'Delete';
      $('.dlg-head', dlg).textContent = (fv.checked ? 'Permanently delete ' : 'Delete ') + desc + '?';
    });
  }

  function clipTake(p, idx, mode) {
    if (mode === 'cut' && SET.practice) return toast('Practice mode is on, so moving is turned off. You can switch it off in Settings > Safety.', true);
    if (mode === 'del' && SET.practice) return toast('Practice mode is on, so deleting is turned off. You can switch it off in Settings > Safety.', true);
    const items = dropInner(idx.map(i => p.items[i]).filter(it => it && !it.up).map(it => ({ it, path: fullPath(p, it) })))
      .map(({ it, path }) => ({ path, name: base(it.n), dir: !!itDir(p, it), mode, on: true, skip: [] }));
    return clipAdd(items, mode);
  }
  function clipUntag(p, idx) {
    const paths = new Set(idx.map(i => p.items[i]).filter(it => it && !it.up).map(it => fullPath(p, it)));
    clip.items = clip.items.filter(x => !(isDel(x) && paths.has(x.path)));
    saveClip(); toast(`Untagged ${paths.size === 1 ? base([...paths][0]) : paths.size + ' items'} - nothing was deleted`);
  }
  function clipAdd(items, mode) {
    if (!items.length) return toast('Put the cursor on something first', true);
    sound.play('click');
    const what = items.length === 1 ? items[0].name : items.length + ' items';
    if (mode !== 'del' && (!SET.collect || !clip)) {
      const dels = delAll(), had = xferAll().length;
      const keep = dels.filter(d => !items.some(x => x.path === d.path));
      setClip({ items: [...items, ...keep] });
      return toast(`${mode === 'cut' ? 'Cut' : 'Copied'} ${what}${had ? ` (it replaces the ${had} that ${had === 1 ? 'was' : 'were'} on the clipboard)` : ''} - open a folder and Paste (Ctrl+V, or the button at the top)`);
    }
    if (!clip) clip = { items: [] };
    let added = 0, changed = 0;
    for (const x of items) {
      const have = clip.items.find(c => c.path === x.path);
      if (have) { if (have.mode !== mode || !have.on) { have.mode = mode; have.on = true; if (mode === 'del') have.skip = []; changed++; } continue; }
      clip.items.push(x); added++;
    }
    saveClip();
    clipBar.classList.remove('bump'); void clipBar.offsetWidth; clipBar.classList.add('bump');
    if (mode === 'del') return toast(added || changed ? `Tagged ${what} for delete - nothing is deleted until you press Delete in the list (the red trash at the top)` : 'Already tagged for delete');
    toast(added || changed ? `${added ? `Added ${added === 1 ? items[0].name : added + ' items'} ${mode === 'cut' ? 'to move' : 'to copy'}` : `Switched ${changed} to ${mode === 'cut' ? 'Cut' : 'Copy'}`} - the list has ${xferAll().length} item${xferAll().length === 1 ? '' : 's'} now` : 'Already on the list');
  }
  function pasteHere(p, into) {
    if (!xferAll().length) return toast('Nothing to paste yet - Copy or Cut something first', true);
    const target = into || (p.mode === 'dir' && !p.root ? p.path : null);
    if (!target) return toast('Open a folder in this pane first, then Paste', true);
    const on = ticked();
    if (!on.length) return toast('Nothing on the list is ticked', true);
    openPaste(on, null, target, { fromClip: true });
  }
  /* rows that are on the list get a small mark (cut ones are dimmed, tagged ones struck through) */
  function clipMark(path) { if (!clipSet.has(path)) return null; const c = clip.items.find(x => x.path === path); return c ? c.mode : null; }

  /* ---------- the Paste window ----------
   * Lists every item with the folder it comes from; untick what shouldn't go;
   * for a name that's already there choose Keep both (a new name) or Replace. */
  const uniqueName = (name, taken) => {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) { const n = `${stem} (${i})${ext}`; if (!taken.has(n)) return n; }
  };
  const verbOf = ops => { const c = ops.filter(o => o.mode !== 'cut').length, m = ops.length - c; return !m ? 'Copy' : !c ? 'Move' : 'Paste'; };
  async function openPaste(items, mode, target, o = {}) {
    closeMenu(); cartEl.hidden = true;
    let there;
    try { there = new Set((await api('list', { path: target })).items.map(x => x[0])); }
    catch (e) { return toast(e.message, true); }
    const notes = [], ops = [];
    const seen = new Map();
    for (const it of items) {
      const m = mode || it.mode || 'copy';
      if (it.dir && (target === it.path || target.startsWith(it.path + '/'))) { notes.push(`${it.name} is left out: a folder can't go inside itself.`); continue; }
      if (m === 'cut' && parent(it.path) === target) { notes.push(`${it.name} is left out: it's already in this folder.`); continue; }
      const op = { path: it.path, name: it.name, dir: it.dir, skip: it.skip || [], mode: m, on: true, act: 'keep', clash: null };
      if (seen.has(it.name)) op.clash = { dup: seen.get(it.name) };
      else if (there.has(it.name)) op.clash = parent(it.path) === target ? 'self' : 'exists';
      seen.set(it.name, it.path);
      ops.push(op);
    }
    if (!ops.length) return openDlg('Nothing to paste', `<div class="muted">${notes.map(esc).join('<br>')}</div>`, [{ label: 'OK', primary: true }]);
    /* the name each one will get */
    const names = () => {
      const taken = new Set(there), out = [];
      ops.forEach((op, i) => {
        if (!op.on) { out[i] = null; return; }
        if (op.clash && op.act === 'replace') { out[i] = op.name; taken.add(op.name); return; }
        out[i] = uniqueName(op.name, taken); taken.add(out[i]);
      });
      return out;
    };
    if (o.quick && !notes.length && !ops.some(op => op.clash)) return runPaste(ops, names(), target, o);
    const canReplace = op => op.clash === 'exists' && !SET.practice;
    const title = verbOf(ops);
    const draw = () => {
      const nm = names(), onOps = ops.filter(op => op.on), on = onOps.length, clashes = ops.filter(op => op.clash);
      const c = onOps.filter(x => x.mode !== 'cut').length, mv = on - c;
      $('.pw-list', dlg).innerHTML = ops.map((op, i) => {
        const why = !op.clash ? '' : op.clash === 'self' ? 'copying it into its own folder' : op.clash === 'exists' ? `${op.dir ? 'a folder' : 'a file'} with this name is already there` : 'another item in this paste has the same name';
        const res = !op.on ? '' : op.act === 'replace' ? (op.dir ? 'goes into the folder that is there; files with the same name are replaced' : 'replaces the one that is there') + (SET.trash === false ? ' - the trash is off, so the old one is gone for good' : ' - the old one goes to the trash')
          : nm[i] !== op.name ? `saved as <b>${esc(nm[i])}</b>` : '';
        return `<label class="pw-i${op.clash ? ' clash' : ''}${op.on ? '' : ' off'}"><input type="checkbox" data-pi="${i}" ${op.on ? 'checked' : ''}>
          <span class="pw-op ${op.mode}">${op.mode === 'cut' ? '✂ Move' : '⧉ Copy'}</span>
          <span class="pw-n"><b>${esc(op.name)}${op.dir ? '/' : ''}</b><span class="pw-from">from ${esc(parent(op.path))}/</span>${op.skip.length ? `<span class="pw-why">only the ticked contents - ${op.skip.length} inside left out${op.mode === 'cut' ? ', they stay where they are' : ''}</span>` : ''}${why ? `<span class="pw-why">${why}</span>` : ''}${res ? `<span class="pw-res">→ ${res}</span>` : ''}</span>
          ${op.clash && op.on ? `<span class="pw-seg"><button type="button" data-pa="${i}" data-v="keep" class="${op.act === 'keep' ? 'on' : ''}">Keep both</button>${op.clash === 'exists' ? `<button type="button" data-pa="${i}" data-v="replace" class="${op.act === 'replace' ? 'on' : ''}" ${canReplace(op) ? '' : 'disabled title="Practice mode is on"'}>${op.dir ? 'Merge' : 'Replace'}</button>` : ''}</span>` : '<span></span>'}</label>`;
      }).join('');
      const nFolders = new Set(onOps.map(x => parent(x.path))).size;
      $('.pw-head', dlg).innerHTML = `<label class="pw-all"><input type="checkbox" class="pw-allcb" ${on === ops.length ? 'checked' : ''}></label><span>${on ? [c && `Copy ${c}`, mv && `move ${mv}`].filter(Boolean).join(', ').replace(/^m/, 'M') + (nFolders > 1 ? ` from ${nFolders} folders` : '') : 'Nothing ticked'}${on < ops.length ? ` <span class="muted">(${ops.length - on} left out${o.fromClip ? ` - ${ops.length - on === 1 ? 'it stays' : 'they stay'} on the list` : ''})</span>` : ''}</span>`
        + (clashes.length ? `<span class="sp"></span><span class="pw-clashn">${clashes.length} name${clashes.length === 1 ? '' : 's'} already taken</span><span class="pw-seg"><button type="button" data-pall="keep">Keep all</button>${clashes.some(canReplace) ? '<button type="button" data-pall="replace">Replace all</button>' : ''}</span>` : '');
      const go = $$('.dlg-foot .uc-btn', dlg).pop(); go.disabled = !on; go.textContent = on ? `${verbOf(onOps)} ${on.toLocaleString()}` : title;
    };
    const hasCopy = ops.some(x => x.mode !== 'cut'), hasMove = ops.some(x => x.mode === 'cut');
    openDlg(`${title} here`, `
      <div class="pw-into"><small>${title} into</small><span class="mono">${esc(target)}</span></div>
      <div class="pw"><div class="pw-head"></div><div class="pw-list"></div></div>
      ${notes.length ? `<div class="muted pw-notes">${notes.map(esc).join('<br>')}</div>` : ''}
      <div class="muted pw-foot">${hasMove ? 'On the same disk a move is instant. ' : ''}Shows up in History, so it can be undone.${o.fromClip && hasCopy ? ' Copied items stay on the list after pasting, so you can paste them somewhere else too; moved ones leave it.' : ''}</div>`,
      [{ label: 'Cancel' }, { label: title, primary: true, run: () => runPaste(ops, names(), target, o) }], 'paste-dlg');
    const box = $('.pw', dlg);
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-pa]'), all = e.target.closest('[data-pall]');
      if (a) { e.preventDefault(); ops[+a.dataset.pa].act = a.dataset.v; draw(); }
      if (all) { e.preventDefault(); ops.forEach(op => { if (op.clash) op.act = all.dataset.pall === 'replace' && canReplace(op) ? 'replace' : 'keep'; }); draw(); }
    });
    box.addEventListener('change', e => {
      const c = e.target.closest('[data-pi]');
      if (c) { ops[+c.dataset.pi].on = c.checked; draw(); }
      if (e.target.closest('.pw-allcb')) { const to = e.target.checked; ops.forEach(op => { op.on = to; }); draw(); }
    });
    draw();
  }
  async function runPaste(ops, nm, target, o) {
    const pick = ops.map((op, i) => ({ op, name: nm[i] })).filter(x => x.op.on);
    const nCopy = pick.filter(x => x.op.mode !== 'cut').length, nMove = pick.length - nCopy;
    const label = (nCopy && nMove) ? `Pasted ${pick.length} items into ${base(target) || target} (${nCopy} copied, ${nMove} moved)` : '';
    /* up to four groups (copy / move, each plain or replacing): one History step */
    const groups = [];
    for (const type of ['copy', 'move']) for (const repl of [false, true]) {
      const g = pick.filter(x => (x.op.mode === 'cut') === (type === 'move') && !!(x.op.clash && x.op.act === 'replace') === repl);
      if (g.length) groups.push({ type, repl, g });
    }
    const jobs = []; let hist = '';
    try {
      for (const { type, repl, g } of groups) {
        const r = await api('job_start', { type, sources: g.map(x => x.op.path), dest: target, exists: repl ? 'overwrite' : 'skip',
          as: g.map(x => x.name === x.op.name ? '' : x.name), excl: g.map(x => x.op.skip || []), hist_join: hist, label });
        hist = hist || r.hist || ''; if (!r.instant) jobs.push(r.job);
      }
    } catch (e) { toast(e.message, true); refreshBoth(); return false; }
    /* moved items leave the list; copied ones stay for another paste */
    if (o.fromClip && clip) { const gone = new Set(pick.filter(x => x.op.mode === 'cut').map(x => x.op.path)); if (gone.size) { clip.items = clip.items.filter(x => !gone.has(x.path)); saveClip(); } }
    panes.forEach(q => { if (q.mode === 'dir' && q.sel.size && pick.some(x => parent(x.op.path) === q.path)) q.sel.clear(); });
    if (jobs.length) { openProgress(jobs[0]); if (progress) jobs.forEach(i => progress.ids.add(i)); }
    else {
      if (!modal.hidden && $('.pw', dlg)) closeDlg();
      done(label || `${nMove ? 'Moved' : 'Copied'} ${pick.length === 1 ? pick[0].name : pick.length + ' items'} into ${base(target) || target}`, hist); refreshBoth();
    }
    return false;
  }

  /* ---------- New file ---------- */
  function newFile(p) {
    if (p.mode !== 'dir' || p.root) return toast('Open a folder first', true);
    openDlg('New file', `<div class="field"><label>Name</label><input type="text" class="f-name" value="new.txt"></div>
      <div class="muted">An empty file in <span class="mono">${esc(p.path)}</span>. It opens in the editor straight away.</div>`,
      [{ label: 'Cancel' }, { label: 'Create', primary: true, run: async () => {
        const dir = p.path, r = await api('newfile', { path: dir, name: $('.f-name', dlg).value });
        closeDlg(); await load(p, dir, r.name);
        done(`Created ${r.name}`, r.hist);
        openEditor(r.path);
        return false;
      } }]);
    const inp = $('.f-name', dlg); inp.setSelectionRange(0, 3);
  }

  /* ---------- Properties ---------- */
  async function showProps(p, it) {
    const path = fullPath(p, it);
    let s = null;
    try { s = (await api('stat', { path: parent(path), names: [base(path)] })).stats[base(path)]; } catch (e) {}
    if (!s) return toast(`${base(path)} isn't there any more`, true);
    const row = (k, v) => v ? `<div class="pr-r"><span class="pr-k">${k}</span><span class="pr-v">${v}</span></div>` : '';
    const locs = p.locs && p.locs.get(it.abs || it.n);
    openDlg('Properties', `<div class="pr">
      ${row('Name', `<b>${esc(base(path))}</b>`)}${row('Folder', `<span class="mono">${esc(parent(path))}</span>`)}
      ${row('Kind', s.l ? `link → <span class="mono">${esc(s.l)}</span>` : s.d ? 'folder' : 'file')}
      ${row('Size', s.d ? '<button type="button" class="uc-btn pr-size">Add up the folder size</button>' : `${fmtBytes(s.s)} <span class="muted">(${(s.s || 0).toLocaleString()} bytes)</span>`)}
      ${row('Modified', new Date(s.m * 1000).toLocaleString())}
      ${row('Owner', `<span class="mono">${esc(s.o)}:${esc(s.g)}</span>${s.o !== 'nobody' || s.g !== 'users' ? ' <span class="muted">(unRAID usually uses nobody:users)</span>' : ''}`)}
      ${row('Permissions', `<span class="mono">${esc(s.p)}</span>`)}
      ${locs && locs.length ? row('On', esc(locs.join(', '))) : ''}</div>`,
      [{ label: 'Copy path', run: () => { copyText(path); return false; } }, { label: 'Close', primary: true }]);
    const b = $('.pr-size', dlg);
    if (b) b.addEventListener('click', () => { closeDlg(); actOn(p, [p.items.indexOf(it)], 'sizes'); });
  }

  /* ---------- what goes in the menu ---------- */
  function rowMenu(p, i, x, y) {
    if (p.loading) return;
    setActive(p.i);
    const it = i == null ? null : p.items[i];
    if (!it || it.up) return emptyMenu(p, x, y);
    if (it.ghost) { p.cursor = i; drawRows(p); const g = udOf(p, it); return showMenu(x, y, it.n, [{ label: 'Mount', ic: 'enter', hl: true, sub: g ? g.about || g.src : '', run: () => udMountRow(p, it, false) }, { label: 'Mount and open', ic: 'open', run: () => udMountRow(p, it, true) }]); }
    let idx;
    if (p.sel.has(i)) idx = [...p.sel].sort((a, b) => a - b);
    else { idx = [i]; p.cursor = i; p.armed = null; drawRows(p); }
    const its = idx.map(k => p.items[k]).filter(Boolean), one = its.length === 1;
    const path = fullPath(p, its[0]), isDir = one && itDir(p, its[0]);
    const anyDir = its.some(t => itDir(p, t)), inDir = p.mode === 'dir' && !p.root;
    const sysDel = its.some(t => !inShares(fullPath(p, t)));
    const forGood = p.trash || sysDel || SET.trash === false || its.some(t => fullPath(p, t).includes('/.uncommander-trash'));
    const items = [];
    if (p.arc) {              // inside an archive: look, copy out, nothing that changes it
      const q = B();
      if (one && isDir) items.push({ label: 'Open', ic: 'open', sc: 'Enter', hl: true, run: () => openItem(p, i) }, { label: 'Open in the other pane', ic: 'pane', run: () => load(B(), path) });
      else if (one) items.push({ label: 'View', ic: 'view', sc: fkKeyOf('view'), hl: true, run: () => actOn(p, idx, 'view') });
      items.push('-', { label: 'Copy', ic: 'copy', sc: 'Ctrl C', sub: 'paste it anywhere outside the archive', run: () => clipTake(p, idx, 'copy') });
      if (q.mode === 'dir' && !q.root && !q.arc) items.push({ label: 'Copy to the other pane', ic: 'copy', sc: fkKeyOf('copy'), hl: !one || isDir, sub: `out of the archive, into ${base(q.path) || q.path}`, run: () => actOn(p, idx, 'copy') });
      if (one && !isDir) items.push({ label: 'Download', ic: 'download', sub: 'to this computer', run: () => downloadPaths([path]) });
      items.push('-', { label: one ? 'Copy path' : 'Copy paths', ic: 'link', run: () => copyText(its.map(t => fullPath(p, t)).join('\n')) });
      return showMenu(x, y, one ? base(path) : `${its.length.toLocaleString()} ticked items`, items);
    }
    if (one && !isDir && isArchive(path) && !p.root) items.push({ label: 'Open as a folder', ic: 'open', sc: 'Enter', hl: true, sub: 'look inside - read-only', run: () => openItem(p, i) });
    if (p.root) {
      items.push({ label: 'Open', ic: 'enter', sc: 'Enter', hl: true, run: () => openItem(p, i) },
                 { label: 'Open in the other pane', ic: 'pane', run: () => load(B(), path) }, '-',
                 { label: 'Copy path', ic: 'link', run: () => copyText(path) });
      return showMenu(x, y, base(path) || path, items);
    }
    if (one && isDir) items.push({ label: 'Open', ic: 'open', sc: 'Enter', hl: true, run: () => openItem(p, i) },
                                 { label: 'Open in the other pane', ic: 'pane', run: () => load(B(), path) });
    else if (one) {
      items.push({ label: 'View', ic: 'view', sc: fkKeyOf('view'), hl: true, run: () => actOn(p, idx, 'view') });
      if (!NO_EDIT.test(path)) items.push({ label: 'Edit', ic: 'edit', sc: fkKeyOf('edit'), run: () => actOn(p, idx, 'edit') });
      else if (EDIT_IMG.test(path)) items.push({ label: 'Edit picture…', ic: 'edit', sub: 'rotate, crop, resize, change type', run: () => openImageEditor(path) });
      items.push({ label: 'Show in the other pane', ic: 'pane', run: () => load(B(), parent(path), base(path)) });
    }
    /* music: tags and covers */
    const auds = its.filter(t => !itDir(p, t) && GAL_AUD.test(t.n));
    if ((auds.length && auds.length === its.length) || (mus && its.every(t => itDir(p, t))))
      items.push({ label: 'Edit music tags…', ic: 'edit', sub: one && !isDir ? 'title, artist, album…' : 'for all the songs in it, with MusicBrainz', lock: lockIf('changing tags'), run: () => openTagEditor(its.map(t => ({ path: fullPath(p, t), dir: itDir(p, t) }))) });
    /* music folders: in the music library, while a playlist or the player is in use, or anywhere under a music collection */
    const musicHere = mus || pl.items.length || [...musProbe].some(([k, v]) => v === true && p.mode === 'dir' && (p.path === k || p.path.startsWith(k + '/')));
    const isPl = one && /\.m3u8?$/i.test(path);
    const musicSel = its.every(t => itDir(p, t) || GAL_AUD.test(t.n) || /\.m3u8?$/i.test(t.n)) && (auds.length || (musicHere && its.some(t => itDir(p, t))));   // songs and folders (playlist files among them are skipped)
    if (playerOn() && (musicSel || isPl))
      items.push({ label: 'Play', ic: 'view', sub: isPl ? 'opens this playlist in the player' : 'in the player - replaces the playlist', run: () => plPlay(its.map(t => fullPath(p, t))) },
                 { label: 'Add to playlist', ic: 'plus', sub: pl.items.length ? `"${pl.name}" · ${pl.items.length} song${pl.items.length === 1 ? '' : 's'} so far` : 'the player\'s playlist', run: () => plAdd(its.map(t => fullPath(p, t))) });
    if (isPl) items.push({ label: 'Check this playlist', ic: 'view', sub: 'which songs are there, how its paths are written', run: () => openPlaylistCheck(path) },
                         { label: 'Edit as text', ic: 'edit', sub: 'the file itself, line by line', run: () => openEditor(path) });
    if (one && auds.length === 1) items.push({ label: 'Save its cover as cover.jpg', ic: 'star', sub: 'the picture inside the song, for the whole folder', lock: lockIf('saving covers'), run: () => saveCover(path, parent(path)) });
    if (one && !isDir && /\.(jpe?g|png)$/i.test(path) && !/^cover\./i.test(base(path))) items.push({ label: "Use as the folder's cover", ic: 'star', sub: 'saved as cover.' + (/png$/i.test(path) ? 'png' : 'jpg'), lock: lockIf('saving covers'), run: () => saveCover(path, parent(path)) });
    items.push('-',
      { label: 'Copy', ic: 'copy', sc: 'Ctrl C', sub: SET.collect && clip ? 'add to the list' : '', run: () => clipTake(p, idx, 'copy') },
      { label: 'Cut', ic: 'cut', sc: 'Ctrl X', sub: SET.collect && clip ? 'add to the list (to move)' : '', lock: lockIf('moving'), run: () => clipTake(p, idx, 'cut') });
    if (SET.collect) {
      const paths = its.map(t => fullPath(p, t)), allTagged = paths.every(x => clipMark(x) === 'del');
      items.push(allTagged ? { label: 'Untag', ic: 'trash', sub: 'take it off the delete list', run: () => clipUntag(p, idx) }
        : { label: 'Tag for delete', ic: 'trash', danger: true, sub: 'add to the delete list - nothing is deleted yet', lock: lockIf('deleting'), run: () => clipTake(p, idx, 'del') });
    }
    const heics = its.filter(t => !itDir(p, t) && HEIC.test(t.n));
    if (heics.length) items.push({ label: heics.length === 1 ? 'Convert to JPG' : `Convert ${heics.length} HEIC to JPG`, ic: 'copy', sub: 'a .jpg next to each - the HEIC stays', run: () => heicToJpg(heics.map(t => fullPath(p, t))) });
    const nT = ticked().length;
    if (nT && one && isDir && p.mode === 'dir') items.push({ label: `Paste into "${base(path)}"`, ic: 'paste', hl: true, sub: `${nT} item${nT === 1 ? '' : 's'} from the list`, run: () => pasteHere(p, path) });
    items.push('-');
    if (one) items.push({ label: 'Rename…', ic: 'rename', sc: fkKeyOf('rename'), lock: lockIf('renaming'), run: () => actOn(p, idx, 'rename') });
    else if (inDir && p.sel.size) items.push({ label: 'Batch rename…', ic: 'rename', lock: lockIf('renaming'), run: () => actOn(p, idx, 'brename') });
    items.push({ label: 'Fix access…', ic: 'key', sub: 'so shares and Docker apps can open it (nobody / users)', lock: lockIf('changing permissions'), run: () => actOn(p, idx, 'perms') },
               { label: 'Permissions…', ic: 'key', sc: fkKeyOf('perms'), lock: lockIf('changing permissions'), run: () => actOn(p, idx, 'perms') });
    if (one && isDir) items.push({ label: "What's using space here", ic: 'size', sub: 'a map and a list, biggest first', run: () => openSpaceTool(path) });
    if (inDir) items.push({ label: 'Compress…', ic: 'zip', run: () => actOn(p, idx, 'compress') });
    if (one && isArchive(path)) items.push({ label: 'Extract…', ic: 'unzip', hl: true, run: () => actOn(p, idx, 'extract') });
    if (anyDir) items.push({ label: one ? 'Folder size' : 'Folder sizes', ic: 'size', run: () => actOn(p, idx, 'sizes') });
    items.push('-');
    if (one && isDir) {
      items.push({ label: 'Find in this folder…', ic: 'find', run: () => findDialog(p, { path }) },
                 { label: 'Add to shortcuts', ic: 'star', run: () => addBookmark(path) });
    }
    if (!p.root) items.push({ label: one && !isDir ? 'Download' : 'Download as .zip', ic: 'download', sub: one && !isDir ? 'to this computer' : `${one ? 'the folder' : `the ${its.length.toLocaleString()} items`}, in one .zip - to this computer`, run: () => downloadPaths(its.map(t => fullPath(p, t))) });
    if (one && isDir && p.mode === 'dir') items.push({ label: `Upload into "${base(path)}"…`, ic: 'upload', sub: 'files from this computer', run: () => upPick(p, path) });
    const udx = one && p.udMap ? udOf(p, its[0]) : null;
    if (udx && udx.mounted) items.push({ label: 'Unmount', ic: 'x', sub: udx.about || udx.src, run: () => udUnmount(p, udx) });
    if (one) items.push({ label: 'Properties', ic: 'info', run: () => showProps(p, its[0]) });
    items.push({ label: one ? 'Copy path' : 'Copy paths', ic: 'link', run: () => copyText(its.map(t => fullPath(p, t)).join('\n')) });
    if (p.trash && its.some(t => itDir(p, t))) items.push('-', { label: 'Restore', ic: 'restore', hl: true, lock: lockIf('restoring from the trash'), run: () => actOn(p, idx, 'restore') });
    const q = B();
    if (inDir && q.mode === 'dir' && !q.root) {
      const into = `into ${base(q.path) || q.path} (${q.i ? 'right' : 'left'} pane)`;
      items.push('-', { label: 'Copy to the other pane', ic: 'copy', sc: fkKeyOf('copy'), sub: into, run: () => actOn(p, idx, 'copy') },
                      { label: 'Move to the other pane', ic: 'pane', sc: fkKeyOf('move'), sub: into, lock: lockIf('moving'), run: () => actOn(p, idx, 'move') });
    }
    items.push('-', { label: forGood ? 'Delete for good…' : 'Delete…', ic: 'trash', sc: fkKeyOf('delete') || 'Del', danger: true, lock: lockIf('deleting'), run: () => actOn(p, idx, 'delete') });
    showMenu(x, y, one ? base(path) : `${its.length.toLocaleString()} ticked items`, items);
  }
  function emptyMenu(p, x, y) {
    setActive(p.i);
    if (p.mode !== 'dir' || p.root) return;
    if (p.arc) return showMenu(x, y, base(p.arc.file) + ' · read-only', [
      { label: 'Select all', ic: 'check', sc: 'Ctrl A', run: () => selectCmd('all') },
      { label: 'Select by pattern…', ic: 'pattern', sub: 'like *.srt', run: () => { const pat = $('.uc-pat'); pat.focus(); pat.select(); } },
      '-', { label: 'Close the archive', ic: 'enter', sub: 'back to the folder it is in', run: () => load(p, parent(p.arc.file), base(p.arc.file)) }]);
    const items = [
      ticked().length ? { label: 'Paste here', ic: 'paste', sc: 'Ctrl V', hl: true, sub: `${ticked().length} item${ticked().length === 1 ? '' : 's'} from the list`, run: () => pasteHere(p) }
           : { label: 'Paste here', ic: 'paste', sc: 'Ctrl V', off: true, sub: 'Copy or Cut something first' },
      '-',
      { label: 'New folder…', ic: 'newdir', sc: fkKeyOf('mkdir'), run: () => actOn(p, [], 'mkdir') },
      { label: 'New file…', ic: 'newfile', run: () => newFile(p) },
      { label: 'Upload files here…', ic: 'upload', sub: 'from this computer - or drop them on the list', run: () => upPick(p, p.path) },
      IS_IOS ? null : { label: 'Upload a folder here…', ic: 'upload', run: () => upPick(p, p.path, true) },
      '-',
      { label: 'Select all', ic: 'check', sc: 'Ctrl A', run: () => selectCmd('all') },
      { label: 'Select by pattern…', ic: 'pattern', sub: 'like *.srt', run: () => { const pat = $('.uc-pat'); pat.focus(); pat.select(); } },
      { label: 'Refresh', ic: 'refresh', run: () => refresh(p) },
      mus ? { label: 'Close music library', ic: 'view', sub: 'both panes stay where they are', run: () => musExit() } : p.gal ? { label: 'List view', ic: 'view', run: () => galSet(p, false) } : { label: 'Gallery view', ic: 'view', sub: 'pictures as tiles, a big preview in the other pane', run: () => galSet(p, true) },
      { label: 'Compare with the other pane', ic: 'compare', run: () => { musExit(); act('compare'); } },
      '-',
      { label: "What's using space here", ic: 'size', sub: 'a map and a list, biggest first', run: () => openSpaceTool(p.path) },
      { label: "Copy this folder's path", ic: 'link', run: () => copyText(p.path) },
      { label: `${showHidden ? 'Hide' : 'Show'} hidden files`, ic: 'hidden', run: () => $('.uc-showhidden').click() },
    ];
    showMenu(x, y, base(p.path) || p.path, items);
  }
  function crumbMenu(p, path, x, y) {
    setActive(p.i);
    showMenu(x, y, path, [
      { label: 'Open', ic: 'enter', hl: true, run: () => load(p, path) },
      { label: 'Open in the other pane', ic: 'pane', run: () => load(B(), path) },
      '-', { label: 'Copy path up to here', ic: 'link', run: () => copyText(path) },
    ]);
  }

  /* ---------- wiring: right-click, press-and-hold, the menu key ---------- */
  const rowIdx = e => { const r = e.target.closest('.uc-row'); return r ? +r.dataset.idx : null; };
  function holdToMenu(el, open) {
    let lp = null;
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || store.get('ctxOff', false)) { lp && clearTimeout(lp.t); lp = null; return; }
      const t = e.touches[0], target = e.target;
      lp = { x: t.clientX, y: t.clientY, t: setTimeout(() => { lp.fired = true; el.lpAt = Date.now(); store.set('holdHint', true); try { getSelection().removeAllRanges(); } catch (e) {} open({ target, clientX: lp.x, clientY: lp.y }); }, 500) };
    }, { passive: true });
    el.addEventListener('touchmove', e => { if (!lp) return; const t = e.touches[0]; if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 10) { clearTimeout(lp.t); lp = null; } }, { passive: true });
    el.addEventListener('touchend', e => { if (!lp) return; clearTimeout(lp.t); if (lp.fired && e.cancelable) e.preventDefault(); lp = null; });
    el.addEventListener('touchcancel', () => { if (lp) clearTimeout(lp.t); lp = null; });
    el.addEventListener('contextmenu', e => {
      if (e.shiftKey || store.get('ctxOff', false)) return;      // the browser's own menu (Inspect…)
      /* right-click ticks: a mouse's right-click is handled below (the menu comes from holding it) */
      if (el.rtickPane && rtickOn() && Date.now() - (el.rtickPane.touchAt || 0) > 1500 && Date.now() - (el.lpAt || 0) > 1000) { e.preventDefault(); return; }
      if (el === e.currentTarget && e.target.closest('.uc-trail') && (() => { const s = getSelection(); return s && !s.isCollapsed && el.contains(s.anchorNode); })()) return;   // text is selected: the browser's own menu
      e.preventDefault();
      if (Date.now() - (el.lpAt || 0) < 1000) return;        // Android sends this after our own press-and-hold
      open(e);
    });
  }
  for (const p of panes) {
    holdToMenu(p.list, e => rowMenu(p, rowIdx(e), e.clientX, e.clientY));
    holdToMenu(p.trailEl, e => { const seg = e.target.closest('.tr-seg'); if (seg) crumbMenu(p, seg.dataset.path, e.clientX, e.clientY); });
  }
  /* right-click ticks (Settings > Keyboard, mouse only): a click ticks or unticks the row, dragging with the
   * button held ticks (or unticks) every row it passes, holding still for half a second opens the menu */
  for (const p of panes) {
    p.list.rtickPane = p;
    let rd = null;
    const end = () => { if (rd) clearTimeout(rd.t); rd = null; };
    p.list.addEventListener('pointerdown', e => {
      if (e.button !== 2 || e.pointerType !== 'mouse' || e.shiftKey || !rtickOn() || p.gal || p.mt) return;
      const i = rowIdx(e); end();
      if (i == null || !p.items[i] || p.items[i].up) return;
      setActive(p.i);
      rd = { i, last: i, on: !p.sel.has(i), x: e.clientX, y: e.clientY, menu: false, moved: false };
      rd.t = setTimeout(() => { if (!rd || rd.moved) return; rd.menu = true; rowMenu(p, rd.i, rd.x, rd.y); }, 500);
    });
    p.list.addEventListener('pointermove', e => {
      if (!rd || rd.menu || !(e.buttons & 2)) return;
      if (!rd.moved) { if (Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < 5) return; rd.moved = true; clearTimeout(rd.t); selectRange(p, rd.i, rd.i, rd.on); }
      const i = rowIdx(e);
      if (i != null && i !== rd.last && p.items[i]) { selectRange(p, rd.last, i, rd.on); rd.last = i; }
      drawRows(p); updateSelInfo(p);
    });
    window.addEventListener('pointerup', e => {
      if (!rd || e.button !== 2) return;
      const r = rd; end();
      if (r.menu || r.moved) return;
      toggle(p, r.i); moveCursor(p, r.i); drawRows(p); updateSelInfo(p); sound.play('click');
    });
  }
  /* the menu key / Shift+F10: the menu for the row under the cursor */
  function menuAtCursor() {
    const p = A(), r = $(`.uc-row[data-idx="${p.cursor}"]`, p.list);
    const b = (r || p.list).getBoundingClientRect();
    rowMenu(p, p.items[p.cursor] ? p.cursor : null, b.left + Math.min(160, b.width / 3), b.top + (r ? b.height : 20));
  }

  /* ---------- drag rows to the other pane, or onto a folder (mouse) ---------- */
  let drag = null;
  function dropTarget(e) {
    if (!drag) return null;
    const list = e.target.closest('.uc-list'); if (!list) return null;
    const q = panes.find(x => x.list === list); if (!q || q.loading || q.mode !== 'dir' || q.root || q.arc) return null;   // nothing goes into an archive
    const i = rowIdx(e), it = i == null ? null : q.items[i];
    if (it && !it.up && itDir(q, it)) {
      const path = fullPath(q, it);
      if (!drag.paths.includes(path) && !drag.paths.some(s => path.startsWith(s + '/'))) return { dir: path, row: $(`.uc-row[data-idx="${i}"]`, list) };
    }
    if (q !== drag.from && !drag.paths.some(s => parent(s) === q.path)) return { dir: q.path, list };
    return null;
  }
  const osFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  function osTarget(e) {
    const list = e.target.closest('.uc-list'); if (!list) return null;
    const q = panes.find(x => x.list === list); if (!q || q.loading || q.mode !== 'dir' || q.root || q.arc) return null;   // nothing goes into an archive
    const i = rowIdx(e), it = i == null ? null : q.items[i];
    if (it && !it.up && itDir(q, it)) return { q, dir: fullPath(q, it), row: $(`.uc-row[data-idx="${i}"]`, list) };
    return { q, dir: q.path, list };
  }
  const clearDrop = () => $$('.drop-on, .drop-here', root).forEach(el => el.classList.remove('drop-on', 'drop-here'));
  for (const p of panes) {
    p.list.addEventListener('dragstart', e => {
      const i = rowIdx(e), it = i == null ? null : p.items[i];
      if (!it || it.up || p.loading || !finePointer()) return e.preventDefault();
      /* no redrawing here: replacing the dragged row would cancel the drag */
      const idx = p.sel.has(i) ? [...p.sel].sort((a, b) => a - b) : [i];
      const its = dropInner(idx.map(k => p.items[k]).filter(t => t && !t.up).map(it => ({ it, path: fullPath(p, it) }))).map(x => x.it);
      drag = { from: p, items: its.map(t => ({ path: fullPath(p, t), name: base(t.n), dir: !!itDir(p, t) })) };
      drag.paths = drag.items.map(x => x.path);
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', drag.paths.join('\n'));
      const g = document.createElement('div'); g.className = 'uc-dragghost';
      g.textContent = its.length === 1 ? base(its[0].n) : `${its.length} items`;
      root.appendChild(g); e.dataTransfer.setDragImage(g, 14, 14); setTimeout(() => g.remove(), 0);
    });
    p.list.addEventListener('dragover', e => {
      if (!drag && osFiles(e)) {               // files from the computer: upload
        const t = osTarget(e); clearDrop(); if (!t) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        return (t.row || t.list).classList.add(t.row ? 'drop-on' : 'drop-here');
      }
      const t = dropTarget(e); clearDrop(); if (!t) return;
      e.preventDefault(); e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
      (t.row || t.list).classList.add(t.row ? 'drop-on' : 'drop-here');
    });
    p.list.addEventListener('dragleave', e => { if (!e.relatedTarget || !p.list.contains(e.relatedTarget)) clearDrop(); });
    p.list.addEventListener('drop', async e => {
      if (!drag && osFiles(e)) {
        const t = osTarget(e); clearDrop(); if (!t) return;
        e.preventDefault();
        let list; try { list = await dropEntries(e.dataTransfer); } catch (err) { return toast(`Couldn't read what was dropped: ${err.message}`, true); }
        return uploadTo(t.q, t.dir, list);
      }
      const t = dropTarget(e); clearDrop(); if (!t) return;
      e.preventDefault();
      const d = drag, go = mode => openPaste(d.items.map(x => ({ ...x, mode, skip: [] })), mode, t.dir, { quick: true });
      if (e.ctrlKey || e.metaKey || e.altKey || d.from.arc) return go('copy');      // out of an archive: always a copy
      if (e.shiftKey) return SET.practice ? toast('Practice mode is on, so moving is turned off.', true) : go('cut');
      const n = d.items.length;
      showMenu(e.clientX, e.clientY, `${n === 1 ? d.items[0].name : n + ' items'} → ${base(t.dir) || t.dir}`, [
        { label: 'Copy here', ic: 'copy', sc: 'Ctrl', hl: true, run: () => go('copy') },
        { label: 'Move here', ic: 'move', sc: 'Shift', hl: true, lock: lockIf('moving'), run: () => go('cut') },
        '-', { label: SET.collect ? 'Add to the list instead' : 'Put on the clipboard instead', ic: 'paste', sub: 'paste it later, anywhere', run: () => clipAdd(d.items.map(x => ({ ...x, mode: 'copy', on: true, skip: [] })), 'copy') },
        { label: 'Cancel', ic: 'x', run: () => {} }]);
    });
  }
  document.addEventListener('dragend', () => { clearDrop(); setTimeout(() => { drag = null; }, 0); });
  /* files from the computer dropped anywhere else: don't let the browser open them in place of unCommander */
  document.addEventListener('dragover', e => { if (!drag && osFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  document.addEventListener('drop', e => { if (!drag && osFiles(e) && !e.defaultPrevented) e.preventDefault(); });

  function selectCmd(cmd) {
    const p = A(); const pat = $('.uc-pat').value || '*';
    p.items.forEach((it, i) => {
      if (it.up) return;
      if (cmd === 'all') p.sel.add(i);
      else if (cmd === 'none') p.sel.delete(i);
      else if (cmd === 'invert') p.sel.has(i) ? p.sel.delete(i) : p.sel.add(i);
    });
    if (cmd === 'add' || cmd === 'remove') {
      const re = glob(pat); let n = 0;
      p.items.forEach((it, i) => { if (!it.up && re.test(base(it.n))) { cmd === 'add' ? p.sel.add(i) : p.sel.delete(i); n++; } });
      toast(`${cmd === 'add' ? 'Added' : 'Removed'} ${n} match${n === 1 ? '' : 'es'} for ${pat}`);
    }
    drawRows(p); updateSelInfo(p);
  }
  $$('[data-sel]').forEach(b => b.addEventListener('click', () => selectCmd(b.dataset.sel)));
  $('.uc-pat').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') selectCmd(e.shiftKey ? 'remove' : 'add'); });

  /* ---------- jump to name ----------
   * Two ways in: start typing anywhere over the panes (a real keyboard), or
   * tap the Jump box (the on-screen keyboard on a tablet). Either way the
   * cursor leaps to the first name starting with what you typed, then to the
   * first name containing it. It jumps, it doesn't filter. */
  const jumpBox = $('.uc-jump');
  const JM_ICON = { jump: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/></svg>', filter: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h11l-4.2 5v4.5l-2.6 1.2V8z"/></svg>' };
  const jumpLabel = () => {
    const jm = root.querySelector('.uc-jmode');
    if (jm) { jm.innerHTML = JM_ICON[filterMode() ? 'filter' : 'jump']; jm.classList.toggle('on', filterMode()); jm.title = filterMode() ? 'Typing filters the list - click to jump to names instead' : 'Typing jumps to a name - click to filter the list instead'; jm.setAttribute('aria-label', jm.title); }
    jumpBox.placeholder = filterMode() ? 'Filter names…' : 'Jump to name…'; jumpBox.title = filterMode() ? 'Type to list only the names containing it, in the active pane - Esc shows everything again' : 'Type a name to jump to it in the active pane — Enter opens it, ↑↓ for other matches'; };
  /* the icon at the left of the box: switches between jumping to a name and filtering the list */
  const jumpMode = document.createElement('button');
  jumpMode.type = 'button'; jumpMode.className = 'uc-jmode'; jumpMode.tabIndex = -1;
  jumpMode.addEventListener('pointerdown', e => e.preventDefault());
  jumpMode.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation(); sound.play('click');
    store.set('typeMode', filterMode() ? 'jump' : 'filter');
    if (!filterMode()) { panes.forEach(q => { if (q.flt) { q.flt = ''; applySort(q); updateSelInfo(q); } }); jumpBox.classList.remove('filtering', 'miss'); }
    else if (jumpBox.value) setFilter(A(), jumpBox.value);
    jumpLabel();
    toast(filterMode() ? 'Typing now filters the list - only matching names stay' : 'Typing now jumps to a name');
  });
  jumpLabel();
  /* an ✕ inside the Jump and pattern boxes to empty them (shown only when there's text) */
  [[jumpBox, 'j', () => { if (A().flt) setFilter(A(), ''); clearJump(); jumpBox.focus(); }], [$('.uc-pat'), 'p', () => { const i = $('.uc-pat'); i.value = ''; i.focus(); }]].forEach(([inp, k, clear]) => {
    if (!inp) return;
    const w = document.createElement('span'); w.className = 'uc-clrwrap ' + k;
    inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
    w.insertAdjacentHTML('beforeend', '<button type="button" class="uc-clr" tabindex="-1" title="Clear" aria-label="Clear">✕</button>');
    $('.uc-clr', w).addEventListener('pointerdown', e => e.preventDefault());       // keep the keyboard where it is
    $('.uc-clr', w).addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); clear(); });
  });
  jumpBox.parentNode.insertBefore(jumpMode, jumpBox); jumpLabel();
  let prefix = '', prefixTimer = null;
  function jumpTo(text, step = 0) {
    const p = A(), t = text.toLowerCase();
    jumpBox.classList.remove('miss');
    if (!t) return;
    const names = p.items.map(it => it.up ? null : base(it.n).toLowerCase());
    let hits = names.reduce((a, nm, i) => (nm !== null && nm.startsWith(t) && a.push(i), a), []);
    if (!hits.length) hits = names.reduce((a, nm, i) => (nm !== null && nm.includes(t) && a.push(i), a), []);
    if (!hits.length) { jumpBox.classList.add('miss'); return; }
    let ix = hits[0];
    if (step > 0) ix = hits.find(i => i > p.cursor) ?? hits[0];
    if (step < 0) ix = [...hits].reverse().find(i => i < p.cursor) ?? hits[hits.length - 1];
    moveCursor(p, ix, true);
  }
  function clearJump() { prefix = ''; if (filterMode() && A().flt) return; jumpBox.value = ''; jumpBox.classList.remove('miss'); }
  /* filter mode: only the names containing what you typed are listed (Esc, or another folder, shows all again) */
  function setFilter(p, text) {
    p.flt = text; jumpBox.value = text;
    jumpBox.classList.toggle('filtering', !!text);
    applySort(p);
    const ix = p.items.findIndex(it => !it.up);
    jumpBox.classList.toggle('miss', !!text && ix < 0);
    if (text && ix >= 0) moveCursor(p, ix, true);
    updateSelInfo(p);
  }
  function typeAhead(ch) {
    if (filterMode() && A().mode === 'dir' && !A().root) {
      prefix += ch; clearTimeout(prefixTimer); prefixTimer = setTimeout(() => { prefix = ''; }, 1200);
      return setFilter(A(), (A().flt || '') + ch);
    }
    prefix += ch;
    jumpBox.value = prefix;               // show what's been typed
    clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => { if (document.activeElement !== jumpBox) clearJump(); }, 1200);
    jumpTo(prefix);
  }
  jumpBox.addEventListener('input', () => { clearTimeout(prefixTimer); if (filterMode() && A().mode === 'dir' && !A().root) return setFilter(A(), jumpBox.value); jumpTo(jumpBox.value); });
  jumpBox.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpTo(jumpBox.value, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); jumpTo(jumpBox.value, -1); }
    else if (e.key === 'Enter') {               // open the item it landed on; keep typing for the next level
      e.preventDefault();
      const p = A(), it = p.items[p.cursor];
      if (it && jumpBox.value) { clearJump(); openItem(p, p.cursor); }
    }
    else if (e.key === 'Escape') { if (A().flt) setFilter(A(), ''); clearJump(); jumpBox.blur(); root.focus({ preventScroll: true }); }
  });

  /* ---------- keyboard ---------- */
  root.addEventListener('keydown', e => {
    if (!modal.hidden) {
      if (e.key === 'Escape' && !dlg.sticky) closeDlg();
      return;
    }
    if (!tmodal.hidden) return;
    if (e.target.matches('input, select, textarea')) return;
    const p = A();
    if (e.key === 'Escape' && p.loading) { e.preventDefault(); return cancelLoad(p); }
    if (p.flt && e.key === 'Escape') { e.preventDefault(); return setFilter(p, ''); }
    if (p.flt && e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return setFilter(p, p.flt.slice(0, -1)); }
    /* Ctrl/Alt/Cmd + an F-key belongs to the browser (Ctrl+F5 = reload the page) */
    if (/^F\d+$/.test(e.key) && (e.ctrlKey || e.altKey || e.metaKey)) return;
    const fk = e.key === 'Delete' ? 'delete' : /^F\d+$/.test(e.key) && !e.shiftKey ? fkMap()[e.key] : null;
    if (fk) { e.preventDefault(); sound.play('click'); return act(fk); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return doUndo(); }
    /* Copy / Cut / Paste - unless text is selected (then it's the browser's copy) */
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[cxv]$/i.test(e.key) && !String(getSelection())) {
      if (termLast) return;                       // the terminal's - the browser pastes, and the text goes there (above)
      e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === 'v') return pasteHere(p);
      return clipTake(p, p.sel.size ? [...p.sel].sort((a, b) => a - b) : [p.cursor], k === 'x' ? 'cut' : 'copy');
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); return menuAtCursor(); }
    if ((p.gal || p.mt) && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.shiftKey) {
      e.preventDefault();
      const c = galCols(p);
      return moveCursor(p, p.cursor + { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -c, ArrowDown: c }[e.key]);
    }
    const page = Math.max(1, Math.floor(p.list.clientHeight / ROW) - 1);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return moveCursor(p, p.cursor + 1);
      case 'ArrowUp': e.preventDefault(); return moveCursor(p, p.cursor - 1);
      case 'PageDown': e.preventDefault(); return moveCursor(p, p.cursor + page);
      case 'PageUp': e.preventDefault(); return moveCursor(p, p.cursor - page);
      case 'Home': e.preventDefault(); return moveCursor(p, 0);
      case 'End': e.preventDefault(); return moveCursor(p, p.items.length - 1);
      case 'Enter': e.preventDefault(); return openItem(p, p.cursor);
      case 'Backspace': e.preventDefault(); return p.mode === 'find' ? load(p, p.findInfo.start) : load(p, parent(p.path), base(p.path));
      case 'Tab': e.preventDefault(); return setActive(1 - active);
      case 'Insert': e.preventDefault(); toggle(p, p.cursor); return moveCursor(p, p.cursor + 1);
      case 'ArrowRight': case 'ArrowLeft': {
        if (!treeOn(p)) return;
        e.preventDefault();
        const it = p.items[p.cursor]; if (!it || it.up) return;
        const open = itDir(p, it) && p.tree.has(fullPath(p, it));
        if (e.key === 'ArrowRight') return open ? moveCursor(p, p.cursor + 1) : treeToggle(p, p.cursor, true);
        if (open) return treeToggle(p, p.cursor, false);
        if (it.depth) { const up = parent(it.abs), ix = p.items.findIndex(x => fullPath(p, x) === up); if (ix >= 0) moveCursor(p, ix); }
        return;
      }
      case ' ': if (!prefix) { e.preventDefault(); toggle(p, p.cursor); drawRows(p); updateSelInfo(p); return; }
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return selectCmd('all'); }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAhead(e.key); }
  });
  root.addEventListener('mousedown', e => { if (!e.target.closest('input, select, textarea, button, .uc-trail')) setTimeout(() => root.focus({ preventScroll: true }), 0); });

  /* ---------- top controls ---------- */
  $('.uc-swap').addEventListener('click', () => { const a = panes[0].path, b = panes[1].path; load(panes[0], b); load(panes[1], a); });
  $('.uc-same').addEventListener('click', () => load(B(), A().mode === 'find' ? A().findInfo.start : A().path));
  /* Go to…: a panel in sections - shares, array disks (as a grid), pools, Unassigned Devices, system */
  const goBtn = $('.uc-goto');
  let goPop = null;
  const GI2 = {
    share: '<path d="M1.5 4v8.5h13V5.5H8L6.5 4z"/>',
    disk: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 9.5h12M11.5 11.3h.01"/>',
    pool: '<ellipse cx="8" cy="4.2" rx="5.5" ry="2"/><path d="M2.5 4.2v7.6c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4.2M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
    usb: '<rect x="4.5" y="1.5" width="7" height="5" rx="1"/><rect x="3" y="6.5" width="10" height="8" rx="1.5"/>',
    net: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 2 2.8 4 2.8 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.2 5.5 5.2 8S6 12.5 8 14.5"/>',
    flash: '<path d="M5 1.5h6v4l1.5 1.5v7.5h-9V7L5 5.5z"/><path d="M6.5 3.5h1M8.5 3.5h1"/>',
    all: '<rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/>',
    sys: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M2 5l6 3.5L14 5M8 8.5v6"/>',
  };
  const gi = k => `<svg viewBox="0 0 16 16" aria-hidden="true">${GI2[k]}</svg>`;
  function goPanel() {
    if (goPop && !goPop.hidden) { goPop.hidden = true; return; }
    if (!goPop) {
      goPop = document.createElement('div'); goPop.className = 'uc-gopop'; goPop.hidden = true; root.append(goPop);
      document.addEventListener('pointerdown', e => { if (goPop && !goPop.hidden && !goPop.contains(e.target) && !e.target.closest('.uc-goto')) goPop.hidden = true; }, true);
      goPop.addEventListener('keydown', e => { if (e.key === 'Escape') { goPop.hidden = true; goBtn.focus(); } e.stopPropagation(); });
      goPop.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (!b || b.disabled) return; goPop.hidden = true; load(A(), b.dataset.go); root.focus({ preventScroll: true }); });
    }
    const m = JSON.parse(goBtn.dataset.mounts || '[]'), disks = m.filter(x => /^disk\d+$/.test(x)), pools = m.filter(x => !/^disk\d+$/.test(x));
    const off = SET.array === false, cur = A().mode === 'dir' ? A().path : '';
    const on = p => cur === p || (p !== '/mnt' && p !== '/' && cur.startsWith(p + '/')) ? ' on' : '';
    const row = (ic, label, path, dis) => `<button type="button" class="go-row${on(path)}" data-go="${esc(path)}"${dis ? ' disabled title="The array is stopped"' : ''}>${gi(ic)}<span class="go-l">${esc(label)}</span><span class="go-p">${esc(path)}</span></button>`;
    const sec = (title, body) => body ? `<div class="go-sec"><div class="go-h">${title}</div>${body}</div>` : '';
    goPop.innerHTML =
      sec('Shares', row('share', 'All shares', '/mnt/user', off))
      + sec(`Array disks <span>${disks.length}</span>`, disks.length ? `<div class="go-grid">${disks.map(d => `<button type="button" class="go-chip${on('/mnt/' + d)}" data-go="/mnt/${esc(d)}" title="/mnt/${esc(d)}"${off ? ' disabled' : ''}>${gi('disk')}${d.replace('disk', 'Disk ')}</button>`).join('')}</div>` : '')
      + sec('Pools', pools.map(x => row('pool', x, '/mnt/' + x, off)).join(''))
      + sec('Unassigned Devices', (goBtn.dataset.ud ? row('usb', 'Drives', '/mnt/disks') : '') + (goBtn.dataset.rem ? row('net', 'Network shares', '/mnt/remotes') : ''))
      + sec('System', row('flash', 'Flash drive', '/boot') + row('all', 'Everything under /mnt', '/mnt') + (sysOn() ? row('sys', 'The whole system', '/') : ''));
    goPop.hidden = false;
    const b = goBtn.getBoundingClientRect();
    goPop.style.left = '0px'; goPop.style.top = '0px';
    const o = goPop.getBoundingClientRect();
    goPop.style.left = (Math.max(6, Math.min(b.left, innerWidth - goPop.offsetWidth - 6)) - o.left) + 'px';
    goPop.style.top = (b.bottom + 6 - o.top) + 'px';
    const first = $('.go-row.on, .go-chip.on', goPop) || $('[data-go]:not([disabled])', goPop); if (first) first.focus({ preventScroll: true });
  }
  goBtn.addEventListener('click', goPanel);

  /* ---------- the top folder: /mnt (shares) or / (the whole system, Settings > Safety) ---------- */
  const sysOn = () => !!SET.sysmode && store.get('sysView', false) === true;
  const inShares = path => path === '/mnt' || path.startsWith('/mnt/') || path === '/boot' || path.startsWith('/boot/');
  function applySys(switching) {
    const on = sysOn(), seg = $('.uc-sysseg');
    seg.hidden = !SET.sysmode;
    $$('.sys-b', seg).forEach(b => { const me = (b.dataset.sys === '1') === on; b.classList.toggle('on', me); b.setAttribute('aria-pressed', me); });
    root.classList.toggle('uc-sys', on);
    if (switching) {
      if (on) load(A(), '/');
      else panes.forEach(p => { if (p.mode === 'dir' && !inShares(p.path)) load(p, '/mnt'); else if (p.mode === 'dir') { draw(p); renderTrail(p); } });
      if (on) { const b = B(); if (b.mode === 'dir') { draw(b); renderTrail(b); } }
    }
  }
  $('.uc-sysseg').addEventListener('click', e => {
    const b = e.target.closest('.sys-b'); if (!b) return; b.blur();
    const want = b.dataset.sys === '1'; if (want === sysOn()) return;
    store.set('sysView', want); sound.play('click'); applySys(true);
  });
  const sortSel = $('.uc-sort'), sortDir = $('.uc-sortdir');
  function saveSort() {
    store.set('sort', sortKey); store.set('rev', sortRev);
    sortSel.value = sortKey; sortDir.textContent = sortRev ? '↓' : '↑';
    $$('.uc-cols > div').forEach(h => h.classList.toggle('on', h.dataset.k === sortKey));
  }
  sortSel.addEventListener('change', () => { sortKey = sortSel.value; saveSort(); panes.forEach(p => applySort(p)); });
  sortDir.addEventListener('click', () => { sortRev = !sortRev; saveSort(); panes.forEach(p => applySort(p)); });
  const hid = $('.uc-showhidden'); hid.checked = showHidden;
  hid.addEventListener('change', () => { showHidden = hid.checked; store.set('hidden', showHidden); panes.forEach(p => { p.sel.clear(); applySort(p); }); });
  $$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
  if (JSON.stringify(fkMap()) !== JSON.stringify(FK_PRESETS.uc[2])) renderFk();
  /* the button bar can be hidden for more room (the Buttons box in the Select row, or Settings > General) */
  const fkShow = on => { $('.uc-fkeys').hidden = !on; const c = $('.uc-fkbar'); if (c) c.checked = on; store.set('fkHidden', !on); window.dispatchEvent(new Event('resize')); };
  fkShow(!store.get('fkHidden', false));
  /* "changed lately" wears off by itself */
  setInterval(() => { if (recentMins() && !document.hidden) panes.forEach(p => { if (!p.gal && !p.mt) drawRows(p); }); }, 60000);
  $('.uc-fkbar') && $('.uc-fkbar').addEventListener('change', e => { sound.play('click'); fkShow(e.target.checked); });

  /* ---------- More row: one button slides between the F-keys and More ---------- */
  const fkeys = $('.uc-fkeys'), fkTog = $('.uc-fk-toggle');
  let slideT;
  /* three views, in turn: the F-keys · the More buttons (slid in) · both rows, stacked and slimmer */
  const FK_NEXT = { f: 'more', more: 'both', both: 'f' };
  const FK_TITLE = { f: 'More buttons', more: 'Show both rows (F-keys and More)', both: 'Back to the F-keys only' };
  const fkMode = () => fkeys.classList.contains('both') ? 'both' : fkeys.classList.contains('more') ? 'more' : 'f';
  function setFk(mode, animate) {
    const vp = $('.uc-fk-vp', fkeys), was = fkMode(), h0 = vp.offsetHeight;
    if (animate) { fkeys.classList.add('sliding'); clearTimeout(slideT); slideT = setTimeout(() => fkeys.classList.remove('sliding', 'rise'), 450); }
    fkeys.classList.toggle('more', mode === 'more');
    fkeys.classList.toggle('both', mode === 'both');
    if (animate && (was === 'both') !== (mode === 'both')) {
      const h1 = vp.offsetHeight;
      vp.style.height = h0 + 'px'; void vp.offsetHeight;
      vp.style.transition = 'height .38s cubic-bezier(.65,0,.35,1)'; vp.style.height = h1 + 'px';
      if (mode === 'both') fkeys.classList.add('rise');
      setTimeout(() => { vp.style.height = ''; vp.style.transition = ''; window.dispatchEvent(new Event('resize')); }, 400);
    }
    fkTog.title = FK_TITLE[mode];
    fkTog.setAttribute('aria-label', fkTog.title);
    store.set('fkmode', mode);
  }
  setFk(store.get('fkmode', store.get('more', false) ? 'more' : 'f'), false);
  fkTog.addEventListener('click', () => { sound.play('click'); setFk(FK_NEXT[fkMode()], true); });
  $$('[data-more]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.act) return;     // a working More button (handled like the F-keys)
    sound.play('error'); toast(`${b.dataset.more} is coming in a later update`);
  }));

  /* ---------- dialogs ---------- */
  const modal = $('.uc-modal'), dlg = $('.uc-dlg');
  /* Tools get their own window layer: it can be tucked away (minimized) and
   * keeps running, while ordinary dialogs (View, Copy...) open as usual. */
  const tmodal = $('.uc-tmodal'), tdlg = $('.uc-dlg', tmodal), toolPill = $('.uc-toolpill');
  function openDlgIn(D, M, title, body, buttons, wide) {
    killMedia(D);              // a player in the window being replaced stops
    D.className = 'uc-dlg' + (wide === true ? ' wide' : wide ? ' ' + wide : '');
    D.extraKey = null; D.beforeClose = null; D.onUnpark = null;
    const close = () => closeDlgIn(D, M);
    /* "sticky" windows (Settings, Tools) close only from their own buttons or the ✕ -
     * not by tapping outside or pressing Esc, so work in them isn't lost by accident */
    D.sticky = D.classList.contains('sticky');
    const canPark = D === tdlg;
    D.innerHTML = `<div class="dlg-head">${esc(title)}${canPark ? '<button class="dlg-min" title="Tuck it away - it keeps its results; tap its button at the top to bring it back" aria-label="Minimize">—</button>' : ''}${D.sticky ? '<button class="dlg-x" title="Close" aria-label="Close">✕</button>' : ''}</div><div class="dlg-body">${body}</div><div class="dlg-foot"></div>`;
    if (D.sticky) $('.dlg-x', D).addEventListener('click', close);
    if (canPark) $('.dlg-min', D).addEventListener('click', () => parkTool());
    const foot = $('.dlg-foot', D);
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'uc-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      el.textContent = b.label;
      if (b.title) el.title = b.title;
      el.addEventListener('click', async () => {
        if (!b.run) return close();
        el.disabled = true;
        try { if ((await b.run()) !== false) close(); } catch (err) { toast(err.message, true); }
        el.disabled = false;
      });
      foot.appendChild(el);
    }
    M.hidden = false;
    const first = $('input[type=text]', D);
    if (first) { first.focus(); first.select(); }
    else { D.tabIndex = -1; D.focus({ preventScroll: true }); }   // so keys (Esc, arrows) reach the dialog
    D.onkeydown = e => {
      if (D.extraKey) D.extraKey(e);
      if (e.defaultPrevented) { e.stopPropagation(); return; }
      if (e.key === 'Enter' && e.target.matches('input[type=text]')) { e.preventDefault(); const pb = $('.uc-btn.primary', D); pb && pb.click(); }
      if (e.key === 'Escape' && !D.sticky) close();
      e.stopPropagation();
    };
  }
  function closeDlgIn(D, M) {
    if (D.beforeClose && !D.beforeClose()) return;
    D.beforeClose = null; D.extraKey = null; D.onUnpark = null;
    M.hidden = true; D.innerHTML = '';
    if (D === tdlg) { D.tool = null; toolPill.hidden = true; }
    root.focus({ preventScroll: true });
  }
  const openDlg = (...a) => openDlgIn(dlg, modal, ...a);
  const closeDlg = () => closeDlgIn(dlg, modal);
  const openToolDlg = (kind, ...a) => { if (!tmodal.hidden || tdlg.tool) closeDlgIn(tdlg, tmodal); openDlgIn(tdlg, tmodal, ...a); tdlg.tool = kind; tdlg.gen = (tdlg.gen || 0) + 1; };
  const closeTool = () => closeDlgIn(tdlg, tmodal);
  /* tuck the tool away: hidden, still running; the pill at the top brings it back */
  function parkTool() {
    if (!tdlg.tool) return;
    tmodal.hidden = true;
    drawPill(); toolPill.hidden = false;
    root.focus({ preventScroll: true });
  }
  /* the pill turns amber (and says so) when the tool needs an answer from you */
  function drawPill() {
    const need = tdlg.toolAttn ? tdlg.toolAttn() : 0;
    toolPill.classList.toggle('attn', !!need);
    toolPill.innerHTML = `<span class="tp-ic">${need ? '⚠' : '↩'}</span> ${esc(tdlg.toolLabel ? tdlg.toolLabel() : 'Tool')}${need ? ` <b class="tp-need">${need} need${need === 1 ? 's' : ''} you</b>` : ''}`;
  }
  /* a tool tucked away can be told which folders were open in the panes (and where jobs went) meanwhile */
  function noteTouched(path) { if (path && tdlg.tool && tdlg.onTouched && tmodal.hidden) tdlg.onTouched(path); }
  function unparkTool() { if (!tdlg.tool) return; toolPill.hidden = true; tmodal.hidden = false; tdlg.focus({ preventScroll: true }); if (tdlg.onUnpark) tdlg.onUnpark(); }
  /* how the two panes are set up (folders, views, ticks, open tree folders, active pane, the
   * playlist pinned or not), so a tool that moves them around can put them back when it closes */
  function layoutSnap() {
    return {
      active, pin: isPinned(), mus: mus && !mus.pair ? mus.root : null,
      p: panes.map(q => ({ path: q.mode === 'dir' ? q.path : (q.findInfo && q.findInfo.path) || q.path, gal: !!q.gal,
        tree: [...(q.tree || new Map()).keys()], sel: [...q.sel].map(i => q.items[i] && (q.items[i].abs || q.items[i].n)).filter(Boolean),
        cur: q.items[q.cursor] ? q.items[q.cursor].abs || q.items[q.cursor].n : null })),
    };
  }
  async function layoutRestore(s) {
    if (!s) return;
    if (mus) musExit();
    panes.forEach(q => { if (q.gal) galSet(q, false); });
    await Promise.all(panes.map((q, i) => load(q, s.p[i].path)));
    for (const [i, q] of panes.entries()) {
      const v = s.p[i]; if (q.path !== v.path) continue;
      if (v.tree.length && treeOn(q)) { const seq = q.seq; await treeFetch(q, v.tree.slice(0, 200)); if (seq !== q.seq) continue; saveTree(q); await applySort(q); }
      const want = new Set(v.sel); q.sel.clear();
      q.items.forEach((it, k) => { if (!it.up && want.has(it.abs || it.n)) q.sel.add(k); });
      if (v.cur) { const ix = q.items.findIndex(it => (it.abs || it.n) === v.cur); if (ix >= 0) moveCursor(q, ix, true); }
      draw(q);
    }
    if (s.mus && panes[0].path === s.mus && inDir(panes[1].path, s.mus)) {
      mus = { root: s.mus, busy: false, q: [], i: -1, now: null }; root.classList.add('uc-mus'); store.set('mus', s.mus);
      panes.forEach(q => { q.galItems = null; draw(q); }); musSync();
    } else { const g = panes.find((q, i) => s.p[i].gal); if (g) galSet(g, true); }
    setActive(s.active);
    if (isPinned() !== s.pin) npPin(s.pin);
  }
  toolPill.addEventListener('click', unparkTool);
  modal.addEventListener('mousedown', e => { if (e.target === modal && !dlg.sticky) closeDlg(); });

  let toastTimer;
  /* undoId: the History step the message's Undo link takes back; showHist: add a "History" link */
  function toast(msg, err, undoId, showHist, more) {
    const t = $('.uc-toast'); t.textContent = msg; t.className = 'uc-toast' + (err ? ' err' : ''); t.hidden = false;
    const link = (label, fn) => {
      const a = document.createElement('button'); a.className = 't-undo'; a.textContent = label;
      a.addEventListener('click', () => { t.hidden = true; root.focus({ preventScroll: true }); fn(); });
      t.appendChild(a);
    };
    if (typeof undoId === 'function') link('Undo', undoId); else if (undoId) link('Undo', () => doUndo(undoId));
    if (showHist) link('History', () => openHistory());
    if (more) link(more[0], more[1]);
    if (err) sound.play('error');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, err ? (showHist ? 9000 : 6000) : undoId || more ? 10000 : 2600);
  }

  /* ---------- Undo and History ----------
   * Every change is a step in History (kept on the server, so it survives
   * reloads and reboots). A confirmation message's Undo link takes back that
   * step; the Undo button and Ctrl/Cmd+Z take back the newest step that still
   * can be; the History window takes back any step, or part of one. */
  function done(msg, hist) { toast(msg, false, hist || null); }
  /* The list in the Delete dialog: one tidy row per item. */
  function delList(p, t) {
    const SHOW = 50, dirs = t.filter(x => x.it.t === 'd').length, files = t.length - dirs;
    const parents = new Set(t.map(x => parent(x.path))), one = parents.size === 1;
    const ICON = { d: '<svg viewBox="0 0 16 16"><path d="M1.5 4.5v8h13v-7H8L6.5 4H2z"/></svg>', f: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3"/></svg>' };
    const size = x => { if (x.it.t === 'd') { const ds = p.dirSizes && p.dirSizes.get(x.it.abs || x.it.n); return ds != null ? fmtBytes(ds) : ''; }
      const st = p.stats && p.stats.get(x.it.abs || x.it.n); return st && st.s != null ? fmtBytes(st.s) : ''; };
    const rows = t.slice(0, SHOW).map(x => `<div class="dl-row${x.it.t === 'd' ? ' dir' : ''}"><span class="dl-ic">${ICON[x.it.t === 'd' ? 'd' : 'f']}</span>
      <span class="dl-nm" title="${esc(x.path)}">${esc(base(x.path))}${one ? '' : `<span class="dl-in">${esc(parent(x.path))}</span>`}</span><span class="dl-sz">${size(x)}</span></div>`).join('');
    return `<div class="dl-head"><span>${[files && `${files.toLocaleString()} file${files === 1 ? '' : 's'}`, dirs && `${dirs.toLocaleString()} folder${dirs === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>${one ? `<span class="dl-where" title="${esc([...parents][0])}">in ${esc([...parents][0])}</span>` : ''}</div>
      <div class="dl-list">${rows}${t.length > SHOW ? `<div class="dl-more">…and ${(t.length - SHOW).toLocaleString()} more</div>` : ''}</div>`;
  }
  async function doUndo(id = 'latest', parts) {
    let r;
    try { r = await api('history_undo', parts ? { id, parts } : { id }); }
    catch (e) { toast(/^Nothing left/.test(e.message) && id === 'latest' ? 'Nothing to undo' : `Couldn't undo: ${e.message}`, true, null, !/^Nothing left/.test(e.message)); return null; }
    sound.play('back');
    const n = r.failed.length;
    if (r.job) openProgress(r.job);
    if (n && !r.done && !r.moving) toast(`Couldn't undo "${r.label}": ${r.failed[0][2]}${n > 1 ? ` (and ${n - 1} more)` : ''}`, true, null, true);
    else if (n) toast(`Undid part of "${r.label}". ${n === 1 ? `Couldn't undo ${r.failed[0][1]}: ${r.failed[0][2]}` : `${n} parts couldn't be undone`}`, true, null, true);
    else if (!r.job) toast(`Undone: ${r.label}`);
    refreshBoth();
    return r;
  }
  $('.uc-histbtn').addEventListener('click', () => openHistory());
  $('.uc-usbtn').addEventListener('click', () => openScripts());

  /* ---------- User Scripts: the scripts you pick, run from here ----------
   * In a window (output as it comes, shown as a web page like User Scripts does - so its coloured
   * <span>s work), or in the background (logged, as User Scripts does it). "Edit the list" picks
   * which scripts show and their order. */
  function usClean(html) {
    const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    d.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style').forEach(n => n.remove());
    d.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name) || (/^(href|src|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name); }));
    return d.body.firstChild.innerHTML;
  }
  async function openScripts(edit = false, q0 = '') {
    let r; try { r = await api('us_list'); } catch (e) { return toast(e.message, true); }
    const byId = new Map(r.scripts.map(x => [x.id, x]));
    let order = r.order ? r.order.filter(id => byId.has(id)) : r.scripts.map(x => x.id);
    let q = q0;
    const hit = x => !q || `${x.name} ${x.desc} ${x.id}`.toLowerCase().includes(q.toLowerCase());
    const draw = () => {
      const D = dlg, box = $('.us-list', D);
      if (!box) return;
      const cnt = $('.us-cnt', D);
      if (!r.scripts.length) { box.innerHTML = '<div class="uc-empty">No scripts in User Scripts yet.</div>'; return; }
      if (edit) {
        /* ticked ones first, in their order; the rest A to Z */
        const rest = r.scripts.filter(x => !order.includes(x.id));
        const rows = [...order.map(id => byId.get(id)), ...rest].filter(hit);
        cnt.textContent = `${order.length} of ${r.scripts.length} picked${q ? ` · ${rows.length} match` : ''}`;
        box.innerHTML = rows.map(x => { const on = order.includes(x.id), i = order.indexOf(x.id);
          return `<div class="us-row us-ed${on ? '' : ' off'}"><label class="chk"><input type="checkbox" data-uson="${esc(x.id)}"${on ? ' checked' : ''}><span class="us-tt"><b>${esc(x.name)}</b>${x.desc ? `<span class="us-d">${esc(x.desc)}</span>` : ''}</span></label>
            ${on ? `<span class="us-ord"><button type="button" class="uc-btn" data-usup="${i}"${i ? '' : ' disabled'} title="Move up">🠉</button><button type="button" class="uc-btn" data-usdn="${i}"${i < order.length - 1 ? '' : ' disabled'} title="Move down">🠋</button></span>` : ''}</div>`; }).join('') || '<div class="uc-empty">No script matches.</div>';
        return;
      }
      const rows = order.map(id => byId.get(id)).filter(hit);
      cnt.textContent = q ? `${rows.length} of ${order.length}` : `${order.length} script${order.length === 1 ? '' : 's'}`;
      box.innerHTML = rows.length ? rows.map(x => `<div class="us-row"><span class="us-n"><b>${esc(x.name)}</b>${x.running ? ' <span class="us-run">running in the background</span>' : ''}${x.desc ? `<span class="us-d">${esc(x.desc)}</span>` : ''}</span>
          ${x.fg ? `<button type="button" class="uc-btn primary" data-usfg="${esc(x.id)}">Run</button>` : ''}
          ${x.bg ? (x.running ? `<button type="button" class="uc-btn danger" data-usab="${esc(x.id)}">Stop</button>` : `<button type="button" class="uc-btn" data-usbg="${esc(x.id)}" title="Runs on its own - closing this window doesn't stop it. Its output goes to its log.">In background</button>`) : ''}
          <button type="button" class="uc-btn" data-uslog="${esc(x.id)}"${x.log ? '' : ' disabled title="No log yet"'}>Log</button></div>`).join('')
        : `<div class="uc-empty">${order.length ? 'No script matches.' : 'No scripts picked - press Pick scripts.'}</div>`;
    };
    const tools = `<div class="us-tools"><input type="search" class="us-q" placeholder="Search your scripts…" value="${esc(q)}" spellcheck="false" autocomplete="off">${edit
      ? '<button type="button" class="uc-btn" data-usall>Select all</button><button type="button" class="uc-btn" data-usnone>None</button>' : ''}<span class="us-cnt muted"></span></div>`;
    openDlg(edit ? 'User Scripts - pick and order' : 'User Scripts', `${edit ? '<div class="muted us-hint">Ticked scripts show in the list, in this order (🠉 🠋 move them). Unticking only takes a script off the list - the script itself isn\'t touched.</div>' : ''}${tools}<div class="us-list"></div>`, edit
      ? [{ label: 'Done', primary: true, run: () => { openScripts(false); return false; } }]
      : [{ label: 'Pick scripts…', title: 'Choose which scripts show here, and their order', run: () => { openScripts(true); return false; } }, { label: 'Close', primary: true }], 'wide us-dlg');
    const D = dlg; draw();
    const qi = $('.us-q', D); qi.addEventListener('input', () => { q = qi.value.trim(); draw(); });
    if (r.scripts.length > 8) qi.focus();
    const save = () => api('us_order', { order: JSON.stringify(order) }).catch(e => toast(e.message, true));
    /* ticking: the change event (a click on the label would count twice) */
    $('.us-list', D).addEventListener('change', async e => {
      const on = e.target.closest('[data-uson]'); if (!on) return;
      const id = on.dataset.uson; order = on.checked ? [...order.filter(x => x !== id), id] : order.filter(x => x !== id);
      draw(); save();
    });
    $('.us-tools', D).addEventListener('click', e => {
      const all = e.target.closest('[data-usall]'), none = e.target.closest('[data-usnone]'); if (!all && !none) return;
      const vis = r.scripts.filter(hit).map(x => x.id);
      order = all ? [...order, ...vis.filter(id => !order.includes(id))] : order.filter(id => !vis.includes(id));
      draw(); save();
    });
    $('.us-list', D).addEventListener('click', async e => {
      const t = e.target;
      const up = t.closest('[data-usup]'), dn = t.closest('[data-usdn]');
      if (up || dn) { const i = +(up || dn).dataset[up ? 'usup' : 'usdn'], j = up ? i - 1 : i + 1; [order[i], order[j]] = [order[j], order[i]]; draw(); save(); return; }
      const fg = t.closest('[data-usfg]'), bg = t.closest('[data-usbg]');
      if (fg || bg) {
        const x = byId.get((fg || bg).dataset[fg ? 'usfg' : 'usbg']);
        const args = x.arg ? await usAsk(x) : ''; if (args === null) return openScripts(false, q);
        if (bg) { try { await api('us_run', { id: x.id, bg: '1', args }); toast(`${x.name} is running in the background - Log shows how it's going`); } catch (er) { toast(er.message, true); } return openScripts(false, q); }
        return usRun(x, args);
      }
      const ab = t.closest('[data-usab]');
      if (ab) { try { await api('us_stop', { id: ab.dataset.usab }); toast('Stopped'); } catch (er) { toast(er.message, true); } return openScripts(false, q); }
      const lg = t.closest('[data-uslog]');
      if (lg) return usLog(byId.get(lg.dataset.uslog));
    });
  }
  /* a script with #argumentDescription: asked for, as User Scripts does, before it starts */
  function usAsk(x) {
    return new Promise(res => {
      openDlg(x.name, `<label class="tg-af"><span>${esc(x.arg.about || 'Arguments')}</span><input type="text" class="us-args" value="${esc(x.arg.def)}" spellcheck="false" autocomplete="off"></label><div class="muted">Separate several with spaces (a single one can't contain spaces).</div>`,
        [{ label: 'Cancel', run: () => { res(null); return false; } }, { label: 'Run', primary: true, run: () => { res($('.us-args', dlg).value.trim()); return false; } }]);
      dlg.beforeClose = () => { res(null); return true; };
    });
  }
  async function usRun(x, args) {
    let r; try { r = await api('us_run', { id: x.id, args }); } catch (e) { toast(e.message, true); return openScripts(); }
    openDlg(`${x.name} - running`, `<div class="us-out"><div>Script location: <b>${esc(r.where)}</b>${args ? ` · arguments: <b>${esc(args)}</b>` : ''}</div><div class="us-note">Note that closing this window will stop the script</div><div class="us-text"></div></div>`,
      [{ label: 'Back to the list', run: () => { stop(); openScripts(); return false; } }, { label: 'Stop', danger: true, run: () => { stop(); return false; } }, { label: 'Close', primary: true }], 'full us-dlg');
    const D = dlg, out = $('.us-text', D), head = $('.dlg-head', D); let txt = '', off = 0, done = false;
    const stop = () => { if (!done) api('us_stop', { run: r.run }).catch(() => {}); };
    D.beforeClose = () => { stop(); return true; };
    while (dlg === D && D.contains(out)) {
      let o; try { o = await api('us_out', { run: r.run, off }); } catch (e) { break; }
      if (o.text) { txt += o.text; off = o.off; if (txt.length > 4e6) txt = txt.slice(-3e6); const end = out.parentNode.scrollTop + out.parentNode.clientHeight >= out.parentNode.scrollHeight - 30; out.innerHTML = usClean(txt); if (end) out.parentNode.scrollTop = out.parentNode.scrollHeight; }
      if (o.done) { done = true; head.firstChild.textContent = `${x.name} - ${o.rc === 0 ? 'finished' : o.rc === 143 ? 'stopped' : `finished (exit code ${o.rc})`}`; const sb = $$('.dlg-foot .uc-btn', D).find(b => b.textContent === 'Stop'); if (sb) sb.remove(); $('.us-note', D).remove(); break; }
      await new Promise(res => setTimeout(res, o.text ? 250 : 700));
    }
  }
  async function usLog(x) {
    let r; try { r = await api('us_log', { id: x.id }); } catch (e) { return toast(e.message, true); }
    openDlg(`${x.name} - log`, `<div class="us-out"><div class="muted">${esc(r.path)}${r.cut ? ' · the last 256 KB' : ''}${r.running ? ' · <b>still running</b>' : ''}</div><div class="us-text">${usClean(r.text)}</div></div>`,
      [{ label: 'Back to the list', run: () => { openScripts(); return false; } }, { label: 'Close', primary: true }], 'full us-dlg');
    const o = $('.us-out', dlg); o.scrollTop = o.scrollHeight;
  }
  /* the top bar gets narrower: drop the least-needed things first (CSS uses these classes) */
  /* Narrower screens drop the least-needed things from the top bar, a step at a
   * time: by width first, then one more step while anything still sticks out
   * (the pill grows when the list has copy, cut and delete items). */
  function fitBar() {
    const bar = $('.uc-appbar'), steps = ['uc-b1', 'uc-b2', 'uc-b3', 'uc-b4', 'uc-b5', 'uc-b6', 'uc-b7'];
    root.classList.toggle('uc-w4', root.clientWidth < 760);      // the pane headers drop "free" on small screens
    root.classList.remove(...steps);
    for (const c of steps) { if (!bar || bar.scrollWidth <= bar.clientWidth + 1) break; root.classList.add(c); }
  }
  if (window.ResizeObserver) new ResizeObserver(fitBar).observe(root); else addEventListener('resize', fitBar);
  fitBar();
  /* ---------- the History window ---------- */
  const HS = { open: new Set(), tick: new Map(), timer: 0 };
  const hsName = p => base(p.b || p.p || p.a || '') + (p.t === 'mkdir' || p.t === 'rmdirs' || p.t === 'into' ? '/' : '');
  function hsDesc(p) {
    const P = x => esc(parent(x));
    switch (p.t) {
      case 'mkdir': return `new folder in ${P(p.p)}`;
      case 'ren': return `renamed to <b>${esc(base(p.b))}</b>, in ${P(p.b)}`;
      case 'move': return `moved from ${P(p.a)} to ${P(p.b)}`;
      case 'copy': return `copied into ${P(p.b)}`;
      case 'trash': return `deleted from ${P(p.p)}${p.s === 'u' ? '' : ' - kept in the trash'}`;
      case 'gone': return `deleted from ${P(p.p)}`;
      case 'made': return `made in ${P(p.p)}`;
      case 'into': return `extracted into this folder (${esc(p.p)})`;
      case 'rmdirs': return `empty folder removed from ${P(p.p)}`;
    }
    return '';
  }
  const hsWhen = at => {
    const d = new Date(at * 1000), now = new Date(), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
  };
  function hsDraw(steps) {
    const box = $('.hs', dlg); if (!box) return;
    if (!steps.length) { box.innerHTML = '<div class="hs-empty muted">Nothing yet. Every copy, move, rename, new folder and delete shows up here, newest first, and can be undone from here.</div>'; return; }
    box.innerHTML = `<div class="hs-intro muted">Newest first. <b>Undo</b> takes back a whole step; open a step with its arrow to tick just the parts you want back. Each part is checked against the disk first - if something changed since, it's left alone and you're told why.</div>
      <div class="hs-list">${steps.map(s => {
        const open = HS.open.has(s.id), tick = HS.tick.get(s.id) || new Set();
        const state = s.busy ? 'busy' : !s.open && s.undone && s.undone + s.cant === s.count ? 'undone' : !s.open && !s.undone ? 'cant' : s.undone ? 'part' : '';
        const pill = s.busy ? 'Running' : state === 'undone' ? 'Undone' : state === 'cant' ? "Can't be undone" : state === 'part' ? 'Partly undone' : `${s.count.toLocaleString()} item${s.count === 1 ? '' : 's'}`;
        return `<div class="hs-step${state ? ' ' + state : ''}"><div class="hs-h">
            <button class="hs-car${open ? ' on' : ''}" data-hx="${s.id}" title="${open ? 'Hide' : 'Show'} the parts" aria-expanded="${open}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
            <span class="hs-tm">${hsWhen(s.at)}</span><span class="hs-lb">${esc(s.label)}</span><span class="hs-pill ${state}">${pill}</span>
            ${s.open ? `<button class="uc-btn hs-all" data-hall="${s.id}">${s.undone ? 'Undo the rest' : 'Undo'}</button>` : ''}</div>
          ${open ? `<div class="hs-parts">${s.parts.map((p, i) => {
              const can = p.s === '';
              const note = p.s === 'u' ? '<span class="hs-ok">undone</span>' : p.s === 'w' ? '<span class="hs-busy">still running</span>' : p.s === 'm' ? '<span class="hs-busy">being moved back…</span>'
                : p.why ? `<span class="${p.s === 'x' ? 'hs-cant' : 'hs-why'}">${p.s === 'x' ? '' : "Couldn't undo: "}${esc(p.why)}</span>` : '';
              return `<label class="hs-p${p.s === 'u' ? ' done' : ''}${p.s === 'x' ? ' cant' : ''}"><input type="checkbox" data-ht="${s.id}" data-i="${i}" ${can ? '' : 'disabled'} ${can && tick.has(i) ? 'checked' : ''}>
                <span class="hs-n">${esc(hsName(p))}</span><span class="hs-tx">${hsDesc(p)}</span>${note ? `<span class="hs-note">${note}</span>` : ''}</label>`;
            }).join('')}${s.count > s.parts.length ? `<div class="hs-more muted">Showing the first ${s.parts.length.toLocaleString()} of ${s.count.toLocaleString()} parts. "Undo the rest" includes all of them.</div>` : ''}
            ${s.open ? `<div class="hs-f"><button class="uc-btn primary hs-sel" data-hsel="${s.id}" ${tick.size ? '' : 'disabled'}>Undo ${tick.size ? tick.size + ' ' : ''}ticked</button></div>` : ''}</div>` : ''}</div>`;
      }).join('')}</div>`;
  }
  async function hsLoad() {
    let r; try { r = await api('history'); } catch (e) { toast(e.message, true); return []; }
    HS.steps = r.steps; hsDraw(r.steps);
    clearTimeout(HS.timer);
    if (r.steps.some(s => s.busy)) HS.timer = setTimeout(() => { if ($('.hs', dlg)) hsLoad(); }, 2000);
    return r.steps;
  }
  async function openHistory() {
    let sure = false;
    openDlg('History', '<div class="hs"><div class="hs-empty muted">Loading…</div></div>', [
      { label: 'Forget all steps', title: 'Forget these steps. Nothing on the disks changes and nothing is taken out of the trash, but the steps can no longer be undone from here.', run: async () => {
        const b = $$('.dlg-foot .uc-btn', dlg)[0];
        if (!sure) { sure = true; b.textContent = 'Sure? Forget all steps'; b.classList.add('danger'); return false; }
        await api('history_clear'); HS.open.clear(); HS.tick.clear(); await hsLoad(); sure = false; b.textContent = 'Forget all steps'; b.classList.remove('danger'); return false;
      } },
      { label: 'Close', primary: true }], 'hist-dlg');
    const box = $('.hs', dlg);
    box.addEventListener('click', async e => {
      const x = e.target.closest('[data-hx]'), all = e.target.closest('[data-hall]'), sel = e.target.closest('[data-hsel]');
      if (x) { const id = x.dataset.hx; HS.open.has(id) ? HS.open.delete(id) : HS.open.add(id); return hsDraw(HS.steps); }
      if (all || sel) {
        const id = (all || sel).dataset.hall || (all || sel).dataset.hsel;
        const parts = sel ? [...(HS.tick.get(id) || [])] : null;
        (all || sel).disabled = true;
        const r = await doUndo(id, parts);
        HS.tick.delete(id);
        if (r && r.failed.length) HS.open.add(id);       // show why
        await hsLoad();
      }
    });
    box.addEventListener('change', e => {
      const c = e.target.closest('[data-ht]'); if (!c) return;
      const id = c.dataset.ht, i = +c.dataset.i;
      if (!HS.tick.has(id)) HS.tick.set(id, new Set());
      c.checked ? HS.tick.get(id).add(i) : HS.tick.get(id).delete(i);
      const b = $(`[data-hsel="${id}"]`, box), n = HS.tick.get(id).size;
      if (b) { b.disabled = !n; b.textContent = `Undo ${n ? n + ' ' : ''}ticked`; }
    });
    await hsLoad();
  }

  /* Asked before any copy replaces files. */
  function confirmReplace(c, what, go) {
    const n = c.count, keep = SET.trash !== false, days = SET.trash_days;
    const list = c.sample.map(x => `<div class="mono">${esc(x)}</div>`).join('') + (n > c.sample.length ? `<div class="muted">…and ${(n - c.sample.length).toLocaleString()} more${c.cut ? ' (stopped counting - there may be more)' : ''}</div>` : '');
    openDlg(`Replace ${n.toLocaleString()} file${n === 1 ? '' : 's'}?`, `
      <div>${esc(what)} will overwrite ${n === 1 ? 'a file' : `${n.toLocaleString()} files`} already there (${fmtBytes(c.bytes)}):</div>
      <div class="cr-list">${list}</div>
      <div class="warnbox warn">${keep
        ? `<b>The files at the destination get overwritten.</b> unCommander keeps the old versions in the trash on that share or disk, so <b>Undo</b> or <b>History</b> (in the More row) can put them back. Once the trash is purged${days ? ` (after ${days} day${days === 1 ? '' : 's'})` : ''}, <b>this cannot be undone</b>.`
        : `<b>This cannot be undone.</b> The trash is switched off (Settings > Safety & trash), so the old versions are deleted for good.`}</div>`,
      [{ label: 'Cancel' }, { label: `Replace ${n.toLocaleString()}`, primary: true, danger: true, run: go }], 'pm-dlg');
  }
  const refresh = (p, name) => p.mode === 'dir' ? load(p, p.path, name) : null;
  const refreshBoth = () => { refresh(A()); if (B().path !== A().path || B().mode !== 'dir') refresh(B()); else refresh(B()); };

  /* ---------- auto-refresh (opt-in: Settings > General) ----------
   * Every few seconds, ask the server whether either open folder changed
   * (it only looks at the folders' last-changed times - no listing). Only a
   * folder that did change is reloaded, keeping ticks, cursor and scroll.
   * Waits while the tab is hidden, a window is open, Compare is on, a pane
   * is loading, or you touched something in the last moment. */
  const watchOn = () => !!(SET.autorefresh && SET.autorefresh.on);
  let watchT = 0, lastTouch = 0;
  ['pointerdown', 'keydown', 'wheel', 'touchmove'].forEach(ev => document.addEventListener(ev, () => { lastTouch = Date.now(); }, { capture: true, passive: true }));
  function watchArm() {
    clearTimeout(watchT);
    if (watchOn()) watchT = setTimeout(watchTick, (SET.autorefresh.secs || 10) * 1000);
  }
  async function watchTick() {
    if (!watchOn()) return;
    try {
      const calm = !document.hidden && modal.hidden && tmodal.hidden && !cmpOn && !booting && Date.now() - lastTouch > 1500;
      const ps = panes.filter(p => p.mode === 'dir' && !p.loading && !p.error && p.sig && p.el.offsetParent !== null);
      if (calm && ps.length) {
        const r = await api('watch', { paths: [...new Set(ps.map(p => p.path))] });
        for (const p of ps) {
          const sig = r.sig && r.sig[p.path];
          if (sig && sig !== 'gone' && sig !== p.sig && !p.loading && modal.hidden && tmodal.hidden && !cmpOn) await softReload(p);
        }
      }
    } catch (e) { /* a missed check is fine - try again next time */ }
    watchArm();
  }
  async function softReload(p) {
    const path = p.path;
    const ticked = new Set([...p.sel].map(i => p.items[i]).filter(it => it && !it.up).map(it => fullPath(p, it)));
    const cur = p.items[p.cursor], curName = cur && !cur.up ? fullPath(p, cur) : null;
    const before = new Set(p.all.map(it => it.n)), top = p.list.scrollTop;
    p.quiet = true;
    try { await load(p, path); } finally { p.quiet = false; }
    if (p.error || p.path !== path || p.mode !== 'dir') return;
    p.items.forEach((it, i) => { if (!it.up && ticked.has(fullPath(p, it))) p.sel.add(i); });
    if (curName) { const ix = p.items.findIndex(it => !it.up && fullPath(p, it) === curName); if (ix >= 0) p.cursor = ix; }
    p.list.scrollTop = top;
    const fresh = p.all.filter(it => !before.has(it.n)).map(it => it.n);
    if (fresh.length) { p.flash = new Set(fresh); clearTimeout(p.flashT); p.flashT = setTimeout(() => { p.flash = null; drawRows(p); }, 3000); }
    drawRows(p); updateChrome(); saveSel();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && watchOn()) { clearTimeout(watchT); watchT = setTimeout(watchTick, 300); } });

  /* ---------- Find File (laid out like mc's) ---------- */
  const FIND_DEFAULTS = { name: '*', text: '', ignoreOn: false, ignore: '', recursive: true, shell: true,
    name_case: false, skip_hidden: false, follow: false, regex: false, text_case: false, whole: false };

  function findDialog(p, again) {
    const o = Object.assign({}, FIND_DEFAULTS, store.get('find2', {}), again || {});
    const start = again && again.path ? again.path : (p.mode === 'find' ? p.findInfo.start : p.path);
    const cb = (k, label) => `<label class="chk"><input type="checkbox" data-o="${k}" ${o[k] ? 'checked' : ''}> ${label}</label>`;
    openDlg('Find File', `
      <div class="field"><label>Start at</label><input type="text" class="f-start" value="${esc(start)}"></div>
      <div class="ff-tree" hidden></div>
      <div class="field">
        ${cb('ignoreOn', 'Enable ignore directories:')}
        <input type="text" class="f-ignore" value="${esc(o.ignore)}" placeholder="Downloads:appdata:/mnt/user/Backups" ${o.ignoreOn ? '' : 'disabled'}>
        <div class="muted ff-hint">Separate folders with <b class="mono">:</b> — for example <span class="mono">Downloads:appdata:/mnt/user/Backups</span><br>• <span class="mono">Downloads</span> — skips every folder named Downloads, wherever it is<br>• <span class="mono">/mnt/user/Backups</span> — skips just that one folder<br>• <span class="mono">Movies/Old</span> — skips Old inside Movies, under Start at</div>
      </div>
      <div class="ff-grid">
        <div class="ff-col">
          <div class="field"><label>File name</label><input type="text" class="f-name" value="${esc(o.name)}" placeholder="*"></div>
          ${cb('recursive', 'Find recursively')}
          ${cb('shell', 'Using shell patterns')}
          ${cb('name_case', 'Case sensitive')}
          ${cb('skip_hidden', 'Skip hidden')}
          ${cb('follow', 'Follow symlinks')}
        </div>
        <div class="ff-col">
          <div class="field"><label>Content</label><input type="text" class="f-text" value="${esc(o.text)}" placeholder="leave empty to match names only"></div>
          ${cb('regex', 'Regular expression')}
          ${cb('text_case', 'Case sensitive')}
          ${cb('whole', 'Whole words')}
        </div>
      </div>`,
      [{ label: 'OK', primary: true, run: () => {
         const q = { name: $('.f-name', dlg).value.trim() || '*', text: $('.f-text', dlg).value, path: $('.f-start', dlg).value.trim(),
                     ignore: $('.f-ignore', dlg).value.trim() };
         $$('[data-o]', dlg).forEach(c => q[c.dataset.o] = c.checked);
         store.set('find2', Object.assign({}, q, { path: undefined }));
         findRun(p, q);
         return false;   // findRun swaps the dialog for the results window
       } },
       { label: 'Tree', run: () => { toggleTree(); return false; } },
       { label: 'Cancel' }], true);
    const ign = $('.f-ignore', dlg);
    $('[data-o="ignoreOn"]', dlg).addEventListener('change', e => { ign.disabled = !e.target.checked; if (e.target.checked) ign.focus(); });
    $('.f-name', dlg).focus(); $('.f-name', dlg).select();

    /* Tree: browse for the start folder instead of typing it. */
    async function toggleTree(path) {
      const tree = $('.ff-tree', dlg), inp = $('.f-start', dlg);
      if (!path && !tree.hidden) { tree.hidden = true; return; }
      path = path || inp.value.trim() || '/mnt/user';
      tree.hidden = false; tree.innerHTML = '<div class="muted">Loading…</div>';
      try {
        const r = await api('list', { path });
        inp.value = r.path;
        const dirs = r.items.filter(([n, t]) => t === 'd' && !n.startsWith('.')).map(([n]) => n).sort(collator.compare);
        tree.innerHTML = (r.path !== '/' ? `<div class="ff-node" data-go="${esc(parent(r.path))}">..</div>` : '')
          + dirs.map(n => `<div class="ff-node" data-go="${esc(join(r.path, n))}">${esc(n)}</div>`).join('')
          + (dirs.length ? '' : '<div class="muted">No subfolders</div>');
        $$('.ff-node', tree).forEach(el => el.addEventListener('click', () => toggleTree(el.dataset.go)));
      } catch (e) { tree.innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; }
    }
  }

  /* Highlight the search term in result snippets and in the viewer. */
  function termRe(q) {
    if (!q || !q.text) return null;
    try {
      const src = q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(q.whole ? `\\b(?:${src})\\b` : src, q.text_case ? 'g' : 'gi');
    } catch (e) { return null; }
  }
  function markText(s, re) {
    if (!re) return esc(s);
    let out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }
  const findLabel = q => `${q.name}${q.text ? ` containing "${q.text}"` : ''}`;

  async function findRun(p, q) {
    const ctl = new AbortController();
    openDlg('Find File', `<div class="ff-status"><span class="ff-spin"></span><span class="ff-msg">Searching <span class="mono">${esc(q.path)}</span> for <span class="mono">${esc(findLabel(q))}</span>…</span></div>`,
      [{ label: 'Stop', run: () => { ctl.abort(); findDialog(p, q); return false; } },
       { label: 'Quit', run: () => { ctl.abort(); } }], true);
    let r;
    try { r = await api('find', Object.assign({}, q, { ignore: q.ignoreOn ? q.ignore : '' }), ctl.signal); }
    catch (e) {
      if (ctl.signal.aborted || modal.hidden) return;
      $('.ff-status', dlg).innerHTML = `<span class="uc-error">${esc(e.message)}</span>`; return;
    }
    if (ctl.signal.aborted || modal.hidden) return;
    showResults(p, q, r, 0);
  }

  /* Results window, grouped by folder like mc. With a Content search there
   * is one entry per matching line: name:line, then the line itself. */
  function showResults(p, q, r, cur) {
    const hits = r.items, n = hits.length, re = termRe(q);
    const files = new Set(hits.map(h => h[0])).size;
    const pre = r.start.replace(/\/$/, '') + '/';
    const rel = d => d === r.start ? r.start : d.startsWith(pre) ? d.slice(pre.length) : d;
    let html = '', lastDir = null;
    hits.forEach(([abs, t, line, snip], i) => {
      const dir = parent(abs);
      if (dir !== lastDir) { html += `<div class="ff-dir">${esc(rel(dir))}</div>`; lastDir = dir; }
      html += `<div class="ff-hit${t === 'd' ? ' dir' : ''}" data-i="${i}"><span class="ff-name">${esc(base(abs))}${t === 'd' ? '/' : ''}${line ? `<span class="ff-ln">:${line}</span>` : ''}</span>`
        + (line ? `<span class="ff-snip">${markText(snip, re)}</span>` : '') + '</div>';
    });
    const count = r.lines
      ? `<b>${n.toLocaleString()}</b> matching line${n === 1 ? '' : 's'} in <b>${files.toLocaleString()}</b> file${files === 1 ? '' : 's'}`
      : `<b>${n.toLocaleString()}</b> found`;
    const back = () => showResults(p, q, r, cur);
    openDlg('Find File', `
      <div class="ff-status"><span class="ff-msg">Finished — ${count}${r.truncated ? ' (stopped at 2,000)' : ''}</span></div>
      <div class="ff-results">${html || '<div class="uc-empty">Nothing found.</div>'}</div>`,
      [{ label: 'Go to file', title: 'Open its folder in the pane, with the file selected', run: () => goTo() },
       { label: 'View', title: 'Read it, scrolled to the matching line (F2)', run: () => { if (cur >= 0) openViewer(hits[cur][0], { line: hits[cur][2], re, back }); return false; } },
       { label: 'Edit', title: 'Edit it, at the matching line (F3)', run: () => { if (cur >= 0) openEditor(hits[cur][0], { line: hits[cur][2], back }); return false; } },
       { label: 'List in pane', title: 'Show every found file in the pane, so you can copy, move or delete them together', run: () => listInPane() },
       { label: 'Again', title: 'Change the search', run: () => { findDialog(p, q); return false; } },
       { label: 'Quit' }], true);
    const btns = $$('.dlg-foot .uc-btn', dlg), list = $('.ff-results', dlg);
    if (!n) btns.slice(0, 4).forEach(b => b.disabled = true);
    const pick = i => {
      cur = i;
      $$('.ff-hit.on', list).forEach(el => el.classList.remove('on'));
      const el = $(`.ff-hit[data-i="${i}"]`, list);
      if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'nearest' }); }
      const isDir = hits[i][1] === 'd';
      btns[1].disabled = btns[2].disabled = isDir;
    };
    list.addEventListener('click', e => { const h = e.target.closest('.ff-hit'); if (h) pick(+h.dataset.i); });
    list.addEventListener('dblclick', e => { const h = e.target.closest('.ff-hit'); if (h) { pick(+h.dataset.i); btns[hits[cur][1] === 'd' ? 0 : 1].click(); } });
    dlg.extraKey = e => {
      if (!n || e.target.matches('input')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); pick(Math.min(n - 1, cur + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(0, cur - 1)); }
      else if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); btns[hits[cur][1] === 'd' ? 0 : 1].click(); }
      else if (e.key === 'F3') { e.preventDefault(); btns[2].click(); }
    };
    if (n) pick(Math.min(cur, n - 1));

    function goTo() {
      if (cur < 0) return;
      const [abs, t] = hits[cur];
      if (t === 'd') load(p, abs); else load(p, parent(abs), base(abs));
    }
    async function listInPane() {
      const seen = new Set();
      p.mode = 'find'; p.trash = false; p.root = false;
      p.findInfo = { start: r.start, label: findLabel(q) };
      p.all = hits.filter(h => !seen.has(h[0]) && seen.add(h[0])).map(([abs, t]) => ({ n: abs.startsWith(pre) ? abs.slice(pre.length) : abs, t, abs }));
      p.stats = new Map(); p.locs = new Map(); p.dirSizes = new Map(); p.sel.clear(); p.cursor = 0; p.list.scrollTop = 0;
      applyCols(p); await applySort(p, true); updateChrome();
    }
  }

  /* ---------- image & PDF viewer (F2 on those files) ---------- */
  const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg']);
  const rawUrl = path => `${API}?action=raw&path=${encodeURIComponent(path)}`;
  function openMedia(path, o = {}) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const backBtn = o.back ? [{ label: '‹ Results', run: () => { o.back(); return false; } }] : [];
    const newTab = { label: 'Open in new tab', title: 'Full-screen in its own browser tab', run: () => { window.open(rawUrl(cur()), '_blank', 'noopener'); return false; } };
    if (ext === 'pdf') {
      openDlg(base(path), `
        <div class="vw-meta mono">${esc(path)}</div>
        <iframe class="mv-pdf" src="${esc(rawUrl(path))}" title="${esc(base(path))}"></iframe>`,
        [...backBtn, newTab, { label: 'Close', primary: true }], 'full');
      const cur = () => path;
      return;
    }
    /* All the pictures in this folder, so ‹ Prev / Next › can flip through them. */
    const p = A();
    let list = [path];
    if (p.mode === 'dir' && parent(path) === p.path)
      list = p.items.filter(it => !it.up && it.t !== 'd' && IMG_EXT.has((it.n.split('.').pop() || '').toLowerCase())).map(it => fullPath(p, it));
    let i = Math.max(0, list.indexOf(path));
    const cur = () => list[i];
    openDlg(base(path), `
      <div class="mv-stage"><img class="mv-img" alt=""></div>
      <div class="mv-meta"><span class="mv-name mono"></span><span class="mv-info muted"></span></div>`,
      [...backBtn,
       { label: '‹ Prev', run: () => { show(i - 1); return false; } },
       { label: 'Next ›', run: () => { show(i + 1); return false; } },
       { label: 'Edit picture', title: 'Rotate, flip, crop, resize or change the type', run: () => { if (!EDIT_IMG.test(cur())) { toast("This kind of picture can't be edited here", true); return false; } openImageEditor(cur()); return false; } },
       newTab, { label: 'Close', primary: true }], 'full');
    const stage = $('.mv-stage', dlg), img = $('.mv-img', dlg);
    const btns = $$('.dlg-foot .uc-btn', dlg), off = backBtn.length;
    function show(n) {
      if (n < 0 || n >= list.length) return;
      i = n;
      stage.classList.remove('zoom'); stage.classList.add('loading');
      delete img.dataset.conv;
      img.src = rawUrl(cur());
      $('.dlg-head', dlg).textContent = base(cur());
      $('.mv-name', dlg).textContent = base(cur());
      $('.mv-info', dlg).textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
      setTimeout(() => { btns[off].disabled = i === 0; btns[off + 1].disabled = i === list.length - 1; });
      if (list.length < 2) { btns[off].hidden = btns[off + 1].hidden = true; }
    }
    img.addEventListener('load', () => {
      stage.classList.remove('loading');
      const s = p.stats.get(base(cur())) || {};
      $('.mv-info', dlg).textContent = [img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : '', s.s != null ? fmtBytes(s.s) : '',
        list.length > 1 ? `${i + 1} of ${list.length}` : ''].filter(Boolean).join(' · ');
    });
    img.addEventListener('error', () => {
      if (HEIC.test(cur()) && !img.dataset.conv) {          // not Safari: convert it here
        img.dataset.conv = '1'; $('.mv-info', dlg).textContent = 'Opening the HEIC picture…';
        const want = cur();
        return heicUrl(want).then(u => { if (cur() === want) img.src = u; }, e => { stage.classList.remove('loading'); $('.mv-info', dlg).textContent = e.message; });
      }
      stage.classList.remove('loading'); $('.mv-info', dlg).textContent = "This browser can't show this image type.";
    });
    img.addEventListener('click', () => stage.classList.toggle('zoom'));   // tap: fit ↔ actual size
    dlg.extraKey = e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); show(i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); show(i - 1); }
    };
    /* swipe left/right on a tablet */
    let sx = null;
    stage.addEventListener('touchstart', e => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (sx == null || stage.classList.contains('zoom')) return;
      const dx = e.changedTouches[0].clientX - sx; sx = null;
      if (Math.abs(dx) > 60) show(i + (dx < 0 ? 1 : -1));
    });
    show(i);
  }

  /* ---------- picture editor: rotate, flip, crop, resize, convert ----------
   * Everything happens in the browser - nothing to install on the server. The
   * picture is drawn on a canvas, and the result is sent back in pieces. Save as
   * a new file next to the original, or replace the original (the old one goes
   * to the trash, so History can put it back). */
  const EDIT_IMG = /\.(jpe?g|png|webp|bmp|avif|heic|heif|tiff?)$/i;   // not GIF: it would lose its animation and colours
  const HEIC = /\.hei[cf]$/i;
  /* Send a file to the server in pieces (plain form posts, so no upload size limit
   * applies). mode 'new' never overwrites; 'replace' puts the old one in the trash.
   * extra.join adds it to an existing History step. */
  async function putFile(blob, path, mode, name, extra = {}, onPct) {
    const { id } = await api('put_begin');
    const CH = 768 * 1024;
    for (let i = 0; i < blob.size; i += CH) {
      const u = new Uint8Array(await blob.slice(i, i + CH).arrayBuffer());
      let bin = ''; for (let j = 0; j < u.length; j += 32768) bin += String.fromCharCode.apply(null, u.subarray(j, j + 32768));
      await api('put_part', { id, data: btoa(bin) });
      if (onPct) onPct(Math.min(100, Math.round((i + CH) / blob.size * 100)));
    }
    return api('put_end', Object.assign({ id, path, mode, name }, extra));
  }
  /* ---------- Download to this computer, Upload from it ----------
   * Download: one file comes as it is, anything else as one .zip (made while it
   * downloads - nothing is written on the server). The browser's own download
   * bar shows the progress. */
  async function downloadPaths(paths) {
    let r;
    try { r = await api('dl_prep', { paths: JSON.stringify(paths) }); }
    catch (e) { return toast(`Couldn't download: ${e.message}`, true); }
    const a = document.createElement('a');
    a.href = `${API}?action=dl&t=${r.t}`; a.download = r.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    toast(r.zip ? `Downloading ${r.name} - ${r.files.toLocaleString()} file${r.files === 1 ? '' : 's'}, ${fmtBytes(r.size)}` : `Downloading ${r.name} (${fmtBytes(r.size)})`);
  }

  /* Upload: files or folders dropped on a pane from the computer, or picked with
   * "Upload here…". Sent in pieces (plain form posts, so no size limit applies),
   * three pieces at a time; each file is written next to where it goes and only
   * gets its name when it has arrived whole. One History step for the lot. */
  const UP = { busy: false, stop: false, box: null };
  async function dropEntries(dt) {
    const out = [], walk = async (en, pre) => {
      if (en.isFile) { const f = await new Promise((ok, no) => en.file(ok, no)); out.push({ file: f, rel: pre + f.name }); }
      else if (en.isDirectory) {
        const rd = en.createReader(); let got = [];
        do { got = await new Promise((ok, no) => rd.readEntries(ok, no)); for (const k of got) await walk(k, pre + en.name + '/'); } while (got.length);
        if (!got.length && !out.some(x => x.rel.startsWith(pre + en.name + '/'))) out.push({ dir: true, rel: pre + en.name });
      }
    };
    const ens = [...dt.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry && i.webkitGetAsEntry());
    if (ens.length && ens.every(Boolean)) { for (const en of ens) await walk(en, ''); return out; }
    return [...dt.files].map(f => ({ file: f, rel: f.name }));
  }
  function upPick(p, dir, folder) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true;
    if (folder) inp.webkitdirectory = true;
    inp.style.display = 'none'; document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const list = [...inp.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name })); inp.remove();
      if (list.length) uploadTo(p, dir, list);
    });
    inp.click();
  }
  function upBox(on) {
    if (!UP.box) {
      UP.box = document.createElement('div'); UP.box.className = 'uc-upbox';
      UP.box.innerHTML = '<div class="ub-t"></div><div class="ub-bar"><i></i></div><div class="ub-s"></div><button class="uc-btn ub-x">Stop</button>';
      $('.ub-x', UP.box).addEventListener('click', () => { UP.stop = true; $('.ub-x', UP.box).textContent = 'Stopping…'; });
      root.appendChild(UP.box);
    }
    UP.box.hidden = !on;
    if (on) $('.ub-x', UP.box).textContent = 'Stop';
    return UP.box;
  }
  async function uploadTo(p, dir, list) {
    if (UP.busy) return toast('An upload is already running - wait for it to finish, or stop it', true);
    const files = list.filter(x => !x.dir), dirs = list.filter(x => x.dir);
    if (!files.length && !dirs.length) return;
    let mode = 'skip';
    try {
      const have = files.length ? (await api('up_check', { dir, rels: JSON.stringify(files.map(x => x.rel)) })).have : [];
      if (have.length) {
        mode = await new Promise(res => {
          openDlg('Already there', `<p>${have.length === 1 ? `<b>${esc(have[0])}</b> is` : `${have.length.toLocaleString()} of these are`} already in <b>${esc(base(dir) || dir)}</b>.</p>
            ${have.length > 1 ? `<div class="up-have">${have.slice(0, 8).map(h => `<div>${esc(h)}</div>`).join('')}${have.length > 8 ? `<div>…and ${(have.length - 8).toLocaleString()} more</div>` : ''}</div>` : ''}`,
            [{ label: 'Cancel', run: () => res(null) },
             { label: 'Keep both', title: 'the new one gets (2) in its name', run: () => res('both') },
             { label: 'Replace', run: () => res(SET.practice ? (toast('Practice mode is on, so replacing is turned off.', true), null) : 'replace') },
             { label: 'Skip those', primary: true, run: () => res('skip') }]);
          dlg.beforeClose = () => { res(null); return true; };
        });
        if (!mode) return;
      }
    } catch (e) { return toast(`Couldn't upload: ${e.message}`, true); }
    UP.busy = true; UP.stop = false;
    const box = upBox(true), total = files.reduce((s, x) => s + x.file.size, 0) || 1, t0 = Date.now();
    const madeTop = [], label = n => `Uploaded ${files.length === 1 ? base(files[0].rel) : `${n} file${n === 1 ? '' : 's'}`} to ${base(dir) || dir}`;
    let sent = 0, ok = 0, skipped = 0, hist = null; const bad = [];
    const show = (name, i) => {
      $('.ub-t', box).textContent = `Uploading ${i + 1} of ${files.length.toLocaleString()}: ${name}`;
      const sec = (Date.now() - t0) / 1000, rate = sent / Math.max(sec, .5);
      $('.ub-bar i', box).style.width = Math.round(sent / total * 100) + '%';
      $('.ub-s', box).textContent = `${fmtBytes(sent)} of ${fmtBytes(total)}${sec > 2 ? ` · ${fmtBytes(rate)}/s${rate ? ` · about ${fmtDur(Math.round((total - sent) / rate))} left` : ''}` : ''}`;
    };
    const CH = 1024 * 1024, PAR = 3;
    for (const [i, x] of files.entries()) {
      if (UP.stop) break;
      show(x.rel, i);
      let id = null;
      try {
        const b = await api('up_begin', { dir, rel: x.rel, size: x.file.size, mode });
        b.made.forEach(m => madeTop.push(m));
        if (b.skip) { skipped++; sent += x.file.size; continue; }
        id = b.id;
        const offs = []; for (let o = 0; o < x.file.size; o += CH) offs.push(o);
        let next = 0;
        const worker = async () => {
          while (next < offs.length && !UP.stop) {
            const o = offs[next++], u = new Uint8Array(await x.file.slice(o, o + CH).arrayBuffer());
            let bin = ''; for (let j = 0; j < u.length; j += 32768) bin += String.fromCharCode.apply(null, u.subarray(j, j + 32768));
            await api('up_part', { id, off: o, data: btoa(bin) });
            sent += u.length; show(x.rel, i);
          }
        };
        await Promise.all(Array.from({ length: PAR }, worker));
        if (UP.stop) { api('up_cancel', { id }).catch(() => {}); break; }
        const under = madeTop.some(m => (dir.replace(/\/$/, '') + '/' + x.rel).startsWith(m + '/')) && !b.made.length;
        const r = await api('up_end', { id, mtime: x.file.lastModified || 0, made: JSON.stringify(b.made), under: under ? '1' : '', join: hist || '', label: label(ok + 1) });
        hist = r.hist || hist; ok++;
        if (Date.now() - (UP.drawn || 0) > 2500) { UP.drawn = Date.now(); refresh(p); }   // the new files show up as they arrive
      } catch (e) {
        if (id) api('up_cancel', { id }).catch(() => {});
        bad.push(`${x.rel}: ${e.message}`);
        if (/expired|permissions|no longer there/.test(e.message)) break;
      }
    }
    for (const d of dirs) { const full = dir.replace(/\/$/, '') + '/' + d.rel; try { await api('mkdir', { path: parent(full), name: base(full) }); } catch (e) {} }   // empty folders
    UP.busy = false; upBox(false);
    refreshBoth();
    const skip = skipped ? ` · ${skipped.toLocaleString()} already there, skipped` : '';
    if (UP.stop) toast(`Stopped - ${ok.toLocaleString()} of ${files.length.toLocaleString()} uploaded${skip}`, false, hist);
    else if (bad.length) toast(`Uploaded ${ok.toLocaleString()} of ${files.length.toLocaleString()}${skip}. ${bad.slice(0, 2).join(' · ')}`, true, null, true);
    else done(`Uploaded ${ok.toLocaleString()} file${ok === 1 ? '' : 's'} (${fmtBytes(total === 1 ? 0 : total)}) to ${base(dir) || dir}${skip}`, hist);
  }
  /* HEIC (iPhone photos): Safari shows them itself; other browsers get them
   * converted on the fly by heic2any - one JavaScript file the plugin downloads
   * once at install (nothing is installed on the server). */
  let heicLib = null;
  function loadHeic() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    return heicLib = heicLib || new Promise((ok, no) => {
      const sc = document.createElement('script');
      sc.src = '/plugins/uncommander/lib/heic2any.min.js';
      sc.onload = () => window.heic2any ? ok(window.heic2any) : no(new Error('HEIC support did not load'));
      sc.onerror = () => { heicLib = null; no(new Error("HEIC support isn't downloaded yet - reinstall unCommander while the server is online")); };
      document.head.appendChild(sc);
    });
  }
  async function heicConvert(path, toType = 'image/jpeg', quality = 1) {
    const h = await loadHeic();
    const r = await fetch(rawUrl(path), { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`Couldn't read ${base(path)}`);
    let out = await h({ blob: await r.blob(), toType, quality });
    if (Array.isArray(out)) out = out[0];          // a burst or Live photo: the main picture
    return out;
  }
  const heicUrls = new Map();
  async function heicUrl(path) {
    if (!heicUrls.has(path)) heicUrls.set(path, heicConvert(path, 'image/png').then(b => URL.createObjectURL(b)).catch(e => { heicUrls.delete(path); throw e; }));
    return heicUrls.get(path);
  }
  /* Lossless JPG turns: only the "which way is up" note (EXIF Orientation) changes;
   * the picture data is left exactly as it is. */
  const ORI = { 1: [1, 0, 0, 1], 2: [-1, 0, 0, 1], 3: [-1, 0, 0, -1], 4: [1, 0, 0, -1], 5: [0, 1, 1, 0], 6: [0, -1, 1, 0], 7: [0, -1, -1, 0], 8: [0, 1, -1, 0] };
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
  function jpgOrientation(buf) {        // -> { value, at } (at = byte offset of the value), or null
    const d = new DataView(buf);
    if (d.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < d.byteLength) {
      const m = d.getUint16(o), len = d.getUint16(o + 2);
      if (m === 0xFFE1 && d.getUint32(o + 4) === 0x45786966) {          // "Exif"
        const t = o + 10, le = d.getUint16(t) === 0x4949;
        const ifd = t + d.getUint32(t + 4, le), n = d.getUint16(ifd, le);
        for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (d.getUint16(e, le) === 0x0112) return { value: d.getUint16(e + 8, le), at: e + 8, le, has: true }; }
        return { value: 1, has: false, exif: true };
      }
      if (m === 0xFFDA || (m & 0xFF00) !== 0xFF00) break;
      o += 2 + len;
    }
    return { value: 1, has: false, exif: false };
  }
  function jpgSetOrientation(buf, v) {    // -> new ArrayBuffer, or null if it can't be done safely
    const info = jpgOrientation(buf);
    if (!info) return null;
    if (info.has) { const c = buf.slice(0); new DataView(c).setUint16(info.at, v, info.le); return c; }
    if (info.exif) return null;          // an EXIF block without the tag: re-save instead
    /* no EXIF at all: add a tiny one right after the start marker */
    const seg = new Uint8Array([0xFF, 0xE1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0]);
    const src = new Uint8Array(buf), out = new Uint8Array(src.length + seg.length);
    const dv = new DataView(buf), at = dv.getUint16(2) === 0xFFE0 ? 4 + dv.getUint16(4) : 2;   // after the JFIF block, if there is one
    out.set(src.subarray(0, at)); out.set(seg, at); out.set(src.subarray(at), at + seg.length);
    return out.buffer;
  }
  const CANVAS_MAX = 16000000;        // iPad Safari won't draw a canvas bigger than ~16.7 million pixels
  const FMT = { jpg: ['image/jpeg', 'JPG'], png: ['image/png', 'PNG'], webp: ['image/webp', 'WebP'] };
  function openImageEditor(path) {
    const ext0 = (path.split('.').pop() || '').toLowerCase();
    const stem = base(path).replace(/\.[^.]+$/, '');
    const st = { rot: 0, flip: false, crop: null, aspect: 0, w: 0, h: 0, fmt: FMT[ext0] ? ext0 : ext0 === 'jpeg' ? 'jpg' : 'jpg', q: 100, scale: 1, ang: 0 };
    const ASPECTS = [['0', 'Off'], ['-1', 'Free'], ['1', 'Square 1:1'], ['0.6667', 'Poster 2:3'], ['1.7778', 'Wide 16:9'], ['1.3333', 'Photo 4:3'], ['0.75', 'Upright 3:4']];
    openDlg(`Edit ${base(path)}`, `
      <div class="ie">
        <div class="ie-tools">
          <div class="ie-grp"><button type="button" class="uc-btn" data-ie="rl" title="Rotate left 90° - press again to keep turning">⟲ Left</button><button type="button" class="uc-btn" data-ie="rr" title="Rotate right 90° - press again to keep turning">Right ⟳</button><button type="button" class="uc-btn" data-ie="fh" title="Mirror left-right">⇋ Flip</button></div>
          <div class="ie-grp ie-straight" title="Straighten: turn by a few degrees - the picture is enlarged just enough that no empty corners show"><span class="ie-l">Straighten</span><input type="range" class="ie-ang" min="-45" max="45" step="0.5" value="0"><b class="ie-angv">0°</b><button type="button" class="uc-btn ie-ang0" hidden title="Back to 0°">✕</button></div>
          <div class="ie-grp"><span class="ie-l">Crop</span><select class="ie-asp">${ASPECTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="ie-grp"><span class="ie-l">Size</span><input type="number" class="ie-w" min="1"><span class="muted">×</span><input type="number" class="ie-h" min="1"><button type="button" class="uc-btn" data-ie="half" title="Half the size">½</button><button type="button" class="uc-btn" data-ie="full" title="Back to full size">1:1</button></div>
          <div class="ie-grp"><span class="ie-l">Type</span><select class="ie-fmt">${Object.entries(FMT).map(([k, [, l]]) => `<option value="${k}"${k === st.fmt ? ' selected' : ''}>${l}</option>`).join('')}</select><span class="ie-qw"><span class="ie-l">Quality</span><input type="range" class="ie-q" min="50" max="100" value="100"><b class="ie-qv">100</b></span></div>
        </div>
        <div class="ie-stage loading"><div class="ie-wrap"><canvas class="ie-cv"></canvas><div class="ie-crop" hidden><i data-c="nw"></i><i data-c="ne"></i><i data-c="sw"></i><i data-c="se"></i></div></div></div>
        <div class="ie-bottom"><span class="ie-info muted">Opening…</span><span class="ie-namef"></span></div>
      </div>`,
      [{ label: 'Cancel' },
       { label: 'Replace original', title: 'Save over the original - the old one goes to the trash, so Undo or History can bring it back', run: () => save('replace') },
       { label: 'Save as new file', primary: true, run: () => save('new') }], 'full sticky ie-dlg');
    const D = dlg, cv = $('.ie-cv', D), wrap = $('.ie-wrap', D), stage = $('.ie-stage', D), box = $('.ie-crop', D);
    $('.ie-namef', D).innerHTML = `<label class="muted">New file name</label><input type="text" class="ie-nm" spellcheck="false" autocapitalize="off">`;
    const nm = $('.ie-nm', D), fw = $('.ie-w', D), fh = $('.ie-h', D);
    const [btnCancel, btnRep, btnNew] = $$('.dlg-foot .uc-btn', D);
    if (SET.practice) { btnRep.disabled = true; btnRep.title = 'Practice mode is on - saving over the original is locked; Save as new file still works'; }
    btnRep.disabled = btnNew.disabled = true;
    const img = new Image();
    let src = null;          // the picture, maybe shrunk to fit the canvas limit
    let baseCv = null;       // the picture turned and flipped
    const RW = () => baseCv.width, RH = () => baseCv.height;
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      st.scale = w * h > CANVAS_MAX ? Math.sqrt(CANVAS_MAX / (w * h)) : 1;
      src = document.createElement('canvas');
      src.width = Math.round(w * st.scale); src.height = Math.round(h * st.scale);
      src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
      stage.classList.remove('loading');
      rebuild();
      btnNew.disabled = false; if (!SET.practice) btnRep.disabled = false;
    };
    img.onerror = () => {
      if (HEIC.test(path) && !img.dataset.conv) {        // not Safari: convert it in the browser
        img.dataset.conv = '1'; $('.ie-info', D).textContent = 'Opening the HEIC picture…';
        return heicUrl(path).then(u => { img.src = u; }, e => { stage.classList.remove('loading'); $('.ie-info', D).textContent = e.message; });
      }
      stage.classList.remove('loading'); $('.ie-info', D).textContent = /tiff?/.test(ext0) ? `This browser can't open ${ext0.toUpperCase()} pictures (Safari on the iPad and Mac can).` : "This browser can't open this picture.";
    };
    img.src = rawUrl(path);
    /* turned (90° steps), flipped, then straightened by a few degrees - enlarged
     * just enough that the corners stay filled, so the size doesn't change */
    function render(c, k) {
      const t = st.rot % 2, w = t ? src.height : src.width, h = t ? src.width : src.height;
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const x = c.getContext('2d'), a = st.ang * Math.PI / 180, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      const z = Math.max((w * cs + h * sn) / w, (w * sn + h * cs) / h);
      x.imageSmoothingQuality = 'high';
      x.translate(c.width / 2, c.height / 2); x.rotate(a); x.scale(z * k, z * k); x.rotate(st.rot * Math.PI / 2); if (st.flip) x.scale(-1, 1);
      x.drawImage(src, -src.width / 2, -src.height / 2);
      return c;
    }
    const previewK = () => { const t = st.rot % 2, w = t ? src.height : src.width, h = t ? src.width : src.height; return Math.min(1, 1600 / Math.max(w, h)); };
    function rebuild(keepCrop) {
      baseCv = render(document.createElement('canvas'), 1);
      /* the preview: at most 1600 px across, the page scales it to fit */
      cv.width = Math.round(baseCv.width * previewK()); cv.height = Math.round(baseCv.height * previewK());
      cv.getContext('2d').drawImage(baseCv, 0, 0, cv.width, cv.height);
      if (!keepCrop) { if (st.aspect) newCrop(); else st.crop = null; }
      sizeFromCrop(); draw();
    }
    /* a JPG only turned or flipped, saved as JPG at full size: no re-saving at all */
    const lossless = () => /^jpe?g$/.test(ext0) && st.fmt === 'jpg' && !st.crop && !st.ang && (() => { const c = cropPx(); return st.w === Math.round(c.w / st.scale) && st.h === Math.round(c.h / st.scale); })();
    const cropPx = () => { const c = st.crop || { x: 0, y: 0, w: 1, h: 1 }; return { x: Math.round(c.x * RW()), y: Math.round(c.y * RH()), w: Math.max(1, Math.round(c.w * RW())), h: Math.max(1, Math.round(c.h * RH())) }; };
    function sizeFromCrop() { const c = cropPx(); st.w = Math.round(c.w / st.scale); st.h = Math.round(c.h / st.scale); }
    function newCrop() {
      const a = st.aspect;
      if (a < 0) { st.crop = { x: .1, y: .1, w: .8, h: .8 }; return; }
      let w = .9, h = w * RW() / a / RH();
      if (h > .9) { h = .9; w = h * a * RH() / RW(); }
      st.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
    }
    function draw() {
      const c = st.crop;
      box.hidden = !c;
      if (c) Object.assign(box.style, { left: c.x * 100 + '%', top: c.y * 100 + '%', width: c.w * 100 + '%', height: c.h * 100 + '%' });
      fw.value = st.w; fh.value = st.h;
      const q = $('.ie-qw', D); q.hidden = st.fmt === 'png';
      $('.ie-qv', D).textContent = st.q;
      const ow = Math.round(img.naturalWidth), oh = Math.round(img.naturalHeight);
      $('.ie-info', D).textContent = `Original ${ow} × ${oh}  →  ${st.w} × ${st.h} ${FMT[st.fmt][1]}` + (lossless() ? ' · lossless turn: the picture itself is not re-saved' : '') + (st.scale < 1 ? ` · very large picture: this device can work on it at ${src.width} × ${src.height} at most` : '');
      const want = `${stem}-edited.${st.fmt}`;
      if (!nm.dataset.touched) nm.value = want;
      else nm.value = nm.value.replace(/\.(jpe?g|png|webp)$/i, '') + '.' + st.fmt;
    }
    nm.addEventListener('input', () => { nm.dataset.touched = '1'; });
    $('.ie-tools', D).addEventListener('click', e => {
      const b = e.target.closest('[data-ie]'); if (!b || !src) return;
      const k = b.dataset.ie;
      if (k === 'rl') { st.rot = (st.rot + 3) % 4; rebuild(); }
      else if (k === 'rr') { st.rot = (st.rot + 1) % 4; rebuild(); }
      else if (k === 'fh') { st.flip = !st.flip; rebuild(); }
      else if (k === 'half') { st.w = Math.max(1, Math.round(st.w / 2)); st.h = Math.max(1, Math.round(st.h / 2)); draw(); }
      else if (k === 'full') { sizeFromCrop(); draw(); }
    });
    /* straighten: a quick preview while dragging, the full picture when let go */
    const ang = $('.ie-ang', D), angv = $('.ie-angv', D), ang0 = $('.ie-ang0', D);
    const angShow = () => { angv.textContent = `${st.ang > 0 ? '+' : ''}${st.ang}°`; ang0.hidden = !st.ang; };
    ang.addEventListener('input', () => { if (!src) return; st.ang = +ang.value; angShow(); wrap.classList.add('grid'); render(cv, previewK()); draw(); });
    ang.addEventListener('change', () => { if (!src) return; st.ang = +ang.value; angShow(); wrap.classList.remove('grid'); rebuild(true); });
    ang0.addEventListener('click', () => { ang.value = 0; st.ang = 0; angShow(); rebuild(true); });
    $('.ie-asp', D).addEventListener('change', e => { st.aspect = +e.target.value; if (st.aspect) newCrop(); else st.crop = null; sizeFromCrop(); draw(); });
    $('.ie-fmt', D).addEventListener('change', e => { st.fmt = e.target.value; draw(); });
    $('.ie-q', D).addEventListener('input', e => { st.q = +e.target.value; $('.ie-qv', D).textContent = st.q; });
    /* the size keeps the picture's shape: change one side, the other follows */
    const ratio = () => { const c = cropPx(); return c.w / c.h; };
    fw.addEventListener('input', () => { const v = parseInt(fw.value, 10); if (v > 0) { st.w = v; st.h = Math.max(1, Math.round(v / ratio())); fh.value = st.h; draw(); } });
    fh.addEventListener('input', () => { const v = parseInt(fh.value, 10); if (v > 0) { st.h = v; st.w = Math.max(1, Math.round(v * ratio())); fw.value = st.w; draw(); } });

    /* cropping: drag the box to move it, a corner to resize it, or draw a new one */
    let drag = null;
    const at = e => { const r = wrap.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
    function span(ax, ay, px, py) {
      const a = st.aspect > 0 ? st.aspect : 0;
      let w = Math.abs(px - ax), h = Math.abs(py - ay);
      if (a) {
        h = w * RW() / a / RH();
        const hmax = py < ay ? ay : 1 - ay, wmax = px < ax ? ax : 1 - ax;
        if (h > hmax) { h = hmax; w = h * a * RH() / RW(); }
        if (w > wmax) { w = wmax; h = w * RW() / a / RH(); }
      }
      w = Math.max(w, 0.02); h = Math.max(h, 0.02);
      return { x: px < ax ? ax - w : ax, y: py < ay ? ay - h : ay, w, h };
    }
    wrap.addEventListener('pointerdown', e => {
      if (!st.aspect || !src) return;
      e.preventDefault(); wrap.setPointerCapture(e.pointerId);
      const [px, py] = at(e), c = st.crop, corner = e.target.dataset && e.target.dataset.c;
      if (corner && c) {
        const ax = corner.includes('w') ? c.x + c.w : c.x, ay = corner.includes('n') ? c.y + c.h : c.y;
        drag = { kind: 'size', ax, ay };
      } else if (c && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) drag = { kind: 'move', px, py, x: c.x, y: c.y };
      else drag = { kind: 'size', ax: px, ay: py };
    });
    wrap.addEventListener('pointermove', e => {
      if (!drag) return;
      const [px, py] = at(e), c = st.crop;
      if (drag.kind === 'move') { c.x = Math.min(1 - c.w, Math.max(0, drag.x + px - drag.px)); c.y = Math.min(1 - c.h, Math.max(0, drag.y + py - drag.py)); }
      else st.crop = span(drag.ax, drag.ay, px, py);
      sizeFromCrop(); draw();
    });
    const end = () => { drag = null; };
    wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);

    async function save(mode) {
      if (!src) return false;
      let blob = null;
      if (lossless()) {
        const buf = await (await fetch(rawUrl(path), { credentials: 'same-origin' })).arrayBuffer();
        const now = jpgOrientation(buf);
        const ours = mul([[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]][st.rot], st.flip ? [-1, 0, 0, 1] : [1, 0, 0, 1]);
        const want = mul(ours, ORI[now && ORI[now.value] ? now.value : 1]);
        const v = +Object.keys(ORI).find(k => ORI[k].every((x, i) => x === want[i]));
        const nb = now && jpgSetOrientation(buf, v);
        if (nb) blob = new Blob([nb], { type: 'image/jpeg' });
      }
      if (!blob) blob = await draw2blob();
      return upload(mode, blob);
    }
    async function draw2blob() {
      const c = cropPx(), out = document.createElement('canvas');
      let ow = st.w, oh = st.h;
      if (ow * oh > CANVAS_MAX) { const f = Math.sqrt(CANVAS_MAX / (ow * oh)); ow = Math.round(ow * f); oh = Math.round(oh * f); }   // the device's canvas limit
      out.width = Math.max(1, ow); out.height = Math.max(1, oh);
      const x = out.getContext('2d');
      if (st.fmt === 'jpg') { x.fillStyle = '#fff'; x.fillRect(0, 0, out.width, out.height); }   // JPG has no see-through parts
      x.imageSmoothingQuality = 'high';
      x.drawImage(baseCv, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
      const [mime] = FMT[st.fmt];
      const blob = await new Promise(res => out.toBlob(res, mime, st.q / 100));
      if (!blob) throw new Error("This browser couldn't make the picture");
      if (blob.type !== mime) throw new Error(`This browser can't make ${FMT[st.fmt][1]} pictures - pick another type`);
      return blob;
    }
    async function upload(mode, blob) {
      const name = mode === 'replace' ? `${stem}.${st.fmt}` : (nm.value.trim() || `${stem}-edited.${st.fmt}`);
      const btn = mode === 'replace' ? btnRep : btnNew, label = btn.textContent;
      try {
        const r = await putFile(blob, path, mode, name, {}, n => { btn.textContent = `Saving ${n}%`; });
        btn.textContent = label;
        done(mode === 'replace' ? `Saved ${r.name} - the old one is in the trash` : `Saved ${r.name}`, r.hist);
        const p = A(); if (p.mode === 'dir') await load(p, p.path, parent(r.path) === p.path ? r.name : null);
        const q = B(); if (q.mode === 'dir' && q.path === parent(r.path)) refresh(q);
        openMedia(r.path);
        return false;
      } catch (e) { btn.textContent = label; throw e; }
    }
  }

  /* ---------- Gallery view ----------
   * One pane shows its folder as tiles with small pictures; the other pane is
   * covered by a large preview of the tile under the cursor. Ticking, the menu,
   * F-keys, Copy/Cut/Paste and drag all work as in the list. Leaving puts both
   * panes back as they were. Small pictures come from the server (PHP's GD,
   * kept in RAM); HEIC ones are made in the browser. */
  const GAL_IMG = /\.(jpe?g|png|gif|webp|bmp|avif|svg|heic|heif|tiff?|ico)$/i;
  const GAL_VID = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|ts|m2ts|mpe?g|vob)$/i;
  const GAL_AUD = /\.(mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wma|aiff?|alac|ape|wv|mka|ac3|eac3|dts|mp2|amr|caf|dsf|dff|weba)$/i;
  const THUMB_OK = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
  const GAL_SIZES = { s: [110, 240], m: [160, 320], l: [230, 480] };
  const thumbUrl = (path, s) => `${API}?action=thumb&s=${s}&path=${encodeURIComponent(path)}`;
  const GI = {
    dir: '<svg viewBox="0 0 24 24"><path d="M2.5 6.5v12h19v-10H11L9 6.5z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 2.5h8.5l4 4v15H6z"/><path d="M14.5 2.5v4h4"/></svg>',
    vid: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/></svg>',
    aud: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
    pic: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/></svg>',
  };
  function galFits(p) {
    if (p.mode !== 'dir' || p.root) return false;
    let f = 0, n = 0;
    for (const it of p.items) { if (it.up || it.t === 'd') continue; f++; if (GAL_IMG.test(it.n)) n++; }
    return n >= 5 || (n > 0 && n / f >= .25);
  }
  const galSize = () => GAL_SIZES[store.get('galSize', 'm')] || GAL_SIZES.m;
  function galSet(p, on) {
    const q = panes[1 - p.i];
    if (on) { if (q.gal) galSet(q, false); if (cmpOn) endCompare(true); }
    p.gal = !!on; store.set('gal' + p.i, p.gal);
    p.el.classList.toggle('gal', p.gal);
    p.galItems = null; p.galLast = -1;
    if (p.gal) { p.el.style.setProperty('--tile', galSize()[0] + 'px'); galPrevMake(q, p); }
    else { galPrevRemove(q); p.list.scrollTop = Math.max(0, p.cursor * ROW - p.list.clientHeight / 2); }
    if (p.mode === 'dir') applySort(p); else draw(p);
    if (p.gal) setTimeout(() => galScroll(p), 30);
  }
  function galCols(p) {
    const cur = $(`.uc-tile[data-idx="${p.cursor}"]`, p.list);
    const box = cur && cur.parentElement.classList.contains('mt-grid') ? cur.parentElement : p.spacer;
    const t = [...box.children].filter(x => x.classList.contains('uc-tile')); if (t.length < 2) return 1;
    const top = t[0].offsetTop; let n = 0;
    for (const x of t) { if (x.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  }
  function galScroll(p) { const t = $(`.uc-tile[data-idx="${p.cursor}"]`, p.list); if (t) t.scrollIntoView({ block: 'nearest' }); }
  function galTile(p, it, i, other) {
    if (p.mt && it.up) return `<div class="uc-row uc-tile mt-up${i === p.cursor ? ' cursor' : ''}" data-idx="${i}" title="Up one folder"><span class="nm up">${GI.up}<span>${esc(base(parent(p.path)) || '/')}</span></span></div>`;
    const path = it.up ? '' : fullPath(p, it), dir = it.up || itDir(p, it);
    const cm = it.up || !(clipSet && clipSet.size) ? null : clipMark(path);
    const ext = it.up || dir ? '' : (it.n.includes('.') ? it.n.split('.').pop() : '').slice(0, 5);
    const S = galSize()[1];
    let pic;
    if (it.up) pic = `<span class="tl-ic up">${GI.up}</span>`;
    else if (dir && p.mt && !other) pic = `<img class="tl-cover" loading="lazy" decoding="async" alt="" src="${esc(`${API}?action=cover&s=${S}&v=${coverV}&path=${encodeURIComponent(path)}`)}"><button type="button" class="tl-play" title="Play this album" aria-label="Play ${esc(it.n)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l8.5-5z"/></svg></button><button type="button" class="tl-add" title="Add to the playlist" aria-label="Add ${esc(it.n)} to the playlist"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button>`;
    else if (dir) pic = `<span class="tl-ic dir">${GI.dir}</span>`;
    else if (THUMB_OK.test(it.n)) pic = `<img loading="lazy" decoding="async" alt="" src="${esc(thumbUrl(path, S))}">`;
    else if (/\.svg$/i.test(it.n)) pic = `<img loading="lazy" decoding="async" alt="" src="${esc(rawUrl(path))}">`;
    else if (HEIC.test(it.n)) pic = `<span class="tl-ic" data-heic="${esc(path)}">${GI.pic}</span>`;
    else pic = `<span class="tl-ic">${GAL_VID.test(it.n) ? GI.vid : GAL_AUD.test(it.n) ? GI.aud : GAL_IMG.test(it.n) ? GI.pic : GI.file}</span>`;
    return `<div class="uc-row uc-tile${p.sel.has(i) ? ' sel' : ''}${i === p.cursor ? ' cursor' : ''}${cm ? ' clip-' + cm : ''}" data-idx="${i}"${!it.up && finePointer() ? ' draggable="true"' : ''} title="${esc(it.up ? 'Up one folder' : it.n)}">
      ${it.up ? '' : `<div class="col-sel"><span class="box${p.sel.has(i) ? ' on' : ''}"></span></div>`}
      <div class="tl-pic">${pic}${ext && !THUMB_OK.test(it.n) ? `<span class="tl-ext">${esc(ext)}</span>` : ''}</div>
      <div class="nm${dir ? ' dir' : ''}">${it.up ? '..' : cm ? `<span class="nm-t ${cm}">${esc(it.n)}</span>` : esc(it.n)}</div>${p.mt && dir && !it.up ? `<div class="tl-sub">${esc(musSub(p, it))}</div>` : ''}${cm ? `<span class="clip-tag ${cm}">${cm === 'cut' ? '✂ cut' : cm === 'del' ? '🗑 to delete' : '⧉ copy'}</span>` : ''}</div>`;
  }
  /* HEIC tiles: made in the browser, only for the ones scrolled into view */
  const heicTiles = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(async e => {
    if (!e.isIntersecting) return;
    const el = e.target; heicTiles.unobserve(el);
    try {
      const u = await heicUrl(el.dataset.heic), im = new Image();
      im.onload = () => { const S = galSize()[1], k = Math.min(1, S / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        const img = document.createElement('img'); img.src = c.toDataURL('image/jpeg', .85); if (el.isConnected) el.replaceWith(img); };
      im.src = u;
    } catch (err) { /* stays an icon */ }
  }), { rootMargin: '200px' }) : null;
  function drawGal(p) {
    const sp = p.spacer;
    if (p.galItems !== p.items) {
      p.galItems = p.items;
      if (p.mt) {
        /* the music library: the albums first, everything else smaller below */
        const ups = [], dirs = [], rest = [];
        /* an album is a folder with songs in it; extrafanart, scans and the like are "other files" */
        const album = it => itDir(p, it) && !/^(extra ?fanart|extra ?thumbs?|scans?|artwork|art|covers?|images?|pictures?|photos?|backdrops?|videos?|interviews?|lyrics|booklets?|\.\w.*)$/i.test(it.n)
          && !(p.musInfo && p.musInfo.has(it.n) && !p.musInfo.get(it.n).songs);
        p.items.forEach((it, i) => it.up ? ups.push(galTile(p, it, i)) : album(it) ? dirs.push(galTile(p, it, i)) : rest.push(galTile(p, it, i, true)));
        sp.innerHTML = ups.join('') + `<div class="mt-sec"><div class="mt-h">Albums<span>${dirs.length}</span></div><div class="mt-grid">${dirs.join('')}</div></div>`
          + (rest.length ? `<div class="mt-sec small"><div class="mt-h">Other files<span>${rest.length}</span></div><div class="mt-grid">${rest.join('')}</div></div>` : '');
      } else sp.innerHTML = p.items.map((it, i) => galTile(p, it, i)).join('') || `<div class="uc-empty">${esc(p.error || 'This folder is empty.')}</div>`;
      if (heicTiles) $$('[data-heic]', sp).forEach(el => heicTiles.observe(el));
    } else {
      for (const t of sp.querySelectorAll('.uc-tile')) {
        const i = +t.dataset.idx; if (Number.isNaN(i)) continue;
        const it = p.items[i]; if (!it) continue;
        const cm = it.up || !(clipSet && clipSet.size) ? null : clipMark(fullPath(p, it));
        t.classList.toggle('sel', p.sel.has(i)); t.classList.toggle('cursor', i === p.cursor);
        ['copy', 'cut', 'del'].forEach(k => t.classList.toggle('clip-' + k, cm === k));
        const b = $('.box', t); if (b) b.classList.toggle('on', p.sel.has(i));
        if ((t.dataset.cm || '') !== (cm || '') && !it.up) { t.dataset.cm = cm || ''; $('.nm', t).innerHTML = cm ? `<span class="nm-t ${cm}">${esc(it.n)}</span>` : esc(it.n); }
        const tag = $('.clip-tag', t);
        if (cm && !tag) t.insertAdjacentHTML('beforeend', `<span class="clip-tag ${cm}">${cm === 'cut' ? '✂ cut' : cm === 'del' ? '🗑 to delete' : '⧉ copy'}</span>`);
        else if (!cm && tag) tag.remove();
        else if (cm && tag && !tag.classList.contains(cm)) { tag.className = 'clip-tag ' + cm; tag.textContent = cm === 'cut' ? '✂ cut' : cm === 'del' ? '🗑 to delete' : '⧉ copy'; }
      }
    }
    if (p.gal && (p.cursor !== p.galLast || p.prevPath !== p.path)) { p.galLast = p.cursor; p.prevPath = p.path; clearTimeout(p.galT); p.galT = setTimeout(() => galPreview(p), 90); }
  }
  /* the preview covers the other pane */
  function galPrevMake(q, p) {
    galPrevRemove(q);
    const el = document.createElement('div');
    el.className = 'uc-gprev';
    el.innerHTML = `<div class="gp-head"><span class="gp-t">Preview</span><span class="gp-name"></span><button type="button" class="uc-btn gp-x" title="Back to the list (this pane shows its folder again)">✕ Close gallery</button></div>
      <div class="gp-body"></div><div class="gp-foot"><span class="gp-info muted"></span><span class="gp-btns"></span></div>`;
    $('.uc-box', q.el).appendChild(el);
    q.prev = el;
    el.addEventListener('mousedown', e => { e.stopPropagation(); setActive(p.i); });
    $('.gp-x', el).addEventListener('click', () => galSet(p, false));
    $('.gp-btns', el).addEventListener('click', e => {
      const b = e.target.closest('[data-gp]'); if (!b) return;
      const it = p.items[p.cursor]; if (!it || it.up) return;
      if (b.dataset.gp === 'view') openItem(p, p.cursor);
      if (b.dataset.gp === 'edit') openImageEditor(fullPath(p, it));
      if (b.dataset.gp === 'tab') window.open(rawUrl(fullPath(p, it)), '_blank', 'noopener');
      if (b.dataset.gp === 'play') musPlayFile(fullPath(p, it));
      if (b.dataset.gp === 'add') plAdd([fullPath(p, it)]);
    });
  }
  function galPrevRemove(q) { if (q.prev) { killMedia(q.prev); q.prev.remove(); q.prev = null; } }
  async function galPreview(p) {
    const q = panes[1 - p.i], el = q.prev; if (!el || !p.gal) return;
    const it = p.items[p.cursor], body = $('.gp-body', el), info = $('.gp-info', el), btns = $('.gp-btns', el);
    $('.gp-name', el).textContent = it ? (it.up ? '..' : it.n) : '';
    killMedia(body); body.innerHTML = ''; info.textContent = ''; btns.innerHTML = ''; delete info.dataset.px;
    if (!it || it.up) { body.innerHTML = `<span class="gp-ic">${GI.up}</span>`; return; }
    const path = fullPath(p, it), want = path;
    if (itDir(p, it)) { body.innerHTML = `<span class="gp-ic">${GI.dir}</span>`; info.textContent = 'Folder - double-click or Enter opens it'; return; }
    const B = (k, l) => `<button type="button" class="uc-btn" data-gp="${k}">${l}</button>`;
    if (GAL_IMG.test(it.n)) {
      const img = document.createElement('img'); img.alt = '';
      if (THUMB_OK.test(it.n)) { img.src = thumbUrl(path, 640); const full = new Image(); full.onload = () => { if (img.isConnected) img.src = full.src; }; full.src = rawUrl(path); }
      else img.src = rawUrl(path);
      img.onerror = () => { if (HEIC.test(path) && !img.dataset.conv) { img.dataset.conv = '1'; heicUrl(path).then(u => { if (img.isConnected) img.src = u; }, er => { info.textContent = er.message; }); } };
      img.onload = () => { if (img.naturalWidth && !img.src.includes('action=thumb')) info.dataset.px = `${img.naturalWidth} × ${img.naturalHeight}`; galInfo(p, it, info); };
      body.appendChild(img);
      btns.innerHTML = B('view', 'View') + (EDIT_IMG.test(it.n) ? B('edit', 'Edit picture') : '') + B('tab', 'New tab');
    } else if (GAL_AUD.test(it.n)) {
      /* a song: its cover, and buttons - nothing starts by itself, so the player at the bottom isn't interrupted */
      body.innerHTML = `<img class="gp-cover" alt="" src="${esc(`${API}?action=cover&path=${encodeURIComponent(path)}`)}"><span class="gp-ic" hidden>${GI.aud}</span>`;
      const im = $('.gp-cover', body); im.onerror = () => { im.remove(); $('.gp-ic', body).hidden = false; };
      btns.innerHTML = B('view', 'Preview') + (playerOn() ? B('play', 'Play') + B('add', 'Add to playlist') : '');
    } else if (GAL_VID.test(it.n)) {
      mountPlayer(body, path, true);
      btns.innerHTML = B('view', 'Big player');
    } else if (!NO_EDIT.test(it.n)) {
      body.innerHTML = '<pre class="gp-text">…</pre>';
      try { const r = await api('peek', { path }); if (p.items[p.cursor] !== it) return;
        $('.gp-text', body).textContent = r.binary ? '(not a text file)' : (r.text || '').split('\n').slice(0, 400).join('\n'); } catch (e) { $('.gp-text', body).textContent = e.message; }
      btns.innerHTML = B('view', 'View');
    } else body.innerHTML = `<span class="gp-ic">${GI.file}</span>`;
    galInfo(p, it, info);
  }
  async function galInfo(p, it, info) {
    const k = it.abs || it.n;
    let s = p.stats.get(k);
    if (!s) { try { s = (await api('stat', { path: p.path, names: [k] })).stats[k] || {}; p.stats.set(k, s); } catch (e) { s = {}; } }
    if (p.items[p.cursor] !== it) return;
    info.textContent = [info.dataset.px || '', s.s != null ? fmtBytes(s.s) : '', s.m ? fmtDate(s.m) : ''].filter(Boolean).join(' · ');
  }

  /* ---------- Music library ----------
   * A folder of artist folders (each holding album folders of songs) gets a ♪
   * button where the Gallery button sits. In the library the left pane lists
   * the artists (narrow), the right shows the picked artist's albums as covers,
   * or an album's files as the usual list, with a player under it. It is still
   * the two panes: ticks, F-keys, menus, Copy/Cut/Paste all work. Leaving the
   * library's folder in either pane ends it; both panes stay where they are. */
  let mus = null, musFollowT = 0;
  const musProbe = new Map();
  const musIn = q => q.mode === 'dir' && (q.path === mus.root || q.path.startsWith(mus.root + '/'));
  /* the music library a folder is in (the folder itself, or one inside it): the last one
   * opened, the music check's, or one found to have artists in it */
  function musLib(path) {
    if (!path) return '';
    const roots = [store.get('musroot', ''), store.get('mcroot', ''), ...[...musProbe].filter(([, v]) => v === true).map(([k]) => k)]
      .filter(x => typeof x === 'string' && x).sort((a, b) => b.length - a.length);
    return roots.find(r => path === r || path.startsWith(r + '/')) || '';
  }
  /* two albums side by side, each with its strip (Play, Tags): the music check's "Open both" */
  const inDir = (path, d) => path === d || path.startsWith(d + '/');
  /* CD1/CD2... folders, or a folder of one format (mp3, flac) - parts of an album */
  const PART_RE = /^(?:(?:cd|dis[ck])\s*\d+|mp3|flac|aac|m4a|alac|ogg|opus|wav|wma|ape|dsd|dsf|hi-?res|lossless|24[ -]?bit|16[ -]?bit|320|v0)$/i;
  const musParts = p => { const ds = p.items.filter(it => !it.up && !it.depth && itDir(p, it)); return ds.length > 0 && ds.some(it => /^(?:cd|dis[ck])\s*\d+$/i.test(it.n)) && ds.every(it => PART_RE.test(it.n) || /^(scans?|artwork|covers?|booklet|extras?)$/i.test(it.n)); };
  function musTiles(p) {
    if (!mus || p.i !== 1 || p.mode !== 'dir') return false;
    let d = 0;
    for (const it of p.items) { if (it.up) continue; if (itDir(p, it)) d++; else if (GAL_AUD.test(it.n)) return false; }
    return d > 0 && !musParts(p);        // an album in CD1/CD2 folders is an album, not a row of covers
  }
  function musBtn(p) {
    const b = $('.uc-musbtn', p.el), x = $('.uc-endmus', p.el); if (!b) return;
    x.hidden = !(mus && p.i === 1);
    if (mus && mus.pair) { b.hidden = true; return; }
    if (mus) { b.hidden = p.i !== 0; b.classList.add('on'); b.title = 'Close the music library (both panes stay where they are)'; return; }
    b.classList.remove('on'); b.title = 'Music library - artists on the left, their albums as covers on the right';
    /* anywhere inside a library you've used: opens the library right here */
    if (p.mode === 'dir' && !p.root && !p.loading && musLib(p.path)) { b.hidden = false; b.title = 'Music library - opens here, at this artist or album'; return; }
    const ok = p.mode === 'dir' && !p.root && !p.loading && !p.gal && p.items.filter(it => !it.up && it.t === 'd').length >= 2;
    const v = ok ? musProbe.get(p.path) : false;
    b.hidden = v !== true;
    if (ok && v === undefined) {
      const path = p.path; musProbe.set(path, null);
      api('music_probe', { path }).then(r => { musProbe.set(path, !!r.music); if (p.path === path && !mus) musBtn(p); }, () => musProbe.delete(path));
    }
  }
  /* at: a folder inside the library to open at (an artist, an album) - else where the pane is */
  async function musEnter(p, at) {
    const L = panes[0], Rt = panes[1];
    let R = musLib(at || p.path) || p.path, first = null, pickName = null;
    if (mus) musExit();
    panes.forEach(q => { if (q.gal) galSet(q, false); });
    if (cmpOn) endCompare(true);
    const here = at || p.path;
    if (here !== R && here.startsWith(R + '/')) { first = here; pickName = here.slice(R.length + 1).split('/')[0]; }
    else {
      R = p.path;
      const cur = p.items[p.cursor];
      const pick = cur && !cur.up && !cur.depth && itDir(p, cur) ? cur : p.items.find(it => !it.up && !it.depth && itDir(p, it));
      first = pick ? fullPath(p, pick) : null; pickName = pick && pick.n;
    }
    mus = { root: R, busy: true, q: [], i: -1, now: null }; store.set('mus', R); store.set('musroot', R);
    root.classList.add('uc-mus'); sound.play('open');
    const go = [];
    if (L.path !== R || L.mode !== 'dir') go.push(load(L, R, pickName));
    if (first && Rt.path !== first) go.push(load(Rt, first));
    setActive(first && first.split('/').length - R.split('/').length >= 2 ? 1 : 0);
    try { await Promise.all(go); } finally { if (mus) mus.busy = false; }
    if (!mus) return;
    if (!musIn(L) || L.path !== R || !musIn(Rt)) return musExit();
    panes.forEach(draw); await musSync();
  }
  /* two albums of the library side by side: each pane its own album with Play and Tags */
  async function musPair(R, a, b) {
    if (mus) musExit();
    panes.forEach(q => { if (q.gal) galSet(q, false); });
    if (cmpOn) endCompare(true);
    mus = { root: R, busy: true, q: [], i: -1, now: null, pair: [a, b] };
    root.classList.add('uc-mus', 'uc-muspair'); sound.play('open');
    try { await Promise.all([load(panes[0], a), load(panes[1], b)]); } finally { if (mus) mus.busy = false; }
    if (mus) panes.forEach(draw);
  }
  function musExit() {
    if (!mus) return;
    const Rt = panes[1];
    if (mus.stop) mus.stop();
    $$('.mus-player, .mus-strip').forEach(el => el.remove());
    mus = null; clearTimeout(musFollowT); store.set('mus', null);
    root.classList.remove('uc-mus', 'uc-muspair');
    panes.forEach(q => { if (q.mt) { q.mt = false; q.el.classList.remove('mus-tiles'); if (!q.gal) q.el.classList.remove('gal'); } q.galItems = null; if (q.mode === 'dir') applySort(q); else draw(q); });
    Rt.list.scrollTop = Math.max(0, Rt.cursor * ROW - Rt.list.clientHeight / 2);
  }
  function musAfterLoad(p) {
    if (!mus || mus.busy) return;
    const L = panes[0];
    if (mus.pair) { if (!inDir(L.path, mus.pair[0]) || !inDir(panes[1].path, mus.pair[1])) musExit(); return; }
    if (L.path !== mus.root || !musIn(L) || !musIn(panes[1])) return musExit();
    if (p.i === 1) musSync();
  }
  /* the left pane follows what the right pane shows: the artist, or the album opened in its tree */
  async function musSync() {
    const L = panes[0], Rt = panes[1];
    if (!mus || mus.pair || Rt.mode !== 'dir') return;
    const rel = Rt.path.slice(mus.root.length + 1).split('/').filter(Boolean);
    if (!rel.length) return;
    const artist = join(mus.root, rel[0]);
    if (rel.length > 1 && !L.tree.has(artist)) {
      L.tree.set(artist, []); const seq = L.seq;
      await treeFetch(L, [artist]); if (seq !== L.seq || !mus) return;
      saveTree(L); await applySort(L);
    }
    let ix = -1;
    for (let k = rel.length; k >= 1 && ix < 0; k--) { const want = join(mus.root, rel.slice(0, k).join('/')); ix = L.items.findIndex(it => !it.up && fullPath(L, it) === want); }
    if (ix >= 0 && ix !== L.cursor) { mus.sync = true; moveCursor(L, ix); mus.sync = false; }
  }
  /* moving through the artists on the left shows each one's albums on the right */
  function musFollow(p) {
    if (!mus || mus.pair || p.i !== 0 || mus.sync || mus.busy || p.loading) return;      // only moves made by hand, not a refresh
    clearTimeout(musFollowT);
    musFollowT = setTimeout(() => {
      if (!mus) return;
      const it = p.items[p.cursor], Rt = panes[1];
      if (!it || it.up || !itDir(p, it)) return;
      const path = fullPath(p, it);
      if (Rt.path !== path) load(Rt, path);
    }, 220);
  }
  /* under each album cover: its year (from the folder's name) and how many songs */
  function musSub(p, it) {
    const m = it.n.match(/[([]((?:19|20)\d\d)[)\]]|^((?:19|20)\d\d)\s*[-–.]/), y = m ? m[1] || m[2] : '';
    const f = p.musInfo && p.musInfo.get(it.n);
    return [y, f && f.songs ? `${f.songs} song${f.songs === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '\u00a0';
  }
  /* facts that need the server: song counts for the covers; song lengths in an album (only with ffmpeg) */
  function musFacts(p) {
    if (!mus || (p.i !== 1 && !mus.pair) || p.mode !== 'dir' || p.loading) { if (!mus) { p.durs = null; p.el.classList.remove('mus-times'); } return; }
    if (p.mt) {
      if (p.musInfoFor === p.path) return;
      p.musInfoFor = p.path; p.musInfo = new Map();
      const path = p.path, names = p.items.filter(it => !it.up && !it.depth && itDir(p, it)).map(it => it.n).slice(0, 400);
      api('mus_info', { path, names }).then(r => { if (p.path !== path) return; for (const [k, v] of Object.entries(r.info || {})) p.musInfo.set(k, v); p.galItems = null; drawRows(p); }, () => {});
      return;
    }
    const songs = p.items.filter(it => !it.up && !it.depth && GAL_AUD.test(it.n)).map(it => it.n);
    if (!songs.length) { p.durs = null; p.el.classList.remove('mus-times'); return; }
    if (p.dursFor === p.path) return;
    p.dursFor = p.path; p.durs = new Map(); p.el.classList.remove('mus-times');
    const path = p.path;
    (async () => {
      for (let i = 0; i < songs.length && i < 300; i += 25) {
        let r; try { r = await api('durations', { path, names: songs.slice(i, i + 25) }); } catch (e) { return; }
        if (p.path !== path || !mus) return;
        if (r.ff === false) return ffWant();             // no ffmpeg yet: fetched now, lengths next time
        for (const [k, v] of Object.entries(r.durs || {})) if (v > 0) p.durs.set(k, v);
        p.el.classList.add('mus-times'); drawRows(p); musStripTime(p);
      }
    })();
  }
  function musStripTime(p) {
    const el = $('.mus-strip .ms-s', p.el); if (!el || !p.durs || !p.durs.size) return;
    let t = 0; p.durs.forEach(v => { t += v; });
    el.dataset.base = el.dataset.base || el.textContent;
    el.textContent = `${el.dataset.base} · ${t >= 3600 ? Math.floor(t / 3600) + ' h ' + Math.round(t % 3600 / 60) + ' min' : t < 60 ? Math.round(t) + ' s' : Math.round(t / 60) + ' min'}`;
  }
  /* /mnt/remotes and /mnt/disks: each share or drive Unassigned Devices knows is a row, with
   * "mounted · un-mount" or "mount" in it (asked for after the folder has opened, so it's never slower) */
  async function udLoad(p) {
    const at = p.path; let r;
    try { r = await api('ud_here', { path: at }); } catch (e) { return; }
    if (p.path !== at || p.mode !== 'dir') return;
    p.ud = r.ud;
    p.udMap = new Map();
    if (p.ud) p.ud.all.forEach((x, k) => { if (parent(x.path) === p.path) p.udMap.set(base(x.path), k); });
    const have = new Set(p.all.map(it => it.n));
    for (const [n, k] of p.udMap) if (!have.has(n)) p.all.push({ n, t: 'd', ghost: true });
    await applySort(p);
    udStrip(p);
  }
  const udOf = (p, it) => p.ud && p.udMap && !it.up && !it.depth && p.udMap.has(it.n) ? p.ud.all[p.udMap.get(it.n)] : null;
  function udCell(p, it) {
    const x = udOf(p, it); if (!x) return '';
    return `<span class="ud-cell">${x.mounted ? `<span class="ud-pill on">mounted</span><button type="button" class="ud-act" data-udact="off" title="${esc(x.about || x.src)}">un-mount</button>`
      : `<button type="button" class="ud-act on" data-udact="on" title="${esc(x.about || x.src)}"${p.ud.rc ? '' : ' disabled'}>mount</button>`}</span>`;
  }
  async function udMountRow(p, it, open) {
    const x = udOf(p, it); if (!x) return;
    try { await api('ud_mount', { src: x.src }); toast(`Mounted ${x.name}`); } catch (er) { return toast(er.message, true); }
    if (open) load(p, x.path); else refresh(p);
  }
  /* inside a share or drive that isn't mounted: say so, with Mount */
  function udStrip(p) {
    const box = $('.uc-box', p.el); let el = $('.ud-strip', box);
    const off = p.mode === 'dir' && p.ud && p.ud.off;
    if (!off) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'ud-strip'; box.insertBefore(el, $('.uc-cols', box)); }
    el.innerHTML = `<span><b>${esc(off.name)}</b> isn't mounted - this ${p.ud.kind === 'remotes' ? 'network share' : 'drive'} shows as an empty folder until it is.</span><button type="button" class="uc-btn primary"${p.ud.rc ? '' : ' disabled'}>Mount</button>`;
    $('.uc-btn', el).onclick = async () => { try { await api('ud_mount', { src: off.src }); toast(`Mounted ${off.name}`); } catch (er) { return toast(er.message, true); } load(p, off.path); };
  }
  async function udUnmount(p, x) {
    for (const q of panes) if (q.path === x.path || q.path.startsWith(x.path + '/')) await load(q, parent(x.path));   // a pane inside it would keep it busy
    try { await api('ud_mount', { src: x.src, off: '1' }); toast(`Unmounted ${x.name}`); } catch (er) { toast(er.message, true); }
    refreshBoth();
  }
  /* the album strip above the right pane's list */
  function musStrip(p) {
    const box = $('.uc-box', p.el); let el = $('.mus-strip', box);
    const want = mus && (p.i === 1 || mus.pair) && p.mode === 'dir' && !p.mt && (p.items.some(it => !it.up && GAL_AUD.test(it.n)) || musParts(p));
    if (!want) { if (el) el.remove(); return; }
    const songs = p.items.filter(it => !it.up && !it.depth && GAL_AUD.test(it.n));
    const key = p.path + '|' + songs.length + '|' + coverV;
    if (el && el.dataset.key === key) return;
    if (!el) { el = document.createElement('div'); el.className = 'mus-strip'; box.insertBefore(el, $('.uc-cols', box)); }
    el.dataset.key = key;
    const up = parent(p.path), artist = up !== mus.root && up.startsWith(mus.root + '/') ? base(up) : '';
    const kinds = [...new Set(songs.map(it => it.n.split('.').pop().toUpperCase()))].join(' · ');
    el.innerHTML = `<img class="ms-cover" alt="" src="${esc(`${API}?action=cover&s=240&v=${coverV}&path=${encodeURIComponent(p.path)}`)}">
      <div class="ms-txt"><span class="ms-t" title="${esc(base(p.path))}">${esc(base(p.path))}</span><span class="ms-s">${artist ? esc(artist) + ' · ' : ''}${songs.length} song${songs.length === 1 ? '' : 's'}</span><span class="ms-f">${esc(kinds)}</span></div>
      <button type="button" class="uc-btn primary" data-ms="play">▶ Play<span class="ms-all"> all</span></button><button type="button" class="uc-btn" data-ms="shuffle">Shuffle</button><button type="button" class="uc-btn" data-ms="tags" title="Title, artist, album, year, cover - with MusicBrainz">✎ Tags</button>`;
    $('.ms-cover', el).addEventListener('error', e => { e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'ms-cover ms-ic', innerHTML: GI.aud })); });
    el.querySelectorAll('[data-ms]').forEach(b => b.addEventListener('click', () => b.dataset.ms === 'tags' ? openTagEditor([{ path: p.path, dir: true }]) : musPlayDir(p.path, b.dataset.ms === 'shuffle')));
    /* songs in CD1/CD2 folders: count them there (Play, Shuffle and Tags take them all) */
    if (musParts(p)) {
      const path = p.path, discs = p.items.filter(it => !it.up && !it.depth && itDir(p, it) && /^(?:cd|dis[ck])\s*\d+$/i.test(it.n)).length;
      musTracks(path).then(all => {
        if (p.path !== path || !el.isConnected) return;
        const ss = $('.ms-s', el), sf = $('.ms-f', el);
        if (ss) ss.textContent = `${artist ? artist + ' · ' : ''}${all.length} song${all.length === 1 ? '' : 's'} · ${discs} disc${discs === 1 ? '' : 's'}`;
        if (sf) sf.textContent = [...new Set(all.map(x => x.split('.').pop().toUpperCase()))].join(' · ');
      }, () => {});
    }
    musStripTime(p);
  }
  /* the songs of an album: its own, then those of its CD1/CD2... folders */
  async function musTracks(dir) {
    const r = await api('list', { path: dir });
    const files = r.items.filter(([n, t]) => t !== 'd' && GAL_AUD.test(n)).map(([n]) => n).sort((a, b) => collator.compare(a, b)).map(n => join(dir, n));
    const subs = r.items.filter(([, t]) => t === 'd').map(([n]) => n).sort((a, b) => collator.compare(a, b));
    for (const d of subs.slice(0, 20)) {
      try { const x = await api('list', { path: join(dir, d) }); files.push(...x.items.filter(([n, t]) => t !== 'd' && GAL_AUD.test(n)).map(([n]) => n).sort((a, b) => collator.compare(a, b)).map(n => join(join(dir, d), n))); } catch (e) {}
    }
    return files;
  }
  async function musPlayDir(dir, shuffle) {
    let q; try { q = await musTracks(dir); } catch (e) { return toast(e.message, true); }
    if (!q.length) return toast(`No songs in ${base(dir)}`, true);
    plPlay(q, 0, { shuffle });
  }
  async function musPlayFile(path) {
    const dir = parent(path);
    let q = [];
    try { const r = await api('list', { path: dir }); q = r.items.filter(([n, t]) => t !== 'd' && GAL_AUD.test(n)).map(([n]) => n).sort((a, b) => collator.compare(a, b)).map(n => join(dir, n)); } catch (e) {}
    if (!q.includes(path)) q = [path];
    plPlay(q, q.indexOf(path));
  }


  /* ---------- music tag editor ----------
   * The list of songs is its own preview: every change shows in place, in
   * green, with what it was crossed out under it, and the bar at the bottom
   * always says what Save will do. "Find this album online" (MusicBrainz)
   * lines a release up against the songs, lengths and all. Saving rewrites
   * only the tags (the sound is copied as it is and checked), and the
   * originals can go to the trash so Undo brings them back. */
  const TG_LABEL = { title: 'title', artist: 'artist', album: 'album', album_artist: 'album artist', date: 'year', track: 'track', disc: 'disc', genre: 'genre', composer: 'composer', comment: 'comment' };
  const TG_ALBUM = [['album', 'Album'], ['album_artist', 'Album artist'], ['date', 'Year'], ['genre', 'Genre']];
  const TG_ICON = {
    find: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    names: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8.5l4 4v15H6z"/><path d="M9 12h6M9 16h4"/></svg>',
    num: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h8M11 12h8M11 19h8M4 6l1.5-1V9M4 15.5a1.5 1.5 0 013 0c0 1-3 2-3 3.5h3"/></svg>',
  };
  let coverV = 0;          // bumped when a folder's cover changes, so the pictures load again
  /* what was picked -> its songs: a folder brings its own and its CD1/CD2 folders' */
  async function tagSongs(list) {
    const out = [];
    for (const x of list) { if (x.dir) out.push(...await musTracks(x.path)); else if (GAL_AUD.test(x.path)) out.push(x.path); }
    return [...new Set(out)];
  }
  /* the release's song for each of your files: in order when the counts match; otherwise by
   * title (the song's title tag, else its file name without the number), lengths breaking ties */
  function tgMatch(live, tracks) {
    const inOrder = live.map((r, i) => i < tracks.length ? i : -1);
    if (live.length === tracks.length) return inOrder;
    const words = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\.[a-z0-9]{2,5}$/, '')
      .replace(/^\s*(?:\d+\s*[-.]\s*)?\d+\s*[-._)\s]+/, '').replace(/\bremix(ed)?\b/g, 'mix').replace(/&/g, ' and ')
      .split(/[^\p{L}\p{N}]+/u).filter(w => w && !['the', 'a', 'an', 'version', 'feat', 'ft'].includes(w));
    const like = (a, b) => { if (!a.length || !b.length) return 0; const B = new Set(b); let k = 0; new Set(a).forEach(w => { if (B.has(w)) k++; }); return k / new Set([...a, ...b]).size; };
    const tw = tracks.map(t => words(t.title)), map = [], taken = new Set();
    let hits = 0;
    live.forEach(r => {
      const want = [words(r.cur && r.cur.title), words(base(r.path))].filter(w => w.length);
      let best = -1, bs = 0;
      tw.forEach((t, k) => {
        if (taken.has(k)) return;
        let sc = Math.max(0, ...want.map(w => like(w, t)));
        if (sc < .5) return;
        if (r.len && tracks[k].len && Math.abs(r.len - tracks[k].len) <= 3) sc += .3;
        if (sc > bs) { bs = sc; best = k; }
      });
      if (best >= 0) { taken.add(best); hits++; }
      map.push(best);
    });
    if (hits * 2 < live.length) return inOrder;
    map.byName = true;
    return map;
  }
  async function openTagEditor(list) {
    if (SET.practice) return toast('Practice mode is on, so changing tags is turned off. You can switch it off in Settings > Safety.', true);
    toast('Reading the tags…');
    let files;
    try { files = await tagSongs(list); } catch (e) { return toast(e.message, true); }
    if (!files.length) return toast('No songs there', true);
    if (files.length > 400) return toast(`That's ${files.length} songs - the tag editor takes up to 400 at a time (an album or two)`, true);
    const rows = [];
    try {
      for (let i = 0; i < files.length; i += 40) {
        const r = await api('tags_read', { paths: files.slice(i, i + 40) });
        for (const [path, x] of Object.entries(r.songs)) rows.push({ path, x });
      }
    } catch (e) { return toast(e.message, true); }
    rows.forEach(r => { const t = r.x.tags || {}; r.orig = {}; for (const k of Object.keys(TG_LABEL)) r.orig[k] = t[k] == null ? '' : String(t[k]); r.cur = Object.assign({}, r.orig); r.ro = r.x.ro || (r.x.later ? 'Not read in time - open this song on its own' : ''); r.len = 0; });
    rows.sort((a, b) => collator.compare(a.path, b.path));
    const dir = rows.length === 1 ? parent(rows[0].path) : rows.map(r => parent(r.path)).reduce((a, b) => { while (a !== b && !b.startsWith(a + '/')) a = parent(a); return a; });
    const rel = r => r.path.slice(dir.length + 1);
    const live = rows.filter(r => !r.ro);
    const kinds = [...new Set(rows.map(r => r.path.split('.').pop().toUpperCase()))].join(' · ');
    const folders = new Set(rows.map(r => parent(r.path))).size;
    let folderPic = '';
    try { const l = await api('list', { path: dir }); const pics = l.items.filter(([n, t]) => t !== 'd' && /\.(jpe?g|png)$/i.test(n)).map(([n]) => n);
      folderPic = pics.find(n => /^(cover|folder|front)\./i.test(n)) || pics.find(n => /cover|front|folder/i.test(n)) || ''; } catch (e) {}
    const embedded = rows.some(r => r.x.cover);
    const st = { cover: 'keep', saveJpg: false, mb: null, more: false, filled: '' };
    const showDisc = folders > 1 || rows.some(r => r.orig.disc);
    const mixed = k => new Set(live.map(r => r.cur[k])).size > 1;
    const common = k => live.length && !mixed(k) ? live[0].cur[k] : '';
    const wasTxt = v => v === '' ? '(empty)' : v;

    openDlg(`Edit tags · ${base(dir) || dir}`, `<div class="tg">
      <div class="tg-path">${rows.length} song${rows.length === 1 ? '' : 's'} · ${esc(kinds)} · ${esc(dir)}</div>
      <div class="tg-edit">
        <div class="tg-fill">
          <button type="button" class="tg-card main" data-t="mb"><span class="ic">${TG_ICON.find}</span><span class="tx"><b>Find this album online</b><span>Titles, artists, year, genre and the cover from MusicBrainz</span></span></button>
          <button type="button" class="tg-card" data-t="names"><span class="ic">${TG_ICON.names}</span><span class="tx"><b>Titles from the file names</b><span>"01 - Low Water.flac" becomes track 1, "Low Water"</span></span></button>
          <button type="button" class="tg-card" data-t="num"><span class="ic">${TG_ICON.num}</span><span class="tx"><b>Number the songs 1, 2, 3…</b><span>In the order of the files${folders > 1 ? ', per CD folder' : ''}</span></span></button>
        </div>
        <div class="tg-hint"><span class="tg-filled" hidden></span><span>Or type straight into any value. Nothing is saved until you press Save.</span></div>
        <div class="tg-album">
          <div class="tg-cov"><div class="tg-pic"></div><select class="tg-covsel" aria-label="Cover"></select><label class="chk tg-savejpg" hidden><input type="checkbox"> Also save it as cover.jpg</label></div>
          <div class="tg-afields">${TG_ALBUM.map(([k, l]) => `<label class="tg-af"><span>${l}</span><input type="text" data-a="${k}" spellcheck="false"><span class="tg-was"></span></label>`).join('')}</div>
        </div>
        <label class="chk tg-more"><input type="checkbox"> More fields (composer, comment)</label>
        <div class="tg-songs"><div class="tg-row tg-head"><span></span><span>Track</span>${showDisc ? '<span>Disc</span>' : ''}<span>Title · file</span><span>Artist</span><span class="tg-x">Composer</span><span class="tg-x">Comment</span><span class="r">Length</span></div><div class="tg-body"></div></div>
      </div>
      <div class="tg-find" hidden></div>
      <div class="tg-bar">
        <span class="tg-sum"></span><span class="tg-sumd muted"></span>
        <span class="tg-sp"></span>
        <button type="button" class="tg-link tg-reset" hidden>Undo all changes</button>
        <label class="chk tg-keep"><input type="checkbox"${SET.trash === false ? ' disabled' : ' checked'}> Keep the originals, so Undo works later</label>
        <button type="button" class="uc-btn tg-cancel">Cancel</button>
        <button type="button" class="uc-btn primary tg-save" disabled>Save</button>
      </div>
    </div>`, [], 'full tg-dlg');
    const D = dlg, edit = $('.tg-edit', D), findEl = $('.tg-find', D), bar = $('.tg-bar', D), bodyEl = $('.tg-body', D);
    D.classList.toggle('tg-disc', showDisc);
    $('.tg-keep', D).title = SET.trash === false ? 'The trash is switched off in Settings, so the originals are replaced for good' : "The originals take the album's size in the trash until it's emptied";

    /* ----- the songs ----- */
    const COLS = ['track', ...(showDisc ? ['disc'] : []), 'title', 'artist', 'composer', 'comment'];
    bodyEl.innerHTML = rows.map((r, i) => `<div class="tg-row${r.ro ? ' ro' : ''}" data-i="${i}"${r.ro ? ` title="${esc(r.ro)}"` : ''}><span class="tg-dot"></span>
      ${COLS.map(k => `<span class="tg-c${k === 'composer' || k === 'comment' ? ' tg-x' : ''}"><input type="text" data-k="${k}" value="${esc(r.cur[k])}"${r.ro ? ' disabled' : ''} spellcheck="false" aria-label="${TG_LABEL[k]}"><span class="tg-was"></span>${k === 'title' ? `<span class="tg-file">${esc(rel(r))}</span>` : ''}</span>`).join('')}
      <span class="tg-len r"></span></div>`).join('');
    const rowEl = i => bodyEl.children[i];
    function paintRow(i) {
      const r = rows[i], el = rowEl(i); let any = false;
      $$('input[data-k]', el).forEach(inp => {
        const k = inp.dataset.k, chg = r.cur[k] !== r.orig[k];
        if (document.activeElement !== inp && inp.value !== r.cur[k]) inp.value = r.cur[k];
        inp.classList.toggle('chg', chg); any = any || chg;
        const w = inp.nextElementSibling; w.textContent = chg ? wasTxt(r.orig[k]) : ''; w.classList.toggle('on', chg);
      });
      el.classList.toggle('chg', any || (st.cover !== 'keep' && !r.ro));
    }
    const paintSongs = () => rows.forEach((r, i) => paintRow(i));
    bodyEl.addEventListener('input', e => { const inp = e.target.closest('input[data-k]'); if (!inp) return; const i = +inp.closest('.tg-row').dataset.i; rows[i].cur[inp.dataset.k] = inp.value; paintRow(i); paintAlbum(); paintBar(); });

    /* ----- the album's fields ----- */
    function paintAlbum(all) {
      $$('[data-a]', D).forEach(inp => {
        const k = inp.dataset.a, chg = live.some(r => r.cur[k] !== r.orig[k]);
        if (all || document.activeElement !== inp) { inp.value = common(k); inp.placeholder = mixed(k) ? 'different in each song - type to set them all' : 'empty'; }
        inp.classList.toggle('chg', chg);
        const origs = new Set(live.map(r => r.orig[k])), w = inp.nextElementSibling;
        w.textContent = chg ? 'was: ' + (origs.size > 1 ? 'different in each song' : wasTxt([...origs][0] || '')) : ''; w.classList.toggle('on', chg);
      });
    }
    $$('[data-a]', D).forEach(inp => inp.addEventListener('input', () => {
      const k = inp.dataset.a;
      if (inp.value === '' && new Set(live.map(r => r.orig[k])).size > 1) live.forEach(r => { r.cur[k] = r.orig[k]; });   // emptied a mixed field: each song keeps its own
      else live.forEach(r => { r.cur[k] = inp.value; });
      paintSongs(); paintAlbum(); paintBar();
    }));

    /* ----- the cover ----- */
    const picEl = $('.tg-pic', D), sel = $('.tg-covsel', D), saveJ = $('.tg-savejpg', D);
    function paintCover() {
      const opts = [['keep', embedded ? 'Keep this cover' : 'No cover in the songs']];
      if (folderPic) opts.push(['folder', `Use ${folderPic}`]);
      if (st.mb && st.mb.cover) opts.push(['mb', 'Use the online cover']);
      if (embedded) opts.push(['none', 'Remove the cover']);
      if (!opts.some(o => o[0] === st.cover)) st.cover = 'keep';
      sel.innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === st.cover ? ' selected' : ''}>${esc(l)}</option>`).join('');
      const firstPic = rows.find(r => r.x.cover);
      const url = st.cover === 'mb' ? `${API}?action=mbcover&id=${st.mb.id}` : st.cover === 'folder' ? rawUrl(join(dir, folderPic))
        : st.cover === 'none' ? '' : firstPic ? `${API}?action=cover&path=${encodeURIComponent(firstPic.path)}` : '';
      picEl.innerHTML = (url ? `<img alt="" src="${esc(url)}">` : `<span class="tg-nopic">${GI.aud}<span>${st.cover === 'none' ? 'Taken out' : 'No cover'}</span></span>`) + (st.cover !== 'keep' ? '<span class="tg-new">NEW</span>' : '');
      picEl.classList.toggle('chg', st.cover !== 'keep');
      const canJpg = st.cover === 'mb' || (embedded && st.cover === 'keep' && !folderPic);
      saveJ.hidden = !canJpg; if (!canJpg) st.saveJpg = false;
      $('input', saveJ).checked = st.saveJpg;
      paintSongs(); paintBar();
    }
    sel.addEventListener('change', () => { st.cover = sel.value; paintCover(); });
    $('input', saveJ).addEventListener('change', e => { st.saveJpg = e.target.checked; paintBar(); });

    /* ----- the bar: what Save will do ----- */
    const changed = () => live.map(r => ({ r, d: Object.keys(TG_LABEL).filter(k => r.cur[k] !== r.orig[k]) }));
    function paintBar() {
      const ch = changed(), coverChg = st.cover !== 'keep';
      const nFields = ch.reduce((a, c) => a + c.d.length, 0), songs = ch.filter(c => c.d.length || coverChg).length;
      const what = new Set(); ch.forEach(c => c.d.forEach(k => what.add(TG_LABEL[k] + (['album', 'album artist', 'year', 'genre'].includes(TG_LABEL[k]) ? '' : 's'))));
      const sum = $('.tg-sum', D), save = $('.tg-save', D);
      if (!songs && !st.saveJpg) { sum.innerHTML = 'No changes yet'; sum.className = 'tg-sum'; $('.tg-sumd', D).textContent = ''; }
      else {
        sum.className = 'tg-sum on';
        sum.innerHTML = `<i></i>${nFields ? `${nFields} change${nFields === 1 ? '' : 's'} in ${songs} song${songs === 1 ? '' : 's'}` : coverChg ? `New cover for ${songs} song${songs === 1 ? '' : 's'}` : 'Save the cover'}`;
        $('.tg-sumd', D).textContent = [[...what].join(', '), coverChg ? (st.cover === 'none' ? 'cover taken out' : 'new cover') : '', st.saveJpg ? 'cover.jpg saved' : ''].filter(Boolean).join(' · ');
      }
      save.disabled = !songs && !st.saveJpg;
      save.textContent = songs ? `Save ${songs} song${songs === 1 ? '' : 's'}` : st.saveJpg ? 'Save cover.jpg' : 'Save';
      $('.tg-reset', D).hidden = save.disabled;
    }
    $('.tg-reset', D).addEventListener('click', () => { rows.forEach(r => { r.cur = Object.assign({}, r.orig); }); st.cover = 'keep'; st.saveJpg = false; st.filled = ''; $('.tg-filled', D).hidden = true; paintAlbum(true); paintCover(); });
    $('.tg-cancel', D).addEventListener('click', () => closeDlg());
    $('.tg-more input', D).addEventListener('change', e => D.classList.toggle('tg-moreon', e.target.checked));
    const filled = txt => { const f = $('.tg-filled', D); f.textContent = '✓ ' + txt; f.hidden = false; };

    /* ----- the three ways to fill in ----- */
    $('.tg-fill', D).addEventListener('click', e => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      if (b.dataset.t === 'mb') return findOpen();
      if (b.dataset.t === 'names') {
        live.forEach(r => {
          let s = base(r.path).replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim(), m;
          if ((m = s.match(/^(\d{1,2})[-.](\d{1,3})\s*[-.)]?\s+(.+)$/))) { if (showDisc) r.cur.disc = String(+m[1]); r.cur.track = String(+m[2]); s = m[3]; }
          else if ((m = s.match(/^(\d{1,3})\s*[-.)]?\s+(.+)$/)) || (m = s.match(/^(\d{1,3})\s*[-.]\s*(.+)$/))) { r.cur.track = String(+m[1]); s = m[2]; }
          const art = r.cur.album_artist || r.cur.artist;
          if (art && s.toLowerCase().startsWith(art.toLowerCase() + ' - ')) s = s.slice(art.length + 3);
          r.cur.title = s.replace(/^-\s*/, '').trim();
        });
        filled('Titles filled in from the file names - check them below');
      }
      if (b.dataset.t === 'num') {
        const per = new Map();
        live.forEach(r => { const d = parent(r.path), n = (per.get(d) || 0) + 1; per.set(d, n); r.cur.track = String(n); });
        filled('Songs numbered in file order');
      }
      paintSongs(); paintAlbum(); paintBar();
    });

    /* ----- song lengths (ffmpeg), for the list and for matching a release ----- */
    const lensReady = (async () => {
      const byDir = new Map(); rows.forEach(r => { const d = parent(r.path); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(r); });
      for (const [d, rs] of byDir) for (let i = 0; i < rs.length; i += 25) {
        try { const x = await api('durations', { path: d, names: rs.slice(i, i + 25).map(r => base(r.path)) }); if (x.ff === false) return ffWant();
          rs.slice(i, i + 25).forEach(r => { r.len = (x.durs || {})[base(r.path)] || 0; }); } catch (e) { return; }
        if (!D.isConnected) return;
        rows.forEach((r, k) => { if (r.len) $('.tg-len', rowEl(k)).textContent = fmtT(r.len); });
      }
    })();

    /* ----- Find this album online ----- */
    function findShow(on) { edit.hidden = on; bar.hidden = on; findEl.hidden = !on; }
    function findOpen() {
      findShow(true);
      if (findEl.dataset.ready) return;
      findEl.dataset.ready = '1';
      const art = common('album_artist') || common('artist') || (parent(dir) !== '/' ? base(parent(dir)) : '');
      const alb = common('album') || base(dir).replace(/\s*[([]\d{4}[)\]]\s*$/, '');
      findEl.innerHTML = `<div class="tg-fhead"><div class="tg-ftitle"><b>Find this album online</b><span class="muted">Pick the release that matches your files - same songs, same edition. Nothing changes until you save.</span></div><button type="button" class="uc-btn tg-fback">Back to the tags</button></div>
        <div class="tg-fmain">
          <div class="tg-fleft">
            <div class="tg-fq"><label class="tg-af"><span>Artist</span><input type="text" class="mb-art" value="${esc(art)}" spellcheck="false"></label><label class="tg-af"><span>Album</span><input type="text" class="mb-alb" value="${esc(alb)}" spellcheck="false"></label><button type="button" class="uc-btn primary mb-go">Search</button></div>
            <div class="tg-fcount"></div><div class="tg-fres"></div>
          </div>
          <div class="tg-fright"><div class="tg-fempty muted">Search, then pick a release on the left to see it next to your files.</div></div>
        </div>
        <div class="tg-fbar"><span class="muted">Fills in: album, album artist, year, genre, each song's title, artist and track number${showDisc ? ' and disc' : ''}, and the cover.</span><span class="tg-sp"></span><button type="button" class="uc-btn tg-fcancel">Cancel</button><button type="button" class="uc-btn primary tg-fuse" disabled>Use this release</button></div>`;
      $('.tg-fback', findEl).addEventListener('click', () => findShow(false));
      $('.tg-fcancel', findEl).addEventListener('click', () => findShow(false));
      $('.mb-go', findEl).addEventListener('click', search);
      $$('.tg-fq input', findEl).forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); search(); } }));
      $('.tg-fuse', findEl).addEventListener('click', useRelease);
      if (art || alb) search();
    }
    let picked = null;
    async function search() {
      const res = $('.tg-fres', findEl), cnt = $('.tg-fcount', findEl);
      res.innerHTML = ''; cnt.textContent = 'Searching MusicBrainz…';
      let r;
      try { r = await api('mb_search', { artist: $('.mb-art', findEl).value, album: $('.mb-alb', findEl).value }); } catch (e) { cnt.textContent = e.message; return; }
      const n = live.length;
      const list = r.releases.slice().sort((a, b) => ((b.tracks === n) - (a.tracks === n)) || (b.score - a.score));
      cnt.textContent = list.length ? `${list.length} release${list.length === 1 ? '' : 's'} found · best match first` : 'Nothing found - try fewer words, or only the album';
      res.innerHTML = list.map((x, i) => `<button type="button" class="tg-rel" data-i="${i}"><span class="tg-rpic"><img alt="" loading="lazy" src="https://coverartarchive.org/release/${esc(x.id)}/front-250"></span>
        <span class="tg-rtx"><b>${esc(x.title)}</b><span>${esc(x.artist)}</span><span class="muted">${esc([x.date ? x.date.slice(0, 4) : '', x.country, x.format].filter(Boolean).join(' · '))}</span></span>
        <span class="tg-chip${x.tracks === n ? ' ok' : ''}">${x.tracks} song${x.tracks === 1 ? '' : 's'}${x.tracks === n ? ' ✓' : ''}</span></button>`).join('');
      $$('.tg-rpic img', res).forEach(im => im.addEventListener('error', () => im.remove()));
      $$('.tg-rel', res).forEach(b => b.addEventListener('click', () => pick(list[+b.dataset.i].id, b)));
      if (list[0] && list[0].tracks === n) pick(list[0].id, $('.tg-rel', res));
    }
    async function pick(id, btn) {
      $$('.tg-rel', findEl).forEach(b => b.classList.toggle('on', b === btn));
      const right = $('.tg-fright', findEl), use = $('.tg-fuse', findEl);
      right.innerHTML = '<div class="tg-fempty muted">Getting that release…</div>'; use.disabled = true;
      let x; try { x = await api('mb_release', { id }); } catch (e) { right.innerHTML = `<div class="tg-fempty">${esc(e.message)}</div>`; return; }
      if (!btn.classList.contains('on')) return;
      await lensReady;
      const tracks = x.discs.flatMap(d => d.tracks.map(t => Object.assign({ disc: d.pos }, t)));
      const multi = x.discs.length > 1;
      /* which song is which: in order when the counts are the same; else by name (a 9-song
       * folder that is disc 2 of a 19-song edition finds its songs on disc 2) */
      const map = tgMatch(live, tracks);
      const lines = [], used = new Set(map.filter(k => k >= 0));
      const order = [...live.map((r, i) => [r, map[i] >= 0 ? tracks[map[i]] : null]), ...tracks.filter((t, k) => !used.has(k)).map(t => [null, t])];
      let ok = 0, off = 0;
      for (let i = 0; i < order.length; i++) {
        const [r, t] = order[i];
        let mark = '', cls = '';
        if (r && t && r.len && t.len) { if (Math.abs(r.len - t.len) <= 3) { mark = '✓'; cls = 'ok'; ok++; } else { mark = '≠'; cls = 'bad'; off++; } }
        else if (!r || !t) { mark = '–'; cls = 'bad'; }
        lines.push(`<div class="tg-crow"><span class="muted">${i + 1}</span><span class="tg-cf">${r ? esc(rel(r)) : '<i class="muted">no file</i>'}</span><span class="r muted">${r && r.len ? fmtT(r.len) : ''}</span><span class="tg-mk ${cls}">${mark}</span><span>${t ? (multi ? `<span class="muted">${t.disc}-</span>` : '') + esc(t.title) : '<i class="muted">nothing on this release</i>'}</span><span class="r muted">${t && t.len ? fmtT(t.len) : ''}</span></div>`);
      }
      const haveLens = live.some(r => r.len);
      const named = map.byName;
      const verdict = tracks.length !== live.length ? ['warn', `This release has ${tracks.length} songs and you have ${live.length} - ${named ? `matched by their names (${map.filter(k => k >= 0).length} found)` : 'matched in order'}, so check them`]
        : !haveLens ? ['', `${tracks.length} songs, same as yours (lengths can't be compared without ffmpeg)`]
        : off ? ['warn', `${off} song${off === 1 ? '' : 's'} differ in length - maybe another edition`] : ['ok', `All ${tracks.length} songs line up - lengths match`];
      right.innerHTML = `<div class="tg-rhead">${x.cover ? `<img alt="" src="${API}?action=mbcover&id=${x.id}">` : '<span class="tg-nopic">' + GI.aud + '</span>'}
          <div><b class="tg-rt">${esc(x.title)}</b><div>${esc(x.artist)}</div><div class="muted">${esc([x.date ? 'First released ' + x.date : '', 'this edition: ' + [x.format, x.country, x.edate].filter(Boolean).join(', '), x.genre].filter(Boolean).join(' · '))}</div>
          <div class="tg-verdict ${verdict[0]}">${verdict[0] === 'ok' ? '✓ ' : ''}${esc(verdict[1])}</div></div></div>
        <div class="tg-cmp"><div class="tg-crow tg-chead"><span>#</span><span>Your file</span><span class="r">Length</span><span></span><span>On this release</span><span class="r">Length</span></div>${lines.join('')}</div>`;
      picked = { x, tracks, multi, map }; use.disabled = false;
    }
    function useRelease() {
      if (!picked) return;
      const { x, tracks, multi, map } = picked;
      live.forEach((r, i) => {
        r.cur.album = x.title; r.cur.album_artist = x.artist; if (x.date) r.cur.date = x.date; if (x.genre) r.cur.genre = x.genre;
        const t = map[i] >= 0 ? tracks[map[i]] : null; if (!t) return;
        r.cur.title = t.title; r.cur.artist = t.artist || x.artist; r.cur.track = String(t.n);
        if (multi && showDisc) r.cur.disc = String(t.disc);
      });
      st.mb = x; if (x.cover) { st.cover = 'mb'; st.saveJpg = !folderPic; }
      filled('Filled in from MusicBrainz - check the green values, then Save');
      findShow(false); paintAlbum(true); paintCover();
    }

    /* ----- save ----- */
    $('.tg-save', D).addEventListener('click', async () => {
      const coverChg = st.cover !== 'keep';
      const todo = changed().filter(c => c.d.length || coverChg);
      const keep = $('.tg-keep input', D).checked;
      const btn = $('.tg-save', D); btn.disabled = true; $('.tg-cancel', D).disabled = true;
      const coverArg = st.cover === 'mb' ? 'mb:' + st.mb.id : st.cover === 'folder' ? join(dir, folderPic) : st.cover === 'none' ? 'none' : '';
      const label = `Changed the tags of ${todo.length} song${todo.length === 1 ? '' : 's'} in ${base(dir) || dir}`;
      let hist = null, ok = 0; const bad = [];
      if (playerStop) playerStop();         // a song that's playing can't be replaced cleanly
      for (const [i, { r, d }] of todo.entries()) {
        btn.textContent = `Saving ${i + 1} of ${todo.length}…`;
        const tags = {}; d.forEach(k => { tags[k] = r.cur[k]; });
        try {
          const x = await api('tags_write', Object.assign({ path: r.path, tags: JSON.stringify(tags), cover: coverArg, keep: keep ? '1' : '0', label }, hist ? { join: hist } : {}));
          hist = x.hist || hist; ok++;
        } catch (e) { bad.push(e.message); }
      }
      if (st.saveJpg) {
        try {
          const from = st.cover === 'mb' ? 'mb:' + st.mb.id : (rows.find(r => r.x.cover) || {}).path;
          const x = await api('cover_save', Object.assign({ dir, from, label }, hist ? { join: hist } : {}));
          hist = x.hist || hist;
        } catch (e) { bad.push(e.message); }
      }
      coverV++;
      closeDlg(); refreshBoth();
      if (bad.length) toast(`Saved ${ok} of ${todo.length}. ${bad.slice(0, 3).join(' · ')}`, true);
      else done(todo.length ? `Changed the tags of ${ok} song${ok === 1 ? '' : 's'}${st.saveJpg ? ' and saved cover.jpg' : ''}` : 'Saved cover.jpg', hist);
    });

    paintAlbum(true); paintCover();
  }
  /* "Use as the folder's cover" / "Save its cover as cover.jpg" */
  async function saveCover(from, dir) {
    if (SET.practice) return toast('Practice mode is on, so saving covers is turned off.', true);
    try { const x = await api('cover_save', { dir, from }); coverV++; refreshBoth(); done(`Saved ${x.name} in ${base(dir) || dir}`, x.hist); } catch (e) { toast(e.message, true); }
  }

  /* ---------- the playlist and the player ----------
   * One playlist at a time: it is what the player at the bottom plays and what
   * the editor at the side shows. "Play" (songs, albums, artists, a playlist
   * file) makes them the playlist; "Add to playlist" adds to its end. It's
   * "Untitled" until it's saved, kept on this device through reloads, and only
   * Clear empties it. Shuffle changes the order songs play in, never the list. */
  const PL_TARGETS = [
    ['navidrome', 'Navidrome', 'rel', 'Save it anywhere inside your music folder. Navidrome finds it on its next scan.'],
    ['jellyfin', 'Jellyfin / Emby', 'rel', "Save it inside the music library's folder. It shows up after the next library scan."],
    ['plex', 'Plex', 'map', 'unCommander saves it where Plex can read it, then hands it to Plex - it shows up under Playlists. Sending it again replaces it there.'],
    ['kodi', 'Kodi', 'net', "Save it in Kodi's playlists folder (userdata/playlists/music, shared on the network). It shows up in Kodi under Music › Playlists."],
    ['airsonic', 'Airsonic', 'map', "Save it in Airsonic's playlists folder. Airsonic reads it on its next scan."],
    ['usb', 'USB drive / phone', 'rel', 'Save it at the top of the drive, next to the artist folders, and copy those with it. The songs are written relative to the playlist, so it plays on any device.'],
    ['plain', 'unRAID paths', 'abs', 'Paths as they are on this server - for scripts, or players running on the server'],
    ['other', 'Music app or drive', 'other', 'A playlist file for a USB drive, or for a music app that reads playlist files.'],
    ['jf', 'Jellyfin / Emby', 'api', 'unCommander hands the playlist to Jellyfin or Emby - it shows up under Playlists for the person you pick. Sending it again replaces it there.'],
    ['app', 'Music app on this server', 'app', 'For a music app running in Docker on this server (Navidrome, Airsonic, MyMedia for Alexa…): the songs are written the way that app sees your music.'],
    ['pc', 'Computer on your network', 'pc', 'For a player on another computer (MusicBee, foobar2000, VLC, Windows Media Player…) that opens your music over the network.'],
    ['drive', 'USB drive, SD card or phone', 'drive', 'For a player that has the music on its own drive - a USB stick in the car, an SD card, a phone. The drive has to be plugged into this server (Unassigned Devices puts it under /mnt/disks).'],
  ];
  /* Send to… offers these; the others stay so copies sent with them earlier can still be updated */
  const PL_SEND = ['plex', 'jf', 'kodi', 'app', 'pc', 'drive'];
  /* how song lines are written: "Other app or drive" is relative to the playlist, or a path the app sees */
  const plKind = (tg, c) => tg === 'other' ? (c && (c.mode === 'app' || c.mode === 'path' || c.mode === 'map') ? 'map' : 'rel') : PL_T(tg)[2];
  const PL_TOKSAVED = '\u2063saved\u2063';     // stands in the token box for the saved token, which never comes back to the browser
  const plTok = () => { const e = $('.pl-ptok'); const v = e ? e.value.trim() : ''; return v === PL_TOKSAVED ? '' : v; };
  const PL_T = k => PL_TARGETS.find(x => x[0] === k) || PL_TARGETS[0];
  const PL_NEW = () => ({ name: 'Untitled', items: [], file: '', target: '', style: '', dirty: false, missing: [], i: 0, shuffle: false, loop: false, ord: null });
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let pl = Object.assign(PL_NEW(), store.get('pl', null) || {});
  if (!Array.isArray(pl.items)) pl.items = [];
  if (pl.name === 'New playlist') pl.name = 'Untitled';
  { const q = store.get('bpq', null); if (q && q.items && q.items.length && !pl.items.length) { pl.items = q.items; pl.i = q.i || 0; } if (q) store.set('bpq', null); }   // the player's queue (before beta 56)
  const plLens = new Map();
  const playerOn = () => SET.player !== false;
  const plPut = () => store.set('pl', Object.assign({}, pl, { items: pl.items.slice(0, 20000) }));
  const plStore = () => { plPut(); plUI(); };
  const plChanged = () => { pl.dirty = true; plStore(); };
  let plReady = false;
  function plUI() { if (!plReady) return; npSync(); bpCount(); }
  const songName = p => base(p).replace(/\.[^.]+$/, '').replace(/^\d{1,3}\s*[-._ ]\s*/, '');
  const plAlbumDir = p => { const d = parent(p); return /^(cd|dis[ck])\s*\d+$/i.test(base(d)) ? parent(d) : d; };   // CD1/CD2 folders count as their album

  /* a slow step (a big playlist, a whole collection): say so after a moment, until it's done */
  function plBusy(msg) {
    let shown = false;
    const t = setTimeout(() => { shown = true; toast(msg); clearTimeout(toastTimer); np.classList.add('busy'); root.classList.add('uc-plbusy'); }, 350);
    return () => { clearTimeout(t); if (shown) { const el = $('.uc-toast'); if (el && el.textContent === msg) el.hidden = true; np.classList.remove('busy'); root.classList.remove('uc-plbusy'); } };
  }
  /* the songs in these files and folders (and playlist files) */
  async function plSongs(paths) {
    if (paths.length > 1 && paths.every(x => GAL_AUD.test(x))) return paths.slice();
    let lists = paths.filter(x => /\.m3u8?$/i.test(x)), rest = paths.filter(x => !/\.m3u8?$/i.test(x));
    /* a playlist file's songs are only read when playlist files are all that's picked - picked with folders, it's skipped,
       so an old playlist lying in the music folder doesn't bring in songs from somewhere else */
    if (lists.length && rest.length) { const n = lists.length; setTimeout(() => toast(`Skipped ${n} playlist file${n === 1 ? '' : 's'} in what you picked - only the songs and folders were used`), 2800); lists = []; }
    const out = [], done = plBusy(`Collecting the songs${paths.length === 1 ? ' in ' + base(paths[0]) : ''}…`);
    try {
      if (rest.length) { try { const r = await api('pl_songs', { paths: rest }); out.push(...r.songs); if (r.more) setTimeout(() => toast(`Stopped at ${r.songs.length.toLocaleString()} songs - a playlist holds up to 20,000`, true), 2700); } catch (e) { done(); toast(e.message, true); return []; } }
      for (const f of lists) { try { out.push(...(await api('pl_read', { path: f })).items.filter(x => x.ok).map(x => x.path)); } catch (e) { done(); toast(e.message, true); } }
    } finally { done(); }
    if (!out.length) toast('No songs there', true);
    return out;
  }
  /* changes that weren't saved: ask before they're replaced */
  function plAsk(then, what = 'Replace it?') {
    if (!pl.dirty || !pl.items.length) return then();
    openDlg('Unsaved playlist', `<div>"${esc(pl.name)}" has ${pl.items.length} song${pl.items.length === 1 ? '' : 's'} and changes that aren't saved.</div><div class="muted">${esc(what)}</div>`,
      [{ label: 'Cancel' }, { label: 'Replace it', danger: true, run: () => { pl.dirty = false; then(); } },
       { label: 'Save first', primary: true, run: () => { closeDlg(); setTimeout(() => plSave(then)); return false; } }]);
  }
  /* Play: these become the playlist, and the player starts */
  async function plPlay(paths, from = 0, o = {}) {
    if (paths.length === 1 && /\.m3u8?$/i.test(paths[0])) return plOpenFile(paths[0], { play: true });
    const songs = await plSongs(paths); if (!songs.length) return;
    plAsk(() => {
      const keep = { shuffle: pl.shuffle, loop: pl.loop };
      pl = Object.assign(PL_NEW(), keep, { items: songs });
      if (o.shuffle) { pl.shuffle = true; from = Math.floor(Math.random() * songs.length); }
      pl.i = Math.max(0, Math.min(songs.length - 1, from));
      if (pl.shuffle) plShuffle(true);
      plStore(); plFillLens(); bpShow(true, false); bpGo(pl.i, true, o.at || 0);
    });
  }
  /* Add to playlist */
  async function plAdd(paths, at = -1) {
    const songs = await plSongs(paths); if (!songs.length) return;
    const have = new Set(pl.items), add = songs.filter(x => !have.has(x)), was = pl.items.length;
    if (at >= 0 && at < was) pl.items.splice(at, 0, ...add); else pl.items.push(...add);
    if (at >= 0 && at <= pl.i && was) pl.i += add.length;
    if (add.length) plChanged(); else plStore();
    sound.play('click');
    toast(`${add.length ? `Added ${add.length} song${add.length === 1 ? '' : 's'} to "${pl.name}"` : 'Those songs are already in the playlist'}${add.length < songs.length && add.length ? ` (${songs.length - add.length} already in it)` : ''} · ${pl.items.length} in all`);
    if (!was && add.length && playerOn()) { bpShow(true, false); bpGo(0, false); }
    plFillLens();
  }
  /* a playlist file becomes the playlist */
  async function plOpenFile(path, o = {}) {
    if (pl.file === path && !pl.dirty && pl.items.length) { if (o.play) { bpShow(true, false); bpGo(pl.i, true); } else plEditor(true); return; }
    let r;
    const done = plBusy(`Opening ${base(path)}…`);
    try { r = await api('pl_read', { path }); } catch (e) { done(); return toast(e.message, true); }
    done();
    plAsk(() => {
      const keep = { shuffle: pl.shuffle, loop: pl.loop };
      const mapped = r.style === 'abs' && r.items.some(x => x.ok && x.raw !== x.path);
      const why = {}; r.items.forEach(x => { if (!x.ok) why[x.path] = [x.why || 'gone', x.near || '', x.raw || '']; });
      pl = Object.assign(PL_NEW(), keep, { name: r.name, items: r.items.map(x => x.path), file: path, style: mapped ? 'mapped' : r.style, missing: r.items.filter(x => !x.ok).map(x => x.path), why });
      if (pl.shuffle) plShuffle(true);
      plRecent(path); plStore(); plFillLens();
      if (!pl.items.length) return toast(`${base(path)} has no songs in it`, true);
      bpShow(true, false); bpGo(pl.i, !!o.play);
      if (!o.play) plEditor(true);
      toast(`${r.name} · ${pl.items.length} song${pl.items.length === 1 ? '' : 's'}${pl.missing.length ? ` - ${pl.missing.length} not found (in red)` : ''}`, !!pl.missing.length);
    }, `Open ${base(path)} instead?`);
  }
  function plClear() {
    plAsk(() => {
      if (bpStop && playerStop === bpStop) playerStop();
      pl = Object.assign(PL_NEW(), { shuffle: pl.shuffle, loop: pl.loop });
      plStore(); bpLoaded = ''; bpGo(0, false);
      toast('The playlist is empty');
    }, 'Clear it without saving?');
  }
  /* recently opened or saved playlist files, and the ones in Settings > Music > Playlist folders */
  const plRecent = f => { if (!f) return; store.set('plrecent', [f, ...store.get('plrecent', []).filter(x => x !== f)].slice(0, 8)); plFilesAt = 0; };
  let plFilesC = [], plFilesAt = 0;
  async function plFiles() {
    if (Date.now() - plFilesAt < 20000) return plFilesC;
    const groups = [];
    for (const d of (SET.pldirs || []).slice(0, 10)) {
      try { const r = await api('list', { path: d }); const fs = r.items.filter(([n, t]) => t !== 'd' && /\.m3u8?$/i.test(n)).map(([n]) => join(d, n)).sort((a, b) => collator.compare(base(a), base(b)));
        if (fs.length) groups.push([base(d) || d, fs]); } catch (e) {}
    }
    const listed = new Set(groups.flatMap(g => g[1])), rec = store.get('plrecent', []).filter(f => !listed.has(f));
    if (rec.length) groups.push(['Recently opened', rec]);
    plFilesC = groups; plFilesAt = Date.now();
    return groups;
  }
  const plFileOpts = groups => groups.map(([g, fs]) => `<optgroup label="${esc(g)}">${fs.map(f => `<option value="${esc(f)}"${f === pl.file ? ' selected' : ''}>${esc(base(f).replace(/\.m3u8?$/i, ''))}${g === 'Recently opened' ? ` - ${esc(base(parent(f)))}` : ''}</option>`).join('')}</optgroup>`).join('');
  async function plFillSelect(sel, first) {
    const g = await plFiles();
    sel.innerHTML = `<option value="">${esc(first)}</option>${plFileOpts(g)}<option value="*browse">Browse…</option>${g.length ? '<option value="*delete">Delete playlists…</option>' : ''}${g.some(x => x[0] === 'Recently opened') ? '<option value="*clearrec">Clear the recently opened list</option>' : ''}`;
    sel.value = '';
  }

  /* shuffle and loop */
  const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function plShuffle(on) {
    pl.shuffle = on;
    const cur = pl.items[pl.i];
    pl.ord = on ? [cur, ...shuf(pl.items.filter(x => x !== cur))] : null;
    plPut();
  }
  function plOrder() {
    if (!pl.shuffle) return pl.items;
    const have = new Set(pl.items), o = (pl.ord || []).filter(x => have.has(x)), inO = new Set(o);
    pl.ord = o.concat(shuf(pl.items.filter(x => !inO.has(x))));
    return pl.ord;
  }
  /* the song after (d = 1) or before (d = -1) the current one; -1 at the end */
  function plStep(d) {
    const o = plOrder(); if (!o.length) return -1;
    let n = o.indexOf(pl.items[pl.i]) + d;
    if (n >= o.length) { if (!pl.loop) return -1; n = 0; }
    if (n < 0) n = pl.loop ? o.length - 1 : 0;
    return pl.items.indexOf(o[n]);
  }

  /* song lengths, with ffmpeg */
  let plLensBusy = false;
  /* song lengths: the first 1500 songs, then whatever the list shows as you scroll (an
   * album's line shows its total once its songs' lengths are known) */
  let plLensWant = [], plLensT = 0, plLensNoFf = false;
  /* song lengths, a few dozen at a time: the songs on screen first, then the rest of the list */
  async function plFillLens(more) {
    if (more) { plLensWant.push(...more); clearTimeout(plLensT); plLensT = setTimeout(() => plFillLens(), 150); return; }
    if (plLensBusy || plLensNoFf) return; plLensBusy = true;
    const bg = pl.items.slice(0, 3000).filter(p => !plLens.has(p));
    try {
      for (let guard = 0; guard < 3000; guard++) {
        const src = plLensWant.length ? plLensWant : bg;
        let d = null; const names = [];
        while (src.length && names.length < 30) {
          const p = src[0];
          if (plLens.has(p)) { src.shift(); continue; }
          const pd = parent(p); if (d === null) d = pd; if (pd !== d) break;
          src.shift(); if (!names.includes(base(p))) names.push(base(p));
        }
        if (!names.length) { if (!plLensWant.length && !bg.length) break; continue; }
        try { const x = await api('durations', { path: d, names }); if (x.ff === false) { plLensNoFf = true; return ffWant(); } for (const [k, v] of Object.entries(x.durs || {})) plLens.set(join(d, k), v); } catch (e) {}
        names.forEach(n => { if (!plLens.has(join(d, n))) plLens.set(join(d, n), 0); });
        $$('.pl-row[data-p]', root).forEach(r => { const v = plLens.get(r.dataset.p); const el = $('.pl-dur', r); if (v && el) el.textContent = fmtT(v); });
        plInfoAll(); npSubs();
      }
    } finally { plLensBusy = false; }
  }
  const plTime = () => { let t = 0, k = 0; pl.items.forEach(p => { const v = plLens.get(p); if (v) { t += v; k++; } }); return k ? (t >= 3600 ? Math.floor(t / 3600) + ' h ' + Math.round(t % 3600 / 60) + ' min' : t < 60 ? Math.round(t) + ' s' : Math.round(t / 60) + ' min') + (k < pl.items.length ? '+' : '') : ''; };
  const plInfoText = () => [`${pl.items.length} song${pl.items.length === 1 ? '' : 's'}`, plTime()].filter(Boolean).join(' · ');
  function plInfoAll() { $$('.pl-info', root).forEach(el => { el.textContent = plInfoText(); }); }
  function relPath(fromDir, file) {
    const a = fromDir.split('/').filter(Boolean), b = file.split('/').filter(Boolean);
    let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
  }
  const commonDir = paths => paths.length ? paths.map(parent).reduce((a, b) => { while (a !== b && !b.startsWith(a === '/' ? '/' : a + '/')) a = parent(a); return a; }) : '/mnt/user';

  /* ----- picking a folder (or a playlist file) without typing its path ----- */
  function folderBrowser(box, start, o = {}) {
    let cur = start || '/mnt/user';
    async function go(d) {
      let r;
      try { r = await api('list', { path: d }); } catch (e) { if (d !== '/mnt/user') return go('/mnt/user'); box.innerHTML = `<div class="fb-err">${esc(e.message)}</div>`; return; }
      cur = d; if (o.onDir) o.onDir(d);
      const dirs = r.items.filter(([n, t]) => t === 'd').map(([n]) => n).sort((a, b) => collator.compare(a, b));
      const files = o.files ? r.items.filter(([n, t]) => t !== 'd' && o.files.test(n)).map(([n]) => n).sort((a, b) => collator.compare(a, b)) : [];
      const segs = d.split('/').filter(Boolean);
      box.innerHTML = `<div class="fb-path">${segs.map((s, i) => `<button type="button" data-fb="${esc('/' + segs.slice(0, i + 1).join('/'))}">${esc(s)}</button>`).join('<i>/</i>')}<span class="fb-sp"></span><button type="button" class="fb-new" title="Make a new folder in here">+ New folder</button></div>
        <div class="fb-jump">${[...(SET.pldirs || []), '/mnt/user', '/mnt/remotes', '/mnt/disks'].filter((x, i, a) => a.indexOf(x) === i).map(x => `<button type="button" data-fb="${esc(x)}" title="${esc(x)}">${esc(x === '/mnt/remotes' ? 'Remote shares (/mnt/remotes)' : x === '/mnt/disks' ? 'Unassigned disks (/mnt/disks)' : x === '/mnt/user' ? 'User shares' : base(x))}</button>`).join('')}</div>
        <div class="fb-mk" hidden><input type="text" class="fb-mkn" placeholder="Name of the new folder" spellcheck="false"><button type="button" class="uc-btn primary fb-mkgo">Create</button><button type="button" class="uc-btn fb-mkx">Cancel</button></div>
        <div class="fb-list">${d.split('/').filter(Boolean).length > 1 ? `<button type="button" class="fb-row fb-up" data-fb="${esc(parent(d))}">🠉 ..</button>` : ''}${dirs.map(n => `<button type="button" class="fb-row" data-fb="${esc(join(d, n))}"><span class="fb-ic">${GI.dir}</span>${esc(n)}</button>`).join('')}${files.map(n => `<button type="button" class="fb-row fb-file" data-fbf="${esc(join(d, n))}"><span class="fb-ic">${GI.aud}</span>${esc(n)}</button>`).join('')}${!dirs.length && !files.length ? '<div class="muted fb-none">Nothing in here</div>' : ''}</div>`;
    }
    async function mk() {
      const inp = $('.fb-mkn', box), name = inp.value.trim();
      if (!name) return inp.focus();
      try { await api('mkdir', { path: cur, name }); go(join(cur, name)); } catch (e) { toast(e.message, true); }
    }
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-fb]'), f = e.target.closest('[data-fbf]');
      if (e.target.closest('.fb-new')) { const m = $('.fb-mk', box); m.hidden = false; $('.fb-mkn', box).focus(); return; }
      if (e.target.closest('.fb-mkx')) { $('.fb-mk', box).hidden = true; return; }
      if (e.target.closest('.fb-mkgo')) return mk();
      if (b) go(b.dataset.fb); if (f && o.onFile) o.onFile(f.dataset.fbf);
    });
    box.addEventListener('keydown', e => { if (!e.target.closest('.fb-mkn')) return; e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); mk(); } if (e.key === 'Escape') { e.preventDefault(); $('.fb-mk', box).hidden = true; } });
    box.addEventListener('dblclick', e => { const f = e.target.closest('[data-fbf]'); if (f && o.onPick) o.onPick(f.dataset.fbf); });
    go(cur);
    return { go, get dir() { return cur; } };
  }
  function plBrowse() {
    const start = (SET.pldirs || [])[0] || (pl.file ? parent(pl.file) : A().mode === 'dir' ? A().path : '/mnt/user');
    let pick = '';
    openDlg('Open a playlist', `<div class="fb-box"></div><div class="muted fb-note">Pick a .m3u or .m3u8 file - double-click opens it.</div>`,
      [{ label: 'Cancel' }, { label: 'Open', primary: true, run: () => { if (!pick) { toast('Pick a playlist file first', true); return false; } closeDlg(); plOpenFile(pick); return false; } }], 'fb-dlg');
    const D = dlg;
    folderBrowser($('.fb-box', D), start, { files: /\.m3u8?$/i, onFile: f => { pick = f; $$('.fb-file', D).forEach(b => b.classList.toggle('on', b.dataset.fbf === f)); }, onPick: f => { closeDlg(); plOpenFile(f); } });
  }

  /* ----- saving ----- */
  const plLineFor = (p, c, kind) => {
    if (kind === 'rel') return relPath(c.dir, p);
    if (kind === 'abs') return p;
    const from = (c.from || '').replace(/\/+$/, ''), to = (c.to || '').replace(/\/+$/, '');
    if (!from || !(p === from || p.startsWith(from + '/'))) return null;
    return to + p.slice(from.length);
  };
  /* Save: straight to its file, written the way it was; Save as when that isn't known */
  async function plSave(after) {
    if (!pl.items.length) return toast('The playlist is empty - nothing to save', true);
    if (SET.practice) return toast('Practice mode is on, so saving playlists is turned off.', true);
    const kind = pl.target ? PL_T(pl.target)[2] : pl.style === 'rel' || pl.style === 'abs' ? pl.style : '';
    if (!pl.file || !kind) return plSaveAs(after);
    const c = { dir: parent(pl.file), from: '', to: '' };
    if (kind === 'map' || kind === 'net') {
      try { const t = (await api('pl_prefs', {})).prefs.targets[pl.target] || {}; c.from = t.from; c.to = t.to; } catch (e) { return toast(e.message, true); }
    }
    const lines = pl.items.map(p => plLineFor(p, c, kind));
    if (lines.some(l => l === null)) return plSaveAs(after);
    try {
      const x = await api('pl_write', { path: pl.file, text: '#EXTM3U\n' + lines.join('\n') + '\n', replace: '1' });
      let extra = '';
      if (pl.target === 'plex') { try { const r = await api('plex_send', { path: plLineFor(pl.file, c, 'map') || pl.file, file: pl.file, poster: '' }); extra = ` and ${r.replaced ? 'replaced in' : 'handed to'} Plex (${r.library})${r.poster === true ? ', with its poster' : ''}`; } catch (e) { extra = `, but Plex didn't take it: ${e.message}`; } }
      pl.dirty = false; plRecent(pl.file); plStore(); refreshBoth();
      let copies = []; try { copies = ((await api('pl_prefs', {})).prefs.sends || {})[pl.file] || []; } catch (e) {}
      if (copies.length) toast(`Saved ${base(pl.file)}${extra}`, false, x.hist, false, [`Update its ${copies.length === 1 ? 'copy' : copies.length + ' copies'}`, () => plResend(copies)]);
      else done(`Saved ${base(pl.file)}${extra}`, x.hist);
      if (after) after();
    } catch (e) { toast(e.message, true); }
  }
  const plAgo = t => { const m = Math.round((Date.now() / 1000 - (t || 0)) / 60); return !t ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const xmlEsc = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  /* ----- Send to… -----
   * A copy of the playlist for where it will be played. Every song line is a beginning plus the
   * song's path inside your music folder (the folder with the artist folders); each destination
   * only decides the beginning. Plex and Jellyfin/Emby are handed the playlist through their API. */
  const MUSIC_APP_RE = /navidrome|airsonic|subsonic|mymedia|alexa|ampache|gonic|koel|mstream|funkwhale|polaris|lms|logitech|squeeze|owntone|daapd|mopidy|volumio|swingmusic|lyrion|beets|music/i;
  /* the folder that holds the artist folders, for these songs */
  function plLibOf(songs) {
    const roots = [store.get('musroot', ''), store.get('mcroot', ''), ...(mus ? [mus.root] : []), ...[...musProbe].filter(([, v]) => v === true).map(([k]) => k)].filter(Boolean);
    const r = roots.sort((a, b) => b.length - a.length).find(x => songs.slice(0, 50).every(p => p.startsWith(x + '/')));
    return r || commonDir(songs.slice(0, 3000));
  }
  /* one song's line for the newer destinations (null: not inside the music folder) */
  function plLineNew(tg, c, p) {
    const lib = (c.lib || '').replace(/\/+$/, '');
    if (!lib || !p.startsWith(lib + '/')) return null;
    const rel = p.slice(lib.length + 1);
    if (tg === 'app') return (c.to || '').replace(/\/+$/, '') + '/' + rel;
    if (tg === 'pc') { const b = (c.to || '').replace(/[\\/]+$/, ''); return c.win ? b + '\\' + rel.replace(/\//g, '\\') : b + '/' + rel; }
    if (tg === 'drive') {
      const ups = (c.pdir || '').split('/').filter(Boolean).length;
      return '../'.repeat(ups) + (c.mdir ? c.mdir.replace(/^\/+|\/+$/g, '') + '/' : '') + rel;
    }
    return null;
  }
  const PL_NEWT = ['app', 'pc', 'drive'];
  const plFileOf = (c, name) => join(c.tg === 'drive' && c.pdir ? join(c.dir, c.pdir.replace(/^\/+|\/+$/g, '')) : c.dir, `${name}.${c.fmt === 'xsp' ? 'xsp' : c.ext || 'm3u8'}`);
  /* the text of a copy: an .m3u, or for Kodi a smart playlist (.xsp) - the albums' or artists' folders as Kodi sees them */
  function plCopyText(tg, c, name) {
    const kind = plKind(tg, c);
    if (tg === 'kodi' && c.fmt === 'xsp') {
      const key = plKeyer(), dirs = [];
      for (const p of pl.items) { const k = key(p); const d = c.by === 'artist' ? (k && k.ar) || parent(plAlbumDir(p)) : (k && k.al) || plAlbumDir(p); if (!dirs.includes(d)) dirs.push(d); }
      let bad = 0; const vals = [];
      for (const d of dirs) { const l = plLineFor(d, c, kind); if (l === null) bad++; else vals.push(l.replace(/\/*$/, '/')); }
      const text = ['<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>', '<smartplaylist type="songs">', `    <name>${xmlEsc(name)}</name>`, '    <match>one</match>',
        '    <rule field="path" operator="startswith">', ...vals.map(v => `        <value>${xmlEsc(v)}</value>`), '    </rule>',
        ...(c.limit && c.order !== 'artist' ? [`    <limit>${c.limit}</limit>`] : []), `    <order direction="ascending">${c.order === 'artist' ? 'artist' : 'random'}</order>`, '</smartplaylist>', ''].join('\n');
      return { text, bad: bad ? pl.items.filter(p => plLineFor(p, c, kind) === null).length : 0 };
    }
    const lines = PL_NEWT.includes(tg) ? pl.items.map(p => plLineNew(tg, c, p)) : pl.items.map(p => plLineFor(p, c, kind));
    const nl = c.win && tg === 'pc' ? '\r\n' : '\n';      // Windows players get Windows line ends too
    return { text: '#EXTM3U' + nl + lines.join(nl) + nl, bad: lines.filter(l => l === null).length };
  }
  /* send one copy: write the file (and hand it to Plex), or give it to Jellyfin/Emby; for a drive, copy the songs too */
  async function plSendOne(e, replace) {
    const c = Object.assign({}, e, { dir: e.tg === 'drive' ? e.drive || parent(e.dest) : parent(e.dest) });
    if (e.tg === 'jf') {
      const paths = pl.items.map(p => plLineFor(p, c, 'map'));
      if (paths.some(x => x === null)) throw new Error(`Some songs aren't under "${e.from}"`);
      const r = await api('jf_send', { name: e.name, paths });
      return { hist: null, extra: ` to Jellyfin/Emby - ${r.songs} song${r.songs === 1 ? '' : 's'}${r.missing ? `, ${r.missing} not in its library` : ''}${r.replaced ? ' (replaced the old one)' : ''}`, err: '' };
    }
    const out = plCopyText(e.tg, c, base(e.dest).replace(/\.(m3u8?|xsp)$/i, ''));
    if (out.bad) throw new Error(`${out.bad} song${out.bad === 1 ? ' isn\'t' : 's aren\'t'} in "${e.lib || e.from}"`);
    if (e.tg === 'drive' && e.pdir) { try { await api('mkdir', { path: c.dir, name: e.pdir.replace(/^\/+|\/+$/g, '') }); } catch (er) { if (!/exists|already/i.test(er.message)) throw er; } }
    const x = await api('pl_write', { path: e.dest, text: out.text, replace: replace ? '1' : '0' });
    let extra = '', err = '';
    if (e.tg === 'plex' && e.psend) {
      try { const r = await api('plex_send', { path: plLineFor(e.dest, c, 'map') || e.dest, file: e.dest, poster: e.poster || '' });
        extra = ` and ${r.replaced ? 'replaced in' : 'handed to'} Plex (${r.library})${r.poster === true ? ', with its poster' : ''}`; if (typeof r.poster === 'string') err = 'the poster: ' + r.poster; }
      catch (er) { err = er.message; }
    }
    /* the songs onto the drive, in Artist/Album folders (a copy job; songs already there are skipped) */
    if (e.tg === 'drive' && e.copy) {
      const lib = e.lib.replace(/\/+$/, ''), rels = [...new Set(pl.items.filter(p => p.startsWith(lib + '/')).map(p => p.slice(lib.length + 1)))];
      const dest = e.mdir ? join(c.dir, e.mdir.replace(/^\/+|\/+$/g, '')) : c.dir;
      if (e.mdir) { try { await api('mkdir', { path: c.dir, name: e.mdir.replace(/^\/+|\/+$/g, '') }); } catch (er) {} }
      try { await api('job_start', { type: 'sync', root: lib, dest, rel: rels, overwrite: 0 }); pollJobs('start'); extra += ` - copying ${rels.length} song${rels.length === 1 ? '' : 's'} to the drive (see the job at the top)`; }
      catch (er) { err = 'copying the songs: ' + er.message; }
    }
    return { hist: x.hist, extra, err };
  }
  /* bring every copy of the playlist up to date */
  async function plResend(list) {
    if (!list || !list.length) return;
    const done1 = plBusy(`Updating ${list.length} cop${list.length === 1 ? 'y' : 'ies'}…`);
    const ok = [], bad = [];
    for (const e of list) { try { const r = await plSendOne(Object.assign({}, e, { copy: false }), true); (r.err ? bad : ok).push(r.err ? `${PL_T(e.tg)[1]}: ${r.err}` : PL_T(e.tg)[1]); } catch (er) { bad.push(`${PL_T(e.tg)[1]}: ${er.message}`); } }
    done1(); refreshBoth();
    if (bad.length) toast(`Updated ${ok.length} of ${list.length} - ${bad[0]}`, true);
    else toast(`Updated the cop${ok.length === 1 ? 'y' : 'ies'} for ${[...new Set(ok)].join(', ')}`);
  }
  /* Save as: the playlist itself - a name and a folder; songs written as they are on this server.
   * (A copy for an app is Send to….) */
  async function plSaveAs(after) {
    if (!pl.items.length) return toast('The playlist is empty - nothing to save', true);
    if (SET.practice) return toast('Practice mode is on, so saving playlists is turned off.', true);
    const pdirs = (SET.pldirs || []).filter(Boolean);
    const start = pl.file && pl.target === 'plain' ? parent(pl.file) : pdirs[0] || (pl.file ? parent(pl.file) : A().mode === 'dir' ? A().path : '/mnt/user');
    const fn0 = pl.file ? base(pl.file).replace(/\.(m3u8?|xsp)$/i, '') : pl.name === 'Untitled' ? '' : pl.name;
    openDlg('Save the playlist as', `
      <div class="field"><label>Name</label><input type="text" class="ps-fn" value="${esc(fn0)}" spellcheck="false" placeholder="Name of the playlist"></div>
      <div class="field"><label>In this folder</label><span class="pl-inrow"><input type="text" class="ps-dir" value="${esc(start)}" spellcheck="false">${pdirs.length > 1 ? `<select class="ps-dirs"><option value="">Playlist folders…</option>${pdirs.map(d => `<option value="${esc(d)}">${esc(base(d))}</option>`).join('')}</select>` : ''}<button type="button" class="uc-btn ps-brw">Browse…</button></span></div>
      <div class="fb-box pl-fb ps-fb" hidden></div>
      <div class="muted ps-note">Saved as <b>.m3u8</b> with the songs' paths on this server - this is the playlist unCommander opens. For Plex, Kodi, a phone or a USB drive, use <b>Send to…</b>: it writes a copy the way that app reads it, and remembers it so the copies can be updated in one go.</div>
      <div class="pl-warn ps-warn"></div>`,
      [{ label: 'Cancel' }, { label: 'Save', primary: true, run: async () => {
        const d = $('.ps-dir', dlg).value.trim().replace(/\/+$/, '') || '/', n = $('.ps-fn', dlg).value.trim().replace(/[\/\\]/g, '-');
        if (!n) { toast('Give it a name', true); return false; }
        const dest = join(d, n + '.m3u8'), b = $$('.dlg-foot .uc-btn', dlg)[1], replace = b.dataset.confirm === dest || dest === pl.file;
        try {
          const x = await api('pl_write', { path: dest, text: '#EXTM3U\n' + pl.items.join('\n') + '\n', replace: replace ? '1' : '0' });
          Object.assign(pl, { file: dest, name: n, target: 'plain', style: 'abs', dirty: false, missing: [] });
          plRecent(dest); plStore(); refreshBoth();
          done(`Saved ${base(dest)}`, x.hist);
          if (after) setTimeout(after);
        } catch (e) {
          if (/already there/.test(e.message)) { b.dataset.confirm = dest; b.textContent = 'Replace it'; $('.ps-warn', dlg).textContent = `${base(dest)} is already there - press Replace it to overwrite it (the old one goes to the trash)`; return false; }
          toast(e.message, true); return false;
        }
      } }], 'ps-dlg');
    const D = dlg; let brw = null;
    $('.ps-brw', D).addEventListener('click', () => { const fb = $('.ps-fb', D); fb.hidden = !fb.hidden; if (!fb.hidden && !brw) brw = folderBrowser(fb, $('.ps-dir', D).value.trim() || '/mnt/user', { files: /\.m3u8?$/i, onDir: d => { $('.ps-dir', D).value = d; }, onFile: f => { $('.ps-fn', D).value = base(f).replace(/\.m3u8?$/i, ''); } }); });
    const sel = $('.ps-dirs', D); if (sel) sel.addEventListener('change', () => { if (sel.value) { $('.ps-dir', D).value = sel.value; if (brw) brw.go(sel.value); } sel.value = ''; });
  }
  /* Send to…: a copy of the playlist for where it will be played. The playlist itself stays as it
   * is; where it was sent is remembered with it, so its copies can be brought up to date in one go. */
  async function plSendTo() {
    if (!pl.items.length) return toast('The playlist is empty - nothing to send', true);
    if (SET.practice) return toast('Practice mode is on, so saving playlists is turned off.', true);
    let pr;
    try { pr = await api('pl_prefs', {}); } catch (e) { return toast(e.message, true); }
    let prefs = pr.prefs; const songs = pl.items, lib0 = plLibOf(songs);
    const SEND = PL_SEND.map(k => PL_T(k));
    const toSend = k => PL_SEND.includes(k) ? k : k === 'navidrome' || k === 'airsonic' ? 'app' : k === 'usb' ? 'drive' : k === 'jellyfin' ? 'jf' : '';
    let tg = toSend(pl.target) || toSend(prefs.last) || 'plex';
    const sent = () => ((prefs.sends || {})[pl.file] || []);
    const holds = m => songs[0] && (songs[0] === m.host || songs[0].startsWith(m.host + '/'));
    const mapFor = re => pr.maps.filter(m => re.test(m.app + ' ' + (m.image || '')) && holds(m)).sort((a, b) => b.host.length - a.host.length)[0];
    /* the music apps in Docker that can see these songs: one entry each, with the folder pair that holds them */
    const apps = (() => {
      const by = new Map();
      for (const m of pr.maps) {
        if (/plex|jellyfin|emby|kodi/i.test(m.app + ' ' + (m.image || '')) || !MUSIC_APP_RE.test(m.app + ' ' + (m.image || '')) || !holds(m)) continue;
        const o = by.get(m.app); if (!o || m.host.length > o.host.length) by.set(m.app, m);
      }
      return [...by.values()].map(m => {
        const pls = pr.maps.find(x => x.app === m.app && /playlist/i.test(x.container));
        return { app: m.app, host: m.host, container: m.container, pls: pls ? pls.host : '' };
      }).sort((a, b) => a.app.localeCompare(b.app, undefined, { sensitivity: 'base' }));
    })();
    const shareOf = p => { const m = p.match(/^\/mnt\/user\/([^/]+)(\/.*)?$/); return m ? `\\\\${pr.host}\\${m[1]}${(m[2] || '').replace(/\//g, '\\')}` : ''; };
    const defaults = k => {
      const saved = prefs.targets[k] || {}, kind = PL_T(k)[2];
      const c = { tg: k, fmt: 'm3u', order: 'random', by: 'album', limit: 1000, ext: 'm3u8', lib: saved.lib || lib0 };
      c.dir = saved.dir || (pl.file && pl.target === k ? parent(pl.file) : '') || lib0;
      if (k === 'plex') { const m = mapFor(/plex/i); Object.assign(c, { from: saved.from || (m ? m.host : lib0), to: saved.to || (m ? m.container : ''), ext: saved.ext && saved.ext !== 'xsp' ? saved.ext : 'm3u' }); }
      if (k === 'jf') { const m = mapFor(/jellyfin|emby/i); Object.assign(c, { from: saved.from || (m ? m.host : lib0), to: saved.to || (m ? m.container : '') }); }
      if (k === 'kodi') Object.assign(c, { from: saved.from || '/mnt/user/', to: saved.to || `smb://${pr.host}/`, fmt: saved.fmt === 'xsp' ? 'xsp' : 'm3u', order: saved.order === 'artist' ? 'artist' : 'random', by: saved.by || 'album', limit: saved.limit || 1000, ext: saved.fmt === 'xsp' ? 'xsp' : saved.ext && saved.ext !== 'xsp' ? saved.ext : 'm3u8' });
      if (k === 'app') { const a = apps.find(x => x.app === saved.app) || null; Object.assign(c, { app: a ? a.app : '', to: a ? a.container + (c.lib.startsWith(a.host + '/') ? c.lib.slice(a.host.length) : '') : '', dir: saved.dir || (a && a.pls) || c.dir }); }
      if (k === 'pc') Object.assign(c, { to: saved.to || shareOf(c.lib), win: saved.win !== false });
      if (k === 'drive') Object.assign(c, { dir: saved.dir || '/mnt/disks', mdir: saved.mdir || '', pdir: saved.pdir || '', copy: !!saved.copy });
      if (kind === 'net' && !c.to) c.to = `smb://${pr.host}/`;
      return c;
    };
    let cur = defaults(tg), fname = pl.file ? base(pl.file).replace(/\.(m3u8?|xsp)$/i, '') : pl.name === 'Untitled' ? '' : pl.name;
    openDlg('Send the playlist to…', `<div class="pl-save"></div>`, [], 'pl-dlg pl-send');
    const D = dlg, sv = $('.pl-save', D);
    const field = (label, cls, val, ph = '', wide = false, more = '') => `<label class="tg-af${wide ? ' pl-wide' : ''}"><span>${label}</span><input type="text" class="${cls}" value="${esc(val || '')}" spellcheck="false" placeholder="${esc(ph)}">${more}</label>`;
    function paint() {
      const t = PL_T(tg), was = sent(), big = tg === 'kodi' && cur.fmt !== 'xsp' && pl.items.length > 2000;
      const folder = (label = 'Save it in', hint = '') => `<div class="tg-af pl-wide"><span>${label}</span><span class="pl-inrow"><input type="text" class="pl-dir" value="${esc(cur.dir)}" spellcheck="false"><button type="button" class="uc-btn pl-brw" title="Pick the folder by clicking through">Browse…</button></span>${hint ? `<span class="muted pl-fh">${hint}</span>` : ''}<div class="fb-box pl-fb" hidden></div></div>`;
      const name = (withExt = true) => `<label class="tg-af"><span>Name</span><span class="pl-inrow"><input type="text" class="pl-fn" value="${esc(fname)}" spellcheck="false" placeholder="Name of the playlist">${withExt ? `<span class="pl-extl">.${esc(cur.fmt === 'xsp' ? 'xsp' : cur.ext)}</span>` : ''}</span></label>`;
      const ftype = () => cur.fmt !== 'xsp' ? `<label class="tg-af"><span>File type</span><select class="pl-ext"><option${cur.ext === 'm3u8' ? ' selected' : ''}>m3u8</option><option${cur.ext === 'm3u' ? ' selected' : ''}>m3u</option></select></label>` : '';
      const libRow = () => `<div class="pl-lib pl-wide">Your music folder (the one with the artist folders): <input type="text" class="pl-lib-in" value="${esc(cur.lib)}" spellcheck="false"></div>`;
      let body = '';
      if (tg === 'plex') body = `<div class="pl-grid">
          ${field('Plex address', 'pl-purl', prefs.plex_url, 'http://192.168.0.10:32400')}
          <label class="tg-af"><span>Plex token ${prefs.has_token ? '(saved)' : ''}</span><span class="pl-inrow"><input type="password" class="pl-ptok" value="${prefs.has_token ? PL_TOKSAVED : ''}" placeholder="X-Plex-Token" autocomplete="off"><button type="button" class="uc-btn pl-ptest">Test</button></span></label>
          <div class="pl-wide pl-ptres" hidden></div>
          ${field('Your music on this server', 'pl-from', cur.from)}${field("The same folder inside Plex's container", 'pl-to', cur.to, '/music')}
          ${folder('Save the file in', 'Plex is handed this file; any folder works.')}${name()}${ftype()}
          <label class="chk pl-wide"><input type="checkbox" class="pl-psend" checked> Hand it to Plex after saving</label>
          <label class="tg-af pl-wide"><span>Poster in Plex (optional) - a picture on the server</span><span class="pl-inrow"><input type="text" class="pl-poster" placeholder="none" spellcheck="false"><button type="button" class="uc-btn pl-pcur">Picture under the cursor</button><button type="button" class="uc-btn pl-palb">First album's cover</button></span></label></div>`;
      if (tg === 'jf') body = `<div class="pl-grid">
          ${field('Address', 'pl-jurl', prefs.jf_url, 'http://192.168.0.10:8096')}
          <label class="tg-af"><span>API key ${prefs.has_jf_key ? '(saved)' : ''}</span><span class="pl-inrow"><input type="password" class="pl-jkey" value="${prefs.has_jf_key ? PL_TOKSAVED : ''}" placeholder="Jellyfin: Dashboard › API Keys · Emby: Settings › Advanced › API Keys" autocomplete="off"><button type="button" class="uc-btn pl-jtest">Test</button></span></label>
          <div class="pl-wide pl-jres" hidden></div>
          <label class="tg-af"><span>Whose playlist</span><select class="pl-juser">${prefs.jf_user ? `<option value="${esc(prefs.jf_user)}">${esc(prefs.jf_uname || 'saved user')}</option>` : '<option value="">Test first</option>'}</select></label>
          ${name(false)}
          ${field('Your music on this server', 'pl-from', cur.from)}${field('The same folder inside its container', 'pl-to', cur.to, '/data/music')}</div>`;
      if (tg === 'kodi') body = `<div class="pl-kodi">
            <label class="chk"><input type="radio" name="pl-kf" value="m3u"${cur.fmt !== 'xsp' ? ' checked' : ''}> <b>Playlist file</b> - every song, in this order</label>
            <label class="chk"><input type="radio" name="pl-kf" value="rnd"${cur.fmt === 'xsp' && cur.order !== 'artist' ? ' checked' : ''}> <b>Smart playlist: Randomized</b> - a fresh random mix each time it's opened</label>
            <label class="chk"><input type="radio" name="pl-kf" value="ord"${cur.fmt === 'xsp' && cur.order === 'artist' ? ' checked' : ''}> <b>Smart playlist: In order</b> - by artist, then album (oldest first), then track</label>
            ${cur.fmt === 'xsp' ? `<div class="pl-xsp">Songs from the <select class="pl-xby"><option value="album"${cur.by !== 'artist' ? ' selected' : ''}>albums</option><option value="artist"${cur.by === 'artist' ? ' selected' : ''}>artists (all their albums)</option></select> in this playlist${cur.order !== 'artist' ? `, <input type="text" class="pl-xlim" inputmode="numeric" value="${esc(String(cur.limit || ''))}" size="6"> at a time (empty: all)` : ''}.
              <div class="muted">A smart playlist is a list of folders, not songs: Kodi fills it from its own music library, so it opens at once however big it is.</div></div>` : ''}
            ${big ? `<div class="pl-big">⚠ ${pl.items.length.toLocaleString()} songs: Kodi gets very slow with a playlist file this big. A smart playlist works better. <button type="button" class="uc-btn pl-toxsp">Use a smart playlist</button></div>` : ''}
          </div><div class="pl-grid">${folder('Save it in', "Kodi's userdata/playlists/music - your Kodi share is under Remote shares (/mnt/remotes).")}<div class="pl-wide pl-ud" hidden></div>${name()}
          ${field('How Kodi reaches your music', 'pl-to', cur.to, 'smb://TOWER/')}${field('Your music on this server', 'pl-from', cur.from)}${ftype()}</div>`;
      if (tg === 'app') {
        const a = apps.find(x => x.app === cur.app);
        body = `<div class="pl-grid">
          <label class="tg-af"><span>Which app?</span><select class="pl-app"><option value="">${apps.length ? 'Pick it…' : 'No music app found in Docker'}</option>${apps.map(x => `<option value="${esc(x.app)}"${x.app === cur.app ? ' selected' : ''}>${esc(x.app)}</option>`).join('')}</select></label>
          ${field('It sees your music folder as', 'pl-to', cur.to, '/music')}
          ${a ? `<div class="muted pl-wide">${esc(a.app)} has <b>${esc(a.host)}</b> as <b>${esc(a.container)}</b>${a.pls ? `, and its playlists folder is <b>${esc(a.pls)}</b>` : ''}.</div>` : ''}
          ${libRow()}${folder('Save it in', 'Where the app looks for playlists (often its playlists folder, or inside the music folder).')}${name()}${ftype()}</div>`;
      }
      if (tg === 'pc') body = `<div class="pl-grid">
          ${field('That computer opens your music folder as', 'pl-to', cur.to, '\\\\TOWER\\Media\\Music', true, `<span class="muted pl-fh">For example <b>${esc(shareOf(cur.lib) || '\\\\TOWER\\Media\\Music')}</b> (the network path), or <b>M:\\Music</b> if you gave the share a drive letter.</span>`)}
          <label class="chk pl-wide"><input type="checkbox" class="pl-win"${cur.win ? ' checked' : ''}> Windows computer (paths with \\) - untick for a Mac or Linux computer</label>
          ${libRow()}${folder('Save it in', 'Somewhere that computer can open - your playlists folder, for example.')}${name()}${ftype()}</div>`;
      if (tg === 'drive') body = `<div class="pl-grid">
          ${folder('The drive', 'Plugged into this server - Unassigned Devices puts it under /mnt/disks.')}
          <div class="tg-af"><span>Artist folders on the drive</span><span class="pl-r2"><label class="chk"><input type="radio" name="pl-md" value=""${!cur.mdir ? ' checked' : ''}> at the top</label><label class="chk"><input type="radio" name="pl-md" value="1"${cur.mdir ? ' checked' : ''}> in a folder</label><input type="text" class="pl-mdir" value="${esc(cur.mdir || 'Music')}"${cur.mdir ? '' : ' disabled'}></span></div>
          <div class="tg-af"><span>The playlist file</span><span class="pl-r2"><label class="chk"><input type="radio" name="pl-pd" value=""${!cur.pdir ? ' checked' : ''}> at the top</label><label class="chk"><input type="radio" name="pl-pd" value="1"${cur.pdir ? ' checked' : ''}> in a folder</label><input type="text" class="pl-pdir" value="${esc(cur.pdir || 'Playlists')}"${cur.pdir ? '' : ' disabled'}></span></div>
          ${name()}${ftype()}
          <label class="chk pl-wide"><input type="checkbox" class="pl-copy"${cur.copy ? ' checked' : ''}> <b>Also copy the songs to the drive</b> - only this playlist's songs, into Artist/Album folders (songs already there are skipped)</label>
          ${libRow()}</div>`;
      sv.innerHTML = `<div class="pl-sbody">
          ${was.length ? `<div class="pl-sent"><div class="pl-sent-h"><b>Sent before</b> - its copies (they don't change by themselves when you edit the playlist):<span class="tg-sp"></span><button type="button" class="uc-btn primary pl-upall">Update ${was.length === 1 ? 'it' : was.length === 2 ? 'both' : `all ${was.length}`}</button></div>
            ${was.map((x, i) => `<div class="pl-sent-r"><b>${esc(PL_T(x.tg)[1])}</b><span class="pl-sent-p" title="${esc(x.dest)}">${esc(x.tg === 'jf' ? x.name || x.dest : x.dest)}</span><span class="muted">${esc(plAgo(x.at))}</span><button type="button" class="uc-btn pl-sent-x" data-unsend="${i}" title="Forget this copy (the file stays)">Forget</button></div>`).join('')}</div>` : ''}
          <div class="pl-for">${SEND.map(([k, l]) => `<button type="button" class="pl-tg${k === tg ? ' on' : ''}" data-tg="${k}">${esc(l)}</button>`).join('')}</div>
          <div class="pl-hint">${esc(t[3])}</div>
          ${body}
          ${tg !== 'jf' ? '<div class="tg-af pl-wide pl-exw"><span>How it will look (the first songs)</span><pre class="pl-prev"></pre></div>' : ''}
        </div>
        <div class="tg-fbar"><span class="pl-warn"></span><span class="tg-sp"></span><button type="button" class="uc-btn pl-cancel">Cancel</button><button type="button" class="uc-btn primary pl-write">Send</button></div>`;
      wire();
      preview();
    }
    function wire() {
      $$('.pl-tg', sv).forEach(b => b.addEventListener('click', () => { read(); fname = cur.fn || fname; tg = b.dataset.tg; cur = defaults(tg); paint(); }));
      const kf = k => { read(); fname = cur.fn; cur.fmt = k === 'm3u' ? 'm3u' : 'xsp'; cur.order = k === 'ord' ? 'artist' : 'random'; cur.ext = k === 'm3u' ? (cur.ext === 'xsp' ? 'm3u8' : cur.ext) : 'xsp'; paint(); };
      $$('input[name=pl-kf]', sv).forEach(r => r.addEventListener('change', () => kf(r.value)));
      const tx = $('.pl-toxsp', sv); if (tx) tx.addEventListener('click', () => kf('rnd'));
      const ap = $('.pl-app', sv); if (ap) ap.addEventListener('change', () => {
        read(); fname = cur.fn; const a = apps.find(x => x.app === ap.value); cur.app = a ? a.app : '';
        if (a) { cur.to = a.container + (cur.lib.startsWith(a.host + '/') ? cur.lib.slice(a.host.length) : ''); if (a.pls) cur.dir = a.pls; }
        paint();
      });
      [['pl-md', '.pl-mdir'], ['pl-pd', '.pl-pdir']].forEach(([n, c]) => $$(`input[name=${n}]`, sv).forEach(r => r.addEventListener('change', () => { $(c, sv).disabled = !r.value; preview(); })));
      const ua = $('.pl-upall', sv); if (ua) ua.addEventListener('click', async () => { closeDlg(); await plResend(sent()); });
      $$('[data-unsend]', sv).forEach(b => b.addEventListener('click', async () => {
        const x = sent()[+b.dataset.unsend]; if (!x) return;
        try { prefs = (await api('pl_prefs', { set: '1', prefs: JSON.stringify({ unsend: { master: pl.file, dest: x.dest } }) })).prefs; } catch (e) { return toast(e.message, true); }
        read(); fname = cur.fn; paint();
      }));
      $('.pl-cancel', sv).addEventListener('click', () => closeDlg());
      const dirIn = $('.pl-dir', sv), fb = $('.pl-fb', sv); let brw = null;
      const bb = $('.pl-brw', sv); if (bb) bb.addEventListener('click', () => { fb.hidden = !fb.hidden; if (!fb.hidden && !brw) brw = folderBrowser(fb, dirIn.value.trim() || '/mnt/user', { files: /\.(m3u8?|xsp)$/i, onDir: d => { dirIn.value = d; preview(); }, onFile: f => { $('.pl-fn', sv).value = base(f).replace(/\.(m3u8?|xsp)$/i, ''); preview(); } }); });
      $$('input, select', sv).forEach(i => i.addEventListener('input', preview));
      $('.pl-write', sv).addEventListener('click', write);
      if (tg === 'kodi') udShares();
      const pc = $('.pl-pcur', sv); if (pc) pc.addEventListener('click', () => { const P = A(), it = P.items[P.cursor]; if (!it || it.up || !/\.(jpe?g|png|webp)$/i.test(it.n)) return toast('Put the cursor on a JPG, PNG or WebP picture first', true); $('.pl-poster', sv).value = fullPath(P, it); });
      const pa = $('.pl-palb', sv); if (pa) pa.addEventListener('click', () => { if (pl.items[0]) $('.pl-poster', sv).value = 'album:' + plAlbumDir(pl.items[0]); });
      $$('.pl-ptok, .pl-jkey', sv).forEach(tk => tk.addEventListener('focus', () => { if (tk.value === PL_TOKSAVED) tk.select(); }));
      const pt = $('.pl-ptest', sv); if (pt) pt.addEventListener('click', async () => {
        const out = $('.pl-ptres', sv); out.hidden = false; out.className = 'pl-wide pl-ptres'; out.textContent = 'Checking…'; pt.disabled = true;
        try { const r = await api('plex_test', { url: $('.pl-purl', sv).value, token: plTok() }); out.classList.add('ok');
          out.textContent = `✓ Connected to ${r.name}${r.version ? ` (Plex ${r.version.split('-')[0]})` : ''} · ${r.music.length ? `music librar${r.music.length === 1 ? 'y' : 'ies'}: ${r.music.join(', ')}` : 'but it has no music library'}`;
        } catch (e) { out.classList.add('bad'); out.textContent = '✕ ' + e.message; }
        pt.disabled = false;
      });
      const jt = $('.pl-jtest', sv); if (jt) jt.addEventListener('click', async () => {
        const out = $('.pl-jres', sv); out.hidden = false; out.className = 'pl-wide pl-jres pl-ptres'; out.textContent = 'Checking…'; jt.disabled = true;
        const key = $('.pl-jkey', sv).value.trim();
        try {
          const r = await api('jf_test', { url: $('.pl-jurl', sv).value.trim(), key: key === PL_TOKSAVED ? '' : key });
          out.classList.add('ok'); out.textContent = `✓ Connected to ${r.name || 'the server'}${r.product ? ` (${r.product}${r.version ? ' ' + r.version : ''})` : ''}`;
          const us = $('.pl-juser', sv), keep = us.value || prefs.jf_user;
          us.innerHTML = r.users.map(u => `<option value="${esc(u.id)}"${u.id === keep ? ' selected' : ''}>${esc(u.name)}${u.admin ? ' (admin)' : ''}</option>`).join('');
        } catch (e) { out.classList.add('bad'); out.textContent = '✕ ' + e.message; }
        jt.disabled = false; preview();
      });
    }
    function read() {
      const v = c => { const e = $(c, sv); return e ? e.value.trim() : ''; };
      const has = c => !!$(c, sv);
      const r = Object.assign({}, cur, { tg, fn: v('.pl-fn').replace(/[\/\\]/g, '-') });
      if (has('.pl-dir')) r.dir = v('.pl-dir').replace(/\/+$/, '') || '/';
      if (has('.pl-from')) r.from = v('.pl-from'); if (has('.pl-to')) r.to = v('.pl-to');
      if (has('.pl-ext')) r.ext = v('.pl-ext'); if (r.fmt === 'xsp') r.ext = 'xsp';
      if (has('.pl-xby')) r.by = v('.pl-xby'); if (has('.pl-xlim')) r.limit = parseInt(v('.pl-xlim'), 10) || 0;
      if (has('.pl-lib-in')) r.lib = v('.pl-lib-in').replace(/\/+$/, '');
      if (has('.pl-win')) r.win = $('.pl-win', sv).checked;
      if (has('.pl-copy')) r.copy = $('.pl-copy', sv).checked;
      if (has('.pl-mdir')) { const on = ($('input[name=pl-md]:checked', sv) || {}).value; r.mdir = on ? v('.pl-mdir').replace(/^\/+|\/+$/g, '') : ''; }
      if (has('.pl-pdir')) { const on = ($('input[name=pl-pd]:checked', sv) || {}).value; r.pdir = on ? v('.pl-pdir').replace(/^\/+|\/+$/g, '') : ''; }
      cur = r; return cur;
    }
    /* Kodi: its share from Unassigned Devices - mount it from here, and use its playlists folder */
    async function udShares() {
      const box = $('.pl-ud', sv); if (!box) return;
      let r; try { r = await api('ud_remotes'); } catch (e) { return; }
      if (!r.shares.length || !$('.pl-ud', sv)) return;
      const draw = () => {
        const d = $('.pl-dir', sv).value.trim();
        box.hidden = false;
        box.innerHTML = `<span class="muted pl-udl">Network shares (Unassigned Devices):</span> ${r.shares.map((x, i) => {
          const here = d === x.path || d.startsWith(x.path + '/');
          return `<span class="pl-udsh${x.mounted ? ' on' : ''}${here ? ' here' : ''}" title="${esc(x.src)} → ${esc(x.path)}"><i></i>${esc(x.name)}${x.mounted
            ? `<button type="button" class="uc-btn" data-udi="${i}">${here ? 'In use' : 'Use'}</button><button type="button" class="uc-btn" data-udu="${i}"${r.ud ? '' : ' disabled'}>Unmount</button>`
            : `<button type="button" class="uc-btn" data-udm="${i}"${r.ud ? '' : ' disabled title="Unassigned Devices isn\'t installed"'}>Mount</button>`}</span>`; }).join('')}`;
      };
      const use = x => { const dirIn = $('.pl-dir', sv); const cur0 = dirIn.value.trim(); if (!(cur0 === x.path || cur0.startsWith(x.path + '/'))) dirIn.value = x.kodi || x.path; preview(); draw();
        if (!x.kodi) toast(`No playlists/music folder found in ${x.name} - pick Kodi's userdata/playlists/music with Browse…`); };
      box.addEventListener('click', async e => {
        const u = e.target.closest('[data-udi]'); if (u) return use(r.shares[+u.dataset.udi]);
        const um = e.target.closest('[data-udu]');
        if (um) {
          const x = r.shares[+um.dataset.udu]; um.disabled = true; um.textContent = 'Unmounting…';
          try { Object.assign(x, await api('ud_mount', { src: x.src, off: '1' })); toast(`Unmounted ${x.name}`); } catch (er) { toast(er.message, true); }
          return draw();
        }
        const m = e.target.closest('[data-udm]'); if (!m) return;
        const x = r.shares[+m.dataset.udm]; m.disabled = true; m.textContent = 'Mounting…';
        try { Object.assign(x, await api('ud_mount', { src: x.src })); toast(`Mounted ${x.name}`); use(x); }
        catch (er) { toast(er.message, true); draw(); }
      });
      $('.pl-dir', sv).addEventListener('input', draw);
      draw();
    }
    function preview() {
      const c = read(), w = $('.pl-warn', sv), btn = $('.pl-write', sv);
      let bad = 0, need = '';
      if (tg === 'jf') {
        bad = pl.items.filter(p => plLineFor(p, c, 'map') === null).length;
        need = !c.to ? 'Fill in "The same folder inside its container"' : !($('.pl-juser', sv) || {}).value ? 'Test, then pick whose playlist it is' : '';
      } else {
        const out = plCopyText(tg, c, c.fn || 'playlist'); bad = out.bad;
        const pre = $('.pl-prev', sv);
        if (pre) pre.textContent = c.fmt === 'xsp' ? out.text.split('\n').slice(0, 8).join('\n') + '\n        …' : out.text.split(/\r?\n/).slice(0, 5).join('\n') + (pl.items.length > 4 ? '\n…' : '');
        need = (tg === 'app' && !c.to) ? (apps.length ? 'Pick the app' : 'Fill in "It sees your music folder as"') : (tg === 'pc' && !c.to) ? 'Fill in how that computer opens your music folder' : (['plex', 'kodi'].includes(tg) && !c.to) ? `Fill in "${tg === 'kodi' ? 'How Kodi reaches your music' : 'The same folder inside the container'}"` : '';
      }
      w.textContent = bad ? `${bad} song${bad === 1 ? ' isn\'t' : 's aren\'t'} in ${PL_NEWT.includes(tg) ? `your music folder (${c.lib})` : `"${c.from}"`}` : need || (!c.fn ? 'Give it a name' : '');
      const xl = $('.pl-extl', sv); if (xl) xl.textContent = '.' + (c.fmt === 'xsp' ? 'xsp' : c.ext);
      btn.disabled = !!bad || !c.fn || !!need;
      const dest = tg === 'jf' ? 'jellyfin:' + c.fn : plFileOf(c, c.fn);
      if (btn.dataset.confirm && btn.dataset.confirm !== dest) { delete btn.dataset.confirm; btn.textContent = 'Send'; }
    }
    async function write() {
      preview(); const c = cur, btn = $('.pl-write', sv);
      const dest = tg === 'jf' ? 'jellyfin:' + c.fn : plFileOf(c, c.fn);
      const replace = btn.dataset.confirm === dest || sent().some(x => x.dest === dest);
      btn.disabled = true; const was = btn.textContent; btn.textContent = 'Sending…';
      try {
        if (tg === 'plex') await api('pl_prefs', { set: '1', prefs: JSON.stringify({ plex_url: $('.pl-purl', sv).value, plex_token: plTok() }) });
        if (tg === 'jf') {
          const us = $('.pl-juser', sv), key = $('.pl-jkey', sv).value.trim();
          prefs = (await api('pl_prefs', { set: '1', prefs: JSON.stringify({ jf_url: $('.pl-jurl', sv).value.trim(), jf_key: key === PL_TOKSAVED ? '' : key, jf_user: us.value, jf_uname: us.selectedOptions[0] ? us.selectedOptions[0].textContent : '' }) })).prefs;
        }
        const entry = { tg, dest, name: c.fn, from: c.from, to: c.to, fmt: c.fmt, order: c.order, by: c.by, limit: c.limit, lib: c.lib, app: c.app, win: c.win, mdir: c.mdir, pdir: c.pdir, copy: c.copy, drive: tg === 'drive' ? c.dir : undefined,
          psend: tg === 'plex' && $('.pl-psend', sv).checked, poster: ($('.pl-poster', sv) || {}).value || '' };
        const r = await plSendOne(entry, replace);
        const tgs = {}; tgs[tg] = { dir: c.dir, from: c.from, to: c.to, ext: c.ext, fmt: c.fmt, order: c.order, by: c.by, limit: c.limit, lib: c.lib, app: c.app, win: c.win, mdir: c.mdir, pdir: c.pdir, copy: c.copy };
        api('pl_prefs', { set: '1', prefs: JSON.stringify(Object.assign({ targets: tgs, last: tg }, pl.file ? { send: { master: pl.file, entry: Object.assign({}, entry, { copy: false }) } } : {})) }).catch(() => {});
        closeDlg(); refreshBoth();
        const what = tg === 'jf' ? `"${c.fn}"` : base(dest);
        if (r.err) toast(`Sent ${what}${r.extra}, but ${r.err.startsWith('copying') ? r.err : `Plex didn't take ${r.err.startsWith('the poster') ? r.err : 'it: ' + r.err}`}`, true);
        else if (r.hist) done(`Sent ${what}${r.extra}${pl.file ? '' : ' - save the playlist too, so its copies can be updated in one go later'}`, r.hist);
        else toast(`Sent ${what}${r.extra}`);
      } catch (e) {
        btn.disabled = false; btn.textContent = was;
        if (/already there/.test(e.message)) { btn.dataset.confirm = dest; btn.textContent = 'Replace it'; $('.pl-warn', sv).textContent = `${base(dest)} is already there - press Replace it to overwrite it (the old one goes to the trash)`; return; }
        toast(e.message, true);
      }
    }
    paint();
    const fn = $('.pl-fn', sv); if (fn) { fn.focus(); fn.select(); }
  }

  /* ---------- the player and its playlist panel ----------
   * The player sits in the middle of the Select / Sort bar. Clicking the song
   * opens the playlist panel above it: the song playing, the buttons that go
   * with the playlist, and the playlist itself (drag to reorder, drop songs in,
   * click one to play it). The panel can be pinned to the side as a third
   * column - then the player moves into it - and ✕ unpins it again. The ♪
   * button at the top shows and hides all of it; the playlist always stays. */
  const bpEl = root.querySelector('.uc-bp'), bpHost = bpEl.querySelector('.bp-host');
  const bpHome = document.createComment('player'); bpEl.parentNode.insertBefore(bpHome, bpEl);   // where the player goes back to when the panel is unpinned
  const plBtn = root.querySelector('.uc-plbtn');
  let bpStop = null;         // our player's stop function, to tell if another player took over
  let bpLoaded = '';         // the song loaded in the player ('' = nothing loaded yet)
  let bpInfo = null, bpFails = 0;
  const bpBad = new Set();   // songs that couldn't be played
  const bpMedia = () => bpStop && playerStop === bpStop ? $('.vp-v', bpHost) : null;
  const bpPlaying = () => { const v = bpMedia(); return !!(v && !v.paused); };
  const SVG_SHUF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5h2.6c3.4 0 4.4 7 7.8 7h2.6M1.5 11.5h2.6c1.4 0 2.3-1.2 3-2.6M9 7.1c.7-1.4 1.6-2.6 3-2.6h2.5"/><path d="M12.7 2.6l1.9 1.9-1.9 1.9M12.7 9.6l1.9 1.9-1.9 1.9"/></svg>';
  const SVG_LOOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 9.5V7.2c0-1.5 1.2-2.7 2.7-2.7h8"/><path d="M11.8 2.6l1.9 1.9-1.9 1.9"/><path d="M13 6.5v2.3c0 1.5-1.2 2.7-2.7 2.7h-8"/><path d="M4.2 13.4l-1.9-1.9 1.9-1.9"/></svg>';
  const SVG_PIN = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg>';

  const np = document.createElement('div');
  np.className = 'uc-np'; np.hidden = true;
  np.innerHTML = `<div class="np-tools"><select class="np-open" title="Open a playlist from your playlist folders (Settings > General > Music player)"><option value="">Playlists…</option></select><button type="button" data-n="save" title="Save the playlist">Save</button><button type="button" data-n="saveas" title="Save it under another name or in another folder">Save as…</button><button type="button" data-n="send" title="Send a copy to Plex, Kodi, a phone or a USB drive - written the way that app reads it">Send…</button><button type="button" data-n="clear" title="Empty the playlist (nothing on the disks changes)">Clear</button><button type="button" data-n="pin" class="np-ic" title="Pin it to the side - the player goes with it" aria-label="Pin to the side">${SVG_PIN}</button><button type="button" data-n="x" class="np-ic np-x" aria-label="Close">✕</button></div>
    <div class="np-head"><div class="np-nm"><input type="text" class="np-name" spellcheck="false" aria-label="Playlist name" title="The playlist's name - also its file name when it's saved"><span class="np-sub"><span class="pl-info"></span><span class="np-dot" title="Changed - not saved yet"></span><button type="button" data-n="clean" class="np-clean" hidden></button></span></div><button type="button" data-n="pp" class="np-pp" title="Play / pause" aria-label="Play or pause"></button></div>
    <div class="np-file"><span class="np-path"></span></div>
    <div class="np-now"></div>
    <div class="np-slot"></div>
    <div class="np-list"><div class="np-rows"></div></div>
    <div class="np-foot">Drag songs, albums or artists here · click a song to play it</div>`;
  root.appendChild(np);
  const npList = $('.np-list', np), npRowsEl = $('.np-rows', np), npOpenSel = $('.np-open', np);
  const RH = 44;               // the height of a song in the list (only the songs in view are drawn)
  const isPinned = () => !!store.get('nppin', false);
  let npFloat = false;         // the panel open above the player

  /* where a song is in the list as shown: in the order they'll play when shuffled */
  /* The rows of the list. In order (not shuffled), songs of the same album one after the other are grouped
   * under an album row that folds them away; shuffled, it's the songs in the order they'll play. */
  let npCol = new Set(store.get('npcol', []));     // album folders folded away
  const npSaveCol = () => store.set('npcol', [...npCol].slice(-3000));
  /* Which artist and album a song belongs to: the first and second folder under the music
   * library (so CD1/CD2, mp3/flac folders inside an album stay part of it). The library is
   * the music view's folder, the music check's, or one found to have music; else the folder
   * all the songs have in common. */
  function plKeyer() {
    const it = pl.items;
    const roots = [store.get('mus', null), store.get('mcroot', ''), ...(mus ? [mus.root] : []), ...[...musProbe].filter(([, v]) => v === true).map(([k]) => k)]
      .filter(x => typeof x === 'string' && x).sort((a, b) => b.length - a.length);
    let common = it.length ? commonDir(it.slice(0, 3000)) : '';
    /* all from one artist: the common folder is the artist (or an album) - the library is above it */
    if (common && it.length && it.every(p => p.slice(common.length + 1).split('/').length < 3)) common = parent(common);
    if (common && it.length && new Set(it.slice(0, 3000).map(p => p.slice(common.length + 1).split('/')[0])).size === 1 && it.every(p => p.slice(common.length + 1).split('/').length >= 2)) common = parent(common);
    const cache = new Map();
    return p => {
      let k = cache.get(p); if (k) return k;
      const r = roots.find(x => p.startsWith(x + '/') && p.slice(x.length + 1).split('/').length >= 2) || (common && p.startsWith(common + '/') ? common : '');
      if (r) { const rel = p.slice(r.length + 1).split('/'); k = { ar: r + '/' + rel[0], al: rel.length >= 3 ? r + '/' + rel[0] + '/' + rel[1] : '' }; }
      else { const ad = plAlbumDir(p); k = { ar: parent(ad), al: ad }; }
      cache.set(p, k); return k;
    };
  }
  function npModel() {
    const it = pl.items, rows = [];
    if (pl.shuffle) { const idx = new Map(it.map((x, k) => [x, k])); for (const p of plOrder()) rows.push({ t: 's', i: idx.get(p) }); return rows; }
    const key = plKeyer(), K = it.map(key);
    /* every artist gets one line; inside it, its albums (one line each, then their songs) and its loose songs */
    for (let k = 0; k < it.length;) {
      const ar = K[k].ar; let e = k + 1;
      while (e < it.length && K[e].ar === ar) e++;
      const albs = new Set(); for (let q = k; q < e; q++) if (K[q].al) albs.add(K[q].al);
      rows.push({ t: 'r', d: ar, a: k, b: e, lv: 0, n: albs.size });
      if (!npCol.has(ar)) for (let j = k; j < e;) {
        let f = j + 1; while (f < e && K[f].al === K[j].al) f++;
        if (K[j].al) { rows.push({ t: 'a', d: K[j].al, a: j, b: f, lv: 1 }); if (!npCol.has(K[j].al)) for (let q = j; q < f; q++) rows.push({ t: 's', i: q, lv: 2 }); }
        else for (let q = j; q < f; q++) rows.push({ t: 's', i: q, lv: 1 });
        j = f;
      }
      k = e;
    }
    return rows;
  }
  let npRowsC = null;          // the rows as last drawn
  let npTops = [0];            // where each row starts (rows have different heights: artist 30, album 44, a song in a group 28, a song on its own 44)
  let RHA = 26; const RHS = 28;
  const rowH = r => r.t === 'r' ? RHA : r.t === 'a' ? RH : r.lv ? RHS : RH;
  function npLayout(rows) { RHA = Math.max(22, Math.round(parseFloat(getComputedStyle(root).getPropertyValue('--rowpx')) || parseFloat(getComputedStyle(root).getPropertyValue('--row')) || 23) + 3); const t = new Array(rows.length + 1); t[0] = 0; for (let k = 0; k < rows.length; k++) t[k + 1] = t[k] + rowH(rows[k]); npTops = t; return t; }
  /* the row at a height in the list */
  const rowAtY = y => { let lo = 0, hi = npTops.length - 2; if (hi < 0) return 0; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (npTops[mid] <= y) lo = mid; else hi = mid - 1; } return lo; };
  const npPos = () => { const rows = npRowsC || npModel(); let k = rows.findIndex(r => r.t === 's' && r.i === pl.i); if (k < 0) for (let q = rows.length - 1; q >= 0; q--) if (rows[q].t !== 's' && pl.i >= rows[q].a && pl.i < rows[q].b) { k = q; break; } return Math.max(0, k); };
  function plAlbRow(r, pos) {
    if (r.t === 'r') return plArtRow(r, pos);
    const n = r.b - r.a, open = !npCol.has(r.d), now = pl.i >= r.a && pl.i < r.b;
    const art = r.t === 'r';
    return `<div class="pl-alb${art ? ' art' : ''} lv${r.lv || 0}${now ? ' now' : ''}${open ? ' open' : ''}" data-a="${r.a}" data-b="${r.b}" data-d="${esc(r.d)}" draggable="true" style="top:${npTops[pos]}px" title="${esc(r.d)}">
      <span class="pa-car" aria-hidden="true">▸</span>
      <span class="pl-cov"><img alt="" loading="lazy" src="${esc(`${API}?action=cover&s=96&v=${coverV}&path=${encodeURIComponent(r.d)}`)}">${now && bpLoaded && !open ? '<i class="bc-eq"><i></i><i></i><i></i></i>' : ''}</span>
      <span class="pl-t"><span class="pl-tt"><b>${esc(base(r.d))}</b></span><span class="pl-sub">${albSub(r)}</span></span>
      <span class="pl-btns"><button type="button" data-ab="play" title="Play from its first song" aria-label="Play">▶</button><button type="button" data-ab="del" title="Take ${art ? 'all of this artist\'s songs' : 'the whole album'} out of the playlist" aria-label="Remove">✕</button></span></div>`;
  }
  /* under an album's name: how many songs · how long */
  function albSub(r) {
    const n = r.b - r.a; let t = 0, k2 = 0;
    for (let j = r.a; j < r.b; j++) { const v = plLens.get(pl.items[j]); if (v) { t += v; k2++; } }
    return `${r.t === 'r' ? `${r.n} albums · ` : ''}${n} song${n === 1 ? '' : 's'}${k2 ? ' · ' + (t >= 3600 ? Math.floor(t / 3600) + ' h ' + Math.round(t % 3600 / 60) + ' min' : fmtT(t)) + (k2 < n ? '+' : '') : ''}`;
  }
  /* the album lines on screen: their totals as lengths come in; ask for the ones not known yet */
  function npSubs() {
    if (np.hidden || !npRowsC) return;
    $$('.pl-alb[data-a]', npRowsEl).forEach(el => { const a = +el.dataset.a, r = npRowsC.find(x => x.a === a && x.t !== 's' && x.d === el.dataset.d); const sub = r && $('.pl-sub', el); if (sub) sub.textContent = albSub(r); });
  }
  /* an artist: one line - its name, then how many albums and songs */
  function plArtRow(r, pos) {
    const n = r.b - r.a, open = !npCol.has(r.d), now = pl.i >= r.a && pl.i < r.b;
    let t = 0, k2 = 0; for (let j = r.a; j < r.b; j++) { const v = plLens.get(pl.items[j]); if (v) { t += v; k2++; } }
    return `<div class="pl-alb art${now ? ' now' : ''}${open ? ' open' : ''}" data-a="${r.a}" data-b="${r.b}" data-d="${esc(r.d)}" draggable="true" style="top:${npTops[pos]}px;height:${RHA}px" title="${esc(r.d)}">
      <span class="pa-car" aria-hidden="true">▸</span>
      <span class="pa-line"><b>${esc(base(r.d))}</b>${now && bpLoaded && !open ? '<i class="bc-eq"><i></i><i></i><i></i></i>' : ''}<span class="pa-n">${n} song${n === 1 ? '' : 's'}</span></span>
      <span class="pl-btns"><button type="button" data-ab="play" title="Play from its first song" aria-label="Play">▶</button><button type="button" data-ab="del" title="Take all of this artist's songs out of the playlist" aria-label="Remove">✕</button></span></div>`;
  }
  /* a song inside an album: one line, no picture */
  function plRowCompact(p, i, pos) {
    const miss = pl.missing && pl.missing.includes(p), now = i === pl.i, bad = miss || bpBad.has(p);
    return `<div class="pl-row cmp${bad ? ' miss' : ''}${now ? ' now' : ''}" data-i="${i}" data-p="${esc(p)}" draggable="${!pl.shuffle}" title="${esc(p)}${bad ? ` - ${miss ? 'not found' : 'couldn\'t be played'}` : ''}" style="top:${npTops[pos]}px;height:${RHS}px">
      <span class="pl-grip" title="Drag to move">⋮⋮</span>
      <span class="pl-tt">${now && bpLoaded ? '<i class="bc-eq"><i></i><i></i><i></i></i>' : ''}<b>${esc(base(p).replace(/\.[^.]+$/, ''))}</b><span class="pl-dur">${plLens.get(p) ? fmtT(plLens.get(p)) : ''}</span></span>
      <span class="pl-btns">${bad ? `<button type="button" data-b="dir" title="Open its folder in the active pane to have a look" aria-label="Open its folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4v8.5h13v-7H7.3L6 4z"/></svg></button>` : ''}<button type="button" data-b="del" title="Take it out of the playlist" aria-label="Remove">✕</button></span></div>`;
  }
  function plRow(p, i, pos = i) {
    const f = base(p).replace(/\.[^.]+$/, ''), ad = plAlbumDir(p), al = base(ad), ar = base(parent(ad));
    const miss = pl.missing && pl.missing.includes(p), now = i === pl.i;
    return `<div class="pl-row${miss || bpBad.has(p) ? ' miss' : ''}${now ? ' now' : ''}" data-i="${i}" data-p="${esc(p)}" draggable="${!pl.shuffle}" title="${esc(p)}${pl.why && pl.why[p] && pl.why[p][2] ? `\nIn the playlist file: ${esc(pl.why[p][2])}` : ''}" style="top:${npTops[pos] !== undefined ? npTops[pos] : pos * RH}px">
      <span class="pl-grip" title="${pl.shuffle ? 'Shuffle is on - turn it off to move songs' : 'Drag to move'}">⋮⋮</span>
      <span class="pl-cov"><img alt="" loading="lazy" src="${esc(`${API}?action=cover&s=96&v=${coverV}&path=${encodeURIComponent(ad)}`)}">${now && bpLoaded ? '<i class="bc-eq"><i></i><i></i><i></i></i>' : ''}</span>
      <span class="pl-t"><span class="pl-tt"><b>${esc(f)}</b><span class="pl-dur">${plLens.get(p) ? fmtT(plLens.get(p)) : ''}</span></span>
        <span class="pl-sub">${miss || bpBad.has(p) ? `<span class="pl-miss">${p.includes('\uFFFD') || (pl.why && pl.why[p] && pl.why[p][0] === 'enc') ? 'its name on the disk isn\'t UTF-8' : miss ? 'not found' : 'couldn\'t be played'}: ${esc(p)}</span>` : `<span class="pl-ar">${esc(ar)}</span> › <span class="pl-al">${esc(al)}</span>`}</span></span>
      <span class="pl-btns">${miss || bpBad.has(p) ? `<button type="button" data-b="dir" title="Open its folder in the active pane to have a look (or the nearest folder that's there)" aria-label="Open its folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4v8.5h13v-7H7.3L6 4z"/></svg></button>` : ''}<button type="button" data-b="del" title="Take it out of the playlist" aria-label="Remove">✕</button></span></div>`;
  }
  /* the list: only the rows in view are drawn, so a playlist of 10,000 songs is as quick as one of 10 */
  function npRows() {
    if (np.hidden) return;
    const n = pl.items.length;
    if (!n) { npRowsEl.style.height = ''; npRowsEl.innerHTML = '<div class="pl-empty muted">The playlist is empty.<br><br>Drag songs, albums or artists from the panes onto this list, right-click them and pick <b>Play</b> or <b>Add to playlist</b>, or pick one under <b>Playlists…</b> above.</div>'; return; }
    const rows = npRowsC = npModel(), m = rows.length, tops = npLayout(rows);
    npRowsEl.style.height = tops[m] + 'px';
    const top = npList.scrollTop, h = npList.clientHeight || 400;
    const a = Math.max(0, rowAtY(top) - 8), b = Math.min(m, rowAtY(top + h) + 9);
    let html = ''; for (let k = a; k < b; k++) { const r = rows[k]; html += r.t !== 's' ? plAlbRow(r, k).replace('class="pl-alb', `class="pl-alb lv${r.lv || 0}`) : r.lv ? plRowCompact(pl.items[r.i], r.i, k).replace('class="pl-row', `class="pl-row lv${r.lv}`) : plRow(pl.items[r.i], r.i, k); }
    npRowsEl.innerHTML = html;
    npList.classList.toggle('shuf', pl.shuffle);
    if (!plLensNoFf) { const need = []; for (let k = a; k < b && need.length < 400; k++) { const r = rows[k]; if (r.t !== 's' && r.t !== 'r') for (let j = r.a; j < r.b && j < r.a + 60; j++) if (!plLens.has(pl.items[j])) need.push(pl.items[j]); } if (need.length) plFillLens(need); }
    npFoldBtn();
  }
  function npFoldBtn() {
    const rows = npRowsC || [];
    const fb = $('[data-n="fold"]', np);
    if (fb) { const groups = rows.filter(r => r.t !== 's'); fb.hidden = pl.shuffle || !groups.length; const allShut = groups.length && groups.every(g => npCol.has(g.d)); fb.textContent = allShut ? 'Unfold all' : 'Fold all'; fb.title = allShut ? 'Show every song again' : 'Show each artist and album as one line - click one to see what\'s inside'; }
  }
  let npRaf = 0;
  npList.addEventListener('scroll', () => { if (!npRaf) npRaf = requestAnimationFrame(() => { npRaf = 0; npRows(); }); });
  const npScrollTo = (i, mid = true) => { if (!np.hidden) npLayout(npRowsC = npModel()); const h = npList.clientHeight; const y = npTops[i] || 0; if (mid) npList.scrollTop = Math.max(0, y - h / 2 + RH / 2); else if (y < npList.scrollTop || y + RH > npList.scrollTop + h) npList.scrollTop = Math.max(0, y - h / 2 + RH / 2); npRows(); };
  /* the song playing: a card with its cover, its tags and what plays next */
  function npNow() {
    const box = $('.np-now', np);
    if (!pl.items.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    const p = pl.items[pl.i], live = bpLoaded === p, inf = live && bpInfo || {}, tg = inf.tags || {}, a = (inf.audio || [])[0] || {}, ad = plAlbumDir(p);
    const fmt = [a.codec && a.codec.toUpperCase(), a.hz && (a.hz / 1000).toFixed(a.hz % 1000 ? 1 : 0) + ' kHz', a.bits && a.bits + '-bit', a.ch, inf.kbps && inf.kbps + ' kb/s'].filter(Boolean);
    const pic = live && inf.cover ? `${API}?action=cover&path=${encodeURIComponent(p)}` : `${API}?action=cover&s=320&v=${coverV}&path=${encodeURIComponent(ad)}`;
    box.innerHTML = `<div class="nn-cov"><img alt="" src="${esc(pic)}" onerror="this.remove()"></div>
      <div class="nn-main"><b class="nn-title" title="${esc(p)}">${esc(tg.title || songName(p))}</b><span class="nn-artist">${esc(tg.artist || base(parent(ad)))}</span>
        <span class="nn-album">${esc(tg.album || base(ad))}${tg.date ? ` · ${esc(String(tg.date).slice(0, 10))}` : ''}</span>
        ${fmt.length || tg.genre ? `<span class="nn-fmt">${esc([tg.genre, ...fmt].filter(Boolean).join(' · '))}</span>` : ''}</div>
      <div class="nn-btns"><button type="button" data-n="shuf" class="np-ic${pl.shuffle ? ' on' : ''}" title="${pl.shuffle ? 'Shuffle is on - click to play in order' : 'Shuffle'}" aria-pressed="${pl.shuffle}">${SVG_SHUF}</button><button type="button" data-n="loop" class="np-ic${pl.loop ? ' on' : ''}" title="${pl.loop ? 'Repeat is on - the playlist starts again after the last song' : 'Repeat the playlist'}" aria-pressed="${pl.loop}">${SVG_LOOP}</button>
        <span class="tg-sp"></span><button type="button" data-n="fold" hidden></button><button type="button" data-n="find" title="Scroll the list to this song">Find</button><button type="button" data-n="show" title="Open its folder in the active pane, with the cursor on it">Show</button></div>`;
    npFoldBtn();
  }
  function npHead() {
    const nm = $('.np-name', np); if (document.activeElement !== nm) nm.value = pl.name;
    np.classList.toggle('dirty', pl.dirty && pl.items.length > 0);
    $('.np-path', np).textContent = pl.file ? '‎' + pl.file + '‎' : '‎Not saved yet - Save keeps it as a file‎';
    $('.np-path', np).title = pl.file || '';
    npPP();
    plInfoAll();
    const nmiss = (pl.missing || []).filter(x => pl.items.includes(x)).length, cb = $('.np-clean', np);
    cb.hidden = !nmiss; cb.textContent = `Remove ${nmiss} not found`; cb.title = `Take the ${nmiss} song${nmiss === 1 ? '' : 's'} in red out of the playlist`;
  }
  /* where it is: above the player, pinned at the side, or not shown */
  function npSync() {
    const show = playerOn() && !!store.get('bpshow', false), pin = show && isPinned(), float = show && !pin && npFloat;
    const was = !np.hidden, wasPin = np.classList.contains('pinned');
    if (pin) { if (np.parentNode !== root.querySelector('.uc-panes')) root.querySelector('.uc-panes').appendChild(np); if (bpEl.parentNode !== $('.np-slot', np)) $('.np-slot', np).appendChild(bpEl); }
    else { if (np.parentNode !== root) root.appendChild(np); if (bpEl.parentNode !== bpHome.parentNode) bpHome.parentNode.insertBefore(bpEl, bpHome.nextSibling); }
    np.classList.toggle('pinned', pin); np.classList.toggle('float', float);
    np.hidden = !(pin || float);
    root.classList.toggle('uc-pldocked', pin);
    bpEl.hidden = !show; root.classList.toggle('uc-bpon', show && !pin);
    $('[data-n="pin"]', np).hidden = pin;
    $('[data-n="x"]', np).title = pin ? 'Unpin - the player goes back to the bottom' : 'Close the playlist';
    if (plBtn) { plBtn.hidden = !playerOn(); plBtn.classList.toggle('on', show); }
    if (!np.hidden) { npHead(); npNow(); npPlace(); npRows(); if (!was || pin !== wasPin) { npScrollTo(npPos()); plFillSelect(npOpenSel, 'Playlists…'); plFillLens(); } }
    if (pin !== wasPin) setTimeout(() => { window.dispatchEvent(new Event('resize')); npPlace(); bpMarquee(); }, 30);
    if (typeof fitBar === 'function') fitBar();
  }
  const plDock = npSync;
  function npPlace() {
    if (np.classList.contains('pinned')) {
      /* pinned: its top lines up with the path boxes, in the space the path row leaves for it */
      const pa = root.querySelector('.uc-path[data-pane="1"]') || root.querySelector('.uc-path');
      np.style.marginTop = '';
      if (pa && innerWidth > 700 && pa.offsetHeight) np.style.marginTop = Math.min(0, pa.getBoundingClientRect().top - np.getBoundingClientRect().top) + 'px';
      np.style.left = np.style.bottom = np.style.width = np.style.maxHeight = '';
      return;
    }
    if (!np.classList.contains('float')) return;
    const r = bpEl.getBoundingClientRect(), w = Math.min(500, innerWidth - 24);
    np.style.marginTop = '';
    np.style.width = w + 'px';
    np.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
    np.style.bottom = (innerHeight - r.top + 8) + 'px';
    np.style.maxHeight = Math.max(260, Math.min(innerHeight * .8, r.top - Math.max(0, root.getBoundingClientRect().top) - 12)) + 'px';
  }
  window.addEventListener('resize', npPlace);
  function npOpen() { if (!playerOn()) return; if (!store.get('bpshow', false)) store.set('bpshow', true); if (!isPinned()) npFloat = true; npSync(); }
  const plEditor = on => on ? npOpen() : (npFloat = false, npSync());
  function npPin(on) { store.set('nppin', !!on); npFloat = false; npSync(); }

  /* the panel's buttons */
  np.addEventListener('click', e => {
    const b = e.target.closest('[data-n]');
    if (b) {
      b.blur();
      const n = b.dataset.n;
      if (n === 'save') plSave();
      if (n === 'saveas') plSaveAs();
      if (n === 'send') { if (!pl.items.length) toast('The playlist is empty - nothing to send', true); else plSendTo(); }
      if (n === 'clear') plClear();
      if (n === 'pin') npPin(true);
      if (n === 'x') { if (np.classList.contains('pinned')) npPin(false); else { npFloat = false; npSync(); } }
      if (n === 'shuf') { plShuffle(!pl.shuffle); npNow(); npScrollTo(npPos()); }
      if (n === 'loop') { pl.loop = !pl.loop; plPut(); npNow(); }
      if (n === 'pp') bpToggle();
      if (n === 'clean') { const gone = new Set(pl.missing || []), cur = pl.items[pl.i]; pl.items = pl.items.filter(x => !gone.has(x)); pl.missing = []; pl.i = Math.max(0, pl.items.indexOf(cur)); plChanged(); toast(`Took ${gone.size} song${gone.size === 1 ? '' : 's'} out - Save to keep it that way`); }
      if (n === 'find') {
        /* open the playing song's artist and album - and fold that artist's other albums */
        const p = pl.items[pl.i];
        if (p) { const key = plKeyer(), k = key(p); pl.items.forEach(x => { const kx = key(x); if (kx.ar === k.ar && kx.al && kx.al !== k.al) npCol.add(kx.al); }); npCol.delete(k.ar); npCol.delete(k.al); npSaveCol(); }
        npScrollTo(npPos());
      }
      if (n === 'fold') {
        /* fold: every artist and album row; unfold: everything (the songs come back) */
        const shut = (npRowsC || npModel()).filter(r => r.t !== 's').every(g => npCol.has(g.d));
        if (shut) npCol.clear(); else { const key = plKeyer(); pl.items.forEach(p => { const k = key(p); npCol.add(k.ar); if (k.al) npCol.add(k.al); }); }
        npSaveCol(); npRows(); npScrollTo(npPos());
      }
      if (n === 'show') { const p = pl.items[pl.i]; if (p) { if (np.classList.contains('float')) { npFloat = false; npSync(); } load(A(), parent(p), base(p)); } }
      return;
    }
    const al = e.target.closest('.pl-alb');
    if (al) {
      const a = +al.dataset.a, b2 = +al.dataset.b, d = al.dataset.d, ab = e.target.closest('[data-ab]');
      if (ab && ab.dataset.ab === 'play') return bpGo(a, true);
      if (ab && ab.dataset.ab === 'del') {
        const playing = pl.i >= a && pl.i < b2 && bpLoaded;
        pl.items.splice(a, b2 - a);
        if (pl.i >= b2) pl.i -= b2 - a; else if (pl.i >= a) pl.i = Math.min(a, pl.items.length - 1);
        pl.i = Math.max(0, pl.i); plChanged();
        if (playing) { if (pl.items.length) bpGo(pl.i, true); else { if (bpMedia()) playerStop(); bpLoaded = ''; bpGo(0, false); } }
        return toast(`Took ${base(d)} out (${b2 - a} songs)`);
      }
      if (npCol.has(d)) npCol.delete(d); else npCol.add(d);
      npSaveCol(); return npRows();
    }
    const r = e.target.closest('.pl-row'); if (!r) return;
    const i = +r.dataset.i, del = e.target.closest('[data-b="del"]');
    if (e.target.closest('[data-b="dir"]')) return plShowWhere(pl.items[i]);
    if (del) {
      const playing = i === pl.i && bpLoaded;
      pl.items.splice(i, 1);
      if (i < pl.i) pl.i--;
      if (pl.i >= pl.items.length) pl.i = Math.max(0, pl.items.length - 1);
      plChanged();
      if (playing) { if (pl.items.length) bpGo(pl.i, bpPlaying()); else { if (bpMedia()) playerStop(); bpLoaded = ''; bpGo(0, false); } }
      return;
    }
    if (e.target.closest('.pl-grip')) return;
    bpGo(i, true);
  });
  npList.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
  /* drag to reorder, or drop songs, albums and artists from the panes */
  let dragI = -1, dragN = 1;      // what's being moved: from song dragI, dragN songs (a whole album when its row is dragged)
  const rowAt = e => { const r = npList.getBoundingClientRect(), y = e.clientY - r.top + npList.scrollTop, k = rowAtY(y), hk = (npTops[k + 1] || 0) - (npTops[k] || 0); return Math.max(0, Math.min(npTops.length - 1, y > (npTops[k] || 0) + hk / 2 ? k + 1 : k)); };
  /* a place between rows, as a place in the playlist */
  const itemAt = ri => { const rows = npRowsC || npModel(); if (ri >= rows.length) return pl.items.length; const r = rows[ri]; return r.t !== 's' ? r.a : r.i; };
  npList.addEventListener('dragstart', e => {
    const r = e.target.closest('.pl-row, .pl-alb'); if (!r) return; if (pl.shuffle) { e.preventDefault(); return; }
    e.stopPropagation();
    if (r.classList.contains('pl-alb')) { dragI = +r.dataset.a; dragN = +r.dataset.b - dragI; } else { dragI = +r.dataset.i; dragN = 1; }
    r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'playlist'); } catch (x) {} });
  npList.addEventListener('dragover', e => {
    if (dragI < 0 && !drag) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = dragI < 0 ? 'copy' : 'move';
    const at = rowAt(e); npList.classList.toggle('drop-in', dragI < 0);
    let ln = $('.np-drop', npRowsEl); if (!ln) { ln = document.createElement('div'); ln.className = 'np-drop'; npRowsEl.appendChild(ln); }
    ln.style.top = (npTops[at] || 0) - 1 + 'px';
    const h = npList.getBoundingClientRect();   // scroll while dragging near the edges
    if (e.clientY < h.top + 30) npList.scrollTop -= 12; else if (e.clientY > h.bottom - 30) npList.scrollTop += 12;
  });
  const dropOff = () => { npList.classList.remove('drop-in'); const ln = $('.np-drop', npRowsEl); if (ln) ln.remove(); };
  npList.addEventListener('dragleave', e => { if (!e.relatedTarget || !npList.contains(e.relatedTarget)) dropOff(); });
  npList.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); const at = rowAt(e); dropOff();
    const to = itemAt(at);
    if (dragI >= 0) {
      const cur = pl.items[pl.i];
      if (to >= dragI && to <= dragI + dragN) { dragI = -1; return; }      // dropped on itself
      const block = pl.items.splice(dragI, dragN);
      pl.items.splice(to > dragI ? to - dragN : to, 0, ...block); dragI = -1;
      pl.i = Math.max(0, pl.items.indexOf(cur)); return plChanged();
    }
    if (drag) await plAdd(drag.paths.slice(), pl.shuffle ? -1 : to);
  });
  npList.addEventListener('dragend', () => { dragI = -1; dropOff(); $$('.pl-row, .pl-alb', npList).forEach(x => x.classList.remove('dragging')); });
  $('.np-name', np).addEventListener('input', e => { pl.name = e.target.value.trim() || 'Untitled'; pl.dirty = true; plPut(); np.classList.toggle('dirty', pl.items.length > 0); bpCount(); });
  $('.np-name', np).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  npOpenSel.addEventListener('mousedown', () => { if (Date.now() - plFilesAt > 20000) plFillSelect(npOpenSel, 'Playlists…'); });
  npOpenSel.addEventListener('change', () => { const v = npOpenSel.value; npOpenSel.value = ''; npOpenSel.blur();
    if (v === '*clearrec') { store.set('plrecent', []); plFilesAt = 0; plFillSelect(npOpenSel, 'Playlists…'); return toast('The recently opened list is empty'); }
    if (v === '*delete') return plDeleteFiles();
    if (v === '*browse') plBrowse(); else if (v) plOpenFile(v, { play: true }); });
  /* Playlists… > Delete playlists…: tick the files, they go to the trash (Undo brings them back) */
  async function plDeleteFiles() {
    plFilesAt = 0; const g = await plFiles();
    openDlg('Delete playlists', `<div class="muted">Tick the playlists to delete - they go to the trash, and Undo brings them back. Copies sent to apps (Plex, Kodi…) aren't touched.</div>
      <div class="pd-list">${g.map(([grp, fs]) => `<div class="pd-g">${esc(grp)}</div>${fs.map(f => `<label class="chk pd-r"><input type="checkbox" value="${esc(f)}"> ${esc(base(f))}${f === pl.file ? ' <span class="muted">(open now)</span>' : ''}${grp === 'Recently opened' ? ` <span class="muted">- ${esc(parent(f))}</span>` : ''}</label>`).join('')}`).join('')}</div>`,
      [{ label: 'Cancel' }, { label: 'Delete', danger: true, run: async () => {
        const paths = [...new Set($$('.pd-list input:checked', dlg).map(i => i.value))];
        if (!paths.length) { toast('Tick a playlist first', true); return false; }
        const x = await api('trash', { paths, label: `Deleted ${paths.length === 1 ? 'the playlist ' + base(paths[0]) : paths.length + ' playlists'}` });
        if (paths.includes(pl.file)) { pl.file = ''; pl.dirty = true; plStore(); }
        store.set('plrecent', store.get('plrecent', []).filter(f => !paths.includes(f))); plFilesAt = 0;
        refreshBoth(); done(`Deleted ${paths.length === 1 ? base(paths[0]) : paths.length + ' playlists'}`, x.hist);
      } }], 'pd-dlg');
  }
  /* clicking anywhere else closes the panel above the player (not a menu or a window it opened) */
  document.addEventListener('mousedown', e => {
    if (!npFloat || np.hidden || np.contains(e.target) || bpEl.contains(e.target) || e.target.closest('.uc-ctx, .uc-modal, .uc-toast, .uc-plbtn')) return;
    npFloat = false; npSync();
  });

  function bpCount() {
    const n = pl.items.length;
    $('.bp-qb b', bpEl).textContent = n ? `${Math.min(pl.i, n - 1) + 1}/${n}` : '0';
    $('.bp-qb', bpEl).title = `${pl.name}${pl.dirty && n ? ' - not saved' : ''} · click for the playlist`;
    $$('.pl-row', npRowsEl).forEach(r => { const on = +r.dataset.i === pl.i; r.classList.toggle('now', on); const c = $('.pl-cov', r), eq = $('.bc-eq', r); if (on && bpLoaded && !eq && c) c.insertAdjacentHTML('beforeend', '<i class="bc-eq"><i></i><i></i><i></i></i>'); if ((!on || !bpLoaded) && eq) eq.remove(); });
  }
  function bpShow(on, stop = true) {
    on = on && playerOn();
    store.set('bpshow', !!on);
    if (!on) { if (stop && bpMedia()) playerStop(); bpLoaded = ''; npFloat = false; }
    npSync();
    if (on && !bpLoaded && !bpMedia()) bpGo(pl.i, false);
    if (!on) bpCount();
  }
  function bpGo(i, autoplay = true, at = 0) {
    if (!pl.items.length) {
      bpHost.innerHTML = `<div class="vp aud bp-idle"><div class="vp-stage"><div class="vp-art"><span class="gp-ic">${GI.aud}</span><div class="vp-tags"><b>Nothing to play</b><i class="vt-sep"> · </i>click here for playlists</div></div></div></div>`;
      bpStop = null; bpLoaded = ''; bpCount(); if (!np.hidden) { npNow(); npRows(); } return;
    }
    const wasVisible = !np.hidden && (() => { const y = npTops[npPos()] || 0; return y >= npList.scrollTop - RH && y <= npList.scrollTop + npList.clientHeight; })();
    pl.i = Math.max(0, Math.min(pl.items.length - 1, i)); plPut();
    const p = pl.items[pl.i];
    if (autoplay && !store.get('bpshow', false)) { store.set('bpshow', true); npSync(); }
    if (!autoplay) {
      /* ready to play: just its title until ▶ - nothing is loaded, so no connection to the server stays open */
      const ad = plAlbumDir(p);
      if (bpMedia()) playerStop();
      bpHost.innerHTML = `<div class="vp aud bp-idle"><div class="vp-stage"><div class="vp-art"><span class="gp-ic">${GI.aud}</span><div class="vp-tags"><b>${esc(songName(p))}</b><i class="vt-sep"> · </i>${esc(base(parent(ad)))}<i class="vt-sep"> · </i>${esc(base(ad))}</div></div></div><div class="vp-bar"><button type="button" class="vp-b bp-start" title="Play">▶</button></div></div>`;
      $('.bp-start', bpHost).addEventListener('click', e => { e.stopPropagation(); bpGo(pl.i, true, bpResumeAt()); });
      bpStop = null; bpLoaded = ''; bpInfo = null; bpCount(); musNow(''); npPP(); msState(); setTimeout(bpMarquee, 30);
    } else {
      mountPlayer(bpHost, p, false, { list: true, autoplay: true, at,
        onInfo: info => { if (bpLoaded !== p) return; bpInfo = info; if (!np.hidden) npNow(); setTimeout(bpMarquee, 30); },
        onPlay: () => { bpFails = 0; npPP(); msState(); },
        onPause: () => { npPP(); msState(); bpSavePos(true); },
        onTime: t => { bpPos = t; bpSavePos(); },
        onFail: () => {
          /* it can't be played: say which, mark it, and carry on with the next one */
          bpBad.add(p); bpFails++;
          toast(`Couldn't play "${base(p)}" - ${bpFails > 4 ? 'stopped after 5 songs in a row that wouldn\'t play' : 'skipping it'}`, true);
          if (!np.hidden) npRows();
          if (bpFails > 4) return;
          setTimeout(() => { if (bpLoaded !== p) return; const k = plStep(1); if (k >= 0 && k !== pl.i) bpGo(k); }, 1500);
        },
        prev: () => { const k = plStep(-1); bpGo(k < 0 ? pl.i : k); },
        next: ended => { const k = plStep(1); if (k >= 0) return bpGo(k); if (ended) bpGo(pl.items.indexOf(plOrder()[0]), false); } });
      bpStop = playerStop; bpInfo = null; bpLoaded = p; bpPos = at;
      bpHost.title = p; msMeta(p);
      bpCount(); musNow(p);
    }
    if (!np.hidden) { npNow(); if (wasVisible) npScrollTo(npPos(), false); else npRows(); }
  }
  /* a song that isn't there: open its folder, or the nearest one above it that is */
  async function plShowWhere(p) {
    const known = pl.why && pl.why[p] && pl.why[p][1];
    let d = known || parent(p);
    if (!known) for (let k = 0; k < 8 && d && d !== '/'; k++) {
      try { await api('list', { path: d }); break; } catch (e) { d = parent(d); }
    }
    /* nothing of its path is on this server: the playlist's own folder, or where its other songs are */
    if (!d || d === '/' || !d.startsWith('/mnt/')) { const ok = pl.items.filter(x => !(pl.missing || []).includes(x)); d = ok.length ? commonDir(ok.slice(0, 200)) : pl.file ? parent(pl.file) : '/mnt/user'; }
    if (np.classList.contains('float')) { npFloat = false; npSync(); }
    if (d !== parent(p)) toast(`${base(parent(p))} isn't there - showing ${d}`, true);
    load(A(), d, d === parent(p) ? base(p) : undefined);
  }
  /* a song name too long for the player slides slowly to show the rest */
  function bpMarquee() {
    const t = $('.vp-tags', bpHost); if (!t) return;
    let m = $('.mq', t);
    if (!m) { m = document.createElement('span'); m.className = 'mq'; while (t.firstChild) m.appendChild(t.firstChild); t.appendChild(m); }
    t.classList.remove('mq-on');
    const over = m.scrollWidth - t.clientWidth;
    if (over > 4 && t.clientWidth > 40) { t.style.setProperty('--mq', -(over + 6) + 'px'); t.style.setProperty('--mq-t', Math.max(5, over / 22).toFixed(1) + 's'); t.classList.add('mq-on'); }
  }
  if (window.ResizeObserver) new ResizeObserver(() => bpMarquee()).observe(bpEl);
  /* the song playing, shown in the music library's lists */
  function musNow(p) { if (mus && mus.now !== p) { mus.now = p || null; panes.forEach(drawRows); } }
  /* a preview (or a video) borrows the speakers: afterwards the player carries on */
  function bpSuspend() {
    const v = bpMedia(); if (!v) return () => {};
    const wasPlaying = !v.paused, at = v.currentTime || 0, i = pl.i, p = pl.items[i];
    return () => { if (pl.items[i] !== p || bpMedia()) return; if (wasPlaying) bpGo(i, true, at); else bpGo(i, false); };
  }

  /* play / pause from anywhere: the big button, the computer's own media keys and headphones (Media Session) */
  function bpToggle() {
    const v = bpMedia();
    if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); return; }
    if (!pl.items.length) return;
    if (!store.get('bpshow', false)) bpShow(true, false);
    bpGo(pl.i, true, bpResumeAt());
  }
  function npPP() {
    const b = $('.np-pp', np); if (!b) return;
    const on = bpPlaying();
    b.classList.toggle('on', on); b.disabled = !pl.items.length;
    b.innerHTML = on ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx=".8"/><rect x="9" y="3" width="3" height="10" rx=".8"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l8.5-5z"/></svg>';
    b.title = on ? 'Pause' : 'Play';
  }
  const MS = 'mediaSession' in navigator ? navigator.mediaSession : null;
  function msMeta(p) {
    if (!MS || typeof MediaMetadata === 'undefined') return;
    const ad = plAlbumDir(p);
    try { MS.metadata = new MediaMetadata({ title: songName(p), artist: base(parent(ad)), album: base(ad), artwork: [{ src: new URL(`${API}?action=cover&s=320&path=${encodeURIComponent(ad)}`, location.href).href, sizes: '320x320', type: 'image/jpeg' }] }); } catch (e) {}
  }
  function msState() { if (MS) try { MS.playbackState = bpMedia() ? (bpPlaying() ? 'playing' : 'paused') : 'none'; } catch (e) {} }
  if (MS) {
    const h = (a, f) => { try { MS.setActionHandler(a, f); } catch (e) {} };
    h('play', () => bpToggle()); h('pause', () => { const v = bpMedia(); if (v) v.pause(); });
    h('nexttrack', () => { if (!pl.items.length) return; const k = plStep(1); if (k >= 0) bpGo(k); });
    h('previoustrack', () => { if (!pl.items.length) return; const k = plStep(-1); bpGo(k < 0 ? pl.i : k); });
  }
  /* where the song was: a reload (or closing the page) carries on from there */
  let bpPos = 0, bpPosAt = 0;
  function bpSavePos(now) { if (!bpLoaded) return; if (!now && Date.now() - bpPosAt < 4000) return; bpPosAt = Date.now(); store.set('plpos', { p: bpLoaded, t: Math.floor(bpPos) }); }
  const bpResumeAt = () => { const x = store.get('plpos', null); return x && x.p === pl.items[pl.i] && x.t > 3 ? x.t : 0; };
  window.addEventListener('pagehide', () => bpSavePos(true));

  /* volume: one level for every player, kept on this device (iPads ignore it - their own buttons decide) */
  let volLevel = store.get('vol', 100), volMute = store.get('volmute', false);
  function volApply() {
    $$('audio.vp-v, video.vp-v').forEach(v => { v.volume = Math.max(0, Math.min(1, volLevel / 100)); v.muted = volMute; });
    const vb = $('.bp-vb', bpEl); if (!vb) return;
    vb.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/>${volMute || !volLevel ? '<path d="M11 6l3.5 4M14.5 6L11 10"/>' : `<path d="M10.8 6.2a2.6 2.6 0 0 1 0 3.6"/>${volLevel > 50 ? '<path d="M12.6 4.4a5.2 5.2 0 0 1 0 7.2"/>' : ''}`}</svg>`;
    vb.title = volMute ? 'Sound off - click to turn it back on' : `Volume ${Math.round(volLevel)}% - click to mute`;
    $('.bp-vr', bpEl).value = volLevel;
  }
  {
    if (IS_IOS) $('.bp-vol', bpEl).hidden = true;
    $('.bp-vb', bpEl).addEventListener('click', e => { e.stopPropagation(); volMute = !volMute; store.set('volmute', volMute); volApply(); });
    $('.bp-vr', bpEl).addEventListener('input', e => { volLevel = +e.target.value; volMute = false; store.set('vol', volLevel); store.set('volmute', false); volApply(); });
    $('.bp-vr', bpEl).addEventListener('keydown', e => e.stopPropagation());
    volApply();
  }

  /* the player's own buttons: the song (and its number) open the playlist; ✕ hides the player */
  bpHost.addEventListener('click', e => { if (e.target.closest('.vp-play, .vp-prev, .vp-next') && !bpMedia() && pl.items.length) { e.stopPropagation(); bpGo(pl.i, true, bpResumeAt()); } }, true);   // another player took over: ▶ starts ours again
  bpHost.addEventListener('click', e => { if (e.target.closest('.vp-stage') && !isPinned()) { npFloat = !npFloat; npSync(); } });
  $('.bp-qb', bpEl).addEventListener('click', e => { e.stopPropagation(); if (isPinned()) return npScrollTo(npPos()); npFloat = !npFloat; npSync(); });
  $('.bp-x', bpEl).addEventListener('click', () => bpShow(false));
  if (plBtn) plBtn.addEventListener('click', () => { plBtn.blur(); bpShow(!store.get('bpshow', false)); });
  /* Settings > General > Music player switched on or off */
  function playerSetting() {
    if (!playerOn()) { if (bpMedia()) playerStop(); bpLoaded = ''; npFloat = false; npSync(); }
    else { npSync(); if (store.get('bpshow', false) && !bpLoaded && !bpMedia()) bpGo(pl.i, false); }
  }
  plReady = true;
  if (playerOn() && store.get('bpshow', !!pl.items.length)) setTimeout(() => bpShow(true, false), 300);   // the playlist from last time, ready to play
  else { store.set('bpshow', false); npSync(); }

  /* ---------- video & music player ----------
   * Plays in the browser as it is when the browser can; otherwise (sound the
   * browser can't play - AC3, DTS, TrueHD - or MKV on Safari) the server
   * converts the sound to AAC while it plays, if ffmpeg is switched on in
   * Settings. The picture is never re-encoded. */
  const SID = Math.random().toString(36).slice(2, 12);
  const OK_AUD = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'pcm_s16le']);
  const OK_VID = new Set(['h264', 'hevc', 'vp9', 'av1', 'vp8']);
  const IS_SAFARI = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  const canHevc = () => { const v = document.createElement('video'), t = 'video/mp4; codecs="hvc1.1.6.L120.90"';
    return !!(v.canPlayType(t) || v.canPlayType('video/mp4; codecs="hev1.1.6.L120.90"') || (window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(t))); };
  const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  let playerStop = null;            // one player at a time
  function killMedia(el) { if (playerStop && el && el.querySelector && el.querySelector('.vp-v')) playerStop(); }
  /* song lengths and tags need ffmpeg too: the first time, it's fetched in the background (once a session asked) */
  let ffAsked = false;
  function ffWant() {
    if (ffAsked) return; ffAsked = true;
    api('ffmpeg_status').then(r => { if (r.state === 'none' || r.state === 'error') return api('ffmpeg_get').then(() => toast(`Getting ffmpeg (${r.mb} MB, once) for song lengths - they show up the next time`)); }).catch(() => {});
  }
  /* ffmpeg, the first time something needs it: downloaded in the background, with its progress shown */
  async function ffFetch(st, say, mode, ready) {
    try { await api('ffmpeg_get'); } catch (e) { return; }
    for (let i = 0; i < 600 && !st.dead; i++) {
      let r; try { r = await api('ffmpeg_status'); } catch (e) { return; }
      if (r.state === 'ready') { mode.textContent = ''; toast('ffmpeg is ready - every video plays now'); return ready(); }
      if (r.state === 'error') { mode.textContent = ''; return toast(`Couldn't get ffmpeg: ${r.error}`, true); }
      if (r.state === 'noarray') { mode.textContent = ''; return; }        // its folder is on the array, which is stopped
      mode.textContent = `getting ffmpeg (${r.mb} MB, once) ${r.pct}%…`;
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  function mountPlayer(box, path, isVideo, opt = {}) {
    if (playerStop) playerStop();
    box.innerHTML = `<div class="vp${isVideo ? '' : ' aud'}"><div class="vp-stage">${isVideo ? '<video class="vp-v" playsinline preload="metadata"></video>' : `<div class="vp-art"><span class="gp-ic">${GI.aud}</span><div class="vp-tags"></div></div><audio class="vp-v" preload="metadata"></audio>`}<div class="vp-msg" hidden></div></div>
      <div class="vp-bar">${opt.list ? '<button type="button" class="vp-b vp-prev" title="Previous track (↑)">⏮</button>' : ''}<button type="button" class="vp-b vp-play" title="Play / pause (Space)">▶</button>${opt.list ? '<button type="button" class="vp-b vp-next" title="Next track (↓)">⏭</button>' : ''}<span class="vp-t">0:00</span><input type="range" class="vp-seek" min="0" max="1000" value="0" step="1" aria-label="Position"><span class="vp-d">–:––</span>
        <select class="vp-aud" hidden title="Sound track"></select><select class="vp-sub" hidden title="Subtitles"></select>
        <span class="vp-sync" hidden title="If the sound is out of step with the picture"><button type="button" class="vp-b vp-s" data-d="-25" title="Sound earlier (Shift: 250 ms)">−</button><button type="button" class="vp-sv" title="Back to 0"></button><button type="button" class="vp-b vp-s" data-d="25" title="Sound later (Shift: 250 ms)">+</button></span>
        <span class="vp-mode"></span>${isVideo ? '<button type="button" class="vp-b vp-full" title="Full screen">⛶</button>' : ''}</div></div>`;
    const v = $('.vp-v', box), seek = $('.vp-seek', box), msg = $('.vp-msg', box), aud = $('.vp-aud', box), sub = $('.vp-sub', box), mode = $('.vp-mode', box), pb = $('.vp-play', box), sync = $('.vp-sync', box);
    volApply();
    const st = { sb: -1, vtNeed: false, mode: 'native', t0: 0, a: -1, dur: 0, info: null, dead: false, drag: false, pausedAt: 0, hevc: false, vt: false, ad: store.get('avsync', 0), cues: null, trk: null };
    const say = (t, off = true) => { msg.hidden = !t; msg.innerHTML = t || ''; if (t && off) $('.vp-bar', box).classList.add('off'); };
    const conv = () => st.mode !== 'native';
    const now = () => (conv() ? st.t0 : 0) + (v.currentTime || 0);
    const dur = () => st.dur || (isFinite(v.duration) ? v.duration : 0);
    const syncLabel = () => { $('.vp-sv', box).textContent = st.ad ? `sound ${st.ad > 0 ? '+' : ''}${st.ad} ms` : 'sound in step'; };
    async function start(at, play = true) {
      at = Math.max(0, at || 0);
      sync.hidden = !conv() || !isVideo;      // only pictures can be out of step with sound
      if (!conv()) {
        if (!v.dataset.native) { v.dataset.native = '1'; v.src = rawUrl(path); }
        const go = () => { try { v.currentTime = at; } catch (e) {} if (play) v.play().catch(() => {}); };
        if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
      } else {
        delete v.dataset.native;
        /* the picture starts at the key frame before 'at': the clock and subtitles count from there */
        try { st.t0 = (await api('kf', { path, t: at.toFixed(2) })).t; } catch (e) { st.t0 = at; }
        if (st.dead) return;
        const o = { a: st.a, vc: st.hevc && !st.vt ? 'hevc' : '', vt: st.vt ? 1 : '', h: st.info && st.info.video ? st.info.video.h : 0, ad: st.ad, sb: st.sb >= 0 ? st.sb : '' };
        mode.textContent = 'starting…';
        if (IS_SAFARI) {
          try { await api('hls_start', Object.assign({ path, t: at.toFixed(2), sid: SID }, o)); } catch (e) { return say(esc(e.message)); }
          if (st.dead) return;
          v.src = `${API}?action=hls&sid=${SID}&f=index.m3u8&_=${Date.now()}`;
        } else v.src = `${API}?action=stream&sid=${SID}&t=${at.toFixed(2)}&${new URLSearchParams(o)}${isVideo ? '' : '&ao=1'}&path=${encodeURIComponent(path)}`;
        mode.textContent = !isVideo ? 'sound converted' : st.vt ? `picture & sound converted (${{ nvidia: 'NVIDIA', vaapi: 'graphics', cpu: 'CPU' }[SET.vconv] || ''})` : 'through ffmpeg';
        if (play) v.play().catch(() => {});
      }
    }
    /* the progressive stream keeps the film's own times; Safari's pieces start at 0 */
    v.addEventListener('loadeddata', () => placeSubs());
    playerStop = () => { st.dead = true; try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} if (conv()) api('stream_stop', { sid: SID }).catch(() => {}); playerStop = null; };
    v.addEventListener('timeupdate', () => {
      if (st.drag || st.dead || !box.contains(v)) return;
      const d = dur(); $('.vp-t', box).textContent = fmtT(now()); $('.vp-d', box).textContent = d ? fmtT(d) : '–:––';
      seek.value = d ? Math.round(now() / d * 1000) : 0;
      if (opt.onTime) opt.onTime(now());
    });
    v.addEventListener('play', () => { pb.textContent = '❚❚'; if (opt.onPlay) opt.onPlay(); });
    if (opt.list) {
      v.addEventListener('ended', () => { if (!st.dead && opt.next) opt.next(true); });
      $('.vp-prev', box).addEventListener('click', () => opt.prev && opt.prev());
      $('.vp-next', box).addEventListener('click', () => opt.next && opt.next());
    }
    v.addEventListener('pause', () => { pb.textContent = '▶'; st.pausedAt = Date.now(); if (opt.onPause) opt.onPause(); });
    v.addEventListener('error', () => {
      if (st.dead || !v.getAttribute('src')) return;
      if (!conv() && st.info && st.info.ff) { st.mode = 'conv'; return start(now()); }
      say(st.info && st.info.ff ? `This ${isVideo ? 'video' : 'file'} couldn't be played, even through ffmpeg.`
        : 'This browser can\'t play this file as it is. unCommander is getting ffmpeg (58 MB, once) to convert it while it plays - it opens again by itself when that\'s done.');
      if (opt.onFail) opt.onFail();
    });
    pb.addEventListener('click', () => {
      if (!v.paused) return v.pause();
      if (conv() && IS_SAFARI && Date.now() - st.pausedAt > 20000) return start(now());   // Safari's old pieces are gone after a long pause
      v.play().catch(() => {});
    });
    if (isVideo) v.addEventListener('click', () => pb.click());
    seek.addEventListener('input', () => { st.drag = true; $('.vp-t', box).textContent = fmtT(seek.value / 1000 * dur()); });
    seek.addEventListener('change', () => { st.drag = false; const at = seek.value / 1000 * dur(); if (!conv()) { try { v.currentTime = at; } catch (e) {} } else start(at); });
    aud.addEventListener('change', () => { st.a = +aud.value; const t = now(); st.mode = 'conv'; start(t); });
    let syncT = 0;
    sync.addEventListener('click', e => {
      const b = e.target.closest('[data-d]'), z = e.target.closest('.vp-sv'); if (!b && !z) return;
      st.ad = z ? 0 : Math.max(-3000, Math.min(3000, st.ad + +b.dataset.d * (e.shiftKey ? 10 : 1)));
      store.set('avsync', st.ad); syncLabel();
      clearTimeout(syncT); syncT = setTimeout(() => start(now()), 600);      // several taps, one restart
    });
    syncLabel();
    const full = $('.vp-full', box);
    if (full) full.addEventListener('click', () => { const s = $('.vp', box); if (s.requestFullscreen) s.requestFullscreen().catch(() => v.webkitEnterFullscreen && v.webkitEnterFullscreen()); else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); });

    /* subtitles: WebVTT text from the server, shown by the browser */
    function parseVtt(t) {
      const sec = s => { const p = s.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
      const out = [];
      for (const blk of t.replace(/\r/g, '').split(/\n\n+/)) {
        const lines = blk.split('\n'), k = lines.findIndex(l => l.includes('-->'));
        if (k < 0) continue;
        const [a, b] = lines[k].split('-->');
        out.push([sec(a), sec(b.trim().split(/\s/)[0]), lines.slice(k + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '')]);
      }
      return out;
    }
    function placeSubs() {
      if (!isVideo) return;
      if (!st.trk) { st.trk = v.addTextTrack('subtitles', 'Subtitles'); }
      const tr = st.trk;
      tr.mode = 'hidden'; while (tr.cues && tr.cues.length) tr.removeCue(tr.cues[0]);
      if (!st.cues) return;
      const off = conv() ? st.t0 : 0;      // shown on the stream's own clock
      for (const [a, b, txt] of st.cues) if (b - off > 0) { try { tr.addCue(new VTTCue(Math.max(0, a - off), b - off, txt)); } catch (e) {} }
      tr.mode = 'showing';
    }
    sub.addEventListener('change', async () => {
      const val = sub.value;
      st.cues = null; placeSubs();
      const [kind, ref] = (val || '').split('|');
      /* picture subtitles are drawn into the video by the server: restart with them */
      const sb = kind === 'p' ? +ref : -1;
      if (sb !== st.sb) { st.sb = sb; st.vt = sb >= 0 || st.vtNeed; if (sb >= 0) st.mode = 'conv'; start(now()); }
      if (!val || kind === 'p') return;
      let r;
      try { r = await api('subs_prep', kind === 'x' ? { path, ext: ref } : { path, i: ref }); } catch (e) { return toast(e.message, true); }
      const t0 = Date.now();
      while (!st.dead && sub.value === val) {
        const s = await api('subs_status', { key: r.key }).catch(() => ({}));
        if (s.ready) { st.cues = parseVtt(s.text || ''); placeSubs(); mode.textContent = mode.textContent.replace(/ · subtitles.*$/, ''); return; }
        if (!s.running && !s.ready && Date.now() - t0 > 3000) return toast("Those subtitles couldn't be read", true);
        mode.textContent = mode.textContent.replace(/ · subtitles.*$/, '') + ` · subtitles ${fmtT((Date.now() - t0) / 1000)}…`;
        await new Promise(res => setTimeout(res, 1000));
      }
    });

    /* what's inside decides how to play it */
    (async () => {
      let info = null;
      try { info = await api('media_info', { path }); } catch (e) {}
      if (st.dead) return;
      /* no ffmpeg yet: it's fetched now (once, 58 MB), the video plays as it is meanwhile, and
       * opens again through ffmpeg when it's there */
      if (info && SET.vplay === false) info.ff = false;        // switched off in Settings
      else if (info && info.ff === false && isVideo && info.need !== 'ready') ffFetch(st, say, mode, () => {
        if (st.dead) return;
        const at = now(), playing = !v.paused; st.dead = true;
        mountPlayer(box, path, isVideo, Object.assign({}, opt, { at, autoplay: playing }));
      });
      /* music: the cover (inside the file, or cover.jpg / folder.jpg next to it) and its tags */
      if (!isVideo) {
        const art = $('.vp-art', box), tg = info && info.tags || {};
        $('.vp-tags', box).innerHTML = [tg.title ? `<b>${esc(tg.title)}</b>` : `<b>${esc(base(path))}</b>`, tg.artist && esc(tg.artist), [tg.album, tg.date].filter(Boolean).map(esc).join(' · '),
          info && info.audio && info.audio[0] ? `<span class="muted">${esc([info.audio[0].codec.toUpperCase(), info.audio[0].ch].filter(Boolean).join(' · '))}</span>` : ''].filter(Boolean).join('<br><i class="vt-sep"> · </i>');
        if (info && info.cover) { const im = new Image(); im.className = 'vp-cover'; im.alt = ''; im.onload = () => { const ic = $('.gp-ic', art); if (ic) ic.replaceWith(im); }; im.src = `${API}?action=cover&path=${encodeURIComponent(path)}`; }
      }
      st.info = info;
      if (opt.onInfo) opt.onInfo(info);
      if (info && isVideo) {
        const opts = [];
        const burn = info.ff && SET.vconv && SET.vconv !== 'off';      // picture subtitles need the picture converted
        for (const s of info.subs || []) opts.push(`<option value="${s.text ? 'i|' + s.i : burn ? 'p|' + s.i : ''}"${s.text || burn ? '' : ' disabled'}>${esc([s.lang && s.lang !== 'und' ? s.lang.toUpperCase() : '', s.title, s.forced ? 'forced' : '', s.text ? '' : burn ? '(picture - drawn into the video)' : '(picture - needs "Convert the picture" in Settings)'].filter(Boolean).join(' · ') || 'Subtitles ' + s.i)}</option>`);
        for (const x of info.ext || []) opts.push(`<option value="x|${esc(x.path)}">${esc(x.label)} (file)</option>`);
        if (opts.length && info.ff) { sub.innerHTML = '<option value="">Subtitles off</option>' + opts.join(''); sub.hidden = false; }
      }
      if (info && info.ff) {
        st.dur = info.duration || 0;
        const vc = info.video ? info.video.codec : '';
        st.hevc = /hevc|h265/i.test(vc);
        const cant = isVideo && vc && ((st.hevc && !canHevc()) || !OK_VID.has(vc));
        if (cant) {
          if (SET.vconv && SET.vconv !== 'off') { st.vt = st.vtNeed = true; if (info.video.hdr) say('This is an HDR video: converted, its colours look paler than they should.', false); }
          else {
            toast(st.hevc ? "This video is H.265 (HEVC) - this browser can't play that" : `This browser can't show ${vc.toUpperCase()} video`, true);
            return say((st.hevc ? 'This video is <b>H.265 (HEVC)</b>, and this browser can\'t show H.265. Edge on a PC with H.265 support, or Safari on the iPad and Mac, usually can.'
              : `This video is <b>${esc(vc.toUpperCase())}</b>, which browsers can't show.`) + ' Or switch on <b>Convert the picture</b> in Settings &gt; General.');
          }
        }
        if (info.audio.length) {
          aud.innerHTML = info.audio.map(x => `<option value="${x.i}"${x.default ? ' selected' : ''}>${esc([x.lang && x.lang !== 'und' ? x.lang.toUpperCase() : '', x.title, x.codec.toUpperCase(), x.ch].filter(Boolean).join(' · '))}</option>`).join('');
          aud.hidden = !isVideo && info.audio.length < 2; aud.disabled = info.audio.length < 2;
        }
        const pick = info.audio.find(x => x.default) || info.audio[0];
        st.a = pick ? pick.i : -1;
        const badAud = pick && !OK_AUD.has(pick.codec);
        const badBox = IS_SAFARI ? /\.(mkv|avi|ts|m2ts|wmv|vob|mpe?g)$/i.test(path) : /\.(avi|wmv|vob|mpe?g)$/i.test(path);
        if (st.vt || badAud || badBox || (pick && pick !== info.audio[0]) || (isVideo && SET.vsmooth !== false)) st.mode = 'conv';
      }
      $('.vp-d', box).textContent = st.dur ? fmtT(st.dur) : '–:––';
      start(opt.at || 0, !!opt.autoplay);
    })();
  }
  /* music: a small window with every sound file of the folder as a track list */
  async function openMusic(path) {
    const dir = parent(path);
    const resume = bpSuspend();      // the player at the bottom pauses while this plays, and carries on after
    let handed = false;
    openDlg(base(dir) || dir, `<div class="mp"><div class="vp-host"></div><div class="mp-head"><span class="mp-count"></span></div><ol class="mp-list"></ol></div>`,
      [...(playerOn() ? [{ label: 'Play this album', title: 'Make these songs the playlist and carry on in the player at the bottom', run: () => {
        const v = $('.vp-v', D), at = v && v.currentTime || 0; handed = true;
        if (playerStop) playerStop();
        closeDlg(); plPlay(tracks.map(n => (dir === '/' ? '' : dir) + '/' + n), cur, { at }); return false; } }] : []),
       { label: 'Close', primary: true }], 'music');
    const D = dlg, host = $('.vp-host', D), list = $('.mp-list', D);
    let tracks = [base(path)], cur = 0;
    D.beforeClose = () => { if (playerStop) playerStop(); if (!handed) setTimeout(resume, 50); return true; };
    const draw = () => {
      list.innerHTML = tracks.map((n, i) => `<li data-i="${i}"${i === cur ? ' class="on"' : ''}><span class="mp-n">${i + 1}</span><span class="mp-t">${esc(n)}</span></li>`).join('');
      $('.mp-count', D).textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
      const on = $('li.on', list); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const play = (i, auto = true) => {
      if (!tracks.length || dlg !== D) return;
      cur = (i + tracks.length) % tracks.length;
      for (const li of list.children) li.classList.toggle('on', +li.dataset.i === cur);
      const on = $('li.on', list); if (on) on.scrollIntoView({ block: 'nearest' });
      mountPlayer(host, (dir === '/' ? '' : dir) + '/' + tracks[cur], false, { list: true, autoplay: auto,
        prev: () => play(cur - 1), next: ended => { if (ended && cur === tracks.length - 1) return; play(cur + 1); } });
    };
    list.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) play(+li.dataset.i); });
    D.extraKey = e => {
      if (e.key === ' ') { e.preventDefault(); const b = $('.vp-play', D); if (b) b.click(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); play(cur + (e.key === 'ArrowDown' ? 1 : -1)); }
    };
    draw(); play(0, true);
    try {
      const r = await api('list', { path: dir });
      const all = r.items.filter(([n, t]) => t !== 'd' && GAL_AUD.test(n)).map(([n]) => n).sort((a, b) => collator.compare(a, b));
      if (dlg !== D || !all.length) return;
      tracks = all; cur = Math.max(0, all.indexOf(base(path))); draw();
    } catch (e) {}
  }
  function openPlayer(path) {
    if (!GAL_VID.test(path) && GAL_AUD.test(path)) return openMusic(path);
    const resume = bpSuspend();
    openDlg(base(path), `<div class="vp-host"></div>`, [{ label: 'Close', primary: true }], 'full vp-dlg');
    const D = dlg;
    mountPlayer($('.vp-host', D), path, GAL_VID.test(path));
    D.beforeClose = () => { if (playerStop) playerStop(); setTimeout(resume, 50); return true; };
    D.extraKey = e => { if (e.key === ' ') { e.preventDefault(); const b = $('.vp-play', D); if (b) b.click(); } };
  }

  /* Convert HEIC photos to JPG: each gets a .jpg next to it (never overwriting),
   * all in one History step. */
  async function heicToJpg(paths) {
    let hist = null, ok = 0; const bad = [];
    for (const [i, path] of paths.entries()) {
      toast(`Converting ${i + 1} of ${paths.length}: ${base(path)}…`);
      try {
        const blob = await heicConvert(path, 'image/jpeg', 1);
        const r = await putFile(blob, path, 'new', base(path).replace(/\.hei[cf]$/i, '.jpg'),
          hist ? { join: hist, label: `Converted ${i + 1} HEIC picture${i ? 's' : ''} to JPG` } : { label: `Converted ${base(path)} to JPG` });
        hist = r.hist || hist; ok++;
      } catch (e) { bad.push(`${base(path)}: ${e.message}`); if (/reinstall/.test(e.message)) break; }
    }
    refreshBoth();
    if (bad.length) toast(`Converted ${ok} of ${paths.length}. ${bad.slice(0, 3).join(' · ')}`, true);
    else done(`Converted ${ok} picture${ok === 1 ? '' : 's'} to JPG`, hist);
  }

  /* ---------- colour highlighting (viewer and editor) ----------
   * A small rule-based tokenizer: each language is a list of [regex, class]
   * tried in order at every position; anything unmatched is plain text.
   * Classes: k keyword, s string, n number, c comment, p key/property,
   * v variable, t tag, a attribute, e error, w warning, h heading. */
  const makeHL = () => {
    const W = words => new RegExp('\\b(?:' + words.split(' ').join('|') + ')\\b');
    /* shell words: not when they're part of a path or option (/usr/local, --set) */
    /* No lookbehind anywhere (older iPad Safari chokes on it): a rule's optional
     * third part checks the character before the match instead. */
    const afterSpace = pv => pv === undefined || pv === '\n' || pv === ' ' || pv === '\t';
    const HASHC = [/#.*/, 'c', afterSpace];
    const SW = words => [new RegExp('(?:' + words.split(' ').join('|') + ')(?![\\w/.=-])'), 'k', pv => pv === undefined || !/[\w/.$-]/.test(pv)];
    const STR2 = /"(?:\\[\s\S]|[^"\\\n])*"?/, STR1 = /'(?:\\[\s\S]|[^'\\\n])*'?/, STRB = /`(?:\\[\s\S]|[^`\\])*`?/;
    const NUM = /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i;
    const BLOCK = /\/\*[\s\S]*?(?:\*\/|$)/, LINE = /\/\/.*/, HASH = /#.*/;
    const L = {};
    L.sh = { name: 'Shell', rules: [
      HASHC, [STR2, 's'], [STR1, 's'],
      [/\$\{[^}\n]*\}?|\$\(|\$[\w@#?$!*-]/, 'v'],
      SW('if then else elif fi for while until do done case esac in function return exit local export source set unset shift break continue read cd test declare readonly trap eval exec echo printf sleep'),
      [/^[ \t]*[\w-]+(?=\s*\(\)\s*\{)/m, 'p'], [/^[ \t]*[A-Za-z_]\w*(?==)/m, 'p'], [/\b\d+\b/, 'n']] };
    L.ini = { name: 'Settings (key = value)', rules: [
      [/^[ \t]*[#;].*/m, 'c'], [/^[ \t]*\[[^\]\n]*\]/m, 'h'], [/^[ \t]*[\w.\-\/]+(?=\s*[=:])/m, 'p'],
      [STR2, 's'], [STR1, 's'], [W('true false yes no on off enabled disabled none auto TRUE FALSE YES NO'), 'k'], [NUM, 'n']] };
    L.conf = { name: 'Config file', rules: [
      [/^[ \t]*#.*/m, 'c'], HASHC, [STR2, 's'], [STR1, 's'], [/\$\{?[\w]+\}?/, 'v'],
      [/^[ \t]*[\w.\-]+(?=[ \t=:])/m, 'p'], [W('on off yes no true false'), 'k'], [NUM, 'n']] };
    L.json = { name: 'JSON', rules: [
      [/"(?:\\.|[^"\\\n])*"(?=\s*:)/, 'p'], [STR2, 's'], [W('true false null'), 'k'], [/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i, 'n']] };
    L.yaml = { name: 'YAML', rules: [
      HASHC, [/^[ \t]*-?\s*[^\s#:"'][^:#\n]*?(?=:(?:\s|$))/m, 'p'], [/^[ \t]*-(?=\s)/m, 'k'], [/^---$/m, 'k'],
      [STR2, 's'], [STR1, 's'], [/[&*][\w-]+/, 'v'], [W('true false yes no null on off'), 'k'], [NUM, 'n']] };
    const TAG = /<\/?[\w:.-]+(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/;
    const tagSub = [[/^<\/?[\w:.-]+/, 't'], [/\/?>$/, 't'], [/[\w:.-]+(?=\s*=)/, 'a'], [/"[^"]*"|'[^']*'/, 's']];
    L.xml = { name: 'XML / HTML', rules: [
      [/<!--[\s\S]*?(?:-->|$)/, 'c'], [/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/, 's'], [/<[?!][\s\S]*?(?:\??>|$)/, 'k'],
      [TAG, tagSub], [/&#?\w+;/, 'v']] };
    const CK = 'break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await from as interface type enum implements public private protected readonly abstract namespace declare';
    L.js = { name: 'JavaScript', rules: [
      [BLOCK, 'c'], [LINE, 'c'], [STRB, 's'], [STR2, 's'], [STR1, 's'], [W(CK), 'k'], [W('true false null undefined NaN Infinity'), 'n'], [NUM, 'n'], [/\b[A-Z][\w]*\b/, 'p']] };
    L.php = { name: 'PHP', rules: [
      [/<\?(?:php|=)?|\?>/, 't'], [BLOCK, 'c'], [LINE, 'c'], HASHC, [STR2, 's'], [STR1, 's'], [/\$\w+/, 'v'],
      [W('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while yield'), 'k'],
      [/\b(?:true|false|null|TRUE|FALSE|NULL)\b/, 'n'], [NUM, 'n']] };
    L.css = { name: 'CSS', rules: [
      [BLOCK, 'c'], [STR2, 's'], [STR1, 's'], [/@[\w-]+/, 'k'], [/--[\w-]+/, 'v'], [/#[\da-f]{3,8}\b/i, 'n'],
      [/[\w-]+(?=\s*:[^:{}\n]*[;}])/, 'p', pv => pv !== undefined && /[{;\s]/.test(pv)], [/-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|ch|s|ms|deg|fr)?\b/, 'n'], [/!important/, 'k']] };
    L.py = { name: 'Python', rules: [
      [/"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/, 's'], [HASH, 'c'], [/[rbfu]{0,2}(?:"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/i, 's'], [/@[\w.]+/, 'v'],
      [W('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'), 'k'],
      [W('True False None self'), 'n'], [NUM, 'n']] };
    L.md = { name: 'Markdown', rules: [
      [/^#{1,6} .*/m, 'h'], [/^```[\s\S]*?(?:^```|$(?![\s\S]))/m, 's'], [/`[^`\n]+`/, 's'], [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 'p'],
      [/!?\[[^\]\n]*\]\([^)\n]*\)/, 'a'], [/^[ \t]*(?:[-*+]|\d+\.)(?=\s)/m, 'k'], [/^>.*/m, 'c']] };
    L.log = { name: 'Log', rules: [
      [/\b\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?|\b[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\b/, 'c'],
      [/\b(?:error|errors|err|fail|failed|failure|fatal|critical|crit|panic|denied|refused|unable|cannot|corrupt(?:ed)?|i\/o error|segfault|killed|oom)\b/i, 'e'],
      [/\b(?:warn|warning|deprecated|timeout|timed out|retry|retrying)\b/i, 'w'], [/\b(?:info|notice|ok|success(?:ful)?|started|done)\b/i, 'p'],
      [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/, 'v'], [STR2, 's'], [/\[[\w\-.:\/]+\]/, 'k'], [/\b\d+(?:\.\d+)?\b/, 'n']] };
    L.docker = { name: 'Dockerfile', rules: [
      [/^[ \t]*#.*/m, 'c'], [/^[ \t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/im, 'k'],
      [/\bAS\b/, 'k'], [STR2, 's'], [STR1, 's'], [/\$\{?[\w]+\}?/, 'v'], [NUM, 'n']] };
    L.diff = { name: 'Diff', rules: [[/^\+.*/m, 's'], [/^-.*/m, 'e'], [/^@@.*/m, 'k'], [/^(?:diff|index) .*/m, 'h']] };
    L.none = { name: 'None (plain text)', rules: [] };

    const EXT = { sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', command: 'sh',
      cfg: 'ini', ini: 'ini', env: 'ini', cnf: 'ini', properties: 'ini', desktop: 'ini', service: 'ini', toml: 'ini', network: 'ini',
      conf: 'conf', config: 'conf', rc: 'conf',
      json: 'json', jsonc: 'json', webmanifest: 'json',
      yml: 'yaml', yaml: 'yaml',
      xml: 'xml', plg: 'xml', nfo: 'xml', html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', rss: 'xml', opml: 'xml', page: 'php',
      js: 'js', mjs: 'js', cjs: 'js', ts: 'js', jsx: 'js', tsx: 'js',
      php: 'php', inc: 'php', css: 'css', scss: 'css', less: 'css', py: 'py',
      md: 'md', markdown: 'md', log: 'log', diff: 'diff', patch: 'diff' };
    function detect(path, text) {
      const name = (path.split('/').pop() || '').toLowerCase(), ext = name.includes('.') ? name.split('.').pop() : '';
      if (/^(dockerfile|containerfile)/.test(name)) return 'docker';
      if (/^(docker-)?compose\./.test(name)) return 'yaml';
      if (name === 'go' && /\/boot\/config\/?$/.test(path.slice(0, -name.length))) return 'sh';
      if (/^(syslog|messages|dmesg|kern|daemon)(\.\d+)?$/.test(name) || /\.log(\.\d+)?$/.test(name)) return 'log';
      if (EXT[ext]) return EXT[ext];
      const first = (text || '').slice(0, 200);
      if (/^#!.*\b(ba|z|k)?sh\b/.test(first)) return 'sh';
      if (/^#!.*\bphp\b/.test(first)) return 'php';
      if (/^#!.*\bpython/.test(first)) return 'py';
      if (/^[ \t]*<\?xml|^[ \t]*<!doctype html/i.test(first)) return 'xml';
      if (/^[ \t]*[{[]/.test(first) && /^[ \t]*[{[][\s\S]*[}\]]\s*$/.test((text || '').slice(0, 20000).trimEnd())) return 'json';
      return 'none';
    }
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);
    const WORD = /[A-Za-z0-9_]+/y;
    const sticky = new Map();
    const stick = re => { let r = sticky.get(re); if (!r) { r = new RegExp(re.source, re.flags.replace('g', '').replace('y', '') + 'y'); sticky.set(re, r); } return r; };
    /* -> array of [class|null, text] */
    function tokens(text, rules) {
      const out = []; let i = 0, plain = '';
      const n = text.length, rs = rules.map(([re, c, ok]) => [stick(re), c, ok]);
      let tick = 0;
      while (i < n) {
        if (++tick % 4096 === 0 && Date.now() > deadline) throw new Error('slow');   // give up: shown as plain text
        let hit = null;
        for (const [re, c, ok] of rs) {
          if (ok && !ok(i ? text[i - 1] : undefined)) continue;
          re.lastIndex = i; const m = re.exec(text);
          if (m && m[0].length) { hit = [c, m[0]]; break; }
        }
        if (!hit) {
          /* no rule starts here: if this is a word, no rule can start inside it either */
          const w = /[A-Za-z0-9_]/.test(text[i]) ? (WORD.lastIndex = i, WORD.exec(text)) : null;
          if (w) { plain += w[0]; i += w[0].length; } else plain += text[i++];
          continue;
        }
        if (plain) { out.push([null, plain]); plain = ''; }
        if (Array.isArray(hit[0])) out.push(...tokens(hit[1], hit[0]));
        else out.push(hit);
        i += hit[1].length;
      }
      if (plain) out.push([null, plain]);
      return out;
    }
    /* -> one HTML string per line (tokens that span lines are split) */
    let deadline = 0;
    /* -> one HTML string per line, or null if colouring failed or took too long */
    function lines(text, lang) {
      const rules = (L[lang] || L.none).rules;
      const res = [''];
      let toks;
      try { deadline = Date.now() + 400; toks = tokens(text, rules); } catch (e) { return null; }
      for (const [c, t] of toks) {
        const parts = t.split('\n');
        parts.forEach((part, k) => {
          if (k) res.push('');
          if (part) res[res.length - 1] += c ? `<span class="hl-${c}">${esc(part)}</span>` : esc(part);
        });
      }
      return res;
    }
    const html = (text, lang) => { const l = lines(text, lang); return l ? l.join('\n') : null; };
    const options = cur => Object.entries(L).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v.name}</option>`).join('');
    return { detect, lines, html, options, name: k => (L[k] || L.none).name };
  };
  /* built on first use; if this browser can't build it, files just open without colours */
  let hlObj = null;
  const HL_OFF = { detect: () => 'none', lines: () => null, html: () => null, options: () => '<option value="none" selected>None (not available)</option>', name: () => 'None' };
  const getHL = () => {
    if (hlObj) return hlObj;
    try { hlObj = makeHL(); }
    catch (e) { hlObj = HL_OFF; errBar(errText(e, 'Colour highlighting is off in this browser')); }
    return hlObj;
  };

  /* which colours to use for a file: the user's pick for that kind of file, or a guess */
  const HL_EDIT_MAX = 400000;
  const hlKey = path => { const n = base(path).toLowerCase(); return 'hl.' + (n.includes('.') ? n.split('.').pop() : n); };
  const hlLang = (path, text) => SET.highlight === false ? 'none' : store.get(hlKey(path), null) || getHL().detect(path, text);
  const hlPicker = lang => `<label class="hl-pick" title="Colour highlighting for this kind of file">Colours <select>${getHL().options(lang)}</select></label>`;
  /* Wrap long lines (viewer and editor, remembered on this device) */
  const wrapOn = () => store.get('wrap', true) === true;      // on unless turned off: long lines are never cut off at the window's edge
  const wrapBox = () => `<label class="hl-pick wrap-pick" title="Wrap long lines - when off, scroll sideways (scroll bar, or Shift + mouse wheel). Alt+Z switches it."><input type="checkbox" class="wrap-cb"${wrapOn() ? ' checked' : ''}> Wrap</label>`;
  /* Alt+Z (as in VS Code): wrap on / off */
  const wrapKey = e => { if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) { e.preventDefault(); const cb = $('.wrap-cb', dlg); if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } return true; } };

  /* ---------- viewer (F2) ---------- */
  /* if anything in the viewer or editor goes wrong, say so instead of doing nothing */
  async function openViewer(...a) { try { return await viewFile(...a); } catch (e) { console.error(e); toast(`Couldn't open it: ${e.message || e}`, true); errBar(errText(e, 'View')); } }
  async function viewFile(path, o = {}) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (IMG_EXT.has(ext) || ext === 'pdf') return openMedia(path, o);
    if (/\.m3u8?$/i.test(path) && playerOn() && !o.text) return plOpenFile(path);
    if (GAL_VID.test(path) || GAL_AUD.test(path)) return openPlayer(path);
    if (isArchive(path)) return openArchiveList(path, o);
    let v;
    try { v = await api('peek', { path, line: o.line || 1 }); } catch (e) { return toast(e.message, true); }
    const backBtn = o.back ? [{ label: '‹ Results', run: () => { o.back(); return false; } }] : [];
    if (v.binary) return openDlg(base(path), `<div class="muted">Binary file · ${fmtBytes(v.size)} — it can't be shown as text.</div>`, [...backBtn, { label: 'Close', primary: true }]);
    const text = v.text.replace(/\r$/gm, '');
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const last = v.first + lines.length - 1;
    let lang = hlLang(path, text);
    /* search hits (from Find) are marked instead of colouring */
    const render = () => {
      let html = null;
      if (!o.re && lang !== 'none') { try { html = getHL().lines(text, lang); } catch (e) { html = null; } }
      return lines.map((l, i) => {
        const no = v.first + i;
        return `<div class="vw-l${no === o.line ? ' hit' : ''}"><span class="vw-n">${no}</span><span class="vw-t">${(html ? html[i] : markText(l, o.re)) || ' '}</span></div>`;
      }).join('');
    };
    const body = render();
    const edit = () => { openEditor(path, { line: o.line, back: o.back }); return false; };
    openDlg(base(path), `
      <div class="vw-top"><div class="vw-meta mono">${esc(path)} · ${fmtBytes(v.size)}${v.partial ? ` · lines ${v.first.toLocaleString()}–${last.toLocaleString()}${v.more ? ' (file continues)' : ''}` : ''}</div>${wrapBox()}${o.re ? '' : hlPicker(lang)}</div>
      <div class="vw${wrapOn() ? ' wrap' : ''}" style="--gw:${String(last).length + 1}ch">${body}</div>`,
      [...backBtn, { label: 'Edit', run: edit }, { label: 'Close', primary: true }], 'full');
    const box = $('.vw', dlg), hit = $('.vw-l.hit', box);
    const pick = $('.hl-pick select', dlg);
    if (pick) pick.addEventListener('change', () => { lang = pick.value; store.set(hlKey(path), lang); const top = box.scrollTop; box.innerHTML = render(); box.scrollTop = top; box.focus({ preventScroll: true }); });
    $('.wrap-cb', dlg).addEventListener('change', e => { store.set('wrap', e.target.checked); box.classList.toggle('wrap', e.target.checked); if (hit) box.scrollTop = hit.offsetTop - box.clientHeight / 3; box.focus({ preventScroll: true }); });
    if (hit) box.scrollTop = hit.offsetTop - box.clientHeight / 3;
    box.tabIndex = 0; box.focus({ preventScroll: true });
    dlg.extraKey = e => { if (wrapKey(e)) return; if (e.key === 'F3') { e.preventDefault(); edit(); } };
  }

  /* ---------- Clean up: what unCommander keeps, how big, cleared on request ---------- */
  async function openCleanup() {
    const CK = 'clean';
    openToolDlg(CK, 'Clean up', '<div class="cl-list"><div class="mc-busy"><span class="spin"></span><span>Measuring - the trash on every disk can take a little while…</span></div></div>',
      [{ label: 'Close' }, { label: 'Clean up', primary: true, run: () => go() }], 'wide cl-dlg');
    const D = tdlg, gen = D.gen;
    tmodal.classList.add('over');                 // above Settings, which opened it
    D.beforeClose = () => { tmodal.classList.remove('over'); return true; };
    let items = [];
    try { items = (await api('clean_scan')).items; } catch (e) { $('.cl-list', D).innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; return; }
    if (D.gen !== gen) return;
    const pre = new Set(['cache', 'left']);
    $('.cl-list', D).innerHTML = items.map(x => `<label class="chk cl-row"><input type="checkbox" data-ck="${x.key}"${pre.has(x.key) && x.bytes ? ' checked' : ''}${x.bytes || (x.key === 'hist' && x.n) ? '' : ' disabled'}><span class="cl-t"><span class="cl-h"><b>${esc(x.label)}</b><span class="cl-sz">${x.bytes ? fmtBytes(x.bytes) : 'nothing'}${x.key === 'hist' && x.n ? ` · ${x.n.toLocaleString()} step${x.n === 1 ? '' : 's'}` : ''}${x.key === 'trash' && x.n ? ` · in ${x.n} place${x.n === 1 ? '' : 's'}` : ''}</span></span><span class="cl-d">${esc(x.about)}</span></span></label>`).join('')
      + `<div class="cl-tot muted"></div>`;
    const tot = () => { const n = items.filter(x => { const c = $(`[data-ck="${x.key}"]`, D); return c && c.checked; }).reduce((a, x) => a + x.bytes, 0); $('.cl-tot', D).textContent = n ? `Picked: ${fmtBytes(n)}` : 'Tick what to clear.'; };
    $('.cl-list', D).addEventListener('change', tot); tot();
    async function go() {
      const keys = items.filter(x => { const c = $(`[data-ck="${x.key}"]`, D); return c && c.checked; }).map(x => x.key);
      if (!keys.length) { toast('Tick what to clear first', true); return false; }
      if (keys.includes('trash') && !D.sureTrash) { D.sureTrash = true; toast('The trash is deleted for good - press Clean up again to go ahead', true); return false; }
      $('.cl-tot', D).innerHTML = '<span class="spin"></span> Cleaning up…';
      let r; try { r = await api('clean_run', { keys: JSON.stringify(keys) }); } catch (e) { toast(e.message, true); return false; }
      sound.play('done');
      toast(`Cleaned up ${r.done.join(', ').toLowerCase()} - freed ${fmtBytes(r.freed)}`);
      refreshBoth();
      return true;
    }
  }
  /* "Select all" (the browser's right-click menu, or Ctrl+A) while the viewer or editor is open:
   * only the text in it, not the whole page behind */
  document.addEventListener('selectionchange', () => {
    if (!dlg.isConnected || !dlg.offsetParent) return;
    const vw = $('.vw', dlg), ta = $('textarea.ed', dlg); if (!vw && !ta) return;
    const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return;
    const box = vw || ta;
    if (!sel.containsNode(box, false) || box.contains(sel.anchorNode)) return;      // a normal selection inside it
    if (vw) { const rg = document.createRange(); rg.selectNodeContents(vw); sel.removeAllRanges(); sel.addRange(rg); }
    else { sel.removeAllRanges(); ta.focus({ preventScroll: true }); ta.select(); }
  });
  /* ---------- editor (F3) ---------- */
  async function openEditor(...a) { try { return await editFile(...a); } catch (e) { console.error(e); toast(`Couldn't open it: ${e.message || e}`, true); errBar(errText(e, 'Edit')); } }
  async function editFile(path, o = {}) {
    let f;
    try { f = await api('open_edit', { path }); } catch (e) { return toast(e.message, true); }
    let saved = f.text, mtime = f.mtime;
    const backBtn = o.back ? [{ label: '‹ Results', run: () => { if (dlg.beforeClose && !dlg.beforeClose()) return false; dlg.beforeClose = null; o.back(); return false; } }] : [];
    openDlg(`Edit · ${base(path)}`, `
      <div class="vw-top"><div class="vw-meta mono">${esc(path)}${SET.practice ? ' · <span class="uc-error">practice mode - look only, saving is locked</span>' : f.writable ? '' : ' · <span class="uc-error">read-only — saving will fail</span>'}${f.crlf ? ' · Windows line endings (kept)' : ''}</div>${wrapBox()}${f.text.length > HL_EDIT_MAX ? '<span class="hl-pick muted" title="Colours are switched off for very large files so typing stays fast">No colours (large file)</span>' : hlPicker(hlLang(path, f.text))}</div>
      <div class="ed-wrap"><div class="ed-hl" hidden></div><pre class="ed-pre" aria-hidden="true"></pre><textarea class="ed" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" wrap="off"></textarea></div>
      <div class="ed-status mono"><span class="ed-pos"></span><span class="ed-dirty"></span></div>`,
      [...backBtn, { label: 'Close' }, ...(SET.practice ? [] : [{ label: 'Save', primary: true, run: async () => { await save(); return false; } }])], 'full');
    const ta = $('.ed', dlg);
    ta.value = f.text;
    /* colours: a <pre> drawn behind the textarea (whose own text is made
     * transparent), redrawn as you type and scrolled in step with it */
    const pre = $('.ed-pre', dlg), wrap = $('.ed-wrap', dlg);
    /* wrapping: the coloured copy must break lines exactly where the textarea does,
     * so it gets the same width (the textarea's scrollbar is added to its padding) */
    const fitPre = () => { const c = getComputedStyle(ta); const sb = ta.offsetWidth - ta.clientWidth - parseFloat(c.borderLeftWidth) - parseFloat(c.borderRightWidth); pre.style.paddingRight = (parseFloat(c.paddingRight) + Math.max(0, sb)) + 'px'; };
    const setWrap = on => { wrap.classList.toggle('wrap', on); ta.setAttribute('wrap', on ? 'soft' : 'off'); fitPre(); pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
    setWrap(wrapOn());
    $('.wrap-cb', dlg).addEventListener('change', e => { store.set('wrap', e.target.checked); setWrap(e.target.checked); $('.ed-hl', dlg).hidden = true; ta.focus({ preventScroll: true }); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (dlg.contains(ta)) fitPre(); }).observe(ta);
    let lang = f.text.length > HL_EDIT_MAX ? 'none' : hlLang(path, f.text), hlRaf = 0;
    const paint = () => {
      cancelAnimationFrame(hlRaf);
      hlRaf = requestAnimationFrame(() => {
        const on = lang !== 'none' && ta.value.length <= HL_EDIT_MAX;
        let h = null;
        if (on) { try { h = getHL().html(ta.value, lang); } catch (e) { h = null; } }
        wrap.classList.toggle('hl-on', h != null);
        if (h != null) { pre.innerHTML = h + '\n'; fitPre(); pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
        else pre.textContent = '';
      });
    };
    ta.addEventListener('input', paint);
    ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
    const epick = $('.hl-pick select', dlg);
    if (epick) epick.addEventListener('change', () => { lang = epick.value; store.set(hlKey(path), lang); paint(); ta.focus({ preventScroll: true }); });
    paint();
    if (SET.practice) ta.readOnly = true;
    const dirty = () => ta.value !== saved;
    dlg.beforeClose = () => !dirty() || confirm('You have unsaved changes. Close without saving?');
    let raf = 0;
    const status = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!dlg.contains(ta)) return;
        const pos = ta.selectionStart, v = ta.value;
        let ln = 1, ls = 0;
        for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) { ln++; ls = i + 1; }
        $('.ed-pos', dlg).textContent = `Line ${ln}, Col ${pos - ls + 1}`;
        const d = $('.ed-dirty', dlg); d.textContent = dirty() ? '● unsaved changes' : 'saved'; d.classList.toggle('on', dirty());
      });
    };
    ['input', 'click', 'keyup', 'select'].forEach(ev => ta.addEventListener(ev, status));
    /* Jump to the line: caret at its start, and a highlight bar behind it
     * (not a selection — typing would replace a selected line). */
    let start = 0;
    for (let i = 1; i < (o.line || 1); i++) { const nx = ta.value.indexOf('\n', start); if (nx === -1) break; start = nx + 1; }
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, start);
    const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 18, padTop = parseFloat(cs.paddingTop) || 0;
    ta.scrollTop = Math.max(0, ((o.line || 1) - 1) * lh - ta.clientHeight / 3);
    const hl = $('.ed-hl', dlg);
    const placeHl = () => { hl.style.top = (padTop + ((o.line || 1) - 1) * lh - ta.scrollTop) + 'px'; hl.style.height = lh + 'px'; };
    if (o.line && !wrapOn()) {
      hl.hidden = false; placeHl();
      ta.addEventListener('scroll', placeHl);
      ta.addEventListener('input', () => { hl.hidden = true; ta.removeEventListener('scroll', placeHl); }, { once: true });
    }
    status();
    dlg.extraKey = e => {
      if (wrapKey(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (e.key === 'Tab' && e.target === ta && !e.shiftKey) { e.preventDefault(); ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end'); status(); }
    };
    async function save(force) {
      try {
        const r = await api('save_edit', { path, text: ta.value, mtime, crlf: f.crlf ? '1' : '0', force: force ? '1' : '0' });
        saved = ta.value; mtime = r.mtime; status(); toast('Saved');
        if (A().mode === 'dir' && A().path === parent(path)) { A().stats.delete(base(path)); drawRows(A()); queueStat(A()); }
      } catch (e) {
        if (e.message === 'changed') { if (confirm('This file was changed on disk after you opened it. Overwrite it with your version?')) return save(true); return; }
        toast(e.message, true);
      }
    }
  }

  /* ---------- practice mode ---------- */
  /* Settings > Safety. Look around, view, find, copy (never replacing
   * anything) and make folders; everything that can lose or change data is
   * locked. The server enforces the same list. */
  const PRACTICE_LOCKED = { rename: 'Rename', move: 'Move', delete: 'Delete', perms: 'Permissions', restore: 'Restore' };
  function applyPractice() {
    const on = !!SET.practice;
    $('.uc-practice').hidden = !on;
    $$('.uc-fk[data-act]').forEach(b => b.classList.toggle('locked', on && b.dataset.act in PRACTICE_LOCKED));
    root.classList.toggle('uc-practicing', on);
  }
  function practiceBlocked(name) {
    if (!SET.practice || !(name in PRACTICE_LOCKED)) return false;
    sound.play('error');
    toast(`Practice mode is on - ${PRACTICE_LOCKED[name]} is locked. Turn it off in Settings > Safety.`, true);
    return true;
  }

  /* ---------- Compare (More row, style A: marks in the panes) ----------
   * Compares the two panes' folders (top level). Both panes get tags; the
   * ACTIVE pane is the source - its "only here" and "newer" items are
   * ticked, so F5 copies exactly those to the other pane. Tapping the other
   * pane makes it the source instead. Leaving either folder ends it. */
  const CMP_TAG = { only: 'only here', newer: 'newer', older: 'older', differ: 'differs', both: 'folder in both' };
  let cmpOn = false;
  async function startCompare(again) {
    const [L, R] = panes;
    if (L.mode !== 'dir' || R.mode !== 'dir' || L.root || R.root) return toast('Open a folder in both panes first', true);
    let r;
    try { r = await api('compare', { left: L.path, right: R.path }); } catch (e) { return toast(e.message, true); }
    L.cmp = new Map(Object.entries(r.left)); R.cmp = new Map(Object.entries(r.right));
    cmpOn = true; if (!again) sound.play('open');
    for (const p of panes) if (p.tree && p.tree.size) await applySort(p);     // the tree folds away while comparing
    tickCompare();
  }
  function tickCompare() {
    const src = A(), dst = B();
    for (const p of panes) {
      p.sel.clear();
      if (p === src) p.items.forEach((it, i) => { const st = !it.up && p.cmp && p.cmp.get(it.n); if (st === 'only' || st === 'newer') p.sel.add(i); });
      drawRows(p); updateSelInfo(p);
    }
    const count = (p, st) => p.items.filter(it => !it.up && p.cmp && p.cmp.get(it.n) === st).length;
    const ticked = src.sel.size, sName = src.i ? 'Right' : 'Left', dName = dst.i ? 'Right' : 'Left';
    const LBL = { only: 'only here', newer: 'newer', older: 'older', differ: 'differ', both: 'folders in both', same: 'the same' };
    const sum = p => {
      const parts = ['only', 'newer', 'older', 'differ', 'both', 'same'].map(st => [st, count(p, st)]).filter(([, n]) => n);
      return parts.length ? parts.map(([st, n]) => `<span class="cs ${st}"><i></i><b>${n}</b> ${n === 1 && st === 'both' ? 'folder in both' : n === 1 && st === 'differ' ? 'differs' : LBL[st]}</span>`).join('')
        : '<span class="cs none">empty folder</span>';
    };
    const card = p => `<div class="cb-card${p === src ? ' src' : ''}">
        <div class="cb-h"><span class="cb-side">${p.i ? 'Right' : 'Left'}</span><span class="cb-role">${p === src ? 'Source' : 'Target'}</span></div>
        <div class="cb-counts">${sum(p)}</div></div>`;
    const bar = $('.uc-cmpbar');
    bar.hidden = false;
    bar.innerHTML = `${card(panes[0])}
      <div class="cb-dir${src.i ? ' left' : ''}" title="Copy direction"><span>➔</span></div>
      ${card(panes[1])}
      <div class="cb-foot">
        <div class="cb-msg">${ticked
          ? `<b>${ticked}</b> item${ticked === 1 ? '' : 's'} ticked on the ${sName} - missing or older on the ${dName}. <b>F5 Copy</b> sends ${ticked === 1 ? 'it' : 'them'} to the ${dName}.`
          : `Nothing on the ${sName} is missing or older on the ${dName}.`}
          <span class="muted">Tap the ${dName} pane to compare the other way.</span></div>
        <button class="uc-btn cb-full" title="Compare everything, including inside subfolders, in a window where you choose what goes which way">⊞ Detailed compare…</button>
        <button class="uc-btn cb-close">✕ Close compare</button>
      </div>`;
    $('.cb-close', bar).addEventListener('click', () => endCompare());
    $('.cb-full', bar).addEventListener('click', () => openCompareTree());
    centerGlyph($('.cb-dir', bar));
    panes.forEach(p => { drawRows(p); queueStat(p); });
  }
  /* Centre a symbol's ink (not its font box) inside a round button. Fallback
   * symbol fonts sit high or low, and differently on iPad, Windows and Linux,
   * so measure the real glyph and shift it by the difference. */
  function centerGlyph(box) {
    const sp = box && box.firstElementChild; if (!sp) return;
    try {
      box.style.removeProperty('--cb-dx'); box.style.removeProperty('--cb-dy');
      const cs = getComputedStyle(sp), ctx = (centerGlyph.c ||= document.createElement('canvas')).getContext('2d');
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx.measureText(sp.textContent);
      const mark = document.createElement('i'); mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      sp.style.transform = 'none'; sp.appendChild(mark);
      const r = sp.getBoundingClientRect(), base = mark.getBoundingClientRect().bottom;
      mark.remove(); sp.style.transform = '';
      const inkY = base + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
      const inkX = r.left + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
      const dy = (r.top + r.height / 2) - inkY, dx = (r.left + r.width / 2) - inkX;
      if (isFinite(dy) && Math.abs(dy) < 20) box.style.setProperty('--cb-dy', dy.toFixed(2) + 'px');
      if (isFinite(dx) && Math.abs(dx) < 20) box.style.setProperty('--cb-dx', dx.toFixed(2) + 'px');
    } catch (e) {}
  }
  /* ---------- Detailed compare (style B): a window, subfolders included ----------
   * Lists every difference between the two panes' folders, all the way down.
   * Each row has an arrow you can tap: → copy to the right, ← copy to the
   * left, = leave alone. One button copies both ways. Nothing is deleted. */
  const CT_FILTERS = [
    ['diff', 'Differences', x => x.st !== 'same'], ['only-l', 'Only left'], ['only-r', 'Only right'],
    ['newer-l', 'Newer left'], ['newer-r', 'Newer right'], ['differ', 'Same date, different size'], ['same', 'Same'], ['all', 'Everything', () => true]];
  const CT_SHOW = 2500;
  async function openCompareTree() {
    const [L, R] = panes;
    if (L.mode !== 'dir' || R.mode !== 'dir' || L.root || R.root) return toast('Open a folder in both panes first', true);
    const ct = { L: L.path, R: R.path, rows: [], filter: 'diff', act: new Map() };
    openDlg('Compare folders, subfolders included', `
      <div class="ct-paths"><div><span class="ct-lbl">Left</span><span class="mono" title="${esc(ct.L)}">${esc(ct.L)}</span></div>
        <div><span class="ct-lbl">Right</span><span class="mono" title="${esc(ct.R)}">${esc(ct.R)}</span></div></div>
      <div class="ct-wait"><span class="spin"></span> Reading both folders, all the way down… Large folders and sleeping disks can take a minute.</div>
      <div class="ct-main" hidden>
        <div class="ct-filters"></div>
        <div class="ct-bulk"><span class="muted">For every row shown:</span>
          <button class="uc-btn" data-bulk="sug" title="Back to what unCommander suggests">↺ Suggested</button>
          <button class="uc-btn" data-bulk="r">→ Copy right</button>
          <button class="uc-btn" data-bulk="l">← Copy left</button>
          <button class="uc-btn" data-bulk="n">= Leave</button></div>
        <div class="ct-table"><div class="ct-row ct-h"><div>Left</div><div class="r">Size</div><div>Date</div><div class="c">Do</div><div>Right</div><div class="r">Size</div><div>Date</div></div><div class="ct-body"></div></div>
        <div class="muted ct-help">Tap an arrow to change what happens to that row: <b>→</b> copy to the right, <b>←</b> copy to the left, <b>=</b> leave alone.
          An <span class="ct-rep">amber</span> arrow replaces the copy on the other side. Folders that exist on one side only are one row - copying it copies everything inside.
          Nothing is ever deleted here.${SET.practice ? ' <b>Practice mode:</b> files that already exist are never replaced, so amber rows are skipped.' : ''}</div>
      </div>`,
      [{ label: 'Close' }, { label: 'Copy', primary: true, run: () => runCompareTree(ct) }], 'full ct-dlg');
    const foot = $('.dlg-foot', dlg);
    foot.insertAdjacentHTML('afterbegin', '<span class="ct-foot muted">Compared by name, size and date</span>');
    ct.go = $$('.dlg-foot .uc-btn', dlg).pop(); ct.go.disabled = true;
    let r;
    try { r = await api('compare_tree', { left: ct.L, right: ct.R }); }
    catch (e) { const w = $('.ct-wait', dlg); if (w) w.innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; return; }
    if (!$('.ct-wait', dlg)) return;      // window closed meanwhile
    ct.rows = r.rows.map(([p, st, l, rr]) => ({ p, st, l, r: rr }));
    ct.counts = r.counts;
    ct.rows.forEach(x => ct.act.set(x.p, ctSuggest(x)));
    $('.ct-wait', dlg).hidden = true; $('.ct-main', dlg).hidden = false;
    $('.ct-foot', dlg).textContent = `Compared by name, size and date · ${(r.scanned[0] + r.scanned[1]).toLocaleString()} items read in ${r.secs} s`
      + (r.cut ? ' · stopped early - the folders are very large, so this list is incomplete' : '');
    $('.ct-filters', dlg).addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { ct.filter = b.dataset.f; ctDraw(ct); } });
    $('.ct-bulk', dlg).addEventListener('click', e => {
      const b = e.target.closest('[data-bulk]'); if (!b) return;
      for (const x of ctShown(ct)) {
        const want = b.dataset.bulk === 'sug' ? ctSuggest(x) : b.dataset.bulk;
        ct.act.set(x.p, ctOptions(x).includes(want) ? want : 'n');
      }
      ctDraw(ct);
    });
    $('.ct-body', dlg).addEventListener('click', e => {
      const b = e.target.closest('.ct-do'); if (!b) return;
      const x = ct.rows[+b.dataset.i], o = ctOptions(x), cur = ct.act.get(x.p);
      ct.act.set(x.p, o[(o.indexOf(cur) + 1) % o.length]);
      ctDraw(ct);
    });
    ctDraw(ct);
  }
  const ctSuggest = x => ({ 'only-l': 'r', 'newer-l': 'r', 'only-r': 'l', 'newer-r': 'l' })[x.st] || 'n';
  const ctOptions = x => x.st === 'only-l' ? ['r', 'n'] : x.st === 'only-r' ? ['l', 'n'] : x.st === 'same' ? ['n', 'r', 'l'] : ['r', 'l', 'n'];
  function ctShown(ct) {
    const f = CT_FILTERS.find(([k]) => k === ct.filter);
    return ct.rows.filter(f[2] || (x => x.st === ct.filter));
  }
  function ctDraw(ct) {
    const body = $('.ct-body', dlg); if (!body) return;
    const n = k => { const f = CT_FILTERS.find(([q]) => q === k); return k === 'all' ? Object.values(ct.counts).reduce((a, b) => a + b, 0) : k === 'diff' ? Object.entries(ct.counts).filter(([q]) => q !== 'same').reduce((a, [, b]) => a + b, 0) : ct.counts[k] || 0; };
    $('.ct-filters', dlg).innerHTML = CT_FILTERS.map(([k, label]) => {
      const c = n(k);
      return (c || ['diff', 'all'].includes(k)) ? `<button class="ct-f${ct.filter === k ? ' on' : ''}" data-f="${k}">${label} <b>${c.toLocaleString()}</b></button>` : '';
    }).join('');
    const shown = ctShown(ct), idx = new Map(ct.rows.map((x, i) => [x.p, i]));
    const side = (x, s) => {
      if (!s) return '<div class="ct-name none"></div><div></div><div></div>';
      const i = x.p.lastIndexOf('/'), dir = i >= 0 ? x.p.slice(0, i + 1) : '', nm = x.p.slice(i + 1);
      const size = s[0] ? (s[3] === 0 ? 'empty' : s[3] != null ? `${s[3].toLocaleString()} file${s[3] === 1 ? '' : 's'}` : '') : fmtBytes(s[1]);
      return `<div class="ct-name${s[0] ? ' dir' : ''}" title="${esc(x.p)}"><span class="nm">${s[0] ? '▸ ' : ''}${esc(nm)}</span>${dir ? `<span class="in">${esc(dir)}</span>` : ''}</div>
        <div class="r num">${size}${s[0] && s[3] ? `<span class="in">${fmtBytes(s[1])}</span>` : ''}</div><div class="num">${fmtDate(s[2])}</div>`;
    };
    const ARROW = { r: '→', l: '←', n: '=' };
    body.innerHTML = shown.slice(0, CT_SHOW).map(x => {
      const a = ct.act.get(x.p), rep = (a === 'r' && x.r) || (a === 'l' && x.l);
      const tip = a === 'n' ? 'Leave alone' : (a === 'r' ? 'Copy to the right' : 'Copy to the left') + (rep ? ', replacing the copy there' : '');
      return `<div class="ct-row st-${x.st} do-${a}">${side(x, x.l)}<div class="c"><button class="ct-do${rep ? ' rep' : ''}" data-i="${idx.get(x.p)}" title="${tip} - tap to change">${ARROW[a]}</button></div>${side(x, x.r)}</div>`;
    }).join('') + (shown.length > CT_SHOW ? `<div class="ct-more muted">Showing the first ${CT_SHOW.toLocaleString()} of ${shown.length.toLocaleString()} rows. The arrows on hidden rows still count; use a filter to see them.</div>` : '')
      + (!shown.length ? `<div class="ct-more muted">${ct.filter === 'diff' ? 'No differences - both folders match, subfolders included.' : 'Nothing here.'}</div>` : '')
      + ((ct.filter === 'same' || ct.filter === 'all') && (ct.counts.same || 0) > 5000 ? `<div class="ct-more muted">Only the first 5,000 identical files are listed.</div>` : '');
    let toR = 0, toL = 0;
    for (const x of ct.rows) { const a = ct.act.get(x.p); if (a === 'r') toR++; else if (a === 'l') toL++; }
    ct.go.disabled = !(toR + toL);
    ct.go.textContent = toR + toL ? 'Copy ' + [toR && `${toR.toLocaleString()} → right`, toL && `${toL.toLocaleString()} ← left`].filter(Boolean).join(', ') : 'Nothing to copy';
  }
  async function runCompareTree(ct, sure) {
    const pick = d => ct.rows.filter(x => ct.act.get(x.p) === d);
    const toR = pick('r'), toL = pick('l');
    const reps = SET.practice ? [] : [...toR.filter(x => x.r).map(x => [join(ct.R, x.p), x.r]), ...toL.filter(x => x.l).map(x => [join(ct.L, x.p), x.l])];
    if (reps.length && !sure) {
      confirmReplace({ count: reps.length, bytes: reps.reduce((a, [, s]) => a + (s[1] || 0), 0), sample: reps.slice(0, 8).map(([p]) => p) },
        'This compare copy', () => runCompareTree(ct, true));
      return false;
    }
    const over = reps.length > 0;
    const ids = []; let hist = '';
    if (toR.length) { const r = await api('job_start', { type: 'sync', root: ct.L, dest: ct.R, rel: toR.map(x => x.p), overwrite: over ? 1 : 0 }); ids.push(r.job); hist = r.hist || ''; }
    if (toL.length) ids.push((await api('job_start', { type: 'sync', root: ct.R, dest: ct.L, rel: toL.map(x => x.p), overwrite: over ? 1 : 0, hist_join: hist })).job);
    if (cmpOn) endCompare();
    openProgress(ids[0]);
    if (progress) ids.forEach(i => progress.ids.add(i));
    return false;          // the progress window replaces this one
  }
  function endCompare(quiet) {
    if (!cmpOn) return;
    cmpOn = false;
    panes.forEach(p => { p.cmp = null; if (!quiet) p.sel.clear(); if (p.tree && p.tree.size && p.mode === 'dir') applySort(p); drawRows(p); updateSelInfo(p); });
    $('.uc-cmpbar').hidden = true;
    panes.forEach(p => { drawRows(p); queueStat(p); });
  }

  /* ---------- Batch rename (More row) ----------
   * Rules on top, a before -> after list below; nothing changes until the
   * Rename button. The server renames all or nothing, and Undo puts them back. */
  async function openBatchRename(p, t) {
    /* dates are needed for [date] and "order by date" */
    const need = t.map(x => x.it.abs || x.it.n).filter(k => !(p.stats.get(k) || {}).m);
    if (need.length) { try { const r = await api('stat', { path: p.path, names: need }); for (const [k, v] of Object.entries(r.stats)) p.stats.set(k, v || {}); } catch (e) {} }
    const bdir = parent(t[0].path);
    const items = t.map(x => ({ n: x.it.n, dir: x.it.t === 'd', m: (p.stats.get(x.it.abs || x.it.n) || {}).m || 0, on: true }));
    const renaming = new Set(items.map(i => i.n));
    const others = new Set((bdir === p.path ? p.all : (p.tree && p.tree.get(bdir)) || []).map(i => i.n).filter(n => !renaming.has(n)));   // names staying put in this folder
    const st = { mode: 'replace', find: '', repl: '', mcase: false, first: false, regex: false, keepExt: true,
                 addText: '', addWhere: 'before', pattern: '[name] [n]', start: 1, digits: 2, order: 'name', caseTo: 'lower' };
    const folder = base(bdir);
    const pad = (n, d) => String(n).padStart(d, '0');
    const fmtD = m => { const d = new Date(m * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`; };
    const split = (it) => { if (it.dir || !st.keepExt) return [it.n, '']; const i = it.n.lastIndexOf('.'); return i > 0 ? [it.n.slice(0, i), it.n.slice(i)] : [it.n, '']; };
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const titleCase = s => s.toLowerCase().replace(/(^|[\s_\-.(\[])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

    function compute() {
      let err = '';
      let re = null;
      if (st.mode === 'replace' && st.find) {
        try { re = new RegExp(st.regex ? st.find : reEsc(st.find), (st.first ? '' : 'g') + (st.mcase ? '' : 'i') + 'u'); }
        catch (e) { err = 'That pattern isn\'t valid: ' + e.message; }
      }
      const order = [...items].sort((a, b) => st.order === 'date' ? (a.m - b.m) || collator.compare(a.n, b.n) : collator.compare(a.n, b.n));
      const num = new Map(); let k = +st.start || 0;
      order.forEach(it => { if (it.on) num.set(it, k++); });
      for (const it of items) {
        const [stem, ext] = split(it);
        let nw = stem, hiOld = esc(stem), hiNew = null;
        if (st.mode === 'replace' && re) {
          nw = stem.replace(re, st.repl);
          if (nw !== stem) {
            try { hiOld = stem.replace(re, m => '\u0001' + m + '\u0002'); hiOld = esc(hiOld).replace(/\u0001/g, '<mark class="del">').replace(/\u0002/g, '</mark>'); } catch (e) {}
            try { hiNew = esc(stem.replace(re, m => '\u0001' + m.replace(new RegExp(re.source, re.flags.replace('g', '')), st.repl) + '\u0002')).replace(/\u0001/g, '<mark class="add">').replace(/\u0002/g, '</mark>'); } catch (e) {}
          }
        } else if (st.mode === 'add' && st.addText) {
          nw = st.addWhere === 'before' ? st.addText + stem : stem + st.addText;
          hiNew = st.addWhere === 'before' ? `<mark class="add">${esc(st.addText)}</mark>${esc(stem)}` : `${esc(stem)}<mark class="add">${esc(st.addText)}</mark>`;
        } else if (st.mode === 'number') {
          const n = num.has(it) ? pad(num.get(it), Math.max(1, Math.min(9, +st.digits || 1))) : '';
          nw = st.pattern.replace(/\[n\]/gi, n).replace(/\[name\]/gi, stem).replace(/\[date\]/gi, it.m ? fmtD(it.m) : '').replace(/\[folder\]/gi, folder);
        } else if (st.mode === 'case') {
          nw = st.caseTo === 'lower' ? stem.toLowerCase() : st.caseTo === 'upper' ? stem.toUpperCase() : st.caseTo === 'title' ? titleCase(stem) : stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
        }
        it.new = nw + ext;
        it.hiOld = hiOld + esc(ext);
        it.hiNew = (hiNew != null ? hiNew : esc(nw)) + esc(ext);
      }
      /* problems: bad names, two files ending up with the same name, or a name already used by something not being renamed */
      const counts = new Map();
      for (const it of items) if (it.on) { const key = it.new.toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1); }
      for (const it of items) {
        it.prob = '';
        if (!it.on) { it.st = 'off'; continue; }
        if (it.new === it.n) { it.st = 'same'; continue; }
        if (!it.new.trim() || it.new === '.' || it.new === '..') it.prob = 'the new name is empty';
        else if (/[\/\0]/.test(it.new)) it.prob = 'names can\'t contain /';
        else if (new Blob([it.new]).size > 255) it.prob = 'the new name is too long';
        else if (it.new !== it.new.trim()) it.prob = 'starts or ends with a space';
        else if (others.has(it.new)) it.prob = `"${it.new}" already exists here`;
        else if (counts.get(it.new.toLowerCase()) > 1) it.prob = 'another file would get the same name';
        it.st = it.prob ? 'bad' : 'go';
      }
      return err;
    }

    const modeTabs = [['replace', 'Replace text'], ['add', 'Add text'], ['number', 'Number'], ['case', 'Change case']];
    openDlg('Batch rename', `
      <div class="br-top"><span class="br-seg">${modeTabs.map(([k, l]) => `<button data-mode="${k}" class="${k === st.mode ? 'on' : ''}">${l}</button>`).join('')}</span>
        <span class="muted">${items.length} item${items.length === 1 ? '' : 's'} ticked in <span class="mono">${esc(folder || p.path)}</span></span></div>
      <div class="br-rules"></div>
      <details class="br-help"><summary></summary><div class="br-help-body"></div></details>
      <div class="br-err uc-error" hidden></div>
      <div class="br-tbl"><div class="br-tr h"><div></div><div>Now</div><div></div><div>After</div><div></div></div><div class="br-rows"></div></div>
      <div class="br-sum"></div>`,
      [{ label: 'Cancel' }, { label: 'Rename', primary: true, run: () => doRename() }], 'full br-dlg');
    const foot = $('.dlg-foot', dlg);
    foot.insertAdjacentHTML('afterbegin', `<span class="br-note">${SET.practice ? '🔒 Practice mode is on - preview only.' : 'Nothing changes until you press Rename. Undo puts the old names back.'}</span>`);
    const go = $$('.dlg-foot .uc-btn', dlg).pop();
    const rulesEl = $('.br-rules', dlg), rowsEl = $('.br-rows', dlg), sumEl = $('.br-sum', dlg), errEl = $('.br-err', dlg);
    const chk = (k, l) => `<label class="chk"><input type="checkbox" data-k="${k}" ${st[k] ? 'checked' : ''}> ${l}</label>`;
    const txt = (k, l, ph, w) => `<div class="field"${w ? ` style="max-width:${w}"` : ''}><label>${l}</label><input type="text" data-k="${k}" value="${esc(String(st[k]))}" placeholder="${esc(ph || '')}" spellcheck="false" autocapitalize="off" autocorrect="off"></div>`;
    /* Number help, worked through with the files you actually ticked */
    function numberHelp() {
      const ex = [...items].sort((a, b) => collator.compare(a.n, b.n)).filter(i => !i.dir).slice(0, 2);
      if (ex.length < 2) ex.push(...[...items].sort((a, b) => collator.compare(a.n, b.n)).filter(i => !ex.includes(i)).slice(0, 2 - ex.length));
      const make = (pat, it, n, digits) => {
        const [stem, ext] = split(it);
        return pat.replace(/\[n\]/gi, String(n).padStart(digits, '0')).replace(/\[name\]/gi, stem).replace(/\[date\]/gi, it.m ? fmtD(it.m) : '2024-07-15').replace(/\[folder\]/gi, folder) + ext;
      };
      const rows = [
        ['Photo [n]', 'Start at 1, Digits 2', 1, 2, 'Plain words plus a number that counts up.'],
        ['[folder] - [n]', 'Start at 1, Digits 2', 1, 2, `The folder's name ("${folder}") plus a number.`],
        ['[name] - Part [n]', 'Start at 1, Digits 1', 1, 1, 'Keeps each old name and adds a part number.'],
        ['[date] [name]', 'no number needed', 1, 2, "Puts each file's date in front of its old name."],
      ];
      const cell = s => `<span class="mono">${esc(s)}</span>`;
      return `<p>Type a <b>pattern</b> into the <b>New name</b> box. Words you type are used exactly as typed. The <b>building blocks</b> in [square brackets] are swapped for something different for each file - tap a block to drop it in where the cursor is.</p>
        <table class="br-hl"><tr><td class="mono">[n]</td><td>a number that goes up by one for each file. <b>Start at</b> is the first number; <b>Digits</b> adds zeros in front so they sort neatly (2 digits: 01, 02 … 10).</td></tr>
          <tr><td class="mono">[name]</td><td>the file's name as it is now (without the extension)</td></tr>
          <tr><td class="mono">[date]</td><td>the date of the file, like 2024-07-15</td></tr>
          <tr><td class="mono">[folder]</td><td>the name of this folder: "${esc(folder)}"</td></tr></table>
        <p><b>Examples with your files</b> - the first two of the ones you ticked:</p>
        <table class="br-ex"><tr><th>Type in New name</th><th>Set</th><th>${esc(ex[0] ? ex[0].n : '')}<br>becomes</th>${ex[1] ? `<th>${esc(ex[1].n)}<br>becomes</th>` : ''}</tr>
          ${rows.map(([pat, set, start, dg, why]) => `<tr><td>${cell(pat)}<div class="muted">${why}</div></td><td>${set}</td>
            <td>${cell(make(pat, ex[0], start, dg))}</td>${ex[1] ? `<td>${cell(make(pat, ex[1], start + 1, dg))}</td>` : ''}</tr>`).join('')}</table>
        <p><b>Order</b> decides which file gets which number: <i>Name</i> = alphabetical; <i>Date</i> = oldest first, so photos stay in the order they were taken. Unticked files don't use up a number.</p>
        <p class="muted">Every new name has to be different, so a pattern with no [n] and no [name] would give every file the same name - those rows turn red.</p>`;
    }
    function drawHelp() {
      const label = modeTabs.find(m => m[0] === st.mode)[1];
      $('.br-help summary', dlg).textContent = `How does ${label} work?`;
      $('.br-help-body', dlg).innerHTML = (st.mode === 'number' ? numberHelp() : BR_HELP[st.mode]) + BR_HELP.common;
    }
    function drawRules() {
      drawHelp();
      const keep = chk('keepExt', 'Leave extensions alone (.mkv, .jpg …)');
      rulesEl.innerHTML = st.mode === 'replace' ? `<div class="br-grid">${txt('find', 'Find', 'e.g. IMG_')}${txt('repl', 'Replace with', 'leave empty to remove it')}</div>
          <div class="radios">${chk('mcase', 'Match upper/lower case')}${chk('first', 'First match only')}${chk('regex', 'Advanced pattern (regex)')}${keep}</div>`
        : st.mode === 'add' ? `<div class="br-grid">${txt('addText', 'Text to add', 'e.g. 2024 - ')}
            <div class="field"><label>Where</label><div class="radios"><label class="chk"><input type="radio" name="brw" value="before" ${st.addWhere === 'before' ? 'checked' : ''}> Before the name</label><label class="chk"><input type="radio" name="brw" value="after" ${st.addWhere === 'after' ? 'checked' : ''}> After the name</label></div></div></div>
          <div class="radios">${keep}</div>`
        : st.mode === 'number' ? `<div class="br-grid">${txt('pattern', 'New name', '[name] [n]')}
            <div class="field"><label>Building blocks - tap to add</label><div class="br-chips">${[['[n]', 'number'], ['[name]', 'old name'], ['[date]', 'file date'], ['[folder]', 'folder name']].map(([c, l]) => `<button data-chip="${c}">${c} ${l}</button>`).join('')}</div></div></div>
          <div class="radios"><label class="chk">Start at <input type="text" data-k="start" value="${esc(String(st.start))}" inputmode="numeric" class="br-small"></label>
            <label class="chk">Digits <input type="text" data-k="digits" value="${esc(String(st.digits))}" inputmode="numeric" class="br-small"></label>
            <label class="chk">Order <select data-k="order"><option value="name" ${st.order === 'name' ? 'selected' : ''}>Name</option><option value="date" ${st.order === 'date' ? 'selected' : ''}>Date (oldest first)</option></select></label>${keep}</div>`
        : `<div class="radios">${[['lower', 'lower case'], ['upper', 'UPPER CASE'], ['title', 'Title Case'], ['sentence', 'Sentence case']].map(([v, l]) => `<label class="chk"><input type="radio" name="brc" value="${v}" ${st.caseTo === v ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          <div class="radios">${keep}</div>`;
    }
    function drawRows() {
      const err = compute();
      errEl.hidden = !err; errEl.textContent = err;
      const lim = 500;
      const ICON = { go: ['✓', 'will be renamed'], same: ['=', 'no change'], off: ['–', 'unticked - left alone'], bad: ['⚠', 'problem'] };
      rowsEl.innerHTML = items.slice(0, lim).map((it, i) => `<div class="br-tr ${it.st}">
          <div><input type="checkbox" data-i="${i}" ${it.on ? 'checked' : ''}></div>
          <div class="nm">${it.st === 'go' ? it.hiOld : esc(it.n)}</div><div class="ar">→</div>
          <div class="nm new">${it.st === 'go' || it.st === 'bad' ? it.hiNew : it.st === 'same' ? '<span class="muted">no change</span>' : '<span class="muted">left alone</span>'}${it.st === 'bad' ? `<div class="prob">⚠ ${esc(it.prob)}</div>` : ''}</div>
          <div class="ic" title="${ICON[it.st][1]}">${ICON[it.st][0]}</div></div>`).join('')
        + (items.length > lim ? `<div class="br-tr more"><div></div><div class="muted">…and ${items.length - lim} more (the summary below counts them all)</div></div>` : '');
      const n = s => items.filter(it => it.st === s).length;
      const goN = n('go'), bad = n('bad');
      sumEl.innerHTML = `<b class="ok">${goN} will be renamed</b><span class="muted">${n('same')} unchanged · ${n('off')} unticked</span>${bad ? `<b class="bad">${bad} problem${bad > 1 ? 's' : ''}</b><span>- untick ${bad > 1 ? 'them' : 'it'} or change the rule</span>` : '<span class="muted">no problems</span>'}`;
      go.textContent = `Rename ${goN} item${goN === 1 ? '' : 's'}`;
      go.disabled = SET.practice || !goN || !!bad || !!err;
    }
    $$('.br-seg button', dlg).forEach(b => b.addEventListener('click', () => {
      st.mode = b.dataset.mode; $$('.br-seg button', dlg).forEach(x => x.classList.toggle('on', x === b)); drawRules(); drawRows();
    }));
    const onRule = e => {
      const k = e.target.dataset.k;
      if (k) st[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (e.target.name === 'brw') st.addWhere = e.target.value;
      if (e.target.name === 'brc') st.caseTo = e.target.value;
      drawRows();
    };
    rulesEl.addEventListener('input', onRule);
    rulesEl.addEventListener('change', onRule);
    rulesEl.addEventListener('click', e => {
      const c = e.target.closest('[data-chip]'); if (!c) return;
      const inp = $('input[data-k="pattern"]', rulesEl); const pos = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, pos) + c.dataset.chip + inp.value.slice(inp.selectionEnd ?? pos); st.pattern = inp.value;
      inp.focus(); inp.setSelectionRange(pos + c.dataset.chip.length, pos + c.dataset.chip.length); drawRows();
    });
    rowsEl.addEventListener('change', e => { const i = e.target.dataset.i; if (i != null) { items[+i].on = e.target.checked; drawRows(); } });
    /* Rename for real: all or nothing on the server, then reload with the new names ticked */
    async function doRename() {
      if (compute() || items.some(it => it.st === 'bad')) return false;
      const pairs = items.filter(it => it.st === 'go').map(it => [it.n, it.new]);
      if (!pairs.length) return false;
      go.disabled = true; go.textContent = `Renaming ${pairs.length}…`;
      let r;
      try { r = await api('batch_rename', { path: bdir, pairs }); }
      catch (e) { toast(e.message, true); drawRows(); return false; }
      const dir = p.path;
      closeDlg();
      await brReload(p, dir, pairs.map(x => x[1]));
      done(`Renamed ${r.count} item${r.count === 1 ? '' : 's'}`, r.hist);
      return false;
    }
    drawRules(); drawRows();
    const f = $('input[data-k="find"]', rulesEl); if (f) f.focus();
  }
  /* after a batch rename (or its undo): reload the folder with those names ticked */
  async function brReload(p, dir, names) {
    if (p.mode !== 'dir' || p.path !== dir) { panes.forEach(q => { if (q.mode === 'dir' && q.path === dir) refresh(q); }); return; }
    await load(p, dir, names[0]);
    const want = new Set(names);
    p.items.forEach((it, i) => { if (!it.up && want.has(it.n)) p.sel.add(i); });
    drawRows(p); updateChrome(); saveSel();
    const o = panes.find(q => q !== p && q.mode === 'dir' && q.path === dir); if (o) refresh(o);
  }
  const BR_HELP = {
    replace: `<p>Finds some text in each name and swaps it for something else. Leave "Replace with" empty to simply remove the text.</p>
      <ul><li><span class="mono">Summer Trip_Beach.jpg</span> - find <span class="mono">_</span>, replace with <span class="mono"> - </span> → <span class="mono">Summer Trip - Beach.jpg</span></li>
        <li><span class="mono">The.Office.S01E01.mkv</span> - find <span class="mono">.</span>, replace with a space → <span class="mono">The Office S01E01.mkv</span> (the extension is left alone)</li>
        <li><span class="mono">Movie [1080p].mkv</span> - find <span class="mono"> [1080p]</span>, replace with nothing → <span class="mono">Movie.mkv</span></li></ul>
      <p><b>Match upper/lower case</b>: off, "img" also finds "IMG". <b>First match only</b>: change just the first place it appears in each name.</p>
      <p class="muted"><b>Advanced pattern (regex)</b> is for experts: e.g. find <span class="mono">\s*\(\d{4}\)</span> removes a year in brackets like " (2014)".</p>`,
    add: `<p>Puts the same text in front of, or after, every name.</p>
      <ul><li>Before, <span class="mono">2024 - </span>: <span class="mono">Beach.jpg</span> → <span class="mono">2024 - Beach.jpg</span></li>
        <li>After, <span class="mono"> (copy)</span>: <span class="mono">Beach.jpg</span> → <span class="mono">Beach (copy).jpg</span></li></ul>
      <p class="muted">Include any spaces or dashes you want between the old name and the new text.</p>`,
    number: `<p>Builds every new name from a <b>pattern</b> you type in "New name". Plain text is copied as it is; the <b>building blocks</b> in square brackets are filled in for each file. Tap a block to add it where the cursor is.</p>
      <table class="br-hl"><tr><td class="mono">[n]</td><td>a number that counts up: the first file gets "Start at", the next one more, and so on. "Digits" pads it with zeros: 2 digits gives 01, 02 … 10; 3 digits gives 001, 002 …</td></tr>
        <tr><td class="mono">[name]</td><td>the file's current name (without its extension)</td></tr>
        <tr><td class="mono">[date]</td><td>the file's date, written like 2024-07-15</td></tr>
        <tr><td class="mono">[folder]</td><td>the name of the folder the files are in</td></tr></table>
      <p><b>Examples</b></p>
      <ul><li><span class="mono">Italy 2024 - [n]</span>, 3 digits → <span class="mono">Italy 2024 - 001.jpg</span>, <span class="mono">Italy 2024 - 002.jpg</span> …</li>
        <li><span class="mono">[date] [name]</span> → <span class="mono">2024-07-15 IMG_4512.jpg</span></li>
        <li><span class="mono">[folder] - [n]</span> in "Season 1", 2 digits → <span class="mono">Season 1 - 01.mkv</span>, <span class="mono">Season 1 - 02.mkv</span> …</li>
        <li><span class="mono">Episode [n]</span>, start at 5 → <span class="mono">Episode 05.mkv</span>, <span class="mono">Episode 06.mkv</span> …</li></ul>
      <p><b>Order</b> decides which file gets which number: <i>Name</i> numbers them alphabetically; <i>Date</i> numbers them oldest first - handy for photos, so they stay in the order they were taken. Unticked files don't use up a number.</p>
      <p class="muted">Every name needs to come out different, so a pattern without [n] (or [name]) gives every file the same name - those rows turn red.</p>`,
    case: `<p>Changes upper and lower case only - the letters stay the same.</p>
      <ul><li><b>lower case</b>: <span class="mono">My HOLIDAY Photo</span> → <span class="mono">my holiday photo</span></li>
        <li><b>UPPER CASE</b>: → <span class="mono">MY HOLIDAY PHOTO</span></li>
        <li><b>Title Case</b>: → <span class="mono">My Holiday Photo</span></li>
        <li><b>Sentence case</b>: → <span class="mono">My holiday photo</span></li></ul>`,
    common: `<h4>Safety checks (every tab)</h4><ul>
      <li><b>Now</b> is today's name, <b>After</b> is what it will become. Nothing changes until you press <b>Rename</b>, and one Undo puts every name back.</li>
      <li><b>Leave extensions alone</b> (on by default) keeps .mkv, .jpg and so on exactly as they are.</li>
      <li>A row turns <b style="color:var(--danger)">red</b> if the new name is already used in this folder, if two files would end up with the same name, or if the name isn't allowed. Rename stays off until every red row is fixed or unticked.</li>
      <li>Untick any row to leave that file alone. The mark at the end of each row: ✓ will be renamed · = no change · – left alone · ⚠ problem.</li></ul>`,
  };

  /* ---------- Compress / Extract (More row) ---------- */
  const ARCH_RE = /\.(zip|rar|7z|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|iso|cab|arj|lzh)$/i;
  const isArchive = path => ARCH_RE.test(path);
  /* inside an archive: the strip under the pane header, and the function keys that can't work there look switched off */
  function arcShow(p) {
    const bar = $('.uc-arcbar', p.el);
    if (bar) { bar.hidden = !p.arc; if (p.arc) { const t = $('.ab-t', bar); t.textContent = ''; t.append('Inside ', Object.assign(document.createElement('b'), { textContent: base(p.arc.file) }), ' · read-only'); } }
    arcKeys();
  }
  function arcKeys() {
    const p = panes[active], o = panes[1 - active]; if (!p) return;
    $$('.uc-fk[data-act]').forEach(b => {
      const a = b.dataset.act;
      const off = (p.arc && a in ARC_NO) || (o && o.arc && (a === 'copy' || a === 'move')) || (p.arc && a === 'move');
      b.classList.toggle('arc-off', !!off);
      if (off) { if (!('t0' in b.dataset)) b.dataset.t0 = b.title; b.title = p.arc && ARC_NO[a] ? ARC_NO[a] : 'The other pane is inside an archive, which opens read-only'; }
      else if ('t0' in b.dataset) { b.title = b.dataset.t0; delete b.dataset.t0; }
    });
  }
  const ARC_RO = "That's inside an archive, which opens read-only - copy it out first (F5)";
  const ARC_NO = { rename: ARC_RO, move: "Inside an archive nothing can be moved - copy it out instead (F5)", delete: "Inside an archive nothing can be deleted - it opens read-only", mkdir: ARC_RO, newfile: ARC_RO,
    perms: ARC_RO, brename: ARC_RO, compress: 'Copy it out of the archive first (F5), then compress it', extract: 'Copy it out of the archive first (F5)', restore: ARC_RO,
    sizes: 'The sizes are shown already - inside an archive every file has its size', find: "Find doesn't look inside archives - go up out of it first", compare: "Compare doesn't work inside archives - copy it out first" };
  /* an archive that needs its password: asked once, kept in memory on the server until the next reboot */
  function arcPassword(p, file, path, focusName, why) {
    openDlg(`Password for ${base(file)}`, `<div class="field"><label>Password</label><input type="password" class="arc-pw" autocomplete="off" spellcheck="false"></div>
      <div class="muted">${esc(why && /not right/.test(why) ? 'That password is not right - try again.' : 'This archive is locked with a password.')} It's kept in the server's memory (not on the flash drive) until the next reboot.</div>`,
      [{ label: 'Cancel' }, { label: 'Open', primary: true, run: async () => {
        await api('arc_password', { file, password: $('.arc-pw', dlg).value });
        setTimeout(() => load(p, path, focusName), 0);
      } }]);
    const i = $('.arc-pw', dlg);
    if (i) { i.focus(); i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const b = $('.uc-btn.primary', dlg); b && b.click(); } }); }
  }
  function openCompress(p, q, t) {
    const one = t.length === 1;
    const stem = one ? t[0].it.n.replace(/\.[^./]{1,5}$/, '') || t[0].it.n : base(p.path) || 'archive';
    const other = q.mode === 'dir' && !q.root ? q.path : null;
    openDlg(`Compress ${one ? esc(t[0].it.n) : t.length + ' items'}`, `
      <div class="field"><label>Archive name</label><input type="text" class="f-name" value="${esc(stem)}.zip"></div>
      <div class="field"><label>Type</label><div class="radios col ind">
        <label class="chk"><input type="radio" name="fmt" value="zip" checked> Zip <span class="muted">· opens on any computer or phone</span></label>
        <label class="chk"><input type="radio" name="fmt" value="tgz"> tar.gz <span class="muted">· Linux / unRAID</span></label></div></div>
      <div class="field"><label>Save it in</label><div class="radios col ind">
        ${other ? `<label class="chk"><input type="radio" name="dst" value="other" checked> The other pane <span class="mono muted">${esc(other)}</span></label>` : ''}
        <label class="chk"><input type="radio" name="dst" value="here" ${other ? '' : 'checked'}> This folder <span class="mono muted">${esc(p.path)}</span></label></div></div>
      <hr class="dlg-hr">
      <label class="chk f-store-l"><input type="checkbox" class="f-store" checked><span>Don't squeeze photos and videos <span class="muted">· they're already compressed, so this is much faster</span></span></label>
      <label class="chk"><input type="checkbox" class="f-remove" ${SET.practice ? 'disabled' : ''}><span>Delete the originals once the archive is saved <span class="muted">· ${SET.practice ? 'locked in Practice mode' : SET.trash === false ? 'the trash is off, so they\'re removed for good' : 'they go to the trash, so you can still get them back'}</span></span></label>
      <div class="muted">${t.length} item${t.length === 1 ? '' : 's'}. Runs as a job with a progress window - closing the window doesn't stop it.</div>`,
      [{ label: 'Cancel' }, { label: 'Compress', primary: true, run: async () => {
        const fmt = $('input[name=fmt]:checked', dlg).value;
        const dest = $('input[name=dst]:checked', dlg).value === 'other' ? other : p.path;
        const r = await api('job_start', { type: 'compress', sources: t.map(x => x.path), dest, format: fmt, name: $('.f-name', dlg).value.trim(),
          store: fmt === 'zip' && $('.f-store', dlg).checked ? '1' : '0', remove: $('.f-remove', dlg).checked ? '1' : '0' });
        p.sel.clear(); openProgress(r.job); return false;
      } }], 'pm-dlg');
    const nameEl = $('.f-name', dlg);
    nameEl.setSelectionRange(0, stem.length);
    $$('input[name=fmt]', dlg).forEach(r => r.addEventListener('change', () => {
      const zip = $('input[name=fmt]:checked', dlg).value === 'zip';
      nameEl.value = nameEl.value.replace(/\.(zip|tar\.gz|tgz)$/i, '') + (zip ? '.zip' : '.tar.gz');
      $('.f-store-l', dlg).hidden = !zip;
    }));
  }
  async function openExtract(p, q, x) {
    const other = q.mode === 'dir' && !q.root ? q.path : null;
    let sub = x.it.n.replace(/(\.part0*1)?\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tzst|tar|zip|rar|7z|gz|bz2|xz|zst|iso|cab|arj|lzh)$/i, '') || x.it.n;
    let parts = [x.it.n];
    openDlg(`Extract ${esc(x.it.n)}`, `
      <div class="ex-card">
        <div class="ex-ic">⇧</div>
        <div class="ex-main"><div class="ex-name">${esc(x.it.n)}</div><div class="ex-sum muted">Reading the archive…</div></div>
        <button class="uc-btn ex-list">List contents</button>
      </div>
      <div class="field"><label>Extract to</label><div class="radios col ind">
        ${other ? `<label class="chk"><input type="radio" name="dst" value="other" checked><span>The other pane <span class="mono muted">${esc(other)}</span></span></label>` : ''}
        <label class="chk"><input type="radio" name="dst" value="here" ${other ? '' : 'checked'}><span>This folder <span class="mono muted">${esc(p.path)}</span></span></label></div></div>
      <div class="ind"><label class="chk"><input type="checkbox" class="f-sub" checked><span class="f-sub-t"></span></label></div>
      <div class="field"><label>If a file already exists</label><div class="radios col ind">
        <label class="chk"><input type="radio" name="ex" value="skip" checked><span>Keep the one that's there <span class="muted">· skip it</span></span></label>
        <label class="chk"><input type="radio" name="ex" value="overwrite" ${SET.practice ? 'disabled' : ''}><span>Replace it with the one from the archive${SET.practice ? ' <span class="muted">· locked in Practice mode</span>' : ''}</span></label></div></div>
      <hr class="dlg-hr">
      <label class="chk"><input type="checkbox" class="f-remove" ${SET.practice ? 'disabled' : ''}><span>Delete the archive once everything is extracted <span class="muted ex-rm-note">· ${SET.practice ? 'locked in Practice mode' : SET.trash === false ? 'the trash is off, so it\'s removed for good' : 'it goes to the trash, so you can still get it back'}</span></span></label>
      <div class="muted">Runs as a job with a progress window - closing the window doesn't stop it.</div>`,
      [{ label: 'Cancel' }, { label: 'Extract', primary: true, run: async () => {
        const dest = $('input[name=dst]:checked', dlg).value === 'other' ? other : p.path;
        const r = await api('job_start', { type: 'extract', sources: [x.path], dest, sub: $('.f-sub', dlg).checked ? sub : '',
          exists: $('input[name=ex]:checked', dlg).value, remove: $('.f-remove', dlg).checked ? '1' : '0' });
        openProgress(r.job); return false;
      } }], 'pm-dlg ex-dlg');
    $('.ex-list', dlg).addEventListener('click', () => openArchiveList(x.path, { back: () => openExtract(p, q, x) }));
    const subT = () => {
      const dest = $('input[name=dst]:checked', dlg).value === 'other' ? other : p.path;
      $('.f-sub-t', dlg).innerHTML = `Into a new folder named <b class="mono">${esc(sub)}</b> in <span class="mono muted">${esc(dest)}</span>`;
    };
    subT();
    $$('input[name=dst]', dlg).forEach(r => r.addEventListener('change', subT));
    try {
      const r = await api('archive_list', { path: x.path });
      const el = $('.ex-sum', dlg); if (!el) return;
      sub = r.base || sub; subT();
      el.textContent = `${r.files.toLocaleString()} file${r.files === 1 ? '' : 's'}${r.dirs ? ` in ${r.dirs.toLocaleString()} folder${r.dirs === 1 ? '' : 's'}` : ''} · ${fmtBytes(r.bytes)} when unpacked${r.more ? ' (and more)' : ''}`;
      if (r.parts && r.parts.length > 1) {
        parts = r.parts;
        el.textContent += ` · ${r.parts.length} parts`;
        const note = $('.ex-rm-note', dlg); if (note && !SET.practice) note.textContent = `· all ${r.parts.length} parts ${SET.trash === false ? 'are removed for good' : 'go to the trash'}`;
      }
    } catch (e) {
      const el = $('.ex-sum', dlg); if (el) { el.className = 'ex-sum uc-error'; el.textContent = e.message; }
    }
  }
  async function openArchiveList(path, o = {}) {
    let r;
    try { r = await api('archive_list', { path }); } catch (e) { return toast(e.message, true); }
    const backBtn = o.back ? [{ label: '‹ Back', run: () => { o.back(); return false; } }] : [];
    openDlg(`Inside ${esc(base(path))}`, `
      <div class="muted">${r.files.toLocaleString()} file${r.files === 1 ? '' : 's'}${r.dirs ? ` in ${r.dirs.toLocaleString()} folder${r.dirs === 1 ? '' : 's'}` : ''} · ${fmtBytes(r.bytes)} when unpacked${r.more ? ' · showing the first 3,000' : ''}</div>
      <div class="ar-list">${r.entries.map(([n, d, sz]) => `<div class="ar-row${d ? ' dir' : ''}"><span class="mono">${esc(n)}${d ? '/' : ''}</span><span class="num">${d ? '' : fmtSize(sz)}</span></div>`).join('')}</div>`,
      [...backBtn, ...(o.back ? [] : [{ label: 'Extract…', run: () => { const p = A(); const it = p.items.find(i => fullPath(p, i) === path); if (it) openExtract(p, B(), { it, path }); return false; } }]), { label: 'Close', primary: true }], 'wide');
  }

  /* ---------- folder sizes (More row) ----------
   * Adds up everything inside the ticked folders (or the one under the
   * cursor) on the server. Closing the window doesn't stop it; the totals land
   * in the Size column and the selection tally when they're ready. */
  const dirSize = (p, it) => p.dirSizes ? p.dirSizes.get(it.abs || it.n) : undefined;
  let sizeRun = null;
  async function openSizes(p, dirs) {
    let r;
    try { r = await api('size_start', { paths: dirs.map(x => x.path) }); } catch (e) { return toast(e.message, true); }
    const run = sizeRun = { id: r.id, p, origin: p.mode === 'dir' ? p.path : null, keys: new Map(dirs.map(x => [x.path, x.it.abs || x.it.n])), t0: Date.now(), last: null };
    const n = dirs.length;
    openDlg(`Folder sizes · ${n === 1 ? esc(base(dirs[0].path)) : n + ' folders'}`, `
      <div class="muted">Adding up everything inside ${n === 1 ? 'this folder' : `these ${n} folders`}. Big folders can take a few minutes, and sleeping disks have to spin up first.</div>
      <div class="sz-list"></div>
      <div class="sz-total"><span>Total</span><span class="v"></span></div>
      <div class="pg-hint sz-hint"><b>Closing this window doesn't stop the count.</b> The sizes appear in the Size column when they're ready.</div>`,
      [{ label: 'Stop', run: async () => { await api('size_stop', { id: run.id }).catch(() => {}); return false; } }, { label: 'Close', primary: true }], 'pm-dlg sz-dlg');
    const foot = $('.dlg-foot', dlg);
    foot.insertAdjacentHTML('afterbegin', '<span class="sz-time"></span>');
    run.dlgEls = { list: $('.sz-list', dlg), total: $('.sz-total .v', dlg), time: $('.sz-time', dlg), stop: $$('.dlg-foot .uc-btn', dlg)[0], hint: $('.sz-hint', dlg) };
    pollSizes(run);
  }
  async function pollSizes(run) {
    let st;
    try { st = (await api('size_status', { id: run.id })).size; } catch (e) { if (run.dlgEls && dlg.contains(run.dlgEls.list)) run.dlgEls.list.innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; return; }
    run.last = st;
    /* finished folders go into the Size column, if that pane still shows the same folder */
    const p = run.p;
    let changed = false;
    for (const it of st.items) if (it.state === 'done' && (run.origin === null || p.path === run.origin) && p.dirSizes) {
      const k = run.keys.get(it.path);
      if (k != null && p.dirSizes.get(k) !== it.bytes) { p.dirSizes.set(k, it.bytes); changed = true; }
    }
    if (changed) { drawRows(p); updateSelInfo(p); }
    renderSizes(run);
    if (['running', 'queued'].includes(st.state)) setTimeout(() => pollSizes(run), 700);
  }
  function renderSizes(run) {
    const el = run.dlgEls, st = run.last;
    if (!el || !st || !dlg.contains(el.list)) return;
    const rel = (it, d) => d && d.startsWith(it.path) ? (base(it.path) + d.slice(it.path.length)) : d;
    el.list.innerHTML = st.items.map(it => {
      const ic = it.state === 'done' ? '<span class="ok">✓</span>' : it.state === 'running' ? '<span class="spin"></span>' : it.state === 'stopped' ? '<span class="stp">■</span>' : '<span class="wait">○</span>';
      const counts = `${it.files.toLocaleString()} file${it.files === 1 ? '' : 's'} · ${it.dirs.toLocaleString()} folder${it.dirs === 1 ? '' : 's'}`;
      const sub = it.state === 'done' ? `${counts}${it.secs != null ? ' · ' + (it.secs < 60 ? it.secs + ' s' : fmtDur(Math.round(it.secs))) : ''}`
        : it.state === 'running' ? `so far: ${counts}${it.now ? ` · now in <span class="mono">${esc(rel(it, it.now))}</span>` : ''}`
        : it.state === 'stopped' ? `stopped · ${counts} counted` : '';
      const val = it.state === 'waiting' ? '<span class="wait">waiting</span>' : fmtBytes(it.bytes) + (it.state === 'running' ? '…' : '');
      return `<div class="sz-row ${it.state}">${ic}<span class="n mono" title="${esc(it.path)}">${esc(base(it.path))}</span><span class="v">${val}</span>
        ${sub ? `<span class="s">${sub}</span>` : ''}${it.state === 'running' ? '<div class="bar indet"><i></i></div>' : ''}</div>`;
    }).join('');
    const total = st.items.reduce((a, it) => a + (it.bytes || 0), 0), files = st.items.reduce((a, it) => a + (it.files || 0), 0);
    const busy = ['running', 'queued'].includes(st.state);
    el.total.textContent = `${fmtBytes(total)}${busy ? '…' : ''} · ${files.toLocaleString()} files`;
    const secs = Math.round(((st.finished ? st.finished * 1000 : Date.now()) - run.t0) / 1000);
    el.time.textContent = busy ? `Elapsed ${fmtDur(Math.max(0, secs))}` : st.state === 'done' ? `Finished in ${fmtDur(Math.max(0, secs))}` : st.state === 'stopped' ? 'Stopped' : 'Something went wrong';
    el.stop.hidden = !busy; el.hint.hidden = !busy;
  }

  /* ---------- actions ---------- */
  async function act(name) {
    if (practiceBlocked(name)) return;
    const p = A(), q = B();
    /* inside an archive (read-only): look and copy out, nothing else */
    if (p.arc && name === 'edit') name = 'view';
    if (p.arc && ARC_NO[name]) return toast(ARC_NO[name], true);
    if (q.arc && (name === 'copy' || name === 'move')) return toast("The other pane is inside an archive - nothing can be copied into one (archives open read-only)", true);
    /* the "/" overview only lists places to open - nothing to change there */
    const isRoot = x => x.root && x.mode === 'dir';
    if ((isRoot(p) || (isRoot(q) && ['copy', 'move'].includes(name))) && !['find', 'sizes', 'undo', 'history', 'view'].includes(name))
      return toast(isRoot(p) ? 'Open one of these first - "/" only lists the places you can go' : 'The other pane shows "/" - open a folder there first', true);
    const t = targets(p);
    const desc = t.length === 1 ? base(t[0].path) : `${t.length} items`;
    switch (name) {
      case 'mkdir': {
        if (p.mode !== 'dir') return toast('Open a folder first', true);
        return openDlg('New folder', `<div class="field"><label>Name</label><input type="text" class="f-name"></div>
          <div class="muted">In <span class="mono">${esc(p.path)}</span></div>`,
          [{ label: 'Cancel' }, { label: 'Create', primary: true, run: async () => {
            const dir = p.path, r = await api('mkdir', { path: dir, name: $('.f-name', dlg).value });
            await load(p, dir, r.name);
            done(`Created ${r.name}`, r.hist);
          } }]);
      }
      case 'rename': {
        if (t.length !== 1 || p.mode !== 'dir') return toast('Put the cursor on one item to rename', true);
        const old = base(t[0].path), inDir = parent(t[0].path);
        openDlg('Rename', `<div class="field"><label>New name</label><input type="text" class="f-name" value="${esc(old)}"></div>`,
          [{ label: 'Cancel' }, { label: 'Rename', primary: true, run: async () => {
            const dir = p.path, r = await api('rename', { path: inDir, from: old, to: $('.f-name', dlg).value });
            await load(p, dir, inDir === dir ? r.name : null);
            if (inDir !== dir) { const ix = p.items.findIndex(x => x.abs === join(inDir, r.name)); if (ix >= 0) moveCursor(p, ix, true); }
            if (r.name !== old) done(`Renamed to ${r.name}`, r.hist);
          } }]);
        const inp = $('.f-name', dlg); const dot = old.lastIndexOf('.');
        if (dot > 0 && t[0].it.t !== 'd') inp.setSelectionRange(0, dot);
        return;
      }
      case 'view': {
        if (t.length !== 1 || t[0].it.t === 'd') return toast('Put the cursor on a file to view it', true);
        return openViewer(t[0].path);
      }
      case 'edit': {
        if (t.length !== 1 || t[0].it.t === 'd') return toast('Put the cursor on a file to edit it', true);
        if (EDIT_IMG.test(t[0].path)) return openImageEditor(t[0].path);
        if (/\.m3u8?$/i.test(t[0].path) && playerOn()) return plOpenFile(t[0].path);
        return openEditor(t[0].path);
      }
      case 'copy': case 'move': {
        if (!t.length) return toast('Nothing selected', true);
        if (q.mode !== 'dir') return toast('The other pane needs to show a folder', true);
        const verb = name === 'copy' ? 'Copy' : 'Move';
        openDlg(`${verb} ${desc}`, `
          <div class="field"><label>To</label><input type="text" class="f-dest" value="${esc(q.path)}"></div>
          <div class="field"><label>If a file already exists</label>
            <div class="radios">
              <label class="chk"><input type="radio" name="ex" value="skip" ${cmpOn && !SET.practice ? '' : 'checked'}> Skip it</label>
              <label class="chk"><input type="radio" name="ex" value="newer" ${SET.practice ? 'disabled' : cmpOn ? 'checked' : ''}> Replace if older</label>
              <label class="chk"><input type="radio" name="ex" value="overwrite" ${SET.practice ? 'disabled' : ''}> Replace</label>
            </div>${SET.practice ? '<div class="muted">Practice mode: files already there are always kept.</div>' : cmpOn ? '<div class="muted">From Compare: "Replace if older" is picked so the newer files you ticked overwrite their older copies.</div>' : ''}</div>
          ${name === 'move' ? '<div class="muted">On the same disk this is an instant rename; across disks it copies, then removes the originals.</div>' : ''}
          <div class="muted">A progress window shows it running. You can watch it, or send it to the background and carry on - you'll be told when it's done, even if you close this tab.</div>`,
          [{ label: 'Cancel' }, { label: verb, primary: true, run: async () => {
            const dest = $('.f-dest', dlg).value.trim();
            const ex = ($('input[name=ex]:checked', dlg) || {}).value || 'skip';
            /* replacing anything? say exactly what, and how far it can be undone */
            if (ex !== 'skip') {
              const c = await api('conflicts', { sources: t.map(x => x.path), dest, mode: ex });
              if (c.count) { confirmReplace(c, `${verb} ${desc}`, () => start(dest, ex)); return false; }
            }
            return start(dest, ex);
          } }]);
        async function start(dest, ex) {
            const r = await api('job_start', { type: name, sources: t.map(x => x.path), dest, exists: ex });
            p.sel.clear();
            if (r.instant) { done(`Moved ${desc}`, r.hist); refreshBoth(); return; }
            openProgress(r.job); return false;     // the progress window replaces this dialog
        }
        return;
      }
      case 'delete': {
        if (!t.length) return toast('Nothing selected', true);
        const isBin = x => x.path.endsWith('/.uncommander-trash');
        const sysDel = t.some(x => !inShares(x.path));     // system folders (in RAM) have no trash
        const inTrash = SET.trash === false || p.trash || sysDel || t.some(x => x.path.includes('/.uncommander-trash/') || isBin(x));
        const list = delList(p, t);
        openDlg(inTrash ? `Permanently delete ${desc}?` : `Delete ${desc}?`,
          `${list}<div class="${inTrash && !sysDel ? 'warnbox' : 'muted'} del-note">${sysDel ? 'Outside <span class="mono">/mnt</span> and <span class="mono">/boot</span> there is no trash, so this removes them for good.' : inTrash ? (t.some(isBin) ? 'This empties the trash folder and removes it. Everything in it is deleted for good - there is no undo.' : SET.trash === false ? 'The trash is switched off (Settings > Trash), so this removes them for good. There is no undo.' : 'These are already in the trash. This removes them for good.') : 'Moves to <span class="mono">.uncommander-trash</span> on the same share or disk — instant, and recoverable until it is purged.'}</div>
          ${inTrash ? '' : `<label class="st-radio del-forever"><input type="checkbox" class="f-forever"><span><b>Delete permanently - skip the trash</b><br>
            <span class="muted">Removed for good straight away: no trash copy, no Undo. Handy for freeing space now.</span></span></label>`}`,
          [{ label: 'Cancel' }, { label: inTrash ? 'Delete forever' : 'Delete', primary: true, danger: true, run: async () => {
            const forever = !inTrash && $('.f-forever', dlg).checked;
            const r = await api('trash', { paths: t.map(x => x.path), forever: forever ? 1 : 0 });
            const msg = `Deleted ${r.count} item${r.count === 1 ? '' : 's'}`;
            if (r.bins && r.bins.length) done(msg, r.hist);
            else toast(msg);
            p.sel.clear();
            if (p.mode === 'find') { const gone = new Set(t.map(x => x.path)); p.all = p.all.filter(it => !gone.has(it.abs)); applySort(p, true); }
            else refresh(p);
            if (q.mode === 'dir' && q.path === p.path) refresh(q);
          } }]);
        const fv = $('.f-forever', dlg);
        if (fv) fv.addEventListener('change', () => {
          const note = $('.del-note', dlg), btn = $$('.dlg-foot .uc-btn', dlg).pop();
          note.className = (fv.checked ? 'warnbox warn' : 'muted') + ' del-note';
          note.innerHTML = fv.checked ? '<b>This cannot be undone.</b> The selected items are deleted for good - they will not go to the trash.' : 'Moves to <span class="mono">.uncommander-trash</span> on the same share or disk — instant, and recoverable until it is purged.';
          btn.textContent = fv.checked ? 'Delete forever' : 'Delete';
          $('.dlg-head', dlg).textContent = (fv.checked ? 'Permanently delete ' : 'Delete ') + desc + '?';
        });
        return;
      }
      case 'restore': {
        const bins = t.filter(x => x.it.t === 'd');
        if (!bins.length) return toast('Pick the dated trash folders to restore', true);
        const origins = await Promise.all(bins.map(b => api('trash_info', { path: b.path }).then(r => r.origin).catch(() => null)));
        return openDlg(`Restore ${bins.length} item${bins.length === 1 ? '' : 's'}`,
          origins.map((o, i) => `<div class="mono">${esc(o || base(bins[i].path) + ' — not a trash entry')}</div>`).join(''),
          [{ label: 'Cancel' }, { label: 'Restore', primary: true, run: async () => {
            const r = await api('restore', { paths: bins.map(b => b.path) });
            toast(`Restored ${r.restored.length}`); refresh(p);
          } }]);
      }
      case 'find': return findDialog(p);
      case 'compare': return startCompare();
      case 'compare_full': return openCompareTree();
      case 'undo': return doUndo();
      case 'history': return openHistory();
      case 'newfile': return newFile(p);
      case 'props': { const it = p.items[p.cursor]; if (!it || it.up) return toast('Put the cursor on a file or folder first', true); return showProps(p, it); }
      case 'brename': {
        if (p.mode !== 'dir') return toast('Open a folder first', true);
        if (!p.sel.size) return toast('Tick the files to rename first (Select All ticks everything)', true);
        if (new Set(t.map(x => parent(x.path))).size > 1) return toast('Batch rename works on one folder at a time - the ticked items are in more than one', true);
        return openBatchRename(p, t);
      }
      case 'compress': {
        if (p.mode !== 'dir') return toast('Open a folder first - everything to compress must be in one folder', true);
        if (!t.length) return toast('Tick what to compress, or put the cursor on it', true);
        return openCompress(p, q, t);
      }
      case 'extract': {
        if (t.length !== 1 || !isArchive(t[0].path)) return toast('Put the cursor on an archive (.zip, .rar, .7z, .tar.gz …)', true);
        return openExtract(p, q, t[0]);
      }
      case 'sizes': {
        const dirs = t.filter(x => x.it.t === 'd' || (x.it.t === 'l' && (p.stats.get(x.it.abs || x.it.n) || {}).d));
        if (!dirs.length) return toast(p.sel.size ? 'None of the ticked items are folders' : 'Put the cursor on a folder, or tick some folders', true);
        return openSizes(p, dirs);
      }
      case 'perms': {
        if (!t.length) return toast('Nothing selected', true);
        /* Plain-language permissions: what it is now, one recommended fix,
         * and the raw controls tucked away under "Custom". */
        const key = t[0].it.abs || t[0].it.n;
        let s = p.stats.get(key);
        if (!s || !s.p) {
          try { const r = await api('stat', { path: p.path, names: [key] }); s = r.stats[key] || {}; p.stats.set(key, s); }
          catch (e) { s = {}; }
        }
        const isDir = t[0].it.t === 'd' || !!s.d;
        const anyDir = t.some(x => x.it.t === 'd');
        const mode = (s.p || '').padStart(3, '0').slice(-3);
        const bits = mode.split('').map(Number);
        const owner = s.o || '?', group = s.g || '?';
        const want = isDir ? '777' : '666';
        const standard = owner === 'nobody' && group === 'users' && mode === want;
        const risky = t.some(x => /^\/(mnt\/[^/]+\/(appdata|system|domains)(\/|$)|boot(\/|$))/.test(x.path));
        const what = isDir ? 'folder' : 'file';
        const yes = '<span class="pm-yes">✓</span>', no = '<span class="pm-no">—</span>';
        const who = [['The owner', owner], ['Its group', group], ['Everyone else', '']];
        const table = s.p ? `
          <table class="pm-table">
            <tr><th></th><th>See / open</th><th>Change &amp; delete</th><th>${isDir ? 'Go inside' : 'Run as a program'}</th></tr>
            ${who.map(([label, name], w) => `<tr><td>${label}${name ? ` <span class="mono">${esc(name)}</span>` : ''}</td>${[4, 2, 1].map(b => `<td>${bits[w] & b ? yes : no}</td>`).join('')}</tr>`).join('')}
          </table>` : '<div class="muted">Couldn\'t read the current settings.</div>';
        const grid = ['The owner', 'Its group', 'Everyone else'].map((label, w) =>
          `<div class="pm-g-who">${label}</div>` + [[4, 'See'], [2, 'Change'], [1, isDir ? 'Go inside' : 'Run']].map(([b, l]) =>
            `<label class="chk"><input type="checkbox" class="pb" data-w="${w}" data-b="${b}" ${bits[w] & b ? 'checked' : ''}> ${l}</label>`).join('')).join('');
        openDlg('Permissions', `
          <div class="pm-target">
            <div class="pm-name">${isDir ? '📁' : '📄'} ${esc(t.length === 1 ? base(t[0].path) : `${t.length} items`)}</div>
            <div class="mono muted pm-path">${esc(t.length === 1 ? t[0].path : `${base(t[0].path)} and ${t.length - 1} more`)}</div>
          </div>

          ${risky ? `<div class="pm-caution"><b>Careful with this location.</b> Apps in <span class="mono">appdata</span>, VMs in <span class="mono">domains</span>, <span class="mono">system</span> files and the flash drive often need their own owners. Changing them can stop a container or VM from working — only do this if one is reporting a permissions problem.</div>` : ''}

          <div class="pm-section">
            <div class="pm-h">Right now${t.length > 1 ? ` <span class="muted">(${esc(base(t[0].path))})</span>` : ''}</div>
            <div class="pm-status ${standard ? 'ok' : 'warn'}">
              ${standard
                ? `<b>✓ Standard unRAID access.</b> Your network shares and Docker apps can open and change this ${what}.`
                : `<b>⚠ Not unRAID's standard setup.</b> If a share or a Docker app says "access denied" or "permission denied" for this ${what}, the fix below usually solves it.`}
            </div>
            ${table}
            <div class="muted pm-note"><span class="mono">nobody</span> / <span class="mono">users</span> is the owner unRAID uses for shared files — it's what lets your shares and most apps use them. Files owned by <span class="mono">root</span> usually came from a script or the terminal.</div>
          </div>

          <div class="pm-section">
            <div class="pm-h">What would you like to do?</div>
            <label class="pm-choice"><input type="radio" name="pm" value="fix" checked>
              <span><b>Fix access</b> <span class="pm-badge">Recommended</span><br>
              <span class="muted">Gives it to <span class="mono">nobody</span> / <span class="mono">users</span> and lets shares and apps open and change it — folders 777, files 666. This is exactly what unRAID's own <i>Tools → New Permissions</i> does.</span></span></label>
            <label class="pm-choice"><input type="radio" name="pm" value="custom">
              <span><b>Custom</b> <span class="muted">— for when you know exactly what you need</span></span></label>
            <div class="pm-custom" hidden>
              <div class="pm-row">
                <div class="field"><label>Owner</label><input type="text" class="f-owner" value="${esc(s.o || 'nobody')}"></div>
                <div class="field"><label>Group</label><input type="text" class="f-group" value="${esc(s.g || 'users')}"></div>
                <div class="field"><label>Number</label><input type="text" class="f-mode" value="${esc(mode === '000' && !s.p ? '' : mode)}" maxlength="3" inputmode="numeric"></div>
              </div>
              <div class="pm-grid">${grid}</div>
            </div>
          </div>

          ${anyDir ? `<label class="pm-choice pm-rec"><input type="checkbox" class="f-rec" checked>
            <span><b>Include everything inside</b><br><span class="muted">Applies to every file and folder within. Big folders can take a while — it runs in the background and shows under Jobs.</span></span></label>` : ''}`,
          [{ label: 'Cancel' }, { label: 'Fix access', primary: true, run: async () => {
            const custom = $('input[name=pm]:checked', dlg).value === 'custom';
            const options = custom
              ? { preset: false, owner: $('.f-owner', dlg).value.trim(), group: $('.f-group', dlg).value.trim(), mode: $('.f-mode', dlg).value.trim(), recursive: !!($('.f-rec', dlg) || {}).checked }
              : { preset: true, recursive: !!($('.f-rec', dlg) || {}).checked };
            if (custom && options.mode && !/^[0-7]{3}$/.test(options.mode)) { toast('The number should be three digits from 0 to 7, like 775', true); return false; }
            const r = await api('job_start', { type: 'perms', sources: t.map(x => x.path), options });
            openProgress(r.job); return false;
          } }], 'pm-dlg');
        document.activeElement && document.activeElement.blur();
        const applyBtn = $('.dlg-foot .primary', dlg);
        $$('input[name=pm]', dlg).forEach(r => r.addEventListener('change', () => {
          const custom = $('input[name=pm]:checked', dlg).value === 'custom';
          $('.pm-custom', dlg).hidden = !custom;
          applyBtn.textContent = custom ? 'Apply' : 'Fix access';
        }));
        const sync = () => {
          const m = [0, 0, 0];
          $$('.pb', dlg).forEach(c => { if (c.checked) m[+c.dataset.w] |= +c.dataset.b; });
          $('.f-mode', dlg).value = m.join('');
        };
        $$('.pb', dlg).forEach(c => c.addEventListener('change', sync));
        $('.f-mode', dlg).addEventListener('input', e => {
          const v = e.target.value.replace(/[^0-7]/g, '').slice(0, 3);
          e.target.value = v;
          if (v.length === 3) $$('.pb', dlg).forEach(c => c.checked = !!(+v[+c.dataset.w] & +c.dataset.b));
        });
        return;
      }
    }
  }

  /* ---------- jobs ---------- */
  const jobChip = $('.uc-jobchip');
  let pollTimer = null, seenDone = new Set(store.get('seenDone', []));
  const fmtEta = e => {
    if (!e) return '';
    const [h, m, sec] = e.split(':').map(Number);
    const t = (h || 0) * 3600 + (m || 0) * 60 + (sec || 0);
    return t < 60 ? `about ${t} s left` : t < 3600 ? `about ${Math.round(t / 60)} min left` : `about ${Math.floor(t / 3600)} h ${Math.round(t % 3600 / 60)} min left`;
  };
  function jobRow(j) {
    const running = j.state === 'running', queued = j.state === 'queued';
    const pct = j.state === 'done' ? 100 : j.pct || (j.phase && j.total && j.bytes ? Math.min(99, Math.floor(j.bytes * 100 / j.total)) : 0);
    const indet = (j.type === 'perms' && running) || (running && !pct && !(j.phase && j.total && j.bytes));
    const lines = [];
    if (running && j.phase) {
      /* compress / extract: which step it's on, then how far */
      lines.push(`<b class="ph">${esc(j.phase)}</b>${pct ? ` · ${pct}%` : ''}`);
      const bits = [];
      if (j.count && j.checked) bits.push(`File ${Math.min(j.checked, j.count).toLocaleString()} of ${j.count.toLocaleString()}`);
      else if (j.count) bits.push(`${j.count.toLocaleString()} file${j.count === 1 ? '' : 's'}`);
      if (j.total) bits.push(`${fmtBytes(Math.min(j.bytes || 0, j.total))} of ${fmtBytes(j.total)}`);
      if (bits.length) lines.push(bits.join(' · '));
      if (j.file) lines.push(`<span class="now">Now: <span class="mono">${esc(j.file)}</span></span>`);
    } else if (running && j.type !== 'perms') {
      if (!j.count && !pct) lines.push('Getting the list of files…');
      else {
        lines.push([j.count ? `Item ${Math.max(1, Math.min(j.checked || 0, j.count)).toLocaleString()} of ${j.count.toLocaleString()}` : '',
          `${fmtBytes(j.bytes)}${j.total ? ' of ' + fmtBytes(j.total) : ''}`, j.speed || '', fmtEta(j.eta)].filter(Boolean).join(' · '));
        if (j.file) lines.push(`<span class="now">Now: <span class="mono">${esc(j.file)}</span></span>`);
      }
    } else if (running) lines.push(j.file ? `Working on <span class="mono">${esc(j.file)}</span>` : 'Working…');
    else if (queued) lines.push('Waiting - it starts when the job above it is finished');
    else if (j.finished) {
      const took = j.started ? fmtDur(j.finished - j.started) : '';
      const what = j.type === 'compress' ? (j.count ? `${j.count.toLocaleString()} file${j.count > 1 ? 's' : ''} packed${j.outsize ? ' into ' + fmtBytes(j.outsize) : ''}` : '')
        : j.type === 'extract' ? (j.count ? `${j.count.toLocaleString()} file${j.count > 1 ? 's' : ''} unpacked` : '')
        : j.files ? `${j.files.toLocaleString()} file${j.files > 1 ? 's' : ''} copied` : '';
      lines.push([j.state === 'done' ? 'Finished' : j.state === 'cancelled' ? 'Cancelled' : 'Stopped', new Date(j.finished * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        what, !['compress', 'extract'].includes(j.type) && j.bytes ? fmtBytes(j.bytes) : '', took && 'took ' + took, j.removed && j.removed.length ? (j.type === 'extract' ? 'archive moved to the trash' : 'originals moved to the trash') : ''].filter(Boolean).join(' · '));
    }
    return `<div class="uc-job ${j.state}">
      <div class="lbl" title="${esc(j.label)}">${esc(j.label)}</div>
      <div class="jr"><span class="st ${j.state}">${{ done: 'done', running: running && pct ? pct + '%' : 'running', queued: 'waiting', failed: 'failed', cancelled: 'cancelled' }[j.state] || j.state}</span>
        ${running || queued ? (cancelAsk[j.id] > Date.now() ? `<button class="uc-btn danger" data-cancel="${j.id}" data-sure="1">Stop it?</button>` : `<button class="uc-btn" data-cancel="${j.id}">Cancel</button>`) : ''}</div>
      ${running || queued ? `<div class="bar${indet ? ' indet' : ''}"><i style="width:${pct}%"></i></div>` : ''}
      ${lines.map(l => `<div class="meta">${l}</div>`).join('')}
      ${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}
    </div>`;
  }
  /* Cancel asks once: the button turns into a red "Stop it?" for 5 seconds. */
  const cancelAsk = {};
  const bindCancel = el => $$('[data-cancel]', el).forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.cancel;
    if (b.dataset.sure !== '1') {
      cancelAsk[id] = Date.now() + 5000;
      b.dataset.sure = '1'; b.textContent = 'Stop it?'; b.classList.add('danger');
      setTimeout(() => { if (cancelAsk[id] <= Date.now()) { delete cancelAsk[id]; renderProgress(); } }, 5050);
      return;
    }
    delete cancelAsk[id];
    b.disabled = true; await api('job_cancel', { id }); pollJobs(true);
  }));

  /* ---------- progress window ----------
   * Opens when a copy, move or permissions job starts, and lists it with any
   * job still running or waiting. While it's open the page tells the server
   * it's watching, so a job you watch to the end isn't reported again.
   * "Continue in background" (or leaving the page) means it will be: an alert
   * row at the top of unCommander plus an unRAID notification. */
  let progress = null, lastJobs = [];
  function openProgress(id, all) {
    const ids = new Set(progress ? progress.ids : []);
    if (id) ids.add(id);
    lastJobs.forEach(j => { if (['running', 'queued'].includes(j.state) || (all && j.alert)) ids.add(j.id); });
    openDlg('Jobs', `<div class="pg-list"></div>
      <div class="pg-hint"><b>Closing this window doesn't stop anything.</b> The job keeps running in the background, and unCommander will tell you when it's finished, even if you close the tab or go to another page. The <b>Jobs</b> button at the top brings this window back.</div>`,
      [...(all ? [{ label: 'Dismiss finished', run: async () => { await api('job_ack', { id: '*' }); progress && lastJobs.filter(j => !['running', 'queued'].includes(j.state)).forEach(j => progress.ids.delete(j.id)); pollJobs(true); return false; } }] : []),
       { label: 'Close', primary: true }], 'pg-dlg');
    const close = $$('.dlg-foot .uc-btn', dlg).pop();
    if (all) $('.dlg-foot .uc-btn', dlg).style.marginRight = 'auto';
    progress = { ids, all: !!all, list: $('.pg-list', dlg), hint: $('.pg-hint', dlg), close, closing: null };
    dlg.beforeClose = () => { if (progress) { clearTimeout(progress.closing); unwatch(); } progress = null; return true; };
    renderProgress();
    pollJobs(true);
  }
  /* Closing the window while jobs still run = carry on in the background. */
  function unwatch(beacon) {
    if (!progress) return;
    const ids = [...progress.ids].filter(id => { const j = lastJobs.find(x => x.id === id); return !j || ['running', 'queued'].includes(j.state); });
    if (!ids.length) return;
    if (beacon && navigator.sendBeacon) {
      const fd = new FormData(); fd.append('action', 'job_unwatch'); fd.append('csrf_token', CSRF); fd.append('ids', JSON.stringify(ids));
      navigator.sendBeacon(API, fd);
    } else api('job_unwatch', { ids }).catch(() => {});
  }
  window.addEventListener('pagehide', () => unwatch(true));
  function renderProgress() {
    if (!progress) return;
    if (!dlg.contains(progress.list)) { progress = null; return; }
    if (progress.all) lastJobs.forEach(j => { if (['running', 'queued'].includes(j.state) || j.alert) progress.ids.add(j.id); });
    const jobs = [...progress.ids].map(id => lastJobs.find(j => j.id === id)).filter(Boolean).sort((a, b) => a.created - b.created);
    progress.list.innerHTML = jobs.length ? jobs.map(jobRow).join('') : `<div class="muted" style="padding:10px">${progress.all ? 'No jobs.' : 'Starting…'}</div>`;
    bindCancel(progress.list);
    const open = jobs.filter(j => ['running', 'queued'].includes(j.state));
    progress.hint.hidden = !open.length;
    if (progress.all) return;     // the list behind the Jobs button: nothing closes by itself
    if (!jobs.length || open.length) return;
    /* everything in the window has ended, and you saw it */
    const bad = jobs.filter(j => j.state !== 'done');
    progress.hint.hidden = false;
    if (bad.length) { progress.hint.textContent = bad.some(j => j.state === 'failed') ? 'Something went wrong - see the message above.' : 'Cancelled.'; return; }
    progress.hint.innerHTML = '<b class="pg-ok">✓ All done</b>';
    if (!progress.closing) progress.closing = setTimeout(() => {
      if (!progress) return;
      closeDlg();
      toast(jobs.length === 1 ? `${jobs[0].label} - done` : `${jobs.length} jobs done`);
    }, 1400);
  }

  async function pollJobs(soon) {
    clearTimeout(pollTimer);
    let jobs = [];
    const watch = progress ? [...progress.ids] : [];
    try { jobs = (await api('jobs', watch.length ? { watch } : {})).jobs; } catch (e) { pollTimer = setTimeout(pollJobs, 5000); return; }
    lastJobs = jobs;
    renderProgress();
    /* top-bar chip: what's running, or how many finished jobs are listed */
    const run = jobs.filter(j => ['running', 'queued'].includes(j.state)), cur = jobs.find(j => j.state === 'running');
    const unseen = jobs.filter(j => j.alert);
    jobChip.hidden = !run.length && !unseen.length;
    jobChip.classList.toggle('busy', !!run.length);
    jobChip.innerHTML = run.length ? `<span class="spin"></span>${run.length} job${run.length > 1 ? 's' : ''} running${cur && cur.type !== 'perms' ? ` · ${cur.pct || 0}%` : ''}` : `${unseen.length} finished`;
    drawAlerts(jobs.filter(j => j.alert));
    let changed = false;
    for (const j of jobs) if (!['running', 'queued'].includes(j.state) && !seenDone.has(j.id)) { seenDone.add(j.id); changed = true; if (soon !== 'init') { if (j.dest) noteTouched(j.dest); (j.sources || []).forEach(x => typeof x === 'string' && noteTouched(parent(x))); } }
    if (changed) { store.set('seenDone', [...seenDone].slice(-50)); if (soon !== 'init') refreshBoth(); }
    const busy = jobs.some(j => ['running', 'queued'].includes(j.state));
    pollTimer = setTimeout(pollJobs, busy || progress ? 1000 : 15000);
  }
  jobChip.addEventListener('click', () => { sound.play('click'); openProgress(null, true); });

  /* Finished-job alerts: a row at the top of the page for each job worth
   * mentioning (Settings > Jobs), until it's dismissed - on any device. */
  const alertsEl = $('.uc-alerts');
  let alertKey = '';
  function fmtDur(s) { return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; }
  function drawAlerts(list) {
    const key = list.map(j => j.id).join();
    if (key === alertKey) return;
    alertKey = key;
    alertsEl.hidden = !list.length;
    alertsEl.innerHTML = list.map((j, i) => {
      const verb = { copy: 'Copy', move: 'Move', perms: 'Permissions change', back: 'Undo' }[j.type] || 'Job';
      const st = { done: 'finished', failed: 'failed', cancelled: 'was cancelled' }[j.state] || j.state;
      const cls = j.state === 'failed' ? 'bad' : j.state === 'cancelled' ? 'warn' : '';
      const ic = j.state === 'failed' ? '✕' : j.state === 'cancelled' ? '!' : '✓';
      const took = j.finished && (j.started || j.created) ? fmtDur(j.finished - (j.started || j.created)) : '';
      const bits = [esc(j.label || ''), j.files ? `${j.files.toLocaleString()} files` : '', j.bytes ? fmtBytes(j.bytes) : '', took && 'took ' + took,
        j.finished ? new Date(j.finished * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' · ');
      return `<div class="uc-alert ${cls}"><span class="ic">${ic}</span>
        <span class="tx" title="${esc((j.label || '') + (j.error ? ' - ' + j.error : ''))}"><b>${verb} ${st}</b> · ${bits}${j.error ? ` · <span class="err">${esc(j.error)}</span>` : ''}</span>
        ${i === list.length - 1 && list.length > 1 ? '<button class="uc-btn" data-ack="*">Dismiss all</button>' : ''}
        <button class="uc-btn" data-ack="${esc(j.id)}">Dismiss</button></div>`;
    }).join('');
    $$('[data-ack]', alertsEl).forEach(b => b.addEventListener('click', async () => {
      sound.play('click');
      try { await api('job_ack', { id: b.dataset.ack }); } catch (e) { return toast(e.message, true); }
      pollJobs(true);
    }));
    panes.forEach(p => { drawRows(p); queueStat(p); });
  }

  /* ---------- sounds ----------
   * Synthesised with Web Audio — no sound files. Each kind belongs to a
   * group the user can switch off in Settings → Sounds. */
  const sound = (() => {
    let ctx = null;
    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(c, t0, f0, f1, dur, type, vol) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    const kinds = {
      click: (c, t, v) => tone(c, t, 2200, 1400, 0.03, 'triangle', v * 0.5),
      tap:   (c, t, v) => tone(c, t, 2600, 2000, 0.018, 'sine', v * 0.35),
      open:  (c, t, v) => { tone(c, t, 520, 700, 0.05, 'triangle', v * 0.55); tone(c, t + 0.045, 780, 1040, 0.06, 'triangle', v * 0.55); },
      back:  (c, t, v) => { tone(c, t, 780, 600, 0.05, 'triangle', v * 0.5); tone(c, t + 0.045, 520, 400, 0.06, 'triangle', v * 0.5); },
      error: (c, t, v) => { tone(c, t, 220, 180, 0.12, 'square', v * 0.18); tone(c, t + 0.13, 180, 150, 0.14, 'square', v * 0.18); },
    };
    const group = { click: 'buttons', tap: 'taps', open: 'nav', back: 'nav', error: 'errors' };
    return {
      unlock() { if ((SET.sounds || {}).enabled) ac(); },
      play(kind, opts) {
        const s = Object.assign({}, SET.sounds || {}, opts || {});
        if (!s.force && (!s.enabled || !s[group[kind]])) return;
        const v = Math.max(0, Math.min(1, (s.volume ?? 40) / 100));
        if (v <= 0) return;
        const c = ac(); if (!c) return;
        kinds[kind](c, c.currentTime + 0.005, v);
      },
    };
  })();
  document.addEventListener('touchstart', () => {}, { passive: true });   // lets iPad show :active (the press colour)
  root.addEventListener('pointerdown', e => {
    sound.unlock();
    const b = e.target.closest('button, select');
    if (b && !b.disabled && !b.classList.contains('uc-bm')) sound.play('click');
  }, { capture: true, passive: true });

  /* ---------- shortcut buttons ---------- */
  /* Tools remember their last scan (kept on the server for a day), so closing
   * the window - or leaving the page - doesn't mean scanning all over again. */
  const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : 'over a day ago'; };
  /* a scan you started: keep "working" on screen for a moment (a fast scan
   * otherwise looks like nothing happened), then say it's done */
  const scanSettle = async t0 => { const w = 900 - (Date.now() - t0); if (t0 && w > 0) await new Promise(r => setTimeout(r, w)); };
  const flashCount = node => { if (!node) return; node.classList.remove('uc-flash'); void node.offsetWidth; node.classList.add('uc-flash'); };
  const whenLine = st => st && st.finished ? `Results from ${new Date(st.finished * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${ago(st.finished)}). <b>Scan again</b> to refresh them.` : '';

  /* ---------- Tools > Playlist check ----------
   * One playlist file at a time: how its songs are written (relative, a
   * container's /music, unRAID paths, smb://), where that is on this server,
   * which songs are there and which aren't - then take the missing ones out,
   * change how the paths start, open it in the player, or delete it. */
  async function openPlaylistCheck(file) {
    if (tdlg.tool === 'plcheck' && !file) return unparkTool();
    const dlg = tdlg;
    const C = { file: file || store.get('pccfile', ''), r: null, from: '', to: '', drop: new Set() };
    const STYLE = { rel: 'relative to the playlist file (the songs are found from where the playlist is)', abs: 'full paths', net: 'network paths (smb:// or nfs://) - how another device reaches the share', win: 'Windows paths' };
    openToolDlg('plcheck', 'Playlist check', `
      <div class="ef-card pc-setup"><div class="tg-af"><span>The playlist file</span><span class="pl-inrow"><input type="text" class="pc-file" value="${esc(C.file)}" spellcheck="false" placeholder="/mnt/user/…/playlist.m3u"><select class="pc-pick" title="Your playlist folders"><option value="">Playlists…</option></select><button type="button" class="uc-btn pc-brw">Browse…</button></span>
        <div class="fb-box pl-fb pc-fb" hidden></div></div></div>
      <div class="pc-prog" hidden></div>
      <div class="pc-res" hidden></div>`,
      [{ label: 'Close' }, { label: 'Check', primary: true, run: () => { check(); return false; } }], 'full ef-dlg pc-dlg sticky');
    const el = c => $(c, dlg);
    dlg.toolLabel = () => `Playlist check${C.r ? ' · ' + base(C.file) : ''}`;
    plFillSelect(el('.pc-pick'), 'Playlists…').then(() => { const o = $('option[value="*browse"], option[value="*clearrec"]', el('.pc-pick')); $$('option[value^="*"]', el('.pc-pick')).forEach(x => x.remove()); });
    const fresh = () => { C.from = C.to = ''; C.newFrom = undefined; };
    el('.pc-pick').addEventListener('change', e => { if (e.target.value) { el('.pc-file').value = e.target.value; e.target.value = ''; fresh(); check(); } });
    let brw = null;
    el('.pc-brw').addEventListener('click', () => { const fb = el('.pc-fb'); fb.hidden = !fb.hidden; if (!fb.hidden && !brw) brw = folderBrowser(fb, el('.pc-file').value ? parent(el('.pc-file').value) : (SET.pldirs || [])[0] || '/mnt/user', { files: /\.m3u8?$/i, onFile: f => { el('.pc-file').value = f; fresh(); fb.hidden = true; check(); } }); });
    el('.pc-file').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); fresh(); check(); } });

    async function check() {
      C.file = el('.pc-file').value.trim();
      if (!C.file) return toast('Pick a playlist file first', true);
      store.set('pccfile', C.file);
      el('.pc-prog').hidden = false; el('.pc-prog').innerHTML = `<div class="ef-loading"><span class="spin"></span> Checking every song in ${esc(base(C.file))}…</div>`;
      try { C.r = await api('pl_read', Object.assign({ path: C.file, check: '1' }, C.from && C.to ? { mapfrom: C.from, mapto: C.to } : {})); }
      catch (e) { el('.pc-prog').innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; return; }
      el('.pc-prog').hidden = true;
      if (!C.from) { C.from = C.r.prefix || ''; C.to = C.r.guess || ''; if (C.from && C.to && C.from !== C.to && C.r.items.some(x => !x.ok)) return check(); }
      C.drop.clear(); draw();
    }
    function draw() {
      const r = C.r, miss = r.items.filter(x => !x.ok), ok = r.items.length - miss.length;
      const net = /^[a-z]+:\/\//i.test(C.from);
      el('.pc-res').hidden = false;
      el('.pc-res').innerHTML = `
        <div class="pc-sum"><b>${esc(r.name)}</b> · ${r.items.length.toLocaleString()} songs · <span class="pc-ok">${ok.toLocaleString()} found</span>${miss.length ? ` · <span class="pc-bad">${miss.length.toLocaleString()} not found</span>` : ''}</div>
        <div class="pc-style">Songs are written as <b>${esc(STYLE[r.style] || r.style)}</b>.</div>
        ${r.style !== 'rel' ? `<div class="pc-map">
          <label class="tg-af"><span>In the file, the paths start with</span><input type="text" class="pc-from" value="${esc(C.newFrom !== undefined ? C.newFrom : C.from)}" spellcheck="false" placeholder="/music"></label>
          <span class="pc-arrow">→</span>
          <label class="tg-af"><span>On this server, that is</span><span class="pl-inrow"><input type="text" class="pc-to" value="${esc(C.to)}" spellcheck="false" placeholder="/mnt/user/Media/Music"><button type="button" class="uc-btn pc-again" title="Look for the songs again there">Check again</button></span></label>
          <div class="pc-hint muted">${net ? 'How another device (like Kodi) reaches the share.' : C.from && !C.from.startsWith('/mnt/') ? 'This is how an app in Docker sees your music (its folder mapping) - the songs are looked for in the folder on the right.' : ''} Change the left side to rewrite how the paths start when you save (for another app); change the right side if the songs are somewhere else.</div>
        </div>` : ''}
        <div class="pc-acts">
          <button type="button" class="uc-btn" data-pc="play" title="Make it the player's playlist">Open in the player</button>
          ${miss.length ? `<button type="button" class="uc-btn" data-pc="drop">Take out the ${miss.length.toLocaleString()} not found</button>` : ''}
          <button type="button" class="uc-btn primary" data-pc="save" title="Write the playlist file again - the old one goes to the trash">Save</button>
          <span class="tg-sp"></span>
          <button type="button" class="uc-btn danger" data-pc="del">Delete this playlist</button></div>
        ${C.drop.size ? `<div class="pc-note">${C.drop.size.toLocaleString()} song${C.drop.size === 1 ? '' : 's'} will be left out when you save.</div>` : ''}
        ${miss.length ? `<div class="pc-lh">Not found</div><div class="mc-list">${miss.slice(0, 2000).map(x => `<div class="ef-row${C.drop.has(x.raw) ? ' gone' : ''}"><span class="ef-path"><b>${esc(base(x.path))}</b><span class="in"> ${esc(parent(x.path).split('/').filter(Boolean).join(' / '))}</span><span class="pc-raw">in the file: ${esc(x.raw)}</span></span>
          <span class="mc-meta">${x.why === 'enc' ? 'name on the disk isn\'t UTF-8' : 'not there'}</span><button type="button" class="uc-btn" data-near="${esc(x.near || '')}" data-p="${esc(x.path)}" title="Open the nearest folder that's there">Open folder</button></div>`).join('')}</div>` : '<div class="uc-empty">Every song was found.</div>'}`;
      const f = el('.pc-from'), t = el('.pc-to');
      if (f) f.addEventListener('input', () => { C.newFrom = f.value.trim().replace(/\/+$/, ''); });
      if (f) [f, t].forEach(i => i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el('.pc-again').click(); } }));
    }
    const gen = dlg.gen;     // the window is used again by the next tool: these listeners stay, but stop answering
    dlg.addEventListener('click', async e => {
      if (dlg.gen !== gen || !C.r || !dlg.contains(e.target)) return;
      if (e.target.closest('.pc-again')) { C.newFrom = el('.pc-from').value.trim().replace(/\/+$/, ''); C.to = el('.pc-to').value.trim().replace(/\/+$/, ''); return check(); }
      const nb = e.target.closest('[data-near]');
      if (nb) { let d = nb.dataset.near; if (!d || !d.startsWith('/mnt/')) d = parent(C.file); load(A(), d); parkTool(); return; }
      const b = e.target.closest('[data-pc]'); if (!b) return;
      const k = b.dataset.pc;
      if (k === 'drop') { C.r.items.filter(x => !x.ok).forEach(x => C.drop.add(x.raw)); return draw(); }
      if (k === 'play') { parkTool(); return plOpenFile(C.file, { play: true }); }
      if (k === 'del') {
        try { const x = await api('trash', { paths: [C.file], label: `Deleted the playlist ${base(C.file)}` }); done(`Deleted ${base(C.file)}`, x.hist); } catch (er) { return toast(er.message, true); }
        C.r = null; el('.pc-res').hidden = true; el('.pc-file').value = ''; plFilesAt = 0; refreshBoth(); return;
      }
      if (k === 'save') {
        if (SET.practice) return toast('Practice mode is on, so saving playlists is turned off.', true);
        /* the file's own lines, minus the ones taken out; a changed start of the paths is written in */
        const oldF = C.r.prefix || '', newF = el('.pc-from') ? el('.pc-from').value.trim().replace(/\/+$/, '') : oldF;
        const lines = C.r.items.filter(x => !C.drop.has(x.raw)).map(x => oldF && newF !== oldF && (x.raw === oldF || x.raw.startsWith(oldF + '/')) ? newF + x.raw.slice(oldF.length) : x.raw);
        try {
          const x = await api('pl_write', { path: C.file, text: '#EXTM3U\n' + lines.join('\n') + '\n', replace: '1' });
          done(`Saved ${base(C.file)} - ${lines.length.toLocaleString()} songs${C.drop.size ? `, ${C.drop.size.toLocaleString()} taken out` : ''}`, x.hist);
          if (pl.file === C.file && !pl.dirty) toast('That playlist is open in the player - open it again there to see the changes');
          C.from = newF; C.newFrom = undefined; check();
        } catch (er) { toast(er.message, true); }
      }
    });
    if (C.file && file) check();
  }

  /* ---------- a made-up cover for an album with no artwork ----------
   * Plain on purpose, so it's never mistaken for the real thing: grey square, the album's
   * name in yellow condensed type at the top left, the year under it. Drawn here in the
   * browser (so the preview is exactly what's saved) and saved as the album's cover.jpg. */
  let coverFontP = null;
  function coverFont() {
    if (coverFontP) return coverFontP;
    coverFontP = new Promise(res => {
      const sc = document.createElement('script'); sc.src = '/plugins/uncommander/js/cover-font.js';
      sc.onload = async () => {
        try {
          for (const f of window.UC_COVER_FONT || []) {
            const bin = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
            const ff = new FontFace('UC Cover', bin.buffer, { weight: '600', unicodeRange: f.range });
            await ff.load(); document.fonts.add(ff);
          }
        } catch (e) {}
        res();
      };
      sc.onerror = () => res();
      document.head.appendChild(sc);
    });
    return coverFontP;
  }
  /* the album's name without the year and the [1]-style extras of its folder name */
  function coverWords(folder) {
    const m = folder.match(/(?:^|[\s([])((?:19|20)\d\d)(?:[\s)\]-]|$)/);
    let t = folder.replace(/[([]\s*(?:19|20)\d\d[^)\]]*[)\]]/g, ' ').replace(/\[\d{1,2}\]/g, ' ').replace(/^\s*(?:19|20)\d\d\s*[-–.]\s*/, '').replace(/\s+/g, ' ').trim();
    return { title: t || folder, year: m ? m[1] : '' };
  }
  function coverDraw(cv, title, year) {
    const S = 1000, pad = 84, W = S - pad * 2, x = cv.getContext('2d');
    cv.width = S; cv.height = S;
    x.fillStyle = '#636363'; x.fillRect(0, 0, S, S);
    x.fillStyle = '#ffcc32'; x.fillRect(pad, pad, 110, 12);
    const fam = '"UC Cover", "Oswald", "Arial Narrow", "Roboto Condensed", sans-serif';
    const top = pad + 12 + 44, room = S - top - pad - (year ? 120 : 0);
    const wrap = (sz, hard) => {
      x.font = `600 ${sz}px ${fam}`;
      const lines = []; let cur = '';
      for (const w of title.split(/\s+/)) {
        const tryL = cur ? cur + ' ' + w : w;
        if (x.measureText(tryL).width <= W) { cur = tryL; continue; }
        if (cur) lines.push(cur);
        if (x.measureText(w).width <= W) { cur = w; continue; }
        if (!hard) return null;                          // a word too long for a line at this size
        let piece = ''; for (const ch of w) { if (x.measureText(piece + ch).width > W) { lines.push(piece); piece = ''; } piece += ch; } cur = piece;
      }
      if (cur) lines.push(cur);
      return lines;
    };
    let size = 200, lines = null;
    for (; size >= 56; size -= 4) { lines = wrap(size, false); if (lines && lines.length * size * 1.06 <= room) break; }
    if (size < 56) { size = 56; lines = wrap(size, true); }
    x.fillStyle = '#ffcc32'; x.textBaseline = 'top'; x.font = `600 ${size}px ${fam}`;
    let y = top;
    for (const l of lines) { if (y + size > S - pad) break; x.fillText(l, pad, y); y += size * 1.06; }
    if (year) { x.fillStyle = '#d4d4d4'; x.font = `600 64px ${fam}`; x.fillText(year, pad, Math.min(y + 30, S - pad - 64)); }
  }
  /* dirs: the album folders; after(madeDirs) runs once they're saved */
  async function openCoverMaker(dirs, after) {
    await coverFont();
    const one = dirs.length === 1, w0 = coverWords(base(dirs[0]));
    openDlg(one ? 'Make a cover' : `Make covers for ${dirs.length} albums`, `
      <div class="cm-wrap"><canvas class="cm-cv" width="1000" height="1000"></canvas>
        <div class="cm-side">
          ${one ? `<div class="field"><label>Album name</label><input type="text" class="cm-t" value="${esc(w0.title)}" spellcheck="false"></div>
          <div class="field"><label>Year</label><input type="text" class="cm-y" value="${esc(w0.year)}" spellcheck="false" inputmode="numeric"></div>`
          : `<div class="muted">Each album gets its own name and year, taken from its folder's name. This is the first one: <b>${esc(base(dirs[0]))}</b></div>`}
          <div class="muted">Saved in the album folder as <b>cover.jpg</b> - Plex, Kodi, Jellyfin and the others pick it up at their next scan.</div>
          <label class="chk cm-emb"><input type="checkbox" class="cm-in"> Also put it inside the songs</label>
          <div class="muted">For car stereos and phones that only show the picture inside the song. Every song file is rewritten (the sound stays exactly the same; the originals go to the trash).</div>
        </div></div>`,
      [{ label: 'Cancel' }, { label: one ? 'Save as cover.jpg' : `Save ${dirs.length} covers`, primary: true, run: save }], 'cm-dlg');
    const cv = $('.cm-cv', dlg), t = $('.cm-t', dlg), y = $('.cm-y', dlg);
    const redraw = () => coverDraw(cv, one ? t.value.trim() || w0.title : w0.title, one ? y.value.trim() : w0.year);
    redraw();
    if (one) [t, y].forEach(i => i.addEventListener('input', redraw));
    async function save() {
      const emb = $('.cm-in', dlg).checked, btn = $('.dlg-foot .uc-btn.primary', dlg);
      let hist = '', made = [], bad = [];
      for (const [i, d] of dirs.entries()) {
        btn.textContent = dirs.length > 1 ? `Saving ${i + 1} of ${dirs.length}…` : 'Saving…';
        try {
          if (!one) { const w = coverWords(base(d)); coverDraw(cv, w.title, w.year); }
          else redraw();
          const up = await api('cover_upload', { data: cv.toDataURL('image/jpeg', 0.9) });
          const x = await api('cover_save', Object.assign({ dir: d, from: up.id, label: `Made ${dirs.length === 1 ? 'a cover' : 'covers'} for albums with none (music check)` }, hist ? { join: hist } : {}));
          hist = hist || x.hist; made.push(d);
          if (emb) {
            const songs = await musTracks(d);
            for (const [k, p] of songs.entries()) {
              btn.textContent = `${dirs.length > 1 ? `Album ${i + 1} of ${dirs.length}: ` : ''}song ${k + 1} of ${songs.length}…`;
              try { await api('tags_write', { path: p, tags: {}, cover: join(d, 'cover.jpg'), join: hist, label: 'Made covers (music check)' }); } catch (er) { bad.push(`${base(p)}: ${er.message}`); }
            }
          }
        } catch (er) { bad.push(`${base(d)}: ${er.message}`); }
      }
      coverV++;
      if (made.length) done(`Saved ${made.length} cover${made.length === 1 ? '' : 's'}${bad.length ? ` - ${bad.length} problem${bad.length === 1 ? '' : 's'}: ${bad[0]}` : ''}`, hist);
      else toast(bad[0] || 'Nothing was saved', true);
      refreshBoth();
      if (after) after(made);
    }
  }

  /* ---------- Tools > Music library check ----------
   * One walk through the music folder, six lists: albums with no cover, the
   * same album twice, folders with no songs, names that aren't UTF-8, albums
   * with tracks missing, albums in more than one format. The results are kept
   * on the server for an hour (a fix checks just that folder again); an item
   * you Accept stays off its list until its folder changes. Open shows the
   * album in the music library; the tool's button at the top brings you back,
   * and closing the tool puts both panes back the way they were. */
  async function openMusicTool() {
    if (tdlg.tool === 'music') return unparkTool();
    const dlg = tdlg;
    const M = { r: null, tab: 'nocover', picked: new Set(), busy: false, acc: false, peek: new Map(), tags: new Map(), tagsOff: false, snap: layoutSnap(), moved: false, last: null, at: 0 };
    const saved = store.get('mcroot', '');
    const start = saved || store.get('musroot', '') || (mus && mus.root) || (A().mode === 'dir' ? A().path : '/mnt/user');
    openToolDlg('music', 'Music library check', `
      <div class="mc-setup ef-card">
        <div class="tg-af"><span>Your music folder - every artist's folder is in here</span><span class="pl-inrow"><input type="text" class="mc-root" value="${esc(start)}" spellcheck="false"><button type="button" class="uc-btn mc-here" title="The folder open in the active pane">Active pane's folder</button><button type="button" class="uc-btn mc-brw">Browse…</button></span>
          <div class="fb-box pl-fb mc-fb" hidden></div></div>
        <div class="muted mc-what">Looks for: albums with <b>no cover picture</b> · the <b>same album twice</b> (names that match once years, brackets and words like Deluxe are left out) · album folders with <b>no songs</b> · names that <b>aren't UTF-8</b> · albums with <b>tracks missing</b> · albums in <b>mixed formats</b>. Only reads folder listings, so it's quick - but sleeping disks spin up.</div>
      </div>
      <div class="mc-prog" hidden></div>
      <div class="mc-res" hidden>
        <div class="mc-sum muted"></div>
        <div class="mc-tabs mt-filters"></div>
        <div class="mc-bar"></div>
        <div class="mc-list"></div>
      </div>`,
      [{ label: 'Close' }, { label: 'Check the listed again', title: 'Check only the folders on the lists again - quicker than checking everything', run: () => { if (M.r && !M.busy) relist(); return false; } }, { label: 'Check', primary: true, run: () => { scan(); return false; } }], 'full ef-dlg mc-dlg sticky');
    const el = c => $(c, dlg), bRe = $$('.dlg-foot .uc-btn', dlg)[1], bGo = $$('.dlg-foot .uc-btn', dlg)[2];
    bRe.hidden = true;
    const TABS = [['nocover', 'No cover'], ['dups', 'Same album twice'], ['empty', 'No songs'], ['names', 'Names not UTF-8'], ['gaps', 'Missing tracks'], ['mixed', 'Mixed formats']];
    dlg.toolLabel = () => `Music check${M.r ? ' · ' + TABS.reduce((n, [k]) => n + (M.r[k] || []).length, 0) : ''}`;
    dlg.toolAttn = () => Object.values(M.lid || {}).filter(j => j.state === 'pick').length;   // Lidarr waiting for you to pick the album
    /* closing the tool puts the panes back as they were before it opened something */
    dlg.beforeClose = () => { if (M.moved) layoutRestore(M.snap); return true; };
    /* back from looking at one: check just that folder again */
    dlg.onUnpark = () => { if (M.last && M.r) { const l = M.last; M.last = null; recheck(l); } };
    let brw = null;
    el('.mc-here').addEventListener('click', () => { const P = A(); if (P.mode === 'dir') { el('.mc-root').value = P.path; if (brw) brw.go(P.path); } });
    el('.mc-brw').addEventListener('click', () => { const fb = el('.mc-fb'); fb.hidden = !fb.hidden; if (!fb.hidden && !brw) brw = folderBrowser(fb, el('.mc-root').value.trim() || '/mnt/user', { onDir: d => { el('.mc-root').value = d; } }); });
    el('.mc-root').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); scan(); } });

    const rel = p => M.r && p.startsWith(M.r.root + '/') ? p.slice(M.r.root.length + 1) : p;
    const pretty = p => { const parts = rel(p).split('/'), last = parts.pop(); return `${parts.length ? `<span class="in">${esc(parts.join(' / '))} / </span>` : ''}<b>${esc(last)}</b>`; };
    const keyOf = x => Array.isArray(x) ? x.map(y => y.p).join('|') : x.p;
    const s = n => n === 1 ? '' : 's';
    function got(r) {
      M.r = r; M.r.mixed = M.r.mixed || []; M.r.acc = M.r.acc || {};
      M.at = Date.now() - (r.age || 0) * 1000;
      bGo.textContent = 'Check everything again';
      el('.mc-prog').hidden = true; el('.mc-res').hidden = false; el('.mc-fb').hidden = true;
      for (const k of [...M.peek.keys()]) if (!(M.r.empty || []).some(x => x.p === k)) M.peek.delete(k);
      if (M.tab !== 'lidarr' && !M.r[M.tab].length && !M.acc) M.tab = (TABS.find(([k]) => M.r[k].length) || TABS[0])[0];
      draw();
      if (!M.lidLoaded) { M.lidLoaded = true; lidLoad().then(() => { if (tdlg.tool === 'music') { draw(); lidPoll(); } }); }
    }
    async function scan() {
      const root = el('.mc-root').value.trim().replace(/\/+$/, '');
      if (!root) return toast('Fill in your music folder first', true);
      store.set('mcroot', root);
      el('.mc-prog').hidden = false; el('.mc-prog').innerHTML = `<div class="ef-loading"><span class="spin"></span> Reading every folder in ${esc(root)}…</div>`;
      el('.mc-res').hidden = true; bGo.disabled = true;
      let r; try { r = await api('music_check', { path: root }); } catch (e) { el('.mc-prog').innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; bGo.disabled = false; return; }
      bGo.disabled = false; M.picked.clear(); M.acc = false; got(r);
    }
    /* check only these folders again (what you fixed, or everything on the lists) */
    async function recheck(paths, label, quiet) {
      if (!M.r || !paths.length) return;
      if (quiet) { M.busy = true; try { got(await api('music_check', { path: M.r.root, paths: [...new Set(paths)] })); } catch (e) {} M.busy = false; return; }
      M.busy = true;
      /* a bar over the results while it runs, so it's clear the list is about to change */
      const res = el('.mc-res'), bar = document.createElement('div');
      bar.className = 'mc-busy'; bar.innerHTML = `<span class="spin"></span><span>${esc(label || `Checking ${paths.length === 1 ? base(paths[0]) : paths.length + ' folders'} again…`)}</span>`;
      res.classList.add('busy'); res.prepend(bar);
      const t0 = Date.now();
      try { const r = await api('music_check', { path: M.r.root, paths: [...new Set(paths)] }); await new Promise(ok => setTimeout(ok, Math.max(0, 700 - (Date.now() - t0)))); got(r); }
      catch (e) { toast(e.message, true); draw(); }
      bar.remove(); res.classList.remove('busy');
      M.busy = false;
    }
    /* the folder to check again for an item: dups and names are checked with the folder they're in */
    const recheckOf = (k, x) => k === 'dups' ? parent(x[0].p) : k === 'names' ? parent(x.p) : x.p;
    function relist() {
      const paths = []; TABS.forEach(([k]) => M.r[k].forEach(x => paths.push(recheckOf(k, x))));
      const n = new Set(paths).size;
      return recheck(paths, `Checking the ${n.toLocaleString()} listed folder${s(n)} again - things you fixed outside unCommander drop off…`);
    }
    function ago() {
      const m = Math.round((Date.now() - M.at) / 60000);
      return m < 1 ? 'checked just now' : `checked ${m} min ago`;
    }
    function draw() {
      const r = M.r, accN = k => (r.acc[k] || []).length;
      const listed = TABS.reduce((n, [k]) => n + r[k].length, 0);
      el('.mc-sum').innerHTML = `${r.albums.toLocaleString()} albums · ${r.songs.toLocaleString()} songs · ${r.dirs.toLocaleString()} folders · <span class="mc-ago" title="Results are kept for an hour - after that the check runs again when you open it">${ago()}</span>${r.partial ? ' - <b>stopped early</b> (too big to finish in one go: check one part of it at a time)' : ''}`;
      bRe.hidden = !listed;
      const nLid = Object.keys(M.lid || {}).length;
      if (M.tab === 'lidarr' && !nLid) M.tab = 'gaps';
      el('.mc-tabs').innerHTML = TABS.map(([k, l]) => `<button class="ct-f${M.tab === k ? ' on' : ''}" data-tab="${k}">${l} <b>${r[k].length.toLocaleString()}</b></button>`).join('')
        + (nLid ? `<button class="ct-f mc-tlid${M.tab === 'lidarr' ? ' on' : ''}" data-tab="lidarr" title="Albums you asked Lidarr for">Sent to Lidarr <b>${nLid}</b></button>` : '');
      if (M.tab === 'lidarr') return drawLid();
      const list = M.acc ? (r.acc[M.tab] || []) : r[M.tab], bar = el('.mc-bar'), box = el('.mc-list');
      for (const k of [...M.picked]) if (!list.some(x => keyOf(x) === k)) M.picked.delete(k);
      const pickable = !M.acc && ['nocover', 'empty', 'names'].includes(M.tab);
      const pickAll = pickable ? `<label class="chk"><input type="checkbox" class="mc-all"${list.length && M.picked.size === list.length ? ' checked' : ''}> <b>${M.picked.size ? `${M.picked.size} picked` : 'Pick all'}</b></label>` : '';
      const accTog = accN(M.tab) || M.acc ? `<button type="button" class="ct-f mc-acctog${M.acc ? ' on' : ''}" title="Items you said are fine as they are">${M.acc ? '← Back to the list' : `Accepted <b>${accN(M.tab)}</b>`}</button>` : '';
      const accPicked = pickable ? `<button type="button" class="uc-btn" data-do="accept"${M.picked.size ? '' : ' disabled'} title="They're fine as they are: off the list until their folder changes">Accept the picked</button>` : '';
      const tools = (txt, btns) => { bar.innerHTML = `${pickAll}${txt ? `<span class="muted mc-bt">${txt}</span>` : ''}<span class="tg-sp"></span>${accTog}${M.acc ? '' : (accPicked + (btns || ''))}`; };
      const open = p => `<button type="button" class="uc-btn" data-open="${esc(p)}" title="Look at it in the music library - the button at the top brings you back here">Open</button>`;
      const acc = x => `<button type="button" class="uc-btn mc-accb" data-acc="${esc(keyOf(x))}" title="${M.acc ? 'Put it back on the list' : "It's fine as it is: off the list until its folder changes"}">${M.acc ? 'Un-accept' : 'Accept'}</button>`;
      const chk = x => pickable ? `<input type="checkbox" data-k="${esc(x.p)}"${M.picked.has(x.p) ? ' checked' : ''}>` : '';
      const tag = pickable ? 'label' : 'div';     // a label without a tick box would hand its hover and clicks to its first button
      const row = (x, inner, extra = '') => `<${tag} class="ef-row${M.picked.has(x.p) ? ' on' : ''}">${chk(x)}${inner}${acc(x)}${open(M.tab === 'names' ? parent(x.p) : x.p)}</${tag}>${extra}`;
      if (!list.length) { tools(M.acc ? 'Nothing accepted on this list.' : ''); box.innerHTML = `<div class="uc-empty">${M.acc ? 'Nothing here.' : 'Nothing here - all good.'}</div>`; return; }
      if (M.tab === 'nocover') {
        tools('', `<button type="button" class="uc-btn primary" data-do="covers"${M.picked.size ? '' : ' disabled'} title="Uses the picture inside the songs, when they have one">Save the songs' picture as cover.jpg</button><button type="button" class="uc-btn" data-do="make"${M.picked.size ? '' : ' disabled'} title="A plain grey cover with the album's name - for albums that have no artwork anywhere">Make covers…</button>`);
        box.innerHTML = list.slice(0, 2000).map(a => row(a, `<span class="ef-path">${pretty(a.p)}</span>
          <span class="mc-meta">${a.n} song${s(a.n)}${a.pics ? ` · ${a.pics} other picture${s(a.pics)}` : ''}${a.note ? ` · <span class="mc-note">${esc(a.note)}</span>` : ''}</span>${M.acc ? '' : `<button type="button" class="uc-btn" data-mk="${esc(a.p)}" title="A plain grey cover with the album's name">Make a cover</button>`}`)).join('');
      } else if (M.tab === 'dups') {
        tools('Open both to see them side by side, each with Play and Tags. Delete the one you don\'t want (to the trash - Undo brings it back), or Accept them when they\'re different albums.');
        box.innerHTML = list.slice(0, 1000).map((g, gi) => {
          const tg = g.map(x => M.tags.get(x.p)), known = tg.every(t => t && t.album);
          const nk = t => (t.album + '|' + t.year).toLowerCase().replace(/[^\p{L}\p{N}|]+/gu, '');
          const verdict = known ? (new Set(tg.map(nk)).size > 1 ? '<span class="mc-chip diff">Different albums by their tags</span>' : '<span class="mc-chip">Same album by their tags</span>') : '';
          return `<div class="mc-grp"><div class="mc-gh"><span>${esc(rel(parent(g[0].p)))}</span>${verdict}<span class="tg-sp"></span>${M.acc ? '' : g.length === 2 ? `<button type="button" class="uc-btn" data-both="${gi}">Open both</button><button type="button" class="uc-btn" data-merge="${gi}" title="Put the two together: in one folder, or as CD1 and CD2">Merge…</button>` : ''}${acc(g)}</div>
          ${g.map((x, i) => `<div class="mc-gr"><span class="ef-path"><b>${esc(base(x.p))}</b>${tg[i] ? `<span class="mc-sub">Tags: ${tg[i].album ? `<b>${esc(tg[i].album)}</b>${tg[i].year ? ' · ' + esc(tg[i].year) : ''}` : '<i>no album tag</i>'}</span>` : ''}</span><span class="mc-meta">${x.n ? `${x.n} song${s(x.n)} · ${fmtBytes(x.b)}` : '<span class="mc-note">no songs</span>'}${x.pics ? ` · ${x.pics} picture${s(x.pics)}` : ''}${x.n ? (x.cover ? ' · cover' : ' · <span class="mc-note">no cover</span>') : ''}</span>${M.acc ? '' : renBtn(x, tg[i], g)}${M.acc ? '' : `<button type="button" class="uc-btn" data-open="${esc(x.p)}">Open</button><button type="button" class="uc-btn danger" data-del="${esc(x.p)}">Delete</button>`}</div>`).join('')}</div>`;
        }).join('');
        dupTags(list);
      } else if (M.tab === 'empty') {
        tools('', `<button type="button" class="uc-btn danger" data-do="trash"${M.picked.size ? '' : ' disabled'}>Delete the picked (to the trash)</button>`);
        box.innerHTML = list.slice(0, 2000).map(x => row(x, `<button type="button" class="mc-peekb${M.peek.has(x.p) ? ' on' : ''}" data-peek="${esc(x.p)}" title="What's in it">▸</button><span class="ef-path">${pretty(x.p)}</span>
          <span class="mc-meta">${[x.pics && `${x.pics} picture${s(x.pics)}`, x.other && `${x.other} other file${s(x.other)}`, x.subs && `${x.subs} folder${s(x.subs)}`].filter(Boolean).join(' · ') || 'empty'}</span>${M.acc ? '' : lidBtn(x.p)}`, (M.peek.has(x.p) ? peekHtml(x.p) : '') + lidPick(x.p))).join('');
      } else if (M.tab === 'names') {
        tools('Renaming can\'t be undone from History (the old name can\'t be written down).', `<button type="button" class="uc-btn primary" data-do="names"${M.picked.size ? '' : ' disabled'}>Rename the picked to UTF-8</button>`);
        box.innerHTML = list.slice(0, 3000).map(x => row(x, `<span class="ef-path">${pretty(x.p)}</span><span class="mc-meta">will be named <b>${esc(base(x.p))}</b></span>`)).join('');
      } else if (M.tab === 'mixed') {
        tools('Albums with songs in more than one format - often the same songs twice (FLAC and MP3), side by side or in a folder inside the album. Keep one format (you see what goes before anything is deleted), or Accept it when it\'s fine.');
        box.innerHTML = list.slice(0, 2000).map(x => row(x, `<span class="ef-path">${pretty(x.p)}${x.dirs.length > 1 ? `<span class="mc-sub">in ${x.dirs.map(d => esc(d === x.p ? '(the album folder)' : d.slice(x.p.length + 1))).join(', ')}</span>` : ''}</span><span class="mc-meta">${Object.entries(x.fx).map(([e, c]) => `<b>${c}</b> ${esc(e.toUpperCase())}`).join(' · ')}${oddOne(x) ? ` <span class="mc-chip">only 1 song is ${esc(oddOne(x).toUpperCase())}</span>` : ''}</span>${M.acc ? '' : Object.keys(x.fx).map(e => `<button type="button" class="uc-btn" data-keep="${esc(x.p)}" data-ext="${esc(e)}" title="Keep the ${esc(e.toUpperCase())} songs and delete the others (you see what goes first)">Keep ${esc(e.toUpperCase())}</button>`).join('')}`)).join('');
      } else if (M.tab === 'gaps') {
        tools('The track numbers in the file names skip a number - a song may be missing (or a bonus track numbered on its own).');
        box.innerHTML = list.slice(0, 2000).map(x => row(x, `<span class="ef-path">${pretty(x.p)}</span><span class="mc-meta">${x.gaps.map(([d, m]) => `${d ? esc(d) + ': ' : ''}no ${m.join(', ')}`).join(' · ')} <span class="muted">(${x.n} songs)</span></span>${M.acc ? '' : lidBtn(x.p)}`, lidPick(x.p))).join('');
      }
    }
    /* the folder name its songs' tags would give it, in the folder's own style: Name [1993] or Name (1993) */
    const oddOne = x => { const v = Object.entries(x.fx).sort((a, b) => b[1] - a[1]); return v.length === 2 && v[1][1] === 1 && v[0][1] >= 3 ? v[1][0] : ''; };
    function tagName(cur, t) {
      if (!t || !t.album) return '';
      let n = t.album.replace(/[\/\0]/g, '-').trim();
      if (t.year && !n.includes(t.year)) n += /\[(?:19|20)\d\d\]/.test(cur) ? ` [${t.year}]` : /\((?:19|20)\d\d\)/.test(cur) ? ` (${t.year})` : '';
      return n;
    }
    function renBtn(x, t, g) {
      const n = tagName(base(x.p), t);
      if (!n || n === base(x.p) || g.some(y => base(y.p) === n)) return '';
      return `<button type="button" class="uc-btn" data-ren="${esc(x.p)}" data-to="${esc(n)}" title="Rename the folder to what its songs' tags say">Rename to “${esc(n)}”</button>`;
    }
    /* a pane showing a folder that has just gone: it moves to where things went */
    function leave(gone, to) {
      if (mus && mus.pair && mus.pair.some(d => inDir(d, gone))) musExit();
      panes.forEach(q => { if (q.mode === 'dir' && inDir(q.path, gone)) load(q, to); else refresh(q); });
    }
    /* Same album twice > Merge: which name stays, and how they go together */
    function openMerge(g) {
      const [a, b] = g, keep0 = a.n !== b.n ? (a.n > b.n ? 0 : 1) : base(a.p).length <= base(b.p).length ? 0 : 1;
      openDlg('Merge the two albums', `
        <div class="mg-q">Keep this folder (the other one's things go into it):</div>
        ${g.map((x, i) => `<label class="chk mg-r"><input type="radio" name="mg-keep" value="${i}"${i === keep0 ? ' checked' : ''}> <b>${esc(base(x.p))}</b> <span class="muted">· ${x.n} song${s(x.n)}</span></label>`).join('')}
        <div class="mg-q">How:</div>
        <label class="chk mg-r"><input type="radio" name="mg-how" value="discs" checked> <b>As two discs</b> - the kept folder's songs go into <b>CD1</b>, the other's into <b>CD2</b>. For a deluxe or 2-CD edition split over two folders.</label>
        <label class="chk mg-r"><input type="radio" name="mg-how" value="flat"> <b>All in one folder</b> - the other's songs and pictures go in next to the kept ones. A file whose name is already there stays behind.</label>
        <label class="chk mg-r mg-sub"><input type="checkbox" class="mg-dn" checked> Number the songs by disc: <b>1-01 …</b> for the kept folder's, <b>2-01 …</b> for the other's (so they don't mix when sorted by name)</label>
        <div class="muted mg-note">Either way, the songs' tags don't change. Afterwards open the album and use <b>Tags</b> › Find this album online: picking the 2-disc release fills in the disc and track numbers for all of them.</div>
        <div class="muted mg-note">The other folder then goes to the trash. History's Undo takes all of it back.</div>`,
        [{ label: 'Cancel' }, { label: 'Merge', primary: true, run: async () => {
          const k = +$('input[name=mg-keep]:checked', modal).value, how = $('input[name=mg-how]:checked', modal).value;
          const keep = g[k].p, other = g[1 - k].p;
          const x = await api('music_merge', { keep, other, mode: how, discnum: how === 'flat' && $('.mg-dn', modal).checked ? '1' : '' });
          done(`Merged ${base(other)} into ${base(keep)}${x.skipped.length ? ` - ${x.skipped.length} file${s(x.skipped.length)} with a name already there went to the trash with the folder` : ''}`, x.hist);
          leave(other, keep); M.tags.delete(keep); recheck([parent(keep)]);
        } }]);
    }
    /* Mixed formats > Keep FLAC: the songs in the other formats, to delete */
    async function keepFormat(x, ext, look) {
      const del = [], whole = [];
      for (const d of x.dirs) {
        let r; try { r = await api('list', { path: d }); } catch (e) { continue; }
        const songs = r.items.filter(([n, t]) => t !== 'd' && GAL_AUD.test(n));
        const gone = songs.filter(([n]) => n.split('.').pop().toLowerCase() !== ext);
        if (!gone.length) continue;
        /* a folder inside the album holding nothing but those songs (an "mp3" folder): the whole folder goes */
        if (d !== x.p && gone.length === r.items.length) whole.push(d);
        else gone.forEach(([n]) => del.push(join(d, n)));
      }
      const n = del.length + whole.reduce((k, d) => k + 1, 0), other = Object.keys(x.fx).filter(e => e !== ext).map(e => e.toUpperCase()).join(' and ');
      if (!del.length && !whole.length) return toast(`No ${other} songs left in ${base(x.p)}`);
      const paths = [...whole, ...del];
      const lookFirst = async () => {
        M.moved = true; M.last = [x.p]; closeDlg(); parkTool();
        await musEnter(A(), x.p);
        const Rt = panes[1], want = new Set(paths); Rt.sel.clear();
        Rt.items.forEach((it, i) => { if (!it.up && want.has(fullPath(Rt, it))) Rt.sel.add(i); });
        draw(Rt); updateChrome();
        toast(`The ${other} ${whole.length && !del.length ? 'folder is' : 'songs are'} ticked - look them over, then F8 deletes them. The Music check button at the top brings you back.`);
      };
      if (look) return lookFirst();
      openDlg(`Keep ${ext.toUpperCase()}`, `
        <div>Delete ${whole.length ? `the folder${whole.length === 1 ? '' : 's'} <b>${whole.map(d => esc(base(d))).join(', ')}</b>${del.length ? ' and ' : ''}` : ''}${del.length ? `<b>${del.length} ${other} song${s(del.length)}</b>` : ''} in <b>${esc(base(x.p))}</b>, to the trash?</div>
        <div class="kf-list">${paths.slice(0, 60).map(p => `<div>${esc(p.slice(x.p.length + 1) || base(p))}</div>`).join('')}${paths.length > 60 ? `<div class="muted">+${paths.length - 60} more</div>` : ''}</div>
        <div class="muted">The ${ext.toUpperCase()} songs stay. Undo in History brings the others back.</div>`,
        [{ label: 'Cancel' }, { label: 'Look first', title: 'Open the album with them ticked, to check before deleting', run: () => { lookFirst(); return false; } },
         { label: 'Delete', danger: true, run: async () => {
          const r = await api('trash', { paths, label: `Kept ${ext.toUpperCase()} in ${base(x.p)}: deleted the ${other} (music check)` });
          done(`Deleted ${n} ${other} item${s(n)} from ${base(x.p)}`, r.hist); refreshBoth(); recheck([x.p]);
        } }]);
    }
    /* a bar over the results while something slow runs */
    function mcBusy(label) {
      const res = el('.mc-res'), bar = document.createElement('div');
      bar.className = 'mc-busy'; bar.innerHTML = `<span class="spin"></span><span>${esc(label)}</span>`;
      res.classList.add('busy'); res.prepend(bar);
      return () => { bar.remove(); res.classList.remove('busy'); };
    }
    /* ----- Ask Lidarr (Missing tracks, No songs): the work runs on the server; this shows how far it got ----- */
    M.lid = {};
    const lidOk = () => !!(SET.lidarr && SET.lidarr.ok);
    const LID_BUSY = ['start', 'adding', 'waiting', 'searching'];
    function lidBtn(p) {
      const j = M.lid[p];
      if (!j) return lidOk() ? `<button type="button" class="uc-btn" data-lid="${esc(p)}" title="Lidarr downloads the whole album, into this artist's folder (named Lidarr's way). An artist Lidarr doesn't have is added with nothing wanted.">Ask Lidarr</button>` : '';
      if (LID_BUSY.includes(j.state)) return `<span class="mc-lid busy" title="${esc(j.msg || '')}"><span class="spin"></span> ${esc(j.msg || 'Asking Lidarr…')}</span>`;
      if (j.state === 'sent' && j.dl) return `<span class="mc-lid busy" title="${esc(j.msg || '')}">Lidarr is downloading it · ${j.dl.pct}%</span>`;
      if (j.state === 'sent' && j.where && j.where !== p) return `<span class="mc-lid ok" title="${esc(j.where)}">Lidarr put it in “${esc(base(j.where))}”${j.total ? ` · ${j.have}/${j.total}` : ''}</span>${M.tab === 'empty' ? `<button type="button" class="uc-btn danger" data-lidold="${esc(p)}" title="This old folder is left over - it goes to the trash (Undo brings it back)">Delete this folder</button>` : ''}`;
      if (j.state === 'sent') return `<span class="mc-lid ok" title="${esc(j.msg || '')}">Sent to Lidarr · ${esc(plAgo(j.asked || j.at))}</span>`;
      if (j.state === 'nothing') return `<span class="mc-lid need" title="${esc(j.msg || '')}">${j.found > 0 ? `Lidarr turned down ${j.found} release${j.found === 1 ? '' : 's'}` : 'Lidarr found nothing to download'}</span>${(j.rels || []).length && M.tab !== 'lidarr' ? `<button type="button" class="uc-btn" data-tab="lidarr" title="See why, and pick one to download anyway">See why</button>` : ''}${lidOk() ? `<button type="button" class="uc-btn" data-lid="${esc(p)}">Ask again</button>` : ''}`;
      if (j.state === 'failed') return `<span class="mc-lid bad" title="${esc(j.msg || '')}">Lidarr: ${esc(j.msg || 'failed')}</span>${lidOk() ? `<button type="button" class="uc-btn" data-lid="${esc(p)}">Ask again</button>` : ''}`;
      if (j.state === 'pick') return '<span class="mc-lid need">Lidarr needs you ↓</span>';
      return '';
    }
    function lidPick(p) {
      const j = M.lid[p]; if (!j || j.state !== 'pick') return '';
      return `<div class="mc-lidpick"><span>${esc(j.msg || 'Which album is it?')}</span><select data-lidsel="${esc(p)}">${(j.choices || []).map(c => `<option value="${c.id}">${esc(c.title)}${c.year ? ` (${esc(c.year)})` : ''}${c.type && c.type !== 'Album' ? ` · ${esc(c.type)}` : ''}</option>`).join('')}</select>
        <button type="button" class="uc-btn primary" data-lidpick="${esc(p)}">Ask for this one</button><button type="button" class="uc-btn" data-lidforget="${esc(p)}">Cancel</button></div>`;
    }
    async function lidLoad() { try { M.lid = (await api('lidarr_jobs', {})).jobs || {}; } catch (e) {} lidWhere(); }
    /* where Lidarr put each album it was sent (asked of Lidarr every couple of minutes, one at a time) */
    let lidWhereRun = false;
    async function lidWhere() {
      if (lidWhereRun || !lidOk()) return; lidWhereRun = true;
      try {
        for (const [p, j] of Object.entries(M.lid)) {
          if (!['sent', 'nothing'].includes(j.state) || !j.album_id || (j.whereAt && Date.now() - j.whereAt < (j.dl ? 30000 : 120000))) continue;
          try { const r = await api('lidarr_where', { path: p }); Object.assign(j, r, { whereAt: Date.now() }); } catch (e) { j.whereAt = Date.now(); }
          if (tdlg.tool === 'music' && M.r) draw();
        }
      } finally { lidWhereRun = false; }
    }
    /* Lidarr grabbed nothing: what it found, why it said no to each - and download one anyway */
    const LID_WHY = [[/existing file.*(equal|higher)|not an upgrade|cutoff/i, 'Lidarr only downloads an album when it is better than the files you already have. Yours are as good as these, so it skips them - even though songs are missing. Download one anyway to fill the gaps. A better quality one (FLAC, if your profile allows it) replaces all the songs; one of the same quality only adds the missing songs - Lidarr leaves the rest waiting in Activity › Queue, where you remove them.'],
      [/track count|tracks? (are )?missing|wrong number/i, 'The release has a different number of songs than the edition Lidarr is set to.'],
      [/quality.*(not wanted|profile)/i, 'That quality isn\'t in the Lidarr quality profile.'],
      [/seeders/i, 'Not enough people are sharing it.']];
    function lidRels(p, j) {
      if (j.state !== 'nothing' || !(j.rels || []).length) return '';
      const hint = (LID_WHY.find(([re]) => re.test(j.why || '')) || [])[1];
      const old = j.relsAt && Date.now() / 1000 - j.relsAt > 1500;
      return `<div class="mc-rels">${hint ? `<div class="mc-rhint">${esc(hint)}</div>` : ''}${old ? '<div class="mc-note">Lidarr forgets a search after 30 minutes - press Ask again first, then pick one.</div>' : ''}
        ${j.rels.map(r => `<div class="mc-rel"><span class="mc-rt"><span title="${esc(r.title)}">${esc(r.title)}</span>
          <span class="mc-sub">${[r.q, r.size ? fmtBytes(r.size) : '', r.seed != null && r.proto === 'torrent' ? `${r.seed} seeder${r.seed === 1 ? '' : 's'}` : '', r.indexer].filter(Boolean).map(esc).join(' · ')}${r.no.length ? ` · <span class="mc-no">${esc(r.no.join('; '))}</span>` : ' · <span class="mc-yes">Lidarr would take this one</span>'}</span></span>
          <button type="button" class="uc-btn" data-lidgrab="${esc(p)}" data-guid="${esc(r.guid)}">Download this</button></div>`).join('')}</div>`;
    }
    /* the Sent to Lidarr list: each album, where it landed, its tags, and the old folder */
    function drawLid() {
      const bar = el('.mc-bar'), box = el('.mc-list');
      bar.innerHTML = '<span class="muted mc-bt">Albums you asked Lidarr for. Once Lidarr has one, see where it landed and check its tags; when Lidarr put it in a new folder, delete the old one and update your playlists.</span>';
      const emp = new Set(M.r.empty.map(x => x.p));
      const rows = Object.entries(M.lid).sort((a, b) => (b[1].asked || b[1].at || 0) - (a[1].asked || a[1].at || 0));
      box.innerHTML = rows.map(([p, j]) => {
        const moved = j.where && j.where !== p, done = j.total && j.have >= j.total;
        const short = j.want && j.total && j.total < j.want;
        const info = [j.where ? `${moved ? `Now in <b>${esc(rel(j.where))}</b>` : 'In the same folder'} · ${j.have}/${j.total || '?'} songs${done && !short ? ' - complete' : ''}` : j.state === 'sent' ? 'Lidarr hasn\'t got any of it yet' : '',
          j.dl ? `Downloading · ${j.dl.pct}%${j.dl.eta ? ' · ' + esc(j.dl.eta) + ' left' : ''}` : '',
          short ? `<span class="mc-note">Lidarr counts ${j.total} songs for the edition it matched - your album has ${j.want}. Ask again to switch it to the ${j.want}-song edition.</span>` : '',
          j.edition ? `Edition: ${esc(j.edition)}` : '', j.state === 'nothing' ? `<span class="mc-note">${esc(j.msg || '')}</span>` : ''].filter(Boolean);
        return `<div class="ef-row mc-lrow"><span class="ef-path">${pretty(p)}${info.map(t => `<span class="mc-sub">${t}</span>`).join('')}</span>
          ${(j.state === 'sent' && j.where) || j.state === 'nothing' ? '' : lidBtn(p).replace(/<button[^>]*data-lidold[^>]*>[^<]*<\/button>/, '').replace(/<button[^>]*data-lid=[^>]*>[^<]*<\/button>/, '')}
          ${j.where ? `<button type="button" class="uc-btn" data-lopen="${esc(j.where)}">Open</button><button type="button" class="uc-btn" data-ltags="${esc(j.where)}" title="Check the songs' tags">Tags</button>` : ''}
          ${moved && emp.has(p) ? `<button type="button" class="uc-btn danger" data-lidold="${esc(p)}" title="The old folder is left over - to the trash (Undo brings it back)">Delete old folder</button>` : ''}
          ${moved ? `<button type="button" class="uc-btn" data-lidpl="${esc(p)}" title="Playlists with songs from the old folder get the new folder's songs">Update playlists</button>` : ''}
          ${lidOk() && !LID_BUSY.includes(j.state) ? `<button type="button" class="uc-btn" data-lid="${esc(p)}" title="Run it again: find the album in Lidarr, pick the edition with all the songs, search">Ask again</button>` : ''}
          <button type="button" class="uc-btn mc-accb" data-lidforget="${esc(p)}" title="Take it off this list (Lidarr isn't told anything)">Forget</button></div>${lidPick(p)}${lidRels(p, j)}`;
      }).join('') || '<div class="uc-empty">Nothing sent to Lidarr.</div>';
      lidWhere();
    }
    let lidT = 0, lidRe = 0;
    function lidPoll() {
      clearTimeout(lidT);
      if (tdlg.tool !== 'music') return;
      if (Object.values(M.lid).some(j => LID_BUSY.includes(j.state))) lidT = setTimeout(async () => { await lidLoad(); if (M.r && tdlg.tool === 'music') draw(); lidPoll(); }, 8000);
    }
    /* albums sent to Lidarr: checked again every few minutes while this is open - once complete, they drop off */
    clearInterval(lidRe);
    lidRe = setInterval(() => {
      if (tdlg.tool !== 'music') return clearInterval(lidRe);
      if (!M.r || M.busy) return;
      const listed = new Set([...M.r.gaps, ...M.r.empty].map(x => x.p));
      const paths = Object.entries(M.lid).filter(([p, j]) => j.state === 'sent' && listed.has(p)).map(([p]) => p);
      if (paths.length) recheck(paths, '', true);
    }, 180000);
    /* a folder with no songs, opened in the list: its pictures and files */
    function peekHtml(p) {
      const v = M.peek.get(p);
      if (!v) return '<div class="mc-peek muted"><span class="spin"></span> Reading…</div>';
      if (v.err) return `<div class="mc-peek uc-error">${esc(v.err)}</div>`;
      const pics = v.filter(([n, t]) => t !== 'd' && GAL_IMG.test(n)), rest = v.filter(([n, t]) => t === 'd' || !GAL_IMG.test(n));
      return `<div class="mc-peek">${pics.slice(0, 12).map(([n]) => `<img loading="lazy" alt="" title="${esc(n)}" src="${esc(thumbUrl(join(p, n), 160))}">`).join('')}${pics.length > 12 ? `<span class="muted">+${pics.length - 12} more</span>` : ''}
        ${rest.length ? `<div class="mc-pfiles">${rest.slice(0, 30).map(([n, t]) => `<span>${t === 'd' ? '📁 ' : ''}${esc(n)}</span>`).join('')}${rest.length > 30 ? `<span class="muted">+${rest.length - 30} more</span>` : ''}</div>` : ''}${!v.length ? '<span class="muted">Nothing in it at all.</span>' : ''}</div>`;
    }
    /* the songs' own album name and year, for each folder of the same album twice */
    let tagsRun = false;
    async function dupTags(list) {
      if (tagsRun || M.tagsOff) return;
      const need = list.slice(0, 1000).flat().map(x => x.p).filter(p => !M.tags.has(p));
      if (!need.length) return;
      tagsRun = true;
      try {
        for (let i = 0; i < need.length && i < 600; i += 30) {
          const r = await api('music_albtags', { paths: need.slice(i, i + 30) });
          if (r.ff === false) { M.tagsOff = true; ffWant(); break; }
          for (const [k, v] of Object.entries(r.tags || {})) M.tags.set(k, v || { album: '', year: '' });
          if (M.tab === 'dups' && !M.acc && tdlg.tool === 'music') draw();
        }
      } catch (e) {}
      tagsRun = false;
    }
    const gen = dlg.gen;     // the window is used again by the next tool: these listeners stay, but stop answering
    dlg.addEventListener('click', async e => {
      if (dlg.gen !== gen || !M.r || !dlg.contains(e.target)) return;
      const t = e.target.closest('[data-tab]'); if (t) { M.tab = t.dataset.tab; M.picked.clear(); M.acc = false; return draw(); }
      if (e.target.closest('.mc-acctog')) { M.acc = !M.acc; M.picked.clear(); return draw(); }
      if (e.target.closest('.mc-relist')) { if (!M.busy) relist(); return; }
      const la = e.target.closest('[data-lid]');
      if (la) {
        e.preventDefault(); const p = la.dataset.lid, t = M.tags.get(p) || {}, g = (M.r.gaps || []).find(x => x.p === p), old = M.lid[p] || {};
        /* how many songs the album has: the ones there plus the missing numbers - so Lidarr can be steered to that edition */
        const want = g ? g.n + g.gaps.reduce((n, [, m]) => n + m.length, 0) : old.want || 0;
        try { const r = await api('lidarr_ask', { path: p, artist: parent(p), album: t.album || '', year: t.year || '', want }); M.lid[p] = r.job; } catch (er) { return toast(er.message, true); }
        draw(); lidPoll(); return;
      }
      const lg = e.target.closest('[data-lidgrab]');
      if (lg) {
        e.preventDefault(); const p = lg.dataset.lidgrab, stop = mcBusy('Asking Lidarr to download it…');
        try { const r = await api('lidarr_grab', { path: p, guid: lg.dataset.guid }); Object.assign(M.lid[p], r, { whereAt: 0 }); stop(); toast(r.msg); } catch (er) { stop(); return toast(er.message, true); }
        draw(); lidWhere(); return;
      }
      const lp = e.target.closest('[data-lidpick]');
      if (lp) {
        e.preventDefault(); const p = lp.dataset.lidpick, sel = $(`[data-lidsel="${CSS.escape(p)}"]`, dlg);
        try { const r = await api('lidarr_pick', { path: p, id: sel ? sel.value : 0 }); M.lid[p] = r.job; } catch (er) { return toast(er.message, true); }
        draw(); lidPoll(); return;
      }
      const lo = e.target.closest('[data-lopen]');
      if (lo) { e.preventDefault(); M.moved = true; M.last = []; parkTool(); musEnter(A(), lo.dataset.lopen); return; }
      const lt = e.target.closest('[data-ltags]'); if (lt) { e.preventDefault(); return openTagEditor([{ path: lt.dataset.ltags, dir: true }]); }
      const ld = e.target.closest('[data-lidold]');
      if (ld) {
        e.preventDefault(); const p = ld.dataset.lidold, stop = mcBusy(`Deleting ${base(p)}…`);
        try { const x = await api('trash', { paths: [p], label: `Deleted the old folder ${base(p)} (Lidarr moved the album)` }); stop(); done(`Deleted ${base(p)}`, x.hist); } catch (er) { stop(); return toast(er.message, true); }
        leave(p, parent(p)); return recheck([parent(p)]);
      }
      const lpl = e.target.closest('[data-lidpl]');
      if (lpl) {
        e.preventDefault(); const p = lpl.dataset.lidpl, j = M.lid[p]; if (!j || !j.where) return;
        const mine = pl.items.filter(x => x.startsWith(p + '/'));
        const stop = mcBusy('Looking through your playlists for songs from the old folder…');
        let r; try { r = await api('pl_remap', { from: p, to: j.where, songs: mine }); } catch (er) { stop(); return toast(er.message, true); }
        stop();
        const files = r.files.filter(f => f.found), inPl = mine.filter(x => r.map[x]).length;
        if (!files.length && !inPl) return toast(r.files.length ? `${r.files.length} playlist${s(r.files.length)} have songs from the old folder, but none could be matched in the new one` : 'No playlist has songs from the old folder');
        openDlg('Update playlists', `<div>Songs from <b>${esc(base(p))}</b> are now in <b>${esc(base(j.where))}</b>.</div>
          <div class="kf-list">${files.map(f => `<div>${esc(base(f.path))}: ${f.found} of ${f.songs} song${s(f.songs)}</div>`).join('')}${inPl && !files.some(f => f.path === pl.file) ? `<div>The open playlist: ${inPl} song${s(inPl)}</div>` : ''}</div>
          <div class="muted">Each song is matched by its disc and track number (or its title). The old playlist files go to the trash - Undo brings them back.</div>`,
          [{ label: 'Cancel' }, { label: 'Update', primary: true, run: async () => {
            const stop2 = mcBusy('Updating the playlists…');
            let x; try { x = await api('pl_remap', { from: p, to: j.where, apply: '1' }); } finally { stop2(); }
            if (inPl) { pl.items = pl.items.map(y => x.map[y] || r.map[y] || y); plStore(); }
            plFilesAt = 0; done(`Updated ${files.length} playlist${s(files.length)}${inPl ? ' and the open one' : ''}`, x.hist);
          } }]);
        return;
      }
      const lf = e.target.closest('[data-lidforget]');
      if (lf) { e.preventDefault(); try { M.lid = (await api('lidarr_jobs', { forget: lf.dataset.lidforget })).jobs || {}; } catch (er) {} return draw(); }
      const pk = e.target.closest('[data-peek]');
      if (pk) {
        e.preventDefault(); const p = pk.dataset.peek;
        if (M.peek.has(p)) { M.peek.delete(p); return draw(); }
        M.peek.set(p, null); draw();
        try { const x = await api('list', { path: p }); M.peek.set(p, x.items); } catch (er) { M.peek.set(p, { err: er.message }); }
        return draw();
      }
      const ac = e.target.closest('[data-acc]');
      if (ac) {
        e.preventDefault(); if (M.busy) return;
        try { got(await api('music_accept', { list: M.tab, keys: [ac.dataset.acc], on: M.acc ? '0' : '1' })); } catch (er) { toast(er.message, true); }
        return;
      }
      const o = e.target.closest('[data-open]');
      if (o) {
        e.preventDefault(); const p = o.dataset.open;
        const item = M.r[M.tab].find(x => Array.isArray(x) ? x.some(y => y.p === p) : x.p === p || parent(x.p) === p);
        M.moved = true; M.last = [item ? recheckOf(M.tab, item) : p];
        parkTool(); musEnter(A(), p);
        return;
      }
      const mk = e.target.closest('[data-mk]');
      if (mk) { e.preventDefault(); const p = mk.dataset.mk; return openCoverMaker([p], made => { if (made.length) recheck(made); }); }
      const mg = e.target.closest('[data-merge]'); if (mg) return openMerge(M.r.dups[+mg.dataset.merge]);
      const rn = e.target.closest('[data-ren]');
      if (rn) {
        const p = rn.dataset.ren, to = rn.dataset.to;
        try { const x = await api('rename', { path: parent(p), from: base(p), to }); done(`Renamed to ${to}`, x.hist); } catch (er) { return toast(er.message, true); }
        refreshBoth(); return recheck([parent(p)]);
      }
      const kp = e.target.closest('[data-keep]');
      if (kp) { e.preventDefault(); const x = M.r.mixed.find(y => y.p === kp.dataset.keep); if (x) keepFormat(x, kp.dataset.ext); return; }
      const bo = e.target.closest('[data-both]');
      if (bo) { const g = M.r.dups[+bo.dataset.both]; M.moved = true; M.last = [parent(g[0].p)]; parkTool(); musPair(M.r.root, g[0].p, g[1].p); return; }
      const dl = e.target.closest('[data-del]');
      if (dl) {
        const p = dl.dataset.del;
        try { const x = await api('trash', { paths: [p], label: `Deleted ${base(p)} (music check)` }); done(`Deleted ${base(p)}`, x.hist); } catch (er) { return toast(er.message, true); }
        leave(p, parent(p));
        return recheck([parent(p)]);
      }
      const d = e.target.closest('[data-do]'); if (!d || M.busy) return;
      const picked = [...M.picked]; if (!picked.length) return;
      M.busy = true; d.disabled = true;
      let again = [];
      try {
        if (d.dataset.do === 'make') { M.busy = false; d.disabled = false; return openCoverMaker(picked, made => { M.picked.clear(); if (made.length) recheck(made); else draw(); }); }
        if (d.dataset.do === 'accept') {
          got(await api('music_accept', { list: M.tab, keys: picked, on: '1' }));
          toast(`${picked.length} accepted - they stay off the list until their folder changes`);
        }
        if (d.dataset.do === 'covers') {
          let ok = 0, hist = '';
          for (const [i, p] of picked.entries()) {
            d.textContent = `Saving ${i + 1} of ${picked.length}…`;
            const a = M.r.nocover.find(x => x.p === p);
            try { const x = await api('cover_save', Object.assign({ dir: p, from: a.first, label: `Saved album covers from the songs (music check)` }, hist ? { join: hist } : {})); hist = hist || x.hist; ok++; again.push(p); }
            catch (er) { a.note = /no picture inside/.test(er.message) ? 'no picture inside the songs' : er.message; }
          }
          coverV++;
          const left = picked.length - ok;
          if (ok) done(`Saved ${ok} cover${s(ok)}${left ? ` - ${left} had no picture inside the songs` : ''}`, hist); else toast('None of those songs have a picture inside - look them up in the tag editor (Find this album online)', true);
        }
        if (d.dataset.do === 'trash') {
          const x = await api('trash', { paths: picked, label: `Deleted ${picked.length} folder${s(picked.length)} with no songs (music check)` });
          done(`Deleted ${picked.length} folder${s(picked.length)}`, x.hist);
          again = picked.map(parent);
        }
        if (d.dataset.do === 'names') {
          const raws = M.r.names.filter(y => M.picked.has(y.p)).map(y => y.raw);
          const x = await api('music_fixname', { raws });
          toast(`Renamed ${x.done}${x.bad.length ? ` - ${x.bad.length} couldn't be: ${x.bad.slice(0, 3).join(', ')}` : ''}`, !!x.bad.length);
          again = picked.map(parent);
        }
        if (d.dataset.do !== 'accept') refreshBoth();
      } catch (er) { toast(er.message, true); }
      M.busy = false; M.picked.clear();
      if (again.length) await recheck(again); else draw();
    });
    dlg.addEventListener('change', e => {
      if (dlg.gen !== gen || !M.r) return;
      if (e.target.closest('.mc-all')) { const list = M.r[M.tab]; if (e.target.checked) list.forEach(x => M.picked.add(x.p)); else M.picked.clear(); return draw(); }
      const c = e.target.closest('[data-k]'); if (!c) return;
      if (c.checked) M.picked.add(c.dataset.k); else M.picked.delete(c.dataset.k);
      draw();
    });
    /* the results from the last hour come back at once; older ones are checked again */
    if (saved) {
      el('.mc-prog').hidden = false; el('.mc-prog').innerHTML = '<div class="ef-loading"><span class="spin"></span> Getting the last results…</div>';
      let r = null; try { r = await api('music_check', { path: saved, cached: '1' }); } catch (e) {}
      if (tdlg.tool !== 'music') return;
      if (r && !r.none) { got(r); if (TABS.some(([k]) => M.r[k].length)) relist(); } else scan();
    }
  }

  /* ---------- the tools' "Look in" folders: a short list, added with Browse… ----------
   * Kept as folders relative to /mnt/user (Media/Movies, TV2/Dexter…). */
  const FP_APP = ['appdata', 'system', 'domains', 'isos'];
  /* a folder as a share-relative folder: /mnt/user/Media/Movies or /mnt/disk3/Media/Movies → Media/Movies ('' = all shares) */
  const fpRel = path => { if (/^\/mnt\/user\/?$/.test(path || '')) return ''; const m = /^\/mnt\/([^/]+)\/(.+?)\/?$/.exec(path || ''); return m && !['remotes', 'disks', 'addons', 'rootshare'].includes(m[1]) ? m[2] : null; };
  const fpDefault = shares => shares.filter(n => !FP_APP.includes(n));
  const fpLine = l => (l = [...l].sort((a, b) => collator.compare(a, b))).length ? l.slice(0, 8).map(d => `<span class="fp-pick">${esc(d)}</span>`).join(' ') + (l.length > 8 ? ` <span class="muted">+${l.length - 8} more</span>` : '') : '';
  const flHTML = `<div class="fl-row"><span class="ef-lbl">Look in</span><span class="fl-chips"></span>
        <span class="fl-acts"><button type="button" class="uc-btn fl-brw">Browse…</button><button type="button" class="uc-btn fl-pane" title="Add the folder open in the active pane">Active pane's folder</button></span></div>
      <div class="fl-fb" hidden><div class="fb-box"></div><div class="fl-fbbar"><button type="button" class="uc-btn primary fl-add">Add this folder</button><span class="muted fl-cur mono"></span><button type="button" class="uc-btn fl-done">Done</button></div></div>`;
  function folderList(dlg, key, shares) {
    const all = fpDefault(shares);
    let sel = store.get(key, null) || all, brw = null;
    const isAll = () => sel.length === all.length && all.every(n => sel.includes(n));
    const chips = $('.fl-chips', dlg), fb = $('.fl-fb', dlg);
    function draw() {
      store.set(key, sel);
      chips.innerHTML = !sel.length ? '<span class="muted">nothing yet - Browse… to pick a folder</span>'
        : isAll() ? `<span class="fp-pick">All shares <span class="fp-x2">(not ${FP_APP.filter(n => shares.includes(n)).join(', ')})</span><button type="button" class="fp-x" data-flx="*" title="Remove">✕</button></span>`
        : [...sel].sort((a, b) => collator.compare(a, b)).map(d => `<span class="fp-pick" title="/mnt/user/${esc(d)}">${esc(d)}<button type="button" class="fp-x" data-flx="${esc(d)}" title="Remove">✕</button></span>`).join('');
    }
    function add(rel) {
      if (rel === null) return toast('Pick a folder inside your shares (/mnt/user)', true);
      if (rel === '') { sel = [...all]; return draw(); }
      const cover = sel.find(d => rel === d || rel.startsWith(d + '/'));
      if (cover) return toast(cover === rel ? 'Already in the list' : `Already covered by ${cover}`);
      sel = [...sel.filter(d => !d.startsWith(rel + '/')), rel]; draw();
    }
    chips.addEventListener('click', e => { const x = e.target.closest('[data-flx]'); if (!x) return; e.preventDefault(); sel = x.dataset.flx === '*' ? [] : sel.filter(d => d !== x.dataset.flx); draw(); });
    $('.fl-brw', dlg).addEventListener('click', () => {
      fb.hidden = !fb.hidden;
      if (!fb.hidden && !brw) brw = folderBrowser($('.fb-box', fb), A().mode === 'dir' && fpRel(A().path) !== null ? A().path : '/mnt/user', { onDir: d => { $('.fl-cur', fb).textContent = d; } });
    });
    $('.fl-add', dlg).addEventListener('click', () => add(fpRel(brw ? brw.dir : '')));
    $('.fl-done', dlg).addEventListener('click', () => { fb.hidden = true; });
    $('.fl-pane', dlg).addEventListener('click', () => add(A().mode === 'dir' ? fpRel(A().path) : null));
    draw();
    return { get: () => [...sel] };
  }

  /* ---------- Tools > Empty folders on disks ---------- */
  /* ---------- Tools › Duplicates ----------
   * "Same file on several disks": /mnt/user shows one; the extra copies hide on other disks or the
   * cache (mover can't move a file that's already on a disk). "Same content": identical files under
   * other names or in other folders. You tick what goes; it goes to the trash, one History step. */
  async function openDupTool() {
    if (tdlg.tool === 'dupes') return unparkTool();
    const dlg = tdlg;
    let info; try { info = await api('mounts'); } catch (e) { return toast(e.message, true); }
    const APP = ['appdata', 'system', 'domains', 'isos'];
    const T = { scan: null, st: null, res: [], show: 200, mode: store.get('dupMode', 'paths'), keep: store.get('dupKeep', 'full'), inDir: '', ticks: new Map(), timer: 0, dirn: new Map(), snap: layoutSnap(), moved: false };
    if (!['full', 'oldest', 'newest', 'in'].includes(T.keep)) T.keep = 'full';
    const NAME = { paths: 'Duplicate files on different disks', content: 'Identical files anywhere' };
    const DESC = { paths: "The same file in the same folder on two disks, or on a disk and the cache. Your shares show only one of them - the others waste space and can stop mover. Quick: only reads folder listings.",
      content: 'Files with exactly the same content, even under different names or in different folders - like a movie copied into two folders. Slower: it reads the files to compare them.' };
    openToolDlg('dupes', 'Duplicates', `
      <div class="dp-tabs">${['paths', 'content'].map(m => `<label class="dp-tab" data-m="${m}"><input type="radio" name="dp-m" value="${m}"><span class="dp-tt">${NAME[m]}</span><span class="dp-td">${DESC[m]}</span><span class="dp-now">Showing this list</span></label>`).join('')}</div>
      <div class="dp-card ef-setup">
        <div class="dp-ch">Where to look</div>
        ${flHTML}
        <div class="dp-min"><span class="ef-lbl">Skip files smaller than</span> <input type="text" class="dp-minv" inputmode="numeric" value="${T.mode === 'paths' ? '0' : '10'}" size="5"> <select class="dp-minu"><option value="1024"${T.mode === 'paths' ? ' selected' : ''}>KB</option><option value="1048576"${T.mode === 'paths' ? '' : ' selected'}>MB</option></select> <span class="dp-note">0 = every file</span></div>
        <div class="dp-note">Reads the folders of every disk you have, so sleeping disks spin up. It runs in the background at low priority - you can tuck this window away and come back.</div>
      </div>
      <div class="ef-prog dp-prog" hidden></div>
      <div class="dp-card dp-res" hidden>
        <div class="dp-bar"><div class="dp-ch dp-top"><span>Results: <span class="dp-rname"></span></span><b class="dp-sum"></b><button type="button" class="uc-btn danger dp-del" disabled>Delete ticked</button></div><div class="dp-keep"></div></div>
        <div class="dp-list"></div>
      </div>`,
      [{ label: 'Close' }, { label: 'Stop', run: async () => { if (T.scan) await api('scan_stop', { id: T.scan }).catch(() => {}); return false; } }, { label: 'Scan', primary: true, run: () => { start(); return false; } }], 'full ef-dlg dp-dlg sticky');
    const [bClose, bStop, bGo] = $$('.dlg-foot .uc-btn', dlg); bStop.hidden = true;
    dlg.toolLabel = () => `Duplicates${T.res.length ? ' · ' + T.res.length.toLocaleString() : T.scan ? ' · scanning' : ''}`;
    const el = s => $(s, dlg), gen = dlg.gen;
    const fp = folderList(dlg, 'dupDirs', info.shares);
    /* closing puts the panes back the way they were before Show / Both side by side */
    dlg.beforeClose = () => { clearTimeout(T.timer); if (T.moved) layoutRestore(T.snap); return true; };
    /* back from the panes: anything deleted or moved there comes off the list */
    dlg.onUnpark = async () => {
      if (!T.res.length) return;
      const ps = []; for (const [g] of visible().slice(0, T.show)) for (let j = 0; j < count(g); j++) ps.push(fullOf(g, j));
      const gone = await loadInfo(ps);
      if (gone.length) { addGone(gone); prune(gone, []); saveTicks(); toast(`${gone.length.toLocaleString()} file${gone.length === 1 ? ' is' : 's are'} gone since - taken off the list`); }
      draw();
    };
    /* how full each copy's folder is (and which files are gone): asked for the sets on screen */
    async function loadInfo(ps) {
      const gone = [];
      for (let i = 0; i < ps.length; i += 4000) {
        let r; try { r = await api('dup_info', { paths: JSON.stringify(ps.slice(i, i + 4000)) }); } catch (e) { break; }
        for (const [d, n] of Object.entries(r.dirn)) T.dirn.set(d, n);
        for (const [p, e] of Object.entries(r.exists)) if (!e) gone.push(p);
      }
      return gone;
    }
    /* the two kinds are tabs; each keeps its own last scan, ticks and all */
    async function setMode(m, first) {
      if (!first && T.res.length) saveNow();          // your ticks on this tab, before leaving it
      T.mode = m; store.set('dupMode', m); clearTimeout(T.timer);
      $$('.dp-tab', dlg).forEach(b => { b.classList.toggle('on', b.dataset.m === m); $('input', b).checked = b.dataset.m === m; });
      el('.dp-rname').textContent = NAME[m];
      el('.dp-minv').value = m === 'paths' ? '0' : '10'; el('.dp-minu').value = m === 'paths' ? '1024' : '1048576';
      T.scan = null; T.st = null; T.res = []; T.ticks.clear(); T.show = 200;
      el('.dp-res').hidden = true; el('.dp-prog').hidden = true; bGo.textContent = 'Scan'; bStop.hidden = true; bGo.disabled = false;
      try { const l = await api('scan_last', { tool: 'dupes', mode: m }); if (l.id && T.mode === m) { T.scan = l.id; poll(); } } catch (e) {}
    }
    el('.dp-tabs').addEventListener('change', e => { const t = e.target.closest('[data-m]'); if (t && t.dataset.m !== T.mode) setMode(t.dataset.m); });
    /* your ticks and what you've already deleted, kept per scan so closing the window loses nothing */
    const tk = () => 'dupTicks.' + T.mode;
    let tkT = 0;
    const saveTicks = () => { clearTimeout(tkT); tkT = setTimeout(saveNow, 300); };
    function saveNow() {
      clearTimeout(tkT); if (!T.scan) return; const on = [];
      T.res.forEach((g, i) => (T.ticks.get(i) || new Set()).forEach(j => on.push(fullOf(g, j))));
      const old = store.get(tk(), null), mine = old && old.id === T.scan;
      try { store.set(tk(), { id: T.scan, on, gone: mine ? old.gone || [] : [], hid: mine ? old.hid || [] : [] }); } catch (e) {}
    }
    /* deleted files and folders (a folder ends in /) and sets you cleared from the list */
    const remember = (k, add) => { const old = store.get(tk(), null), mine = old && old.id === T.scan; const o = mine ? old : { id: T.scan, on: [], gone: [], hid: [] }; o[k] = [...(o[k] || []), ...add]; try { store.set(tk(), o); } catch (e) {} };
    const addGone = paths => remember('gone', paths);
    const setKey = g => g.k === 'path' ? 'p:' + g.rel : 'c:' + g.files.map(f => f.p).sort().join('|');
    /* drop deleted files and cleared sets from the list, keeping your ticks on what's left */
    function prune(gone, hid) {
      const files = new Set(gone.filter(x => !x.endsWith('/'))), dirs = gone.filter(x => x.endsWith('/'));
      const isGone = p => files.has(p) || dirs.some(d => p.startsWith(d));
      const on = new Set(); T.res.forEach((g, i) => (T.ticks.get(i) || new Set()).forEach(j => on.add(fullOf(g, j))));
      const hs = new Set(hid);
      T.res = T.res.filter(g => !hs.has(setKey(g))).map(g => g.k === 'path' ? { ...g, copies: g.copies.filter(c => !isGone(`/mnt/${c.dev}/${g.rel}`)) } : { ...g, files: g.files.filter(f => !isGone(f.p)) }).filter(g => count(g) > 1);
      T.ticks.clear(); T.res.forEach((g, i) => T.ticks.set(i, new Set([...Array(count(g)).keys()].filter(j => on.has(fullOf(g, j))))));
    }
    const fullOf = (g, i) => g.k === 'path' ? `/mnt/${g.copies[i].dev}/${g.rel}` : g.files[i].p;
    const count = g => g.k === 'path' ? g.copies.length : g.files.length;
    /* same content but the names say different episodes or discs (s01e03 / s01e05, cd1 / cd2): one of
     * them is a copy under the wrong name - and the real one is probably missing. Never ticked by itself. */
    const EPI = /\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{2}|(?:cd|dis[ck]|part|pt)\s*\d+)\b/i;
    const mislabel = g => g.k === 'content' && new Set(g.files.map(f => ((base(f.p).match(EPI) || [''])[0]).toLowerCase().replace(/\s+/g, ''))).size > 1;
    const leftover = p => /TdarrCacheFile|\.partial~?$|\.part$|\.tmp$/i.test(p);
    const KIND = [['vid', 'Video', /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpe?g|iso|vob)$/i], ['aud', 'Music', /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff?|ape|dsf)$/i], ['img', 'Pictures', /\.(jpe?g|png|gif|webp|heic|tiff?|bmp|tbn)$/i], ['oth', 'Other', /./]];
    const kindOf = g => (KIND.find(([, , re]) => re.test(g.k === 'path' ? g.rel : g.files[0].p)) || KIND[3])[0];
    T.kinds = new Set(['vid']); T.big = 0;
    const visible = () => T.res.map((g, i) => [g, i]).filter(([g]) => g.k === 'path' || (T.kinds.has(kindOf(g)) && (g.k === 'path' ? g.copies[0].size : g.size) >= T.big));
    const autoTick = g => {
      const n = count(g); let keep;
      if (g.k === 'content') return new Set();          // same content: you tick (or "Tick the extra copies" below)
      if (g.k === 'path') { keep = g.copies.findIndex(c => c.served); if (!g.same) return new Set(); if (keep < 0) keep = 0; }
      else if (T.keep === 'in' && T.inDir) { keep = g.files.findIndex(f => f.p.startsWith(T.inDir.replace(/\/$/, '') + '/')); if (keep < 0) return new Set(); }
      else keep = T.keep === 'newest' ? n - 1 : 0;            // files come oldest first
      return new Set([...Array(n).keys()].filter(i => i !== keep));
    };
    async function start() {
      const dirs = fp.get();
      if (!dirs.length) return toast('Tick at least one folder to look in', true);
      const min = Math.round((parseFloat(el('.dp-minv').value) || 0) * +el('.dp-minu').value);
      try { T.scan = (await api('dup_start', { mode: T.mode, dirs: JSON.stringify(dirs), min })).id; } catch (e) { return toast(e.message, true); }
      T.res = []; T.ticks.clear(); el('.dp-res').hidden = true; poll();
    }
    async function poll() {
      clearTimeout(T.timer); if (dlg.gen !== gen || !T.scan) return;
      const id = T.scan; let r; try { r = (await api('scan_status', { id })).scan; } catch (e) { return; }
      if (id !== T.scan) return;
      T.st = r; const run = r.state === 'running' || r.state === 'queued';
      bStop.hidden = !run; bGo.disabled = run;
      const ph = { reading: 'Listing files', sorting: 'Sorting', comparing: 'Comparing', checking: 'Reading files to compare them' }[r.phase] || (run ? 'Starting' : '');
      el('.dp-prog').hidden = false;
      el('.dp-prog').innerHTML = run ? `<span class="spin"></span><span>${ph}… ${(r.seen || 0).toLocaleString()} files${r.checked ? ` · ${r.checked.toLocaleString()} read` : ''} · ${(r.found || 0).toLocaleString()} found so far</span>`
        : `<span>${r.state === 'stopped' ? 'Stopped' : 'Done'} - ${(r.seen || 0).toLocaleString()} files looked at · ${(r.found || 0).toLocaleString()} sets · ${fmtBytes(r.wasted || 0)} in extra copies</span>`;
      if (run) { T.timer = setTimeout(poll, 1000); return; }
      try { T.res = (await api('scan_results', { id: T.scan })).results; } catch (e) { return toast(e.message, true); }
      bGo.textContent = 'Scan again';
      T.res.sort((a, b) => b.waste - a.waste);
      const kept = store.get(tk(), null), mine = kept && kept.id === T.scan;
      const on = mine ? new Set(kept.on || []) : null;
      T.res.forEach((g, i) => T.ticks.set(i, on ? new Set([...Array(count(g)).keys()].filter(j => on.has(fullOf(g, j)))) : autoTick(g)));
      if (mine) prune(kept.gone || [], kept.hid || []);          // what you deleted or cleared since the scan stays off the list
      T.kinds = new Set(T.res.some(g => g.k === 'content' && kindOf(g) === 'vid') ? ['vid'] : KIND.map(k => k[0]));
      draw();
    }
    /* each file: look at it (videos, music and pictures open in the player or viewer), or open its folder */
    const dpActs = (path, fold) => `<span class="dp-acts"><button type="button" class="dp-act" data-dpv="${esc(path)}" title="${GAL_VID.test(path) || GAL_AUD.test(path) ? 'Play it' : 'Look at it'}">▶</button><button type="button" class="dp-act" data-dpo="${esc(path)}" title="Open its folder in the active pane (the panes go back when you close Duplicates)">📂 Show</button>${fold ? `<button type="button" class="dp-act dp-rmdir" data-dprm="${esc(path)}" title="Delete the whole folder this copy is in (${esc(base(parent(path)))}) - posters, .nfo, subtitles and all">🗑 Folder</button>` : ''}</span>`;
    /* a folder can go when it's inside a share (not the share itself) and doesn't hold every copy of this set */
    const canRmDir = (g, j) => /^\/mnt\/user\/[^/]+\/./.test(parent(g.files[j].p));
    /* the copy a set keeps: on disks, the one /mnt/user shows; otherwise by your rule - by default the one in
     * the fullest folder, so the stray copy (alone in a folder, or nearly) is the one that goes. -1: can't say. */
    const keepOf = g => {
      const n = count(g);
      if (g.k === 'path') return g.copies.findIndex(c => c.served);          // the hidden copies go, whatever their size
      if (mislabel(g)) return -1;
      if (g.files.some(f => leftover(f.p))) { const k = g.files.findIndex(f => !leftover(f.p)); if (k >= 0) return k; }
      if (T.keep === 'in') return T.inDir ? g.files.findIndex(f => f.p.startsWith(T.inDir.replace(/\/$/, '') + '/')) : -1;
      if (T.keep === 'newest') return n - 1;
      if (T.keep === 'full') {
        const c = g.files.map(f => T.dirn.get(parent(f.p)));
        if (c.some(x => x === undefined)) return -1;
        let k = 0; c.forEach((x, i) => { if (x > c[k]) k = i; }); return k;     // ties: the oldest (files come oldest first)
      }
      return 0;
    };
    const tickRule = g => { const keep = keepOf(g); return keep < 0 ? new Set() : new Set([...Array(count(g)).keys()].filter(i => i !== keep)); };
    function draw() {
      el('.dp-res').hidden = !T.res.length && !T.st;
      const paths = T.res.length && T.res[0].k === 'path';
      const vis = visible();
      const kc = {}; T.res.forEach(g => { if (g.k !== 'content') return; const k = kindOf(g); kc[k] = kc[k] || [0, 0]; kc[k][0]++; kc[k][1] += g.waste; });
      const seg = `<span class="dp-seg"><button type="button" data-tk="all" title="Tick every copy in the sets shown">All</button><button type="button" data-tk="none" title="Untick everything in the sets shown">None</button><button type="button" data-tk="inv" title="Ticked becomes unticked and the other way round, in the sets shown">Invert</button></span>`;
      const extra = `<button type="button" class="uc-btn dp-tickvis" title="${paths ? 'In every set, tick the copies your shares don\'t show' : 'In each set shown, keep one copy and tick the others'}">${paths ? 'Tick the hidden copies' : 'Keep one, tick the rest'}</button>`;
      el('.dp-keep').innerHTML = paths
        ? `<div class="dp-trow"><span class="dp-tl">Tick</span>${seg}${extra}</div>
          <div class="dp-why">Example: <span class="mono">Movies/Dune/movie.nfo</span> is on both <b>cache</b> and <b>disk1</b>. Your Movies share can only show one of them - that one is marked <b>shown in /mnt/user</b>. The other is hidden: nothing ever reads it, it just takes space. <b>Tick the hidden copies</b> ticks those - in every set, even where the sizes or dates differ, since the hidden one is never used.</div>`
        : `<div class="dp-trow"><span class="dp-tl">Show</span><span class="dp-kinds">${KIND.filter(([k]) => kc[k]).map(([k, l]) => `<label class="ef-chip"><input type="checkbox" data-kind="${k}"${T.kinds.has(k) ? ' checked' : ''}><span>${l} · ${kc[k][0].toLocaleString()} · ${fmtBytes(kc[k][1])}</span></label>`).join('')}</span>
            <label class="dp-szl">Files of <select class="dp-big">${[[0, 'any size'], [1048576, '1 MB or more'], [104857600, '100 MB or more'], [1073741824, '1 GB or more']].map(([v, l]) => `<option value="${v}"${T.big === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <span class="dp-note">${vis.length.toLocaleString()} of ${T.res.length.toLocaleString()} sets shown</span></div>
          <div class="dp-trow"><span class="dp-tl">Tick</span>${seg}${extra}<span class="dp-note">- the one kept is the</span><select class="dp-kr"><option value="full"${T.keep === 'full' ? ' selected' : ''}>copy in the fullest folder</option><option value="oldest"${T.keep === 'oldest' ? ' selected' : ''}>oldest copy</option><option value="newest"${T.keep === 'newest' ? ' selected' : ''}>newest copy</option><option value="in"${T.keep === 'in' ? ' selected' : ''}>copy in a folder…</option></select>${T.keep === 'in' ? ` <input type="text" class="dp-in" value="${esc(T.inDir)}" placeholder="/mnt/user/Media/Movies" spellcheck="false">` : ''}</div>
          <div class="dp-why"><b>Different episodes</b> means the same file under two episode or disc numbers: one is a copy with the wrong name, and the real episode is probably missing. Keep one, tick the rest never touches those.</div>
          <div class="dp-why">Example: <span class="mono">Dune (2021)/Dune.mkv</span> and <span class="mono">Dune (2021) [1080p]/Dune.2021.mkv</span> are the same file. <b>Keep one, tick the rest</b> keeps the copy in the fullest folder (the one with its poster, .nfo and the rest) and ticks the stray one - in every set shown at once. The copy it keeps is green. A folder left empty after deleting goes too.</div>`;
      let n = 0, bytes = 0;
      T.res.forEach((g, i) => { const t = T.ticks.get(i) || new Set(); n += t.size; bytes += t.size * (g.k === 'path' ? 0 : g.size); if (g.k === 'path') t.forEach(j => bytes += g.copies[j].size); });
      el('.dp-sum').textContent = T.res.length ? `${T.res.length.toLocaleString()} set${T.res.length === 1 ? '' : 's'} · ${n.toLocaleString()} ticked (${fmtBytes(bytes)})` : 'No duplicates found';
      const del = el('.dp-del'); del.disabled = !n; del.textContent = n ? `Delete ${n.toLocaleString()} ticked (${fmtBytes(bytes)})` : 'Delete ticked';
      /* folder sizes for what's on screen, then draw again */
      const need = []; for (const [g] of vis.slice(0, T.show)) for (let j = 0; j < count(g); j++) { const f = fullOf(g, j); if (!T.dirn.has(parent(f))) need.push(f); }
      if (need.length && !T.loading) { T.loading = true; loadInfo(need).then(gone => { T.loading = false; need.forEach(f => { if (!T.dirn.has(parent(f))) T.dirn.set(parent(f), 0); }); if (gone.length) { addGone(gone); prune(gone, []); } draw(); }); }
      const alone = p => T.dirn.get(parent(p)) === 1 ? '<span class="dp-tag fold" title="Deleting it deletes its folder too">only file in its folder</span>' : '';
      el('.dp-list').innerHTML = vis.slice(0, T.show).map(([g, i]) => {
        const t = T.ticks.get(i) || new Set(), kp = keepOf(g);
        const rows = g.k === 'path'
          ? g.copies.map((c, j) => `<label class="dp-row${t.has(j) ? ' on' : ''}${c.served ? ' keep' : ''}"><input type="checkbox" data-g="${i}" data-j="${j}"${t.has(j) ? ' checked' : ''}><span class="dp-dev">${esc(c.dev)}</span><span class="dp-p mono">/mnt/${esc(c.dev)}/${esc(g.rel)}</span>${dpActs(`/mnt/${c.dev}/${g.rel}`)}${c.served ? '<span class="dp-tag">shown in /mnt/user</span>' : ''}${alone(`/mnt/${c.dev}/${g.rel}`)}<span class="dp-sz">${fmtBytes(c.size)}</span><span class="dp-dt">${fmtDate(c.m)}</span></label>`).join('')
          : g.files.map((f, j) => `<label class="dp-row${t.has(j) ? ' on' : ''}${j === kp ? ' keep' : ''}"${j === kp ? ' title="Keep one, tick the rest keeps this one"' : ''}><input type="checkbox" data-g="${i}" data-j="${j}"${t.has(j) ? ' checked' : ''}><span class="dp-p mono">${esc(f.p)}</span>${dpActs(f.p, canRmDir(g, j))}${j === kp ? '<span class="dp-tag">keeps this one</span>' : ''}${leftover(f.p) ? '<span class="dp-tag lo">leftover file</span>' : ''}${alone(f.p)}<span class="dp-dt">${fmtDate(f.m)}</span></label>`).join('');
        return `<div class="dp-grp${t.size ? ' some' : ''}"><div class="dp-h"><span class="dp-hb"><button type="button" class="dp-act dp-both" data-dpboth="${i}" title="The folders of the first two copies, one in each pane">📂📂 Both side by side</button><button type="button" class="dp-act dp-both dp-clr" data-dpclr="${i}" title="Take this set off the list - nothing is deleted">✕ Clear from list</button></span><b>${esc(g.k === 'path' ? g.rel : base(g.files[0].p))}</b><span class="muted">${count(g)} copies · ${fmtBytes(g.k === 'path' ? g.copies[0].size : g.size)}${g.k === 'path' ? (g.cmp ? ' · <span class="dp-ok">identical inside - only the dates differ</span>' : g.same ? ' · same size and date' : g.copies.every(c => c.size === g.copies[0].size) ? (g.cmpd ? ' · <span class="dp-diff">same size, but different inside - look before you pick</span>' : ' · <span class="dp-diff">same size, different dates</span>') : ' · <span class="dp-diff">different sizes</span>') : mislabel(g) ? ' · <span class="dp-diff">different episodes - one is a copy under the wrong name</span>' : ''} · ${fmtBytes(g.waste)} extra</span></div>${rows}</div>`;
      }).join('') + (vis.length > T.show ? `<button type="button" class="uc-btn dp-more">Show ${Math.min(200, vis.length - T.show)} more</button>` : '');
    }
    el('.dp-res').addEventListener('change', e => {
      const c = e.target.closest('[data-g]');
      if (c) { const t = T.ticks.get(+c.dataset.g) || new Set(); c.checked ? t.add(+c.dataset.j) : t.delete(+c.dataset.j); T.ticks.set(+c.dataset.g, t); saveTicks(); return draw(); }
      if (e.target.closest('.dp-kr')) { T.keep = e.target.value; store.set('dupKeep', T.keep); return draw(); }
      if (e.target.closest('.dp-in')) { T.inDir = e.target.value.trim(); return draw(); }
      const kd = e.target.closest('[data-kind]'); if (kd) { kd.checked ? T.kinds.add(kd.dataset.kind) : T.kinds.delete(kd.dataset.kind); T.show = 200; return draw(); }
      if (e.target.closest('.dp-big')) { T.big = +e.target.value; T.show = 200; return draw(); }
    });
    el('.dp-res').addEventListener('click', async e => {
      const dv = e.target.closest('[data-dpv]'); if (dv) { e.preventDefault(); return openViewer(dv.dataset.dpv); }
      const db = e.target.closest('[data-dpboth]');
      if (db) {
        e.preventDefault(); const g = T.res[+db.dataset.dpboth], a = fullOf(g, 0), b = fullOf(g, 1);
        T.moved = true; load(panes[0], parent(a), base(a)); load(panes[1], parent(b), base(b)); setActive(0); return parkTool();
      }
      const dpo = e.target.closest('[data-dpo]'); if (dpo) { e.preventDefault(); T.moved = true; load(A(), parent(dpo.dataset.dpo), base(dpo.dataset.dpo)); return parkTool(); }
      if (e.target.closest('.dp-more')) { T.show += 200; return draw(); }
      const clr = e.target.closest('[data-dpclr]');
      if (clr) { e.preventDefault(); const g = T.res[+clr.dataset.dpclr]; remember('hid', [setKey(g)]); prune([], [setKey(g)]); saveTicks(); return draw(); }
      const rm = e.target.closest('[data-dprm]');
      if (rm) {
        e.preventDefault(); const dir = parent(rm.dataset.dprm), pre = dir + '/';
        /* sets whose every copy is in this folder would lose them all */
        const all = T.res.filter(g => g.k === 'content' && g.files.every(f => f.p.startsWith(pre))).length;
        /* videos in there that aren't on the list are probably the only copies: say so */
        let n = '', other = 0; try {
          const r = await api('list', { path: dir }); n = r.items.length;
          const listed = new Set(); T.res.forEach(g => g.k === 'content' && g.files.forEach(f => listed.add(f.p)));
          other = r.items.filter(([nm, t]) => t !== 'd' && GAL_VID.test(nm) && !listed.has(join(dir, nm))).length;
        } catch (er) {}
        if (!confirm(`Move the whole folder to the trash?\n\n${dir}\n\n${n !== '' ? `${n} item${n === 1 ? '' : 's'} inside. ` : ''}${other ? `${other} video${other === 1 ? ' in it isn\'t a duplicate' : 's in it aren\'t duplicates'} - ${other === 1 ? 'it' : 'they'} would go too. ` : ''}${all ? `It holds every copy of ${all} set${all === 1 ? '' : 's'} on the list - none of ${all === 1 ? 'it' : 'them'} would stay. ` : ''}Undo (History) brings it back.`)) return;
        let r; try { r = await api('trash', { paths: JSON.stringify([dir]), label: `Deleted folder ${base(dir)} (duplicate)` }); } catch (er) { return toast(er.message, true); }
        addGone([pre]); prune([pre], []); saveTicks();
        done(`Moved ${base(dir)} to the trash`, r.hist); draw(); refreshBoth(); return;
      }
      if (e.target.closest('.dp-tickvis')) {
        const vis = visible();
        if (T.keep === 'full') { const ps = []; for (const [g] of vis) if (g.k === 'content') g.files.forEach(f => { if (!T.dirn.has(parent(f.p))) ps.push(f.p); }); if (ps.length) await loadInfo(ps); }
        let k = 0, skip = 0, newer = 0;
        for (const [g, i] of vis) {
          const t = tickRule(g), kp = keepOf(g);
          if (kp < 0) { skip++; continue; }
          if (g.k === 'path' && [...t].some(j => g.copies[j].m > g.copies[kp].m)) newer++;
          T.ticks.set(i, t); k += t.size;
        }
        toast(`Ticked ${k.toLocaleString()} extra cop${k === 1 ? 'y' : 'ies'}${newer ? ` - in ${newer.toLocaleString()} set${newer === 1 ? '' : 's'} the hidden copy is the newer one` : ''}${skip ? ` - ${skip.toLocaleString()} set${skip === 1 ? '' : 's'} left for you to look at` : ''}`); saveTicks(); return draw();
      }
      const tkb = e.target.closest('[data-tk]');
      if (tkb) {
        for (const [g, i] of visible()) { const n = count(g), t = T.ticks.get(i) || new Set(); T.ticks.set(i, new Set([...Array(n).keys()].filter(j => tkb.dataset.tk === 'all' || (tkb.dataset.tk === 'inv' && !t.has(j))))); }
        saveTicks(); return draw();
      }
      if (!e.target.closest('.dp-del')) return;
      let paths = []; T.res.forEach((g, i) => (T.ticks.get(i) || new Set()).forEach(j => paths.push(fullOf(g, j))));
      if (!paths.length) return;
      /* a folder left with nothing in it goes too (one step, so Undo brings both back) */
      await loadInfo(paths.filter(p => !T.dirn.has(parent(p))));
      const per = new Map(); paths.forEach(p => per.set(parent(p), (per.get(parent(p)) || 0) + 1));
      const empt = [...per].filter(([d, n]) => n === T.dirn.get(d) && /^\/mnt\/[^/]+\/[^/]+\/./.test(d)).map(([d]) => d);
      if (empt.length) { const es = new Set(empt); paths = [...paths.filter(p => !es.has(parent(p))), ...empt]; }
      const none = T.res.filter((g, i) => (T.ticks.get(i) || new Set()).size >= count(g)).length;
      if (!confirm(`Move ${paths.length.toLocaleString()} item${paths.length === 1 ? '' : 's'} to the trash?${empt.length ? ` (${empt.length.toLocaleString()} of them ${empt.length === 1 ? 'is a folder' : 'are folders'} that would be left empty.)` : ''} ${none ? `Every copy is ticked in ${none.toLocaleString()} set${none === 1 ? '' : 's'} - nothing of ${none === 1 ? 'that one' : 'those'} stays.` : 'One copy of each stays.'} Undo (History) brings them back.`)) return;
      let r; try { r = await api('trash', { paths: JSON.stringify(paths), label: `Deleted ${paths.length} duplicate${paths.length === 1 ? '' : 's'}` }); } catch (er) { return toast(er.message, true); }
      const gl = paths.map(p => empt.includes(p) ? p + '/' : p); addGone(gl); prune(gl, []); empt.forEach(d => T.dirn.delete(d));
      saveTicks();
      done(`Moved ${paths.length.toLocaleString()} duplicate${paths.length === 1 ? '' : 's'} to the trash`, r.hist); draw(); refreshBoth();
    });
    /* the last scan of this kind, if any: kept until you scan again (or the server restarts) */
    setMode(T.mode, true);
  }

  /* ---------- What's using space here: a map and a list, one folder at a time ---------- */
  const SP_KIND = [[/\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpe?g|iso|vob)$/i, 'vid'], [/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff?|ape|dsf)$/i, 'aud'], [/\.(jpe?g|png|gif|webp|heic|tiff?|bmp|raw|cr2|nef|arw|dng)$/i, 'img'], [/\.(zip|rar|7z|tar|gz|xz|bz2|zst|img|qcow2|vdisk)$/i, 'arc']];
  const spKind = it => it.d ? (it.k || 'oth') + ' dir' : it.rest ? 'rest' : (SP_KIND.find(([re]) => re.test(it.n)) || [, 'oth'])[1];
  /* squarified treemap: rows of tiles kept as close to square as possible */
  function squarify(items, x, y, w, h) {
    const out = [], tot = items.reduce((a, b) => a + b.s, 0) || 1;
    let list = items.map(it => ({ it, a: it.s / tot * w * h })).filter(t => t.a > 0);
    while (list.length) {
      const short = Math.min(w, h); let row = [], best = Infinity;
      for (const t of list) {
        const r = [...row, t], sum = r.reduce((a, b) => a + b.a, 0), mx = Math.max(...r.map(z => z.a)), mn = Math.min(...r.map(z => z.a));
        const worst = Math.max(short * short * mx / (sum * sum), sum * sum / (short * short * mn));
        if (worst > best) break; best = worst; row = r;
      }
      list = list.slice(row.length);
      const sum = row.reduce((a, b) => a + b.a, 0), thick = sum / short; let off = 0;
      for (const t of row) { const len = t.a / thick; out.push(w >= h ? { it: t.it, x, y: y + off, w: thick, h: len } : { it: t.it, x: x + off, y, w: len, h: thick }); off += len; }
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    }
    return out;
  }
  async function openSpaceTool(path) {
    path = path || (A().mode === 'dir' ? A().path : '/mnt/user');
    const dlg = tdlg;
    const T = { scan: null, root: path, rel: '', lv: null, timer: 0 };
    openToolDlg('space', "What's using space", `<div class="sp-top"><div class="sp-crumb"></div><span class="sp-tot muted"></span></div>
      <div class="ef-prog sp-prog"></div><div class="sp-map"></div><div class="sp-legend"><span class="muted">Colour = what's inside:</span> <i class="vid"></i>video <i class="aud"></i>music <i class="img"></i>pictures <i class="arc"></i>archives &amp; disk images <i class="oth"></i>other</div><div class="sp-list"></div>`,
      [{ label: 'Close' }, { label: 'Open in the pane', run: () => { load(A(), T.root + (T.rel ? '/' + T.rel : '')); parkTool(); return false; } }, { label: 'Scan again', run: () => { start(); return false; } }], 'full sp-dlg sticky');
    const gen = dlg.gen, el = s => $(s, dlg);
    dlg.toolLabel = () => `Space · ${base(T.root) || T.root}`;
    /* back from the panes: anything changed in the folders opened there is put right in the map */
    const touched = new Set(), under = d => d === T.root || d.startsWith(T.root === '/' ? '/' : T.root + '/');
    dlg.onTouched = d => { if (under(d)) touched.add(d); };
    dlg.onUnpark = async () => {
      panes.forEach(p => { if (p.mode === 'dir' && !p.arc) dlg.onTouched(p.path); });
      if (!touched.size || !T.lv || !T.scan) return;
      const dirs = [...touched]; touched.clear();
      el('.sp-tot').textContent = 'Checking for changes…';
      let r; try { r = await api('space_refresh', { id: T.scan, dirs: JSON.stringify(dirs) }); } catch (e) { toast(e.message, true); }
      if (dlg.gen !== gen) return;
      /* the folder on show may be gone: the nearest one above that's still there */
      let rel = T.rel;
      for (;;) { try { const lv = await api('space_level', { id: T.scan, rel }); if (dlg.gen !== gen) return; T.rel = lv.rel; T.lv = lv; draw(); break; } catch (e) { if (!rel) { el('.sp-tot').textContent = ''; return; } rel = rel.split('/').slice(0, -1).join('/'); } }
      if (r && r.changed) toast(`Updated the map: ${r.changed} folder${r.changed === 1 ? '' : 's'} changed`);
    };
    async function start() {
      try { T.scan = (await api('space_start', { root: T.root })).id; } catch (e) { return toast(e.message, true); }
      T.rel = ''; T.lv = null; el('.sp-map').innerHTML = ''; el('.sp-list').innerHTML = ''; poll();
    }
    async function poll() {
      clearTimeout(T.timer); if (dlg.gen !== gen) return;
      let r; try { r = (await api('scan_status', { id: T.scan })).scan; } catch (e) { return; }
      if (r.state === 'running' || r.state === 'queued') { el('.sp-prog').hidden = false; el('.sp-prog').innerHTML = `<span class="spin"></span> Adding up ${esc(T.root)}… ${(r.seen || 0).toLocaleString()} files · ${fmtBytes(r.bytes || 0)}`; T.timer = setTimeout(poll, 800); return; }
      el('.sp-prog').hidden = true; go('');
    }
    async function go(rel) {
      let r; try { r = await api('space_level', { id: T.scan, rel }); } catch (e) { return toast(e.message, true); }
      if (dlg.gen !== gen) return;
      T.rel = r.rel; T.lv = r; draw();
    }
    function draw() {
      const r = T.lv, parts = T.rel ? T.rel.split('/') : [];
      el('.sp-crumb').innerHTML = `<button type="button" data-rel="">${esc(T.root)}</button>` + parts.map((p, i) => `<span>/</span><button type="button" data-rel="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('');
      el('.sp-tot').textContent = `${fmtBytes(r.s)} · ${r.c.toLocaleString()} files`;
      const box = el('.sp-map'), W = box.clientWidth || 800, H = box.clientHeight || 360;
      const items = r.items.filter(it => it.s > 0);
      box.innerHTML = squarify(items, 0, 0, W, H).map(t => {
        const big = t.w > 70 && t.h > 30, k = spKind(t.it), nm = t.it.rest ? `${t.it.c.toLocaleString()} smaller files` : t.it.n;
        return `<div class="sp-t ${k}" style="left:${t.x}px;top:${t.y}px;width:${Math.max(0, t.w - 2)}px;height:${Math.max(0, t.h - 2)}px"${t.it.d ? ` data-go="${esc(t.it.n)}"` : ''} title="${esc(nm)} · ${fmtBytes(t.it.s)}">${big ? `<span>${esc(nm)}</span><small>${fmtBytes(t.it.s)}</small>` : ''}</div>`;
      }).join('');
      el('.sp-list').innerHTML = (T.rel ? '<div class="sp-row sp-up" data-up="1"><span class="sp-n">↑ Up one folder</span></div>' : '') + items.slice(0, 200).map(it => {
        const pc = r.s ? it.s / r.s * 100 : 0, k = spKind(it);
        return `<div class="sp-row${it.d ? ' dir' : ''}"${it.d ? ` data-go="${esc(it.n)}"` : ` data-file="${esc(it.n)}"`}><i class="sp-k ${k}"></i><span class="sp-n">${it.rest ? `<i>${it.c.toLocaleString()} smaller files</i>` : esc(it.n)}</span><span class="sp-bar"><b style="width:${pc.toFixed(1)}%"></b></span><span class="sp-pc">${pc >= 0.1 ? pc.toFixed(1) + '%' : '<0.1%'}</span><span class="sp-s">${fmtBytes(it.s)}</span><span class="sp-c muted">${it.d ? it.c.toLocaleString() + ' files' : ''}</span></div>`;
      }).join('');
    }
    dlg.addEventListener('click', e => {
      if (dlg.gen !== gen) return;
      const c = e.target.closest('.sp-crumb [data-rel]'); if (c) return go(c.dataset.rel);
      const up = e.target.closest('[data-up]'); if (up) return go(T.rel.split('/').slice(0, -1).join('/'));
      const g = e.target.closest('[data-go]'); if (g) return go(T.rel ? `${T.rel}/${g.dataset.go}` : g.dataset.go);
    });
    dlg.addEventListener('dblclick', e => {
      if (dlg.gen !== gen) return;
      const f = e.target.closest('[data-file]'); if (!f) return;
      const dir = T.root + (T.rel ? '/' + T.rel : ''); load(A(), dir, f.dataset.file); parkTool();
    });
    start();
  }
  async function openEmptyTool() {
    if (tdlg.tool === 'empty') return unparkTool();          // already open (tucked away): just bring it back
    const dlg = tdlg;
    let info;
    try { info = await api('mounts'); } catch (e) { return toast(e.message, true); }
    const T = { scan: null, results: [], showLone: false, picked: new Set(), timer: 0, asking: false, share: 'all' };
    const SHOW_MAX = 1500;
    const APP_SHARES = ['appdata', 'system', 'domains', 'isos'];
    const isPool = d => !/^disk\d+$/.test(d);
    const chip = d => `<label class="ef-chip"><input type="checkbox" value="${esc(d)}" checked><span>${esc(d)}</span></label>`;
    openToolDlg('empty', 'Empty folders on disks', `
      <div class="ef-intro muted">Looks at each disk and pool directly (not the combined share view) for folders with <b>nothing at all inside</b> - no files and nothing hidden.
        These are usually leftovers: the share shows the folder from another disk where the real files are. Deleting only ever removes empty folders: the system refuses if anything has appeared inside.</div>
      <div class="ef-setup ef-card">
        <div class="ef-sec">
          <div class="ef-lbl">Disks <span class="ef-quick"><button type="button" data-q="all">All</button><button type="button" data-q="none">None</button></span></div>
          <div class="ef-disks">${info.mounts.filter(d => !isPool(d)).map(chip).join('')}</div>
          ${info.mounts.some(isPool) ? `<div class="ef-lbl ef-lbl2">Pools</div><div class="ef-disks">${info.mounts.filter(isPool).map(chip).join('')}</div>` : ''}
        </div>
        <div class="ef-sec">${flHTML}</div>
        <div class="ef-hint">Reads every folder on the chosen disks, so sleeping disks spin up. Big disks can take a few minutes; it runs in the background at low priority.</div>
      </div>
      <div class="ef-prog" hidden></div>
      <div class="tl-when muted" hidden></div>
      <div class="ef-res" hidden>
        <div class="ef-bar"><label class="chk"><input type="checkbox" class="ef-all"> <b class="ef-count"></b></label>
          <label class="chk ef-lonebox"><input type="checkbox" class="ef-lone"> <span class="ef-lonetxt">Also show folders that exist on one disk only</span></label></div>
        <div class="ef-shares mt-filters"></div>
        <div class="ef-list"></div>
        <div class="ef-note muted"></div>
      </div>`,
      [{ label: 'Close', run: () => { if (T.asking) { T.asking = false; draw(); return false; } } }, { label: 'Stop', run: async () => { if (T.scan) await api('scan_stop', { id: T.scan }).catch(() => {}); return false; } },
       { label: 'Scan', primary: true, run: () => { startScan(); return false; } }], 'full ef-dlg sticky');
    const btns = $$('.dlg-foot .uc-btn', dlg), [bClose, bStop, bGo] = btns;
    dlg.toolLabel = () => `Empty folders${T.results.length ? ' · ' + shown().length.toLocaleString() : T.scan ? ' · scanning' : ''}`;
    bStop.hidden = true;
    dlg.beforeClose = () => { clearTimeout(T.timer); return true; };
    const el = c => $(c, dlg);
    const fp = folderList(dlg, 'emptyDirs', info.shares);
    const scope = st => st.dirs && st.dirs.length ? fpLine(st.dirs) : st.share ? `Share <b>${esc(st.share)}</b>` : `All shares${st.skip && st.skip.length ? ` except ${esc(st.skip.join(', '))}` : ''}`;

    async function startScan() {
      const disks = $$('.ef-disks input:checked', dlg).map(i => i.value);
      if (!disks.length) return toast('Pick at least one disk or pool', true);
      const dirs = fp.get();
      if (!dirs.length) return toast('Tick at least one folder to look in', true);
      try { T.scan = (await api('empty_scan_start', { disks, dirs: JSON.stringify(dirs) })).id; } catch (e) { return toast(e.message, true); }
      el('.tl-when').hidden = true;
      T.picked.clear(); T.asking = false;
      el('.ef-setup').hidden = true; el('.ef-res').hidden = true; el('.ef-prog').hidden = false;
      bStop.hidden = false; bGo.hidden = true;
      poll();
    }
    async function poll(fresh) {
      if (!dlg.contains(btns[0])) return;
      let st;
      try { st = (await api('scan_status', { id: T.scan, fresh: fresh ? 1 : 0 })).scan; }
      catch (e) {
        if (e.offline) { el('.ef-prog').innerHTML = `<div class="tv-offline">⚠ Lost contact with the server - trying again… <span class="muted">The scan keeps running on the server.</span></div>`; T.timer = setTimeout(() => poll(fresh), 3000); return; }
        el('.ef-prog').innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; return;
      }
      el('.ef-prog').innerHTML = `<div class="ef-prog-h">${scope(st)} · ${st.disks.length} disk${st.disks.length === 1 ? '' : 's'}</div>` +
        st.disks_state.map(d0 => ({ ...d0, state: st.state === 'failed' && d0.state === 'running' ? 'failed' : d0.state })).map(d => `<div class="ef-dk ${d.state}"><span class="ic">${d.state === 'done' ? '✓' : d.state === 'running' ? '<span class="spin"></span>' : d.state === 'stopped' ? '■' : d.state === 'failed' ? '<b class="ef-x">✕</b>' : '○'}</span>
          <b class="mono">${esc(d.disk)}</b><span class="muted">${d.seen ? d.seen.toLocaleString() + ' items checked' : d.state === 'waiting' ? 'waiting' : ''}</span>
          <span class="ef-dkn">${d.state === 'failed' ? 'stopped here' : d.found ? `<b>${(d.left || 0).toLocaleString()}</b> leftover${d.left === 1 ? '' : 's'} <span class="muted">· ${d.found.toLocaleString()} empty in all${d.state === 'done' ? '' : ' so far'}</span>` : d.state === 'done' ? 'none empty' : ''}</span></div>`).join('') +
        `<div class="ef-legend muted"><b>Leftovers</b> are empty folders whose same path also exists on another disk - left behind when files moved. <b>Empty in all</b> also counts empty folders that exist on that disk only.</div>`;
      if (['running', 'queued'].includes(st.state)) { T.timer = setTimeout(poll, 700); return; }
      bStop.hidden = true; bGo.hidden = false; bGo.textContent = 'Scan again';
      el('.ef-prog').insertAdjacentHTML('beforeend', '<div class="ef-loading muted"><span class="spin"></span> Loading the list…</div>');
      try {
        const rr = await api('scan_results', { id: T.scan, fresh: fresh ? 1 : 0 });
        T.results = rr.results.map(([disk, rel, nested, subdirs, also]) => ({ disk, rel, kind: nested ? 'nested' : 'empty', subdirs, also: also || [] }));
      } catch (e) { T.results = []; toast(`Couldn't load the results: ${e.message}`, true); }
      const ld = $('.ef-loading', dlg); if (ld) ld.remove();
      T.share = 'all';
      el('.ef-res').hidden = false;
      /* the scan process died (out of memory, server busy...): say so, keep what it found */
      if (st.state === 'failed') {
        const at = (st.disks_state || []).find(d => d.state === 'running');
        el('.tl-when').innerHTML = `<b>The scan stopped unexpectedly${at ? ` while reading ${esc(at.disk)}` : ''}.</b> Showing what it found on the disks it finished. Untick ${at ? esc(at.disk) : 'that disk'} and scan again, or scan one share at a time.`;
        el('.tl-when').className = 'tl-when warnbox warn'; el('.tl-when').hidden = false; fresh = false;
      }
      el('.ef-setup').hidden = false; el('.ef-setup').classList.add('compact');
      if (fresh) { el('.tl-when').className = 'tl-when muted'; el('.tl-when').innerHTML = whenLine(st); el('.tl-when').hidden = !st.finished; el('.ef-prog').hidden = true; }
      draw();
      if (st.state === 'stopped') toast('Scan stopped - showing what was found so far');
    }
    const shareOf = r => r.rel.split('/')[0];
    const pool = () => T.results.filter(r => T.showLone || r.also.length);
    const shown = () => pool().filter(r => T.share === 'all' || shareOf(r) === T.share);
    const key = r => `/mnt/${r.disk}/${r.rel}`;
    function draw() {
      const rows = shown();
      for (const k of [...T.picked]) if (!rows.some(r => key(r) === k)) T.picked.delete(k);
      const lone = T.results.length - T.results.filter(r => r.also.length).length;
      el('.ef-lonetxt').textContent = `Also show the ${lone.toLocaleString()} that exist on one disk only`;
      el('.ef-count').textContent = rows.length ? `${rows.length.toLocaleString()} ${T.showLone ? 'empty folder' : 'leftover empty folder'}${rows.length === 1 ? '' : 's'}${T.picked.size ? ` · ${T.picked.size.toLocaleString()} picked` : ''}` : 'No empty folders found';
      /* one button per share, so thousands of results can be looked at a share at a time */
      const per = new Map(); for (const r of pool()) per.set(shareOf(r), (per.get(shareOf(r)) || 0) + 1);
      el('.ef-shares').innerHTML = per.size > 1 ? [['all', 'All shares', pool().length], ...[...per].sort((a, b) => b[1] - a[1])]
        .map(([k, l, c]) => `<button class="ct-f${T.share === k ? ' on' : ''}" data-sh="${esc(k)}">${esc(c === undefined ? k : l)} <b>${(c === undefined ? l : c).toLocaleString()}</b></button>`).join('') : '';
      el('.ef-lonebox').hidden = !lone;
      el('.ef-lone').checked = T.showLone;
      el('.ef-all').checked = rows.length && T.picked.size === rows.length;
      el('.ef-all').disabled = !rows.length;
      el('.ef-list').innerHTML = rows.slice(0, SHOW_MAX).map(r => {
        const k = key(r), i = r.rel.lastIndexOf('/');
        return `<label class="ef-row${T.picked.has(k) ? ' on' : ''}"><input type="checkbox" data-k="${esc(k)}" ${T.picked.has(k) ? 'checked' : ''}>
          <span class="ef-disk">${esc(r.disk)}</span>
          <span class="ef-path"><span class="in">${esc(i >= 0 ? r.rel.slice(0, i + 1) : '')}</span><b>${esc(r.rel.slice(i + 1))}</b>
            ${r.kind === 'nested' ? `<span class="ef-kind">only ${r.subdirs} empty folder${r.subdirs === 1 ? '' : 's'} inside</span>` : ''}</span>
          <span class="ef-also">${r.also.length ? 'also on ' + r.also.map(a => `<span class="ef-disk sm">${esc(a)}</span>`).join(' ') : '<span class="muted">only on this disk</span>'}</span>
          <button class="ef-open" data-go="${esc(k)}" title="Show it in the active pane">Show</button></label>`;
      }).join('') + (rows.length > SHOW_MAX ? `<div class="ef-none muted">Showing the first ${SHOW_MAX.toLocaleString()} of ${rows.length.toLocaleString()}. Pick a share above to narrow the list. "Select all" still picks all ${rows.length.toLocaleString()}.</div>` : '')
        || `<div class="ef-none muted">${T.results.length ? `Nothing that's also on another disk. ${lone} folder${lone === 1 ? ' exists' : 's exist'} on one disk only - tick the box above to see ${lone === 1 ? 'it' : 'them'}.` : 'Every folder on the chosen disks has something in it.'}</div>`;
      el('.ef-note').innerHTML = T.showLone && lone ? '<b>One disk only</b> means the share has nothing else at that path: deleting it removes the folder from the share entirely (it was empty anyway).' : '';
      updateDelBtn();
    }
    function updateDelBtn() {
      let b = $('.ef-del', dlg);
      if (!b) { b = document.createElement('button'); b.className = 'uc-btn primary danger ef-del'; $('.dlg-foot', dlg).appendChild(b); b.addEventListener('click', onDelete); }
      const n = T.picked.size;
      b.hidden = !n; b.textContent = T.asking ? `Yes, delete ${n} empty folder${n === 1 ? '' : 's'}` : `Delete ${n} empty folder${n === 1 ? '' : 's'}…`;
      bGo.hidden = T.asking || ['running', 'queued'].includes((T.last || {}).state);
      bClose.textContent = T.asking ? 'Cancel' : 'Close';
      el('.ef-note').classList.toggle('warnbox', T.asking); el('.ef-note').classList.toggle('warn', T.asking);
      if (T.asking) el('.ef-note').innerHTML = `Delete <b>${n}</b> empty folder${n === 1 ? '' : 's'}? Each one is checked again first; anything that isn't completely empty (even a hidden file) is skipped. Undo can recreate them.`;
    }
    async function onDelete() {
      if (SET.practice) return toast('Practice mode is on - deleting is locked. Turn it off in Settings > Safety.', true);
      if (!T.asking) { T.asking = true; updateDelBtn(); return; }
      const paths = [...T.picked];
      let r;
      try { r = await api('empty_delete', { paths }); } catch (e) { T.asking = false; draw(); return toast(e.message, true); }
      T.asking = false;
      const gone = new Set(paths.filter(p => !r.skipped.some(([s]) => s === p || s.startsWith(p + '/'))));
      T.results = T.results.filter(x => !gone.has(key(x)));
      T.picked.clear(); draw();
      if (r.skipped.length) el('.ef-note').innerHTML = '<b>Skipped:</b><br>' + r.skipped.map(([p, why]) => `<span class="mono">${esc(p)}</span> - ${esc(why)}`).join('<br>');
      const msg = `Deleted ${gone.size} empty folder${gone.size === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`;
      if (r.hist) done(msg, r.hist);
      else toast(msg);
      refreshBoth();
    }
    el('.ef-list').addEventListener('change', e => { const c = e.target.closest('input[data-k]'); if (!c) return; c.checked ? T.picked.add(c.dataset.k) : T.picked.delete(c.dataset.k); T.asking = false; draw(); });
    el('.ef-list').addEventListener('click', e => { const b = e.target.closest('.ef-open'); if (!b) return; e.preventDefault(); const p = b.dataset.go; parkTool(); load(A(), parent(p), base(p)); });
    el('.ef-all').addEventListener('change', e => { T.picked = new Set(e.target.checked ? shown().map(key) : []); T.asking = false; draw(); });
    el('.ef-lone').addEventListener('change', e => { T.showLone = e.target.checked; T.asking = false; draw(); });
    $$('.ef-quick [data-q]', dlg).forEach(b => b.addEventListener('click', () => $$('.ef-disks input', dlg).forEach(i => { i.checked = b.dataset.q === 'all'; })));
    el('.ef-shares').addEventListener('click', e => { const b = e.target.closest('[data-sh]'); if (!b) return; T.share = b.dataset.sh; T.asking = false; draw(); el('.ef-list').scrollTop = 0; });
    /* bring back the last scan: its results, or its progress if it's still going */
    let lastId = null;
    try { lastId = (await api('scan_last', { tool: 'empty' })).id; } catch (e) {}
    if (lastId) {
      try {
        const st = (await api('scan_status', { id: lastId })).scan;
        T.scan = lastId;
        $$('.ef-disks input', dlg).forEach(i => { i.checked = st.disks.includes(i.value); });
        el('.ef-setup').hidden = true; el('.ef-prog').hidden = false; bGo.hidden = true; bStop.hidden = false;
        poll(true);
      } catch (e) {}
    }
  }

  /* ---------- Tools > TV shows with missing episodes ----------
   * The scan (server) reads the episode numbers from your files and gets each
   * show's episode list from TVmaze. Everything below - what's missing, what's
   * complete - is worked out here, so your "ignore" choices apply instantly.
   * Only episodes that have aired (3 days ago or earlier) count; specials never do. */
  const TV_GRACE_DAYS = 3;
  const TV_GROUP = {
    missing: ['Missing episodes', 'Some aired episodes are not in the folder'],
    seasons: ['Missing seasons', 'Whole seasons are not in the folder'],
    look: ['Needs a look', "Your files are numbered differently from the episode list, or have no episode numbers - Details says exactly what"],
    empty: ['No videos', 'The folder has no video files at all'],
    nomatch: ['Not matched', "Couldn't tell which show this is - pick it"],
    nocheck: ["Couldn't check", "TVmaze couldn't be reached for this show"],
    complete: ['Complete', 'Ended, and every aired episode is there'],
    uptodate: ['Up to date', 'Still running, and everything aired so far is there'],
    ignored: ['Ignored', 'You chose to ignore this show'],
  };
  const TV_PROBLEMS = ['missing', 'seasons', 'look', 'empty', 'nomatch', 'nocheck'];
  const sxe = (s, e) => `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
  /* daily shows use the year as the season: name those episodes by air date */
  const epName = (s, e, d) => s >= 1900 && d ? d : sxe(s, e);
  function tvVerdict(r, rule, today) {
    const o = { v: 'complete', missing: [], seasons: [], unknown: [], aired: 0, have: (r.have || []).length };
    const cut = new Date(new Date(today + 'T12:00:00').getTime() - TV_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
    if (r.err) { o.v = 'nocheck'; return o; }
    if (!r.show) { o.v = r.files ? 'nomatch' : 'empty'; return o; }
    if (rule && rule.show) { o.v = 'ignored'; return o; }
    const have = new Set(r.have || []), skip = new Set((rule && rule.seasons) || []);
    const known = new Set(), bySeason = new Map();
    for (const [s, e, d, t] of r.eps || []) {
      known.add(`${s}.${e}`);
      if (!d || d > cut || skip.has(s)) continue;
      o.aired++;
      if (!bySeason.has(s)) bySeason.set(s, { aired: 0, have: 0 });
      const b = bySeason.get(s); b.aired++;
      if (have.has(`${s}.${e}`)) b.have++; else o.missing.push([s, e, d, t]);
    }
    for (const k of have) if (!known.has(k)) { const [s, e] = k.split('.').map(Number); if (!skip.has(s)) o.unknown.push([s, e]); }
    o.unknown.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [s, b] of bySeason) if (!b.have) o.seasons.push(s);
    if (rule && rule.complete) { o.v = 'complete'; o.marked = true; return o; }
    if (!r.files) { o.v = 'empty'; return o; }           // no videos at all: every aired episode is missing
    /* numbered differently (DVD order, "parts", absolute numbers): about as many files the
     * list doesn't know as episodes it says are missing - most likely the same ones.
     * One or two odd numbers next to a long missing list are just stray files. */
    const u = o.unknown.length, m = o.missing.length;
    o.renum = u >= 2 && m >= 1 && Math.min(u, m) / Math.max(u, m) >= 0.5;
    o.odd = u > 0 && !o.renum;
    if (!have.size && (r.unparsed || []).length) { o.v = 'look'; o.noNums = true; }
    else if (o.renum) o.v = 'look';
    else if (o.seasons.length) o.v = 'seasons';
    else if (o.missing.length) o.v = 'missing';
    else o.v = r.show.status === 'Ended' ? 'complete' : 'uptodate';
    return o;
  }
  /* "S01E02, S01E05-E07, S03E01" - runs of episodes shortened */
  function tvRuns(list, max = 6) {
    const out = []; let i = 0;
    while (i < list.length) {
      let j = i; while (j + 1 < list.length && list[j + 1][0] === list[i][0] && list[j + 1][1] === list[j][1] + 1) j++;
      out.push(j > i && list[i][0] < 1900 ? `${sxe(list[i][0], list[i][1])}-E${String(list[j][1]).padStart(2, '0')}` : j > i ? `${epName(...list[i])} to ${epName(...list[j])}` : epName(...list[i])); i = j + 1;
    }
    return out.length > max ? out.slice(0, max).join(', ') + ` … +${out.length - max} more` : out.join(', ');
  }

  /* Delete a show's or a movie's whole folder - asks first, with everything spelled out.
   * o: { name, year, poster, badge, path, info, app ('Sonarr'/'Radarr'), inApp, removeApp(), onDeleted(perm, res) } */
  function askFolderDelete(o) {
    if (SET.practice) return toast('Practice mode is on - deleting is locked. Turn it off in Settings > Safety.', true);
    const trashOn = SET.trash !== false, days = SET.trash_days;
    const D = () => $('.uc-modal:not(.uc-tmodal) .uc-dlg');
    openDlg(`Delete "${o.name}"?`, `
      <div class="tvdel-head">${o.poster ? `<img class="tvdel-poster" alt="" referrerpolicy="no-referrer" src="${esc(o.poster)}">` : ''}
        <div><b>${esc(o.name)}</b>${o.year ? ` <span class="mt-year">(${esc(o.year)})</span>` : ''}${o.badge || ''}
          <div class="mono tvdel-path">${esc(o.path)}</div>
          <div class="muted">${o.info}</div></div></div>
      ${trashOn ? `<div class="fd-choice">
          <label class="fd-opt"><input type="radio" name="fd-how" value="trash" checked><span><b>Move to the trash</b><br><span class="muted">Undo, or Restore from the trash, brings it back${days ? ` - until it's emptied after ${days} day${days === 1 ? '' : 's'}` : ''}. The space is freed when the trash is emptied.</span></span></label>
          <label class="fd-opt fd-forever"><input type="radio" name="fd-how" value="perm"><span><b>Delete for good</b><br><span class="muted">Frees the space straight away. Can't be undone or restored.</span></span></label></div>`
        : `<div class="warnbox danger tvdel-warn"><b>The trash is switched off, so this deletes the folder for good.</b> It can't be undone or restored.</div>`}
      <div class="fd-permbox"${trashOn ? ' hidden' : ''}><label class="chk tvdel-opt"><input type="checkbox" class="fd-ok"><span><b>I understand this deletes it for good</b> - it can't be undone</span></label></div>
      ${o.app ? (o.inApp ? `<label class="chk tvdel-opt"><input type="checkbox" class="fd-app" checked><span>Also remove it from ${o.app} <span class="muted">- otherwise ${o.app} may notice it's gone and download it again</span></span></label>`
        : `<div class="muted tvdel-note">If ${o.app} still lists it, remove it there too, or it may download it again.</div>`) : ''}`,
      [{ label: 'Cancel' }, { label: trashOn ? 'Move folder to trash' : 'Delete for good', primary: true, danger: true, run: async () => {
        const perm = !trashOn || ($('input[name="fd-how"]:checked', D()) || {}).value === 'perm';
        if (perm && !$('.fd-ok', D()).checked) { toast('Tick "I understand this deletes it for good" first', true); $('.fd-permbox', D()).classList.add('pulse'); return false; }
        const alsoApp = o.inApp && $('.fd-app', D()) && $('.fd-app', D()).checked;
        let res;
        try { res = await api('trash', { paths: [o.path], forever: perm ? '1' : '0', label: `${perm ? 'Deleted for good' : 'Deleted'}: ${o.name}` }); } catch (e) { toast(e.message, true); return false; }
        let appNote = '';
        if (alsoApp) { try { await o.removeApp(); appNote = ` and removed from ${o.app}`; } catch (e) { appNote = ` - but ${o.app}: ${e.message}`; } }
        o.onDeleted(perm, res);
        const msg = `${perm ? 'Deleted for good' : 'Moved to the trash'}: ${o.name}${appNote}`;
        if (!perm && res.bins && res.bins.length) done(msg + (alsoApp ? ` - if you undo, add it to ${o.app} again` : ''), res.hist);
        else toast(msg);
        refreshBoth();
      } }], 'pm-dlg tvdel-dlg');
    const d = D(), go = $('.dlg-foot .uc-btn.primary', d);
    $$('input[name="fd-how"]', d).forEach(i => i.addEventListener('change', () => {
      const perm = i.value === 'perm' && i.checked;
      $('.fd-permbox', d).hidden = !perm; if (go) go.textContent = perm ? 'Delete for good' : 'Move folder to trash';
    }));
  }
  async function openTvTool() {
    if (tdlg.tool === 'tv') return unparkTool();
    const dlg = tdlg;
    let info = { shares: [] };
    try { info = await api('mounts'); } catch (e) {}
    const guess = info.shares.find(n => /^(tv|tv ?shows|shows|series)$/i.test(n)) || info.shares.find(n => /tv|show|series/i.test(n));
    const T = { scan: null, results: [], rules: {}, today: new Date().toISOString().slice(0, 10), filter: null, timer: 0, root: '', walk: false, sn: new Map(), picked: new Set() };
    openToolDlg('tv', 'TV shows with missing episodes', `
      <div class="mt-setup">
        <div class="field mt-rootf"><label>TV shows folder <span class="muted">- each folder directly inside it is one show</span></label>
          <div class="mt-rootrow"><input type="text" class="mt-root" value="${esc(store.get('root.tv', '') || (guess ? '/mnt/user/' + guess : (A().mode === 'dir' ? A().path : '/mnt/user')))}" spellcheck="false" autocapitalize="off">
          ${info.shares.length ? `<select class="mt-pick"><option value="">Shares…</option>${info.shares.map(n => `<option>${esc(n)}</option>`).join('')}</select>` : ''}</div></div>
        <div class="muted tv-intro">Episode lists come from TVmaze. The first scan takes about a second per show (TVmaze asks for a gentle pace); rescans are much faster. Specials are left out, and only aired episodes count.</div>
      </div>
      <div class="mt-prog muted" hidden></div>
      <div class="tl-when muted" hidden></div>
      <div class="mt-res" hidden>
        <div class="mt-attn" hidden></div>
        <div class="mt-arrived" hidden></div>
        <div class="mt-bar"><label class="chk"><input type="checkbox" class="mt-all" title="Tick every show listed that has missing episodes"> <b class="mt-count"></b></label><div class="mt-filters"></div></div>
        <div class="mt-export" hidden></div>
        <div class="mt-wrap"><div class="mt-list"></div><div class="mt-detail" hidden></div></div>
      </div>`,
      [{ label: 'Close', title: 'Close this window. The last scan is kept: opening the tool again shows it.', run: () => { if (T.view === 'detail') { listView(); return false; } } },
       { label: 'Stop', title: 'Stop the scan - the shows checked so far are kept', run: async () => { if (T.scan) await api('scan_stop', { id: T.scan }).catch(() => {}); return false; } },
       { label: 'Export…', title: 'Save the listed shows and their missing episodes as CSV or text', run: () => { toggleExport(); return false; } },
       { label: 'Send to Sonarr', title: 'Ask Sonarr for the missing episodes of the ticked shows', run: () => { snBulk(); return false; } },
       { label: 'Scan', title: 'Check every show folder again (episode lists already fetched are reused)', primary: true, run: () => { startScan(); return false; } }], 'full mt-dlg tv-dlg sticky');
    const btns = $$('.dlg-foot .uc-btn', dlg), [bClose, bStop, bExport, bSonarr, bGo] = btns;
    bStop.hidden = bExport.hidden = bSonarr.hidden = true;
    T.view = 'list';
    /* Two views share the window: the list, and one show (details or "which show?").
     * In a show, the footer only offers the way back - Close and Scan can't be hit by mistake. */
    function footer() {
      const inShow = T.view === 'detail';
      dlg.classList.toggle('tv-inshow', inShow); bClose.classList.toggle('primary', inShow);
      bClose.textContent = inShow ? '‹ Back to the list' : 'Close';
      bClose.title = inShow ? 'Back to the list of shows' : 'Close this window. The last scan is kept: opening the tool again shows it.';
      bGo.hidden = inShow || T.scanning; bStop.hidden = inShow || !T.scanning; bExport.hidden = inShow || !T.results.length;
      bSonarr.hidden = inShow || T.scanning || !T.results.some(r => sendable(r));
      const n = T.picked.size, busy = T.snBusy;
      bSonarr.textContent = busy ? `Sending ${busy.done + 1} of ${busy.total}…` : n ? `Send ${n} to Sonarr` : 'Send to Sonarr';
      bSonarr.disabled = !!busy;
      if (inShow) el('.mt-export').hidden = true;
    }
    function detailView() { el('.mt-detail').hidden = false; el('.mt-list').hidden = true; el('.mt-detail').scrollTop = 0; T.view = 'detail'; footer(); }
    function listView() { T.walk = false; el('.mt-detail').hidden = true; el('.mt-list').hidden = false; T.view = 'list'; footer(); draw(); }
    const el = c => $(c, dlg);
    const V = r => tvVerdict(r, T.rules[r.path], T.today);
    const needs = () => T.results.filter(r => (!r.show && r.files && !r.err) || (T.sn.get(r.path) || {}).state === 'err');
    const toPick = () => T.results.filter(r => !r.show && r.files && !r.err);
    /* Sonarr: a show can be sent when it's matched and has aired episodes missing */
    /* renumbered shows ("Needs a look") aren't offered: Sonarr would fetch copies of episodes
     * that are already there under other numbers. Details still has "Ask Sonarr anyway". */
    const sendable = r => { const o = V(r); return !!r.show && o.missing.length > 0 && ['missing', 'seasons', 'empty'].includes(o.v); };
    /* every missing episode already asked for (so "tick all" skips it; its button says "Ask again") */
    const asked = r => { const x = T.sn.get(r.path); if (!x || x.state !== 'sent') return false; const a = new Set(x.eps || []); return V(r).missing.every(([sn, en]) => a.has(`${sn}.${en}`)); };
    /* arrived: everything sent to Sonarr is in the folder now (seen by the latest scan) */
    const arrived = () => T.results.filter(r => { const x = T.sn.get(r.path); if (!x || x.dismissed || !['sent', 'removed'].includes(x.state) || !(x.eps || []).length) return false; const h = new Set(r.have || []); return x.eps.every(k => h.has(k)); });
    dlg.toolLabel = () => `TV shows${T.results.length ? ' · ' + T.results.filter(r => TV_PROBLEMS.includes(V(r).v)).length.toLocaleString() : T.scan ? ' · scanning' : ''}`;
    dlg.toolAttn = () => needs().length;
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    dlg.beforeClose = () => { clearTimeout(T.timer); return true; };
    const pk = el('.mt-pick'); if (pk) pk.addEventListener('change', () => { if (pk.value) el('.mt-root').value = '/mnt/user/' + pk.value; pk.value = ''; });
    el('.mt-root').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startScan(); } });

    async function startScan() {
      const root = el('.mt-root').value.trim();
      try { T.scan = (await api('tv_scan_start', { root })).id; } catch (e) { return toast(e.message, true); }
      store.set('root.tv', root);
      T.root = root; T.filter = null; T.results = []; el('.tl-when').hidden = true;
      el('.mt-res').hidden = true; el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = '<span class="spin"></span> Starting…';
      T.scanning = true; T.view = 'list'; el('.mt-detail').hidden = true; el('.mt-list').hidden = false; footer();
      T.t0 = Date.now();
      poll();
    }
    async function poll(restored) {
      if (!dlg.contains(btns[0])) return;
      let st;
      try { st = (await api('scan_status', { id: T.scan })).scan; }
      catch (e) {
        /* the scan runs on the server - a dropped connection only stops this window from hearing about it */
        if (e.offline) { el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = `<div class="tv-offline">⚠ Lost contact with the server - trying again… <span class="muted">The scan keeps running on the server; this window catches up when the connection is back.</span></div>`; T.timer = setTimeout(() => poll(restored), 3000); return; }
        el('.mt-prog').innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; T.scanning = false; footer(); return;
      }
      T.root = st.root; if (st.root && document.activeElement !== el('.mt-root')) el('.mt-root').value = st.root; store.set('root.tv', st.root);
      if (['running', 'queued'].includes(st.state)) {
        const n = st.done || 0, tot = st.total || 0;
        el('.mt-prog').innerHTML = st.phase === 'shows'
          ? `<div class="tv-prog"><div><span class="spin"></span> Checking show <b>${n + 1 > tot ? tot : n + 1}</b> of ${tot.toLocaleString()}${st.current ? ` - <span class="mono">${esc(st.current)}</span>` : ''}</div>
              <div class="tv-bar"><i style="width:${tot ? Math.round(n / tot * 100) : 0}%"></i></div>
              <div class="muted">${tot - n > 3 ? `About ${Math.max(1, Math.round((tot - n) * 1.1 / 60))} min left at TVmaze's pace. ` : ''}You can tuck this window away (—) and keep using unCommander.</div></div>`
          : `<span class="spin"></span> Reading the episode files… ${st.seen ? st.seen.toLocaleString() + ' videos found' : ''}`;
        T.scanning = true; footer();
        T.timer = setTimeout(() => poll(restored), 800); return;
      }
      if (T.t0) await scanSettle(T.t0);
      T.scanning = false; bGo.textContent = 'Scan again';
      el('.tl-when').innerHTML = whenLine(st); el('.tl-when').hidden = !(restored && st.finished);
      try { const rr = await api('scan_results', { id: T.scan, fresh: 1 }); T.results = rr.results; T.rules = rr.rules || {}; if (rr.today) T.today = rr.today; T.sn = new Map(); T.results.forEach(r => { if (r.sn) T.sn.set(r.path, r.sn); }); T.picked.clear(); }
      catch (e) {
        if (e.offline) { el('.mt-prog').innerHTML = `<div class="tv-offline">⚠ Lost contact with the server - trying again…</div>`; T.timer = setTimeout(() => poll(restored), 3000); return; }
        T.results = []; toast(`Couldn't load the results: ${e.message}`, true);
      }
      T.results.sort((a, b) => collator.compare(a.name, b.name));
      if (st.state === 'stopped') toast('Scan stopped - showing the shows checked so far');
      if (st.state === 'failed') toast('The scan stopped unexpectedly - showing the shows checked so far', true);
      el('.mt-prog').hidden = true; el('.mt-res').hidden = false;
      footer(); draw(); snStuck();
      if (T.t0) { const need = T.results.filter(r => TV_PROBLEMS.includes(V(r).v)).length; toast(`Scan finished - ${T.results.length.toLocaleString()} show${T.results.length === 1 ? '' : 's'} checked · ${need ? `${need} need attention` : 'all complete or up to date'}`); flashCount(el('.mt-count')); T.t0 = 0; }
    }
    const thumb = r => r.show && r.show.poster ? `<img class="mt-thumb" loading="lazy" alt="" referrerpolicy="no-referrer" src="${esc(r.show.poster)}">` : '<span class="mt-thumb none"></span>';
    const shown = () => T.results.filter(r => { const v = V(r).v; return T.filter === 'all' ? true : T.filter === 'problems' ? TV_PROBLEMS.includes(v) : v === T.filter; });
    function summary(r, o) {
      if (o.v === 'nocheck') return `<span class="uc-error">${esc(r.err)}</span>${/^Can't reach|busy/.test(r.err || '') ? '' : ` - <a href="#" data-pick="${esc(r.path)}">pick the show ›</a>`}`;
      if (o.v === 'nomatch') return `${(r.cand || []).length ? `${r.cand.length} possible match${r.cand.length === 1 ? '' : 'es'}` : 'No match found on TVmaze'} - <a href="#" data-pick="${esc(r.path)}">pick the show ›</a>`;
      if (o.v === 'empty') return r.show ? `No video files in the folder - all ${o.missing.length} aired episode${o.missing.length === 1 ? '' : 's'} missing` : `No video files in the folder - <a href="#" data-pick="${esc(r.path)}">pick the show ›</a> to get it with Sonarr`;
      if (o.v === 'ignored') return 'Ignored by you';
      const parts = [];
      if (o.seasons.length) parts.push(`missing season${o.seasons.length === 1 ? '' : 's'} ${o.seasons.join(', ')}`);
      const loose = o.missing.filter(([s]) => !o.seasons.includes(s));
      if (loose.length) parts.push(`missing ${tvRuns(loose)}`);
      if (o.marked) return 'Marked complete by you';
      if (o.noNums) return `<b class="tv-why">${(r.unparsed || []).length} file name${(r.unparsed || []).length === 1 ? ' has' : 's have'} no season/episode number</b> - can't count them`;
      if (o.renum) return `<b class="tv-why">Numbered differently</b> - ${o.unknown.length} of your files don't match the episode list, and the ${o.missing.length} it calls missing are probably those`;
      if (o.odd) parts.push(`<span class="tv-why">${o.unknown.length} file${o.unknown.length === 1 ? ' has an' : 's have'} odd episode number${o.unknown.length === 1 ? '' : 's'}</span>`);
      if (r.order === 'sonarr' && !parts.length) return `${o.have} of ${o.aired} aired episodes · <span class="tv-ord">by Sonarr's numbering</span>`;
      return parts.length ? parts.join(' · ') : `${o.have} of ${o.aired} aired episodes`;
    }
    function draw() {
      const all = T.results.map(r => [r, V(r)]);
      const count = k => all.filter(([, o]) => o.v === k).length;
      const probs = all.filter(([, o]) => TV_PROBLEMS.includes(o.v)).length;
      if (!T.filter) T.filter = probs ? 'problems' : 'all';
      drawAttn(); drawArrived(); footer();
      if (tmodal.hidden && dlg.tool === 'tv') drawPill();
      el('.mt-count').textContent = `${T.results.length.toLocaleString()} show${T.results.length === 1 ? '' : 's'} · ${probs ? `${probs} need attention` : 'all complete or up to date'}`;
      el('.mt-filters').innerHTML = [['problems', 'Needs attention', probs], ...Object.keys(TV_GROUP).map(k => [k, TV_GROUP[k][0], count(k)]), ['all', 'All', T.results.length]]
        .filter(([k, , c]) => c || k === 'all').map(([k, l, c]) => `<button class="ct-f tv-f-${k}${T.filter === k ? ' on' : ''}" data-f="${k}" title="${esc((TV_GROUP[k] || [])[1] || '')}">${l} <b>${c}</b></button>`).join('');
      const rows = shown(), ticks = rows.filter(r => sendable(r) && !asked(r));
      for (const k of [...T.picked]) if (!rows.some(r => r.path === k && sendable(r))) T.picked.delete(k);
      el('.mt-all').checked = ticks.length && T.picked.size === ticks.length; el('.mt-all').disabled = !ticks.length;
      el('.mt-list').innerHTML = rows.map(r => {
        const o = V(r), s = r.show, can = sendable(r);
        return `<label class="mt-row tv-row tv-${o.v}${T.picked.has(r.path) ? ' on' : ''}${(T.sn.get(r.path) || {}).state === 'err' ? ' need' : ''}">${can ? `<input type="checkbox" data-k="${esc(r.path)}" ${T.picked.has(r.path) ? 'checked' : ''} title="Tick to send with Send to Sonarr">` : '<span></span>'}${thumb(r)}
          <span class="mt-main"><b>${esc(s ? s.name : r.name)}</b>${s && s.year ? ` <span class="mt-year">(${esc(s.year)})</span>` : ''}${s ? ` <span class="tv-status ${s.status === 'Ended' ? 'ended' : 'running'}">${esc(s.status || '?')}</span>` : ''}
            <span class="mt-sub"><span class="mt-kind tv-k-${o.v}">${TV_GROUP[o.v][0]}</span> <span class="mono">${esc(r.name)}</span>${s ? ` · ${o.have} of ${o.aired} aired` : ''}</span>
            <span class="tv-sum">${summary(r, o)}</span>${snChip(r)}</span>
          <span class="mt-acts">${r.err && !/^Can't reach|busy/.test(r.err) ? `<button class="ef-open na-pick" data-pick="${esc(r.path)}" title="Search TVmaze and choose the right show">Pick ›</button>` : ''}${stuckOf(r).length ? `<button class="ef-open tv-imp" data-snimp="${esc(r.path)}" title="Sonarr downloaded it but won't import it on its own - import it now, like Sonarr's Manual Import">Import now</button>` : ''}${can ? `<button class="ef-open tv-sn" data-sn="${esc(r.path)}" title="Ask Sonarr for this show's ${o.missing.length} missing episode${o.missing.length === 1 ? '' : 's'}">${asked(r) ? 'Ask again' : 'Sonarr'}</button>` : ''}${!s && !r.err ? `<button class="ef-open na-pick" data-pick="${esc(r.path)}" title="Choose which show this folder is">Pick ›</button>` : ''}${['empty', 'nomatch', 'nocheck'].includes(o.v) ? `<button class="ef-open tv-del" data-delrow="${esc(r.path)}" title="Delete this folder - asks first">Delete…</button>` : ''}${true ? `<button class="ef-open" data-det="${esc(r.path)}" title="Season grid, and your choices for this show (ignore, mark complete, change the match)">Details</button>` : ''}<button class="ef-open" data-go="${esc(r.path)}" title="Open this folder in the active pane - this window tucks away into the pill at the top; tap the pill to come back">Show</button></span></label>`;
      }).join('') || `<div class="ef-none muted">${T.results.length ? 'Nothing in this group.' : 'No show folders found.'}</div>`;
    }
    function drawAttn() {
      const box = el('.mt-attn'), list = needs();
      box.hidden = !list.length;
      if (!list.length) { T.walk = false; return; }
      const picks = list.filter(r => !r.show), errs = list.filter(r => r.show);
      box.innerHTML = `<div class="na-h"><span class="na-ic">⚠</span><span class="na-t"><b>${list.length} show${list.length === 1 ? '' : 's'} need${list.length === 1 ? 's' : ''} you</b>
          <span class="na-s">${[picks.length && `${picks.length} couldn't be identified for sure - pick the show (remembered)`, errs.length && `${errs.length} couldn't be sent to Sonarr`].filter(Boolean).join(' · ')}</span></span>
          ${picks.length ? '<button class="uc-btn primary na-go" data-walk="1">Choose now ›</button>' : ''}</div>
        <div class="na-list">${list.map(r => { const x = T.sn.get(r.path) || {}, err = !!r.show; return `<div class="na-row">${thumb(r)}<span class="ma-t"><b>${esc(r.show ? r.show.name : r.name)}</b>
            <span class="ma-s${err ? ' uc-error' : ''}">${err ? '✕ ' + esc(x.msg || 'Sonarr failed') : (r.cand || []).length ? `${r.cand.length} possible match${r.cand.length === 1 ? '' : 'es'}` : 'No match found'}</span></span>
            <span class="mt-acts">${err ? `<button class="ef-open" data-sn="${esc(r.path)}">Retry</button>` : `<button class="ef-open na-pick" data-pick="${esc(r.path)}">Pick ›</button>`}<button class="ef-open" data-go="${esc(r.path)}">Show</button></span></div>`; }).join('')}</div>`;
    }
    /* ---------- Sonarr ---------- */
    /* downloads Sonarr is holding back ("matched to series by ID" ...): unCommander can import them */
    async function snStuck() {
      if (!(SET.sonarr && SET.sonarr.ok) || ![...T.sn.values()].some(x => x.state === 'sent' && !x.dismissed)) { T.stuck = new Map(); return; }
      try { const res = await api('sonarr_stuck'); T.stuck = new Map(Object.entries(res.stuck || {})); } catch (e) { return; }
      draw(); if (T.view === 'detail' && T.detailPath) showDetail(T.detailPath);
    }
    const stuckOf = r => (T.stuck && T.stuck.get(r.path)) || [];
    async function snImport(r, btn) {
      if (!snReady()) return;
      const list = stuckOf(r); if (!list.length) return;
      const name = r.show ? r.show.name : r.name;
      if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
      let n = 0; const skipped = [], cmds = [];
      for (const it of list) {
        try { const res = await api('sonarr_import', { path: r.path, downloadId: it.downloadId }); n += res.imported; skipped.push(...res.skipped); if (res.command) cmds.push(res.command); if (!res.found) skipped.push({ file: it.title, why: `Sonarr found no files for it${res.folder ? ` in ${res.folder}` : ''}` }); }
        catch (e) { skipped.push({ file: it.title, why: e.message }); }
      }
      const skip = skipped.map(s => `${s.file} (${s.why})`).join(' · ');
      if (!n) { toast(skip ? `Nothing imported - ${skip}` : 'Nothing to import', true); if (btn) { btn.disabled = false; btn.textContent = 'Import now'; } return; }
      toast(`${name}: Sonarr is importing ${n} file${n === 1 ? '' : 's'}…${skip ? ` (left alone: ${skip})` : ''}`);
      /* wait for Sonarr's import job to finish, and say how it went */
      let failed = '', done = 0;
      for (let k = 0; k < 20 && done < cmds.length; k++) {
        await sleep(2000); done = 0;
        for (const id of cmds) {
          try { const c = await api('sonarr_cmd', { id }); if (['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(c.status)) { done++; if (c.status !== 'completed' || c.result === 'unsuccessful') failed = c.message || c.status; } }
          catch (e) { done++; }
        }
      }
      try { const res = await api('tv_recheck', { path: r.path, eps: JSON.stringify(r.eps || []) }); Object.assign(r, { have: res.have, odd: res.odd, files: res.files, bytes: res.bytes, extras: res.extras, unparsed: res.unparsed }); } catch (e) {}
      await snStuck();
      if (failed) toast(`${name}: Sonarr's import failed - ${failed}`, true);
      else if (stuckOf(r).length) toast(`${name}: Sonarr finished, but the download is still waiting - check Sonarr > Activity > Queue for its reason`, true);
      else toast(`${name}: imported ✓`);
      draw(); if (T.view === 'detail' && T.detailPath === r.path) showDetail(r.path);
    }
    function snChip(r) {
      const x = T.sn.get(r.path); if (!x) return '';
      const st = stuckOf(r);
      if (st.length) return `<span class="rd-chip need" title="${esc(st.map(i => i.title + (i.msgs.length ? ' - ' + i.msgs.join(' ') : '')).join('\n'))}">⚠ Downloaded - waiting for an import in Sonarr${st.length > 1 ? ` (${st.length})` : ''}</span>`;
      if (arrived().includes(r)) return '<span class="rd-chip added">✓ Arrived through Sonarr</span>';
      const n = (x.eps || []).length;
      const t = { busy: '<span class="spin"></span> Sending to Sonarr…', waiting: '<span class="spin"></span> Sonarr is loading the show…', have: '✓ Sonarr already has these episodes',
                  sent: `✓ Asked Sonarr for ${n} episode${n === 1 ? '' : 's'}${x.searching ? ' · searching' : ''}${(x.packs || []).length ? ` · season${x.packs.length === 1 ? '' : 's'} ${x.packs.join(', ')} also as ${x.packs.length === 1 ? 'a pack' : 'packs'}` : ''}${(x.notfound || []).length ? ` · ${x.notfound.length} not in Sonarr's list` : ''}`,
                  removed: 'Removed from Sonarr', adding: '<span class="spin"></span> Added to Sonarr…', err: '✕ ' + esc(x.msg || 'failed') }[x.state];
      return t ? `<span class="rd-chip ${x.state === 'err' ? 'err' : x.state === 'have' || x.state === 'sent' ? 'added' : ''}" title="${esc(x.msg || '')}">${t}</span>` : '';
    }
    const snReady = () => { if (SET.sonarr && SET.sonarr.ok) return true; toast('Set up Sonarr first: Settings > Tools > Sonarr (address, API key, quality profile)', true); return false; };
    async function snSend(r, season) {
      /* season: just that season's missing episodes (the button next to it in Details) */
      const o = V(r), eps = o.missing.filter(([sn]) => season == null || sn === season).map(([sn, en, dt]) => [sn, en, dt]);
      if (!eps.length) return 'none';
      const prev = T.sn.get(r.path) || {};
      T.sn.set(r.path, { ...prev, state: 'busy', msg: '' }); draw();
      for (let k = 0; k < 15; k++) {
        let res;
        try { res = await api('sonarr_send', { path: r.path, tvdb: (r.show && r.show.tvdb) || 0, type: (r.show && r.show.type) || '', eps: JSON.stringify(eps) }); }
        catch (e) { T.sn.set(r.path, { ...prev, state: 'err', msg: e.message }); draw(); return 'err'; }
        if (res.status === 'waiting') { T.sn.set(r.path, { ...prev, state: 'waiting', seriesId: res.seriesId, added: res.added }); draw(); await sleep(3000); continue; }
        if (res.status === 'have') { T.sn.set(r.path, { ...prev, state: 'have' }); T.picked.delete(r.path); draw(); return 'have'; }
        T.sn.set(r.path, res.sn); T.picked.delete(r.path); draw();
        return 'sent';
      }
      T.sn.set(r.path, { ...prev, state: 'err', msg: 'Sonarr is still loading the show - try again in a minute' }); draw();
      return 'err';
    }
    async function snBulk() {
      if (!snReady() || T.snBusy) return;
      const list = T.results.filter(r => T.picked.has(r.path) && sendable(r));
      if (!list.length) return toast('Tick the shows to send to Sonarr first (the box at the left of each row, or the one above the list for all)', true);
      T.snBusy = { done: 0, total: list.length }; footer();
      const tally = {};
      for (const r of list) { const st = await snSend(r); tally[st] = (tally[st] || 0) + 1; T.snBusy.done++; footer(); }
      T.snBusy = null; footer(); draw();
      toast([tally.sent && `${tally.sent} sent to Sonarr`, tally.have && `${tally.have} already in Sonarr`, tally.err && `${tally.err} couldn't be sent - see the amber box`].filter(Boolean).join(' · ') || 'Done', !!tally.err);
    }
    async function snRemove(r) {
      try { const res = await api('sonarr_remove', { path: r.path }); T.sn.set(r.path, res.sn); toast(`${r.show ? r.show.name : r.name}: removed from Sonarr - the files stay where they are`); }
      catch (e) { toast(e.message, true); }
      draw();
    }
    async function snDismiss(r) {
      try { const res = await api('sonarr_dismiss', { path: r.path }); T.sn.set(r.path, res.sn); } catch (e) { toast(e.message, true); }
      draw();
    }
    /* episodes that came in through Sonarr: a fixed green panel above the list */
    function drawArrived() {
      const box = el('.mt-arrived'), list = arrived();
      box.hidden = !list.length;
      if (!list.length) return;
      const live = list.filter(r => (T.sn.get(r.path) || {}).state !== 'removed').length;
      box.innerHTML = `<div class="ma-h"><b>✓ Arrived through Sonarr</b> <span class="muted">every episode asked for is now in the folder</span>
          <span class="ma-acts">${live ? `<button class="ef-open rd-rm" data-snrmall="1" title="Take them out of Sonarr - the episode files stay where they are">Remove ${live > 1 ? 'all ' + live + ' ' : ''}from Sonarr</button>` : ''}<button class="ef-open" data-sndisall="1">Clear ${list.length > 1 ? 'all' : ''}</button></span></div>
        <div class="ma-list">${list.map(r => { const x = T.sn.get(r.path) || {}; return `<div class="ma-row">${thumb(r)}<span class="ma-t"><b>${esc(r.show ? r.show.name : r.name)}</b>
            <span class="ma-s">${r.show ? `<span class="tv-status ${r.show.status === 'Ended' ? 'ended' : 'running'}" title="${r.show.status === 'Ended' ? 'No more episodes are coming - safe to remove from Sonarr' : 'New episodes are still coming - Sonarr can keep fetching them if you leave it'}">${r.show.status === 'Ended' ? 'Ended' : 'Continuing'}</span> · ` : ''}${(x.eps || []).length} episode${(x.eps || []).length === 1 ? '' : 's'} · ${x.state === 'removed' ? 'removed from Sonarr' : 'still in Sonarr'}</span></span>
            <span class="mt-acts">${x.state !== 'removed' ? `<button class="ef-open rd-rm" data-snrm="${esc(r.path)}" title="Take the show out of Sonarr - the files stay">Remove from Sonarr</button>` : ''}<button class="ef-open" data-sndis="${esc(r.path)}">Clear</button><button class="ef-open" data-go="${esc(r.path)}">Show</button></span></div>`; }).join('')}</div>`;
    }
    /* ---------- details: season grid, your choices ---------- */
    async function setRule(r, patch) {
      const cur = Object.assign({ show: false, complete: false, seasons: [] }, T.rules[r.path] || {}, patch);
      try { const res = await api('tv_rule', { path: r.path, rule: cur }); if (res.rule) T.rules[r.path] = res.rule; else delete T.rules[r.path]; }
      catch (e) { return toast(e.message, true); }
      draw(); showDetail(r.path);
    }
    /* "What's wrong": every problem with a show in plain words, above the season grid */
    function tvIssues(r, o) {
      if (!r.show || ['ignored', 'nocheck', 'nomatch'].includes(o.v) || o.marked) return '';
      const odd = r.odd || {}, items = [], src = r.order === 'sonarr' ? "Sonarr's list" : 'TVmaze';
      const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + 's'}`;
      const fileList = list => `<div class="mono tv-files">${list.map(([a, b]) => { const f = odd[`${a}.${b}`]; return `<span class="tv-fx">${sxe(a, b)}</span> ${f ? esc(f) : ''}`; }).join('<br>')}</div>`;
      /* per season: your files against the aired episodes */
      const perSeason = () => {
        const mine = new Map(), theirs = new Map();
        for (const k of r.have || []) { const sn = +String(k).split('.')[0]; mine.set(sn, (mine.get(sn) || 0) + 1); }
        const cut = new Date(new Date(T.today + 'T12:00:00').getTime() - TV_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
        for (const [sn, , dt] of r.eps || []) if (dt && dt <= cut) theirs.set(sn, (theirs.get(sn) || 0) + 1);
        const all = [...new Set([...mine.keys(), ...theirs.keys()])].sort((a, b) => a - b);
        const cell = sn => (mine.get(sn) || 0) !== (theirs.get(sn) || 0) ? ' class="diff"' : '';
        return `<div class="tv-cmpw"><table class="tv-cmp"><tr><th></th>${all.map(sn => `<th>S${sn}</th>`).join('')}<th>Total</th></tr>
          <tr><td>Your files</td>${all.map(sn => `<td${cell(sn)}>${mine.get(sn) || '-'}</td>`).join('')}<td><b>${(r.have || []).length}</b></td></tr>
          <tr><td>${src}</td>${all.map(sn => `<td${cell(sn)}>${theirs.get(sn) || '-'}</td>`).join('')}<td><b>${o.aired}</b></td></tr></table></div>`;
      };
      if (o.noNums) items.push({ h: `${plural(r.unparsed.length, 'file name')} without a season/episode number`,
        b: `<p>These can't be counted, so the show can't be checked:</p><div class="mono tv-files">${r.unparsed.map(n => esc(n)).join('<br>')}</div>
          <p class="tv-do"><b>To fix:</b> rename them with the number in the name, like <span class="mono">Show - S01E05.mkv</span> (Batch rename can do it), then tap <i>Check the folder again</i>.</p>` });
      if (o.renum) {
        const most = (r.have || []).length >= o.aired * 0.9;
        items.push({ h: `Your files are numbered differently from ${src}`,
          b: `<p>${plural(o.unknown.length, 'file')} in the folder ${o.unknown.length === 1 ? 'has a number' : 'have numbers'} ${src} doesn't have, and it lists ${plural(o.missing.length, 'episode')} that aren't found. ${most ? `You have ${(r.have || []).length} files for ${o.aired} aired episodes, so <b>the "missing" ones are most likely already here</b>, under other numbers.` : 'Some of the "missing" ones are probably already here, under other numbers.'}</p>
            ${perSeason()}
            <div class="tv-two"><div><b>Your files ${src} doesn't know</b> (${o.unknown.length})<span class="mono">${esc(tvRuns(o.unknown, 12))}</span></div>
              <div><b>Episodes not found</b> (${o.missing.length})<span class="mono">${esc(tvRuns(o.missing, 12))}</span></div></div>
            <p class="muted">Common causes: the show was split differently (a season released in two halves, "parts" on Netflix, DVD order), or numbered straight through (absolute numbering).${r.order === 'sonarr' || !(r.show && r.show.tvdb) ? '' : " Sonarr's numbering didn't fit your files any better."}</p>
            <p class="tv-do"><b>What to do:</b> if every episode is really there, mark the show complete. Otherwise rename the files to match the grid below and check the folder again. Asking Sonarr now could download copies of episodes you already have.</p>
            <div class="tv-iacts"><button class="ef-open tv-ok" data-rdone="1">✓ They're all here - mark as complete</button>${o.missing.length ? `<button class="ef-open" data-sn="${esc(r.path)}" title="Sonarr may download episodes you already have under other numbers">Ask Sonarr anyway</button>` : ''}</div>
            <details class="tv-more"><summary>Show the file names</summary>${fileList(o.unknown)}</details>` });
      }
      if (o.seasons.length && !o.renum) items.push({ h: `Missing ${o.seasons.length === 1 ? 'season' : 'seasons'} ${o.seasons.join(', ')}`,
        b: `<p>None of ${o.seasons.length === 1 ? 'its' : 'their'} aired episodes are in the folder (${o.seasons.map(sn => `season ${sn}: ${plural(o.missing.filter(([a]) => a === sn).length, 'episode')}`).join(', ')}).</p>` });
      const loose = o.missing.filter(([sn]) => !o.seasons.includes(sn));
      if (loose.length && !o.renum) items.push({ h: `Missing ${plural(loose.length, 'episode')}`, b: `<p class="mono">${esc(tvRuns(loose, 40))}</p>` });
      if (o.odd) items.push({ h: `${plural(o.unknown.length, 'file')} with an episode number that doesn't exist`,
        b: `${fileList(o.unknown)}<p class="muted">${src} has no such episode - probably a typo in the name, a double episode or a special. It doesn't change the missing list: rename it if it's wrong, or leave it.</p>` });
      if ((r.unparsed || []).length && !o.noNums) items.push({ h: `${plural(r.unparsed.length, 'file')} not counted - no season/episode number in the name`,
        b: `<div class="mono tv-files">${r.unparsed.map(n => esc(n)).join('<br>')}</div>` });
      if (!items.length) return '';
      const bad = TV_PROBLEMS.includes(o.v);
      return `<div class="tv-issues${bad ? '' : ' minor'}"><div class="tv-ih">${bad ? "⚠ What's wrong" : 'ℹ Worth knowing'}</div>
        ${items.map((x, i) => `<div class="tv-issue"><div class="tv-it">${items.length > 1 ? `<span class="tv-in">${i + 1}</span>` : ''}${x.h}</div><div class="tv-ib">${x.b}</div></div>`).join('')}</div>`;
    }
    const HOW = { nfo: 'its id in tvshow.nfo', folder: 'the id in the folder name', title: 'its title', fit: 'its title and your episode files', picked: 'your pick', saved: 'an earlier scan' };
    function showDetail(path) {
      const r = T.results.find(x => x.path === path); if (!r) return;
      T.detailPath = path;
      const o = V(r), s = r.show, rule = T.rules[path] || {}, skip = new Set(rule.seasons || []);
      const d = el('.mt-detail');
      const have = new Set(r.have || []), askedEps = new Set((T.sn.get(path) || {}).eps || []);
      const cut = new Date(new Date(T.today + 'T12:00:00').getTime() - TV_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
      const seasons = new Map(); for (const ep of r.eps || []) { if (!seasons.has(ep[0])) seasons.set(ep[0], []); seasons.get(ep[0]).push(ep); }
      const grid = [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([sn, list]) => {
        const aired = list.filter(([, , dt]) => dt && dt <= cut), got = aired.filter(([, e]) => have.has(`${sn}.${e}`)).length;
        return `<div class="tv-season${skip.has(sn) ? ' skip' : ''}"><div class="tv-sh"><b>Season ${sn}</b><span class="muted">${got} of ${aired.length}${list.length > aired.length ? ` · ${list.length - aired.length} not aired yet` : ''}</span>
            ${(() => { const miss = skip.has(sn) || !s ? [] : o.missing.filter(([a]) => a === sn); if (!miss.length) return '';
              const again = miss.every(([a, e]) => askedEps.has(`${a}.${e}`));
              return `<button class="ef-open tv-snseason" data-snseason="${sn}" title="${esc(`Ask Sonarr for the ${miss.length} missing episode${miss.length === 1 ? '' : 's'} of season ${sn} only${o.renum ? ' - careful: your files are numbered differently, Sonarr may download copies' : ''}`)}">${again ? '↻ Ask again' : `⬇ Get season ${sn}`} <small>(${miss.length})</small></button>`; })()}
            <button class="ef-open" data-skip="${sn}">${skip.has(sn) ? 'Count this season again' : 'Ignore season'}</button></div>
          <div class="tv-cells">${list.map(([, e, dt, t]) => { const k = `${sn}.${e}`, st = have.has(k) ? 'have' : !dt || dt > cut ? 'future' : askedEps.has(k) ? 'asked' : o.renum ? 'nf' : 'miss';
            return `<span class="tv-cell ${st}" title="${esc(`${epName(sn, e, dt)}${t ? ' · ' + t : ''}${dt ? ' · ' + dt : ''} - ${st === 'have' ? 'in the folder' : st === 'miss' ? 'missing' : st === 'nf' ? 'not found by this number - may be here under another' : st === 'asked' ? 'missing - asked Sonarr for it' : 'not aired yet'}`)}">${e}</span>`; }).join('')}</div></div>`;
      }).join('');
      d.innerHTML = `<button class="ef-open mt-back">‹ Back to the list</button>
        <div class="tv-dhead">${s && s.poster ? `<img class="tv-poster" alt="" referrerpolicy="no-referrer" src="${esc(s.poster)}">` : ''}
          <div><h3>${esc(s ? s.name : r.name)}${s && s.year ? ` <span class="mt-year">(${esc(s.year)})</span>` : ''}</h3>
            ${s && s.status ? (() => {
              /* ended or still going - big and clear, with the last or next episode */
              const today = T.today, eps = (r.eps || []).filter(e => e[2]).sort((x, y) => x[2] < y[2] ? -1 : 1);
              const last = [...eps].reverse().find(e => e[2] <= today), next = eps.find(e => e[2] > today);
              const k = s.status === 'Ended' ? 'ended' : s.status === 'Running' ? 'running' : 'tbd';
              const label = { ended: 'Ended', running: 'Continuing', tbd: s.status === 'To Be Determined' ? 'Future unknown' : esc(s.status) }[k];
              const more = k === 'ended' ? (last ? `last episode ${epName(last[0], last[1], last[2])} on ${last[2]}` : '')
                : next ? `next episode ${epName(next[0], next[1], next[2])} on ${next[2]}` : k === 'running' ? 'no next episode announced yet' : (last ? `latest ${epName(last[0], last[1], last[2])} on ${last[2]}` : '');
              return `<div class="tv-life ${k}"><span class="tv-life-b">${k === 'ended' ? '■' : k === 'running' ? '●' : '◐'} ${label}</span>${more ? `<span class="tv-life-m">${esc(more)}</span>` : ''}</div>`;
            })() : ''}
            ${snChip(r) ? `<div>${snChip(r)}</div>` : ''}
            ${s ? `<div class="mt-facts">${[s.network && esc(s.network), s.type && esc(s.type)].filter(Boolean).join(' · ')}</div>
            <div class="tv-links">
              <a class="tv-link imdb" href="${esc(s.imdb ? `https://www.imdb.com/title/${s.imdb}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(s.name + (s.year ? ' ' + s.year : ''))}&s=tt&ttype=tv`)}" target="_blank" rel="noopener" title="${s.imdb ? 'Open the show on IMDb - plot, cast and rating' : 'Search IMDb for this show'}">IMDb${s.imdb ? '' : ' search'} ↗</a>
              ${s.url ? `<a class="tv-link" href="${esc(s.url)}" target="_blank" rel="noopener">TVmaze ↗</a>` : ''}
              ${s.rating ? `<span class="tv-rating" title="Average rating on TVmaze">★ ${esc(s.rating.toFixed ? s.rating.toFixed(1) : s.rating)}<small>/10</small></span>` : ''}
              ${(s.genres || []).length ? `<span class="muted tv-genres">${esc(s.genres.join(' · '))}</span>` : ''}</div>
            <div class="muted tv-how">Matched by ${HOW[r.how] || 'TVmaze'}</div>
            ${r.order === 'sonarr' ? `<div class="tv-ordnote" title="TVmaze splits or numbers this show differently from your files. Sonarr's numbering (TheTVDB) matched them, so that's the list used - it's also the numbering Sonarr names and fetches files by.">Counted by <b>Sonarr's numbering</b> - TVmaze numbers this show differently</div>` : ''}
            ${s.summary ? `<p class="mt-plot">${esc(s.summary)}</p>` : ''}` : `<div class="muted">${r.err ? esc(r.err) : 'Not matched yet.'} <a href="#" data-pick="${esc(path)}">Pick the show ›</a></div>`}
            <div class="mt-status"><span class="mt-kind tv-k-${o.v}">${TV_GROUP[o.v][0]}</span> ${esc(TV_GROUP[o.v][1])}</div>
            ${s && sendable(r) ? `<div class="tv-sndrow"><button class="uc-btn primary tv-snd" data-sn="${esc(path)}">${asked(r) ? '↻ Ask Sonarr again for the missing episodes' : `⬇ Get the ${o.missing.length} missing episode${o.missing.length === 1 ? '' : 's'} with Sonarr`}</button></div>` : ''}
            ${s ? `<div class="tv-rules"><button class="ef-open tv-wrong" data-pick="${esc(path)}" title="Search TVmaze yourself and choose the right show - by name, TVmaze link, or IMDb id">🔍 Wrong show? Search TVmaze</button><button class="ef-open" data-recheck="1" title="Look in the folder again - for episodes that just arrived">↻ Check the folder again</button><button class="ef-open" data-rshow="1">${rule.show ? 'Stop ignoring this show' : 'Ignore this show'}</button><button class="ef-open" data-rdone="1">${rule.complete ? 'Unmark complete' : 'Mark as complete'}</button></div>` : ''}
            <div class="mt-path mono">${esc(path)}</div></div></div>
        ${stuckOf(r).length ? `<div class="tv-stuck"><div class="tv-ih">⚠ Downloaded, but Sonarr won't import ${stuckOf(r).length === 1 ? 'it' : 'them'} on its own</div>
          ${stuckOf(r).map(i => `<div class="tv-stuck-i"><span class="mono">${esc(i.title)}</span>${i.eps.length ? ` <b>${esc(i.eps.join(', '))}</b>` : ''}${i.msgs.length ? `<div class="muted">${esc(i.msgs.join(' '))}</div>` : ''}</div>`).join('')}
          <div class="tv-iacts"><button class="uc-btn primary" data-snimp="${esc(r.path)}">Import now</button><span class="muted">Does what Sonarr's Manual Import does, for the episodes Sonarr has matched. Files it isn't sure about are left alone.</span></div></div>` : ''}
        ${tvIssues(r, o)}
        ${grid ? `<div class="tv-legend"><span class="tv-cell have"></span> in the folder ${o.renum ? '<span class="tv-cell nf"></span> not found by this number' : '<span class="tv-cell miss"></span> missing'}${askedEps.size ? ' <span class="tv-cell asked"></span> asked Sonarr for it' : ''} <span class="tv-cell future"></span> not aired yet
          ${seasons.size > 1 ? `<button class="ef-open tv-skipall" data-skipall="1">${[...seasons.keys()].every(n => skip.has(n)) ? 'Count all seasons again' : 'Ignore all seasons'}</button>` : ''}</div><div class="tv-grid">${grid}</div>` : ''}
        ${r.extras ? `<div class="muted tv-note">${r.extras} extra${r.extras === 1 ? '' : 's'}, special${r.extras === 1 ? '' : 's'} or sample${r.extras === 1 ? '' : 's'} not counted.</div>` : ''}
        <div class="tv-delrow"><button class="ef-open tv-del" data-del="1" title="Delete this show's whole folder - asks first">Delete this show's folder…</button></div>`;
      detailView();
      $('.mt-back', d).addEventListener('click', listView);
      $$('[data-snseason]', d).forEach(b => b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const sn = +b.dataset.snseason;
        if (!snReady() || T.snBusy) return;
        b.disabled = true; b.textContent = 'Asking Sonarr…';
        snSend(r, sn).then(st => {
          if (st === 'sent') toast(`${r.show.name}: asked Sonarr for season ${sn}`);
          else if (st === 'have') toast(`Sonarr already has season ${sn}'s episodes`);
          if (T.view === 'detail') showDetail(r.path);
        });
      }));
      $$('[data-skip]', d).forEach(b => b.addEventListener('click', () => { const n = +b.dataset.skip, cur = new Set(rule.seasons || []); cur.has(n) ? cur.delete(n) : cur.add(n); setRule(r, { seasons: [...cur] }); }));
      const sa = $('[data-skipall]', d);
      if (sa) sa.addEventListener('click', () => { const all = [...seasons.keys()]; setRule(r, { seasons: all.every(n => skip.has(n)) ? [] : all }); });
      const rs = $('[data-rshow]', d); if (rs) rs.addEventListener('click', () => setRule(r, { show: !rule.show }));
      $('[data-del]', d).addEventListener('click', () => askDelete(r));
      const rc = $('[data-recheck]', d); if (rc) rc.addEventListener('click', async () => {
        rc.disabled = true; rc.textContent = 'Checking…';
        const before = (r.have || []).length;
        try { const res = await api('tv_recheck', { path, eps: JSON.stringify(r.eps || []) }); Object.assign(r, { have: res.have, odd: res.odd, files: res.files, bytes: res.bytes, extras: res.extras, unparsed: res.unparsed }); } catch (e) { rc.disabled = false; return toast(e.message, true); }
        const n = r.have.length - before;
        toast(n > 0 ? `${n} new episode${n === 1 ? '' : 's'} found in the folder` : n < 0 ? `${-n} episode${n === -1 ? '' : 's'} no longer in the folder` : 'No change in the folder');
        draw(); showDetail(path);
      });
      $$('[data-rdone]', d).forEach(b => b.addEventListener('click', () => setRule(r, { complete: !rule.complete })));
    }
    /* ---------- deleting a show's folder (asks first, with everything spelled out) ---------- */
    function askDelete(r) {
      const s = r.show, x = T.sn.get(r.path) || {};
      askFolderDelete({ name: s ? s.name : r.name, year: s && s.year, poster: s && s.poster, path: r.path,
        badge: s ? ` <span class="tv-status ${s.status === 'Ended' ? 'ended' : 'running'}">${s.status === 'Ended' ? 'Ended' : 'Continuing'}</span>` : '',
        info: r.files ? `${r.files.toLocaleString()} video file${r.files === 1 ? '' : 's'}${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''} - plus everything else in the folder (posters, .nfo, subtitles)` : 'No video files - everything else in the folder (posters, .nfo, subtitles) goes with it',
        app: 'Sonarr', inApp: !!x.seriesId && x.state !== 'removed', removeApp: () => api('sonarr_remove', { path: r.path }),
        onDeleted: () => { T.results = T.results.filter(q => q !== r); T.picked.delete(r.path); listView(); } });
    }
    const dlg2 = () => $('.uc-modal:not(.uc-tmodal) .uc-dlg');
    /* ---------- "Which show is this?" ---------- */
    function picker(path) {
      const r = T.results.find(x => x.path === path); if (!r) return;
      const d = el('.mt-detail'), left = toPick(), pos = left.findIndex(q => q.path === path) + 1;
      const fromDetail = T.view === 'detail' && !!r.show;
      const q0 = (r.title || r.name).replace(/\s*[\[{(][^\]})]*[\]})]\s*/g, ' ').replace(/[._]+/g, ' ').trim();
      d.innerHTML = `<div class="rd-pickbar"><button class="ef-open mt-back">‹ Back to ${fromDetail ? 'the details' : 'the list'}</button>${T.walk && left.length > 1 && pos ? `<span class="rd-pos">Show ${pos} of ${left.length}</span><button class="ef-open rd-skip">Skip ›</button>` : ''}</div>
        <div class="rd-pickh"><b>Which show is <span class="mono">${esc(r.name)}</span>?</b> <span class="muted">${(r.have || []).length} episode file${(r.have || []).length === 1 ? '' : 's'} in the folder${(r.have || []).length ? ` (${esc(tvRuns((r.have || []).map(k => k.split('.').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]), 3))})` : ''}.</span></div>
        <div class="tv-search"><input type="text" class="tv-q" value="${esc(q0)}" spellcheck="false" autocapitalize="off"><button class="uc-btn tv-go">Search TVmaze</button></div>
        <div class="muted tv-qhint">Type the show's name - or paste its TVmaze link, IMDb id (tt1234567) or TheTVDB id (tvdb:12345) to find exactly that show.${r.show ? ` Now matched to <b>${esc(r.show.name)}${r.show.year ? ` (${esc(r.show.year)})` : ''}</b>.` : ''}</div>
        <div class="rd-cands tv-cands"></div>`;
      detailView();
      const box = $('.tv-cands', d);
      const show = list => {
        box.innerHTML = list.length ? list.map(c => `<div class="rd-cand">${c.poster ? `<img src="${esc(c.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="mt-thumb none"></span>'}
          <div><b>${esc(c.name)}</b> <span class="mt-year">(${esc(c.year || '?')})</span> <span class="tv-status ${c.status === 'Ended' ? 'ended' : 'running'}">${esc(c.status || '?')}</span>${c.network ? ` <span class="muted">${esc(c.network)}</span>` : ''}
          <p>${esc(c.summary || '')}</p>
          ${r.show && r.show.id === c.id ? '<span class="tv-cur">✓ Matched now</span>' : `<button class="uc-btn primary tv-use" data-id="${c.id}">This one</button>`}${c.imdb ? ` <a href="https://www.imdb.com/title/${esc(c.imdb)}/" target="_blank" rel="noopener">IMDb ↗</a>` : ''}${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">TVmaze ↗</a>` : ''}</div></div>`).join('') : '<div class="muted">Nothing found - try another spelling, or paste the show\'s TVmaze link or IMDb id.</div>';
        $$('.tv-use', box).forEach(b => b.addEventListener('click', async () => {
          b.disabled = true; b.textContent = 'Saving…';
          try { const res = await api('tv_pick', { path, id: +b.dataset.id }); Object.assign(r, { show: res.show, eps: res.eps, how: res.how, have: res.have, odd: res.odd, order: res.order }); delete r.cand; delete r.err; }
          catch (e) { b.disabled = false; b.textContent = 'This one'; return toast(e.message, true); }
          toast(`${r.name}: matched to ${r.show.name}${r.show.year ? ` (${r.show.year})` : ''}`);
          next();
        }));
      };
      const search = async () => {
        const q = $('.tv-q', d).value.trim(); if (!q) return;
        box.innerHTML = '<div class="muted"><span class="spin"></span> Searching…</div>';
        try { show((await api('tv_search', { q })).results); } catch (e) { box.innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; }
      };
      if ((r.cand || []).length && !r.show) show(r.cand); else search();
      $('.tv-go', d).addEventListener('click', search);
      $('.tv-q', d).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      const back = listView;
      const next = () => {
        const rest = toPick(), after = rest.find((q, i) => i >= pos - 1 && q.path !== path) || rest.find(q => q.path !== path);
        if (T.walk && after) picker(after.path); else { listView(); if (r.show) showDetail(path); }
      };
      $('.mt-back', d).addEventListener('click', () => fromDetail ? showDetail(path) : back());
      const sk = $('.rd-skip', d); if (sk) sk.addEventListener('click', next);
    }
    /* ---------- export: the missing episodes of the listed shows ---------- */
    function asText(fmt) {
      const rows = shown().map(r => [r, V(r)]);
      if (fmt === 'csv') {
        const q = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
        const lines = [['Show', 'Year', 'Status', 'Result', 'Season', 'Episode', 'Episode title', 'Aired', 'Folder']];
        for (const [r, o] of rows) {
          const base = [r.show ? r.show.name : r.name, r.show && r.show.year, r.show && r.show.status, TV_GROUP[o.v][0]];
          if (o.missing.length && !['ignored', 'complete'].includes(o.v)) for (const [s, e, dt, t] of o.missing) lines.push([...base, s, e, t, dt, r.path]);
          else lines.push([...base, '', '', '', '', r.path]);
        }
        return '﻿' + lines.map(a => a.map(q).join(',')).join('\r\n') + '\r\n';
      }
      return `TV shows with missing episodes - ${T.root} - ${new Date().toLocaleString()}\n\n` + rows.map(([r, o]) => {
        const head = `${r.show ? r.show.name : r.name}${r.show && r.show.year ? ` (${r.show.year})` : ''} - ${TV_GROUP[o.v][0]}\n    ${r.path}`;
        return o.missing.length && !['ignored', 'complete'].includes(o.v) ? `${head}\n    Missing: ${tvRuns(o.missing, 999)}` : head;
      }).join('\n') + '\n';
    }
    const fileName = fmt => `tv-missing-episodes-${new Date().toISOString().slice(0, 10)}.${fmt}`;
    function toggleExport() {
      const x = el('.mt-export');
      if (!x.hidden) { x.hidden = true; return; }
      const n = shown().length;
      x.innerHTML = `<div><b>Export the ${n} show${n === 1 ? '' : 's'} listed</b> <span class="muted">(with their missing episodes - pick a group above first to narrow it)</span></div>
        <div class="mt-xrow"><span class="muted">To this device:</span><button class="uc-btn" data-dl="csv">Download CSV</button><button class="uc-btn" data-dl="txt">Download text</button></div>
        <div class="mt-xrow"><span class="muted">On the server, in</span><input type="text" class="mt-xdir" value="${esc(A().mode === 'dir' ? A().path : '/mnt/user')}" spellcheck="false" autocapitalize="off">
          <button class="uc-btn" data-sv="csv">Save CSV</button><button class="uc-btn" data-sv="txt">Save text</button></div>`;
      x.hidden = false;
    }
    el('.mt-export').addEventListener('click', async e => {
      const b = e.target.closest('[data-dl], [data-sv]'); if (!b) return;
      const fmt = b.dataset.dl || b.dataset.sv, text = asText(fmt);
      if (b.dataset.dl) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: fmt === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
        a.download = fileName(fmt); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return;
      }
      try { const r = await api('save_report', { dir: el('.mt-xdir').value.trim(), name: fileName(fmt), text }); toast(`Saved ${r.path}`); refreshBoth(); }
      catch (err) { toast(err.message, true); }
    });
    el('.mt-filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; T.filter = b.dataset.f; listView(); });
    const onClick = e => {
      const dr = e.target.closest('[data-delrow]');
      if (dr) { e.preventDefault(); const r = T.results.find(x => x.path === dr.dataset.delrow); if (r) askDelete(r); return; }
      const imp = e.target.closest('[data-snimp]');
      if (imp) { e.preventDefault(); const r = T.results.find(x => x.path === imp.dataset.snimp); if (r) snImport(r, imp); return; }
      const snb = e.target.closest('[data-sn]');
      if (snb) { e.preventDefault(); const r = T.results.find(x => x.path === snb.dataset.sn); if (r && snReady() && !T.snBusy) snSend(r).then(st => { if (st === 'sent') toast(`${r.show.name}: asked Sonarr for the missing episodes`); if (T.view === 'detail') showDetail(r.path); }); return; }
      const det = e.target.closest('[data-det]'), go = e.target.closest('[data-go]'), pick = e.target.closest('[data-pick]'), walk = e.target.closest('[data-walk]');
      if (walk) { const first = toPick()[0]; if (first) { T.walk = true; picker(first.path); } return; }
      if (pick) { e.preventDefault(); T.walk = false; picker(pick.dataset.pick); return; }
      if (det) { e.preventDefault(); showDetail(det.dataset.det); return; }
      if (go) { e.preventDefault(); parkTool(); load(A(), go.dataset.go); }
    };
    el('.mt-list').addEventListener('click', onClick);
    el('.mt-list').addEventListener('change', e => { const c = e.target.closest('input[data-k]'); if (!c) return; c.checked ? T.picked.add(c.dataset.k) : T.picked.delete(c.dataset.k); draw(); });
    el('.mt-all').addEventListener('change', e => { T.picked = new Set(e.target.checked ? shown().filter(r => sendable(r) && !asked(r)).map(r => r.path) : []); draw(); });
    el('.mt-arrived').addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      const r = p => T.results.find(x => x.path === p);
      if (b.dataset.snrm && r(b.dataset.snrm)) snRemove(r(b.dataset.snrm));
      else if (b.dataset.sndis && r(b.dataset.sndis)) snDismiss(r(b.dataset.sndis));
      else if (b.dataset.snrmall) { for (const x of arrived()) if ((T.sn.get(x.path) || {}).state !== 'removed') await snRemove(x); }
      else if (b.dataset.sndisall) { for (const x of arrived()) await snDismiss(x); }
      else if (b.dataset.go) { parkTool(); load(A(), b.dataset.go); }
    });
    el('.mt-attn').addEventListener('click', onClick);
    el('.mt-detail').addEventListener('click', e => { if (e.target.closest('[data-sn], [data-snimp]')) return onClick(e); const pick = e.target.closest('[data-pick]'); if (pick) { e.preventDefault(); T.walk = false; picker(pick.dataset.pick); } });
    /* bring back the last scan: its results, or its progress if it's still going */
    let lastId = null;
    try { lastId = (await api('scan_last', { tool: 'tv' })).id; } catch (e) {}
    if (lastId) {
      T.scan = lastId;
      el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = '<span class="spin"></span> Loading the last scan…'; bGo.hidden = true;
      poll(true);
    }
  }

  /* ---------- Tools > Movie folders without a video ---------- */
  async function openMovieTool() {
    if (tdlg.tool === 'movies') return unparkTool();
    const dlg = tdlg;
    let info = { shares: [] };
    try { info = await api('mounts'); } catch (e) {}
    const guess = info.shares.find(n => /^movies?$/i.test(n)) || info.shares.find(n => /movie|film/i.test(n));
    const T = { scan: null, results: [], filter: 'all', picked: new Set(), timer: 0, asking: false, root: '' };
    const KIND = { meta: ['Posters / .nfo only', 'Has an .nfo or pictures but no video'], empty: ['Empty', 'Nothing inside at all'],
                   sample: ['Sample only', 'Only a sample or trailer'], other: ['Other files', 'Files, but no video (subtitles, text...)'] };
    openToolDlg('movies', 'Movie folders without a video', `
      <div class="mt-setup">
        <div class="field mt-rootf"><label>Movies folder <span class="muted">- each folder directly inside it is one movie</span></label>
          <div class="mt-rootrow"><input type="text" class="mt-root" value="${esc(store.get('root.movies', '') || (guess ? '/mnt/user/' + guess : (A().mode === 'dir' ? A().path : '/mnt/user')))}" spellcheck="false" autocapitalize="off">
          ${info.shares.length ? `<select class="mt-pick"><option value="">Shares…</option>${info.shares.map(n => `<option>${esc(n)}</option>`).join('')}</select>` : ''}</div></div>
      </div>
      <div class="mt-prog muted" hidden></div>
      <div class="tl-when muted" hidden></div>
      <div class="mt-res" hidden>
        <div class="mt-attn" hidden></div>
        <div class="mt-arrived" hidden></div>
        <div class="mt-bar"><label class="chk"><input type="checkbox" class="mt-all"> <b class="mt-count"></b></label><div class="mt-filters"></div></div>
        <div class="mt-export" hidden></div>
        <div class="mt-wrap"><div class="mt-list"></div><div class="mt-detail" hidden></div></div>
        <div class="mt-note muted"></div>
      </div>`,
      [{ label: 'Close', run: () => { if (T.asking) { T.asking = false; draw(); return false; } if (!el('.mt-detail').hidden) { el('.mt-detail').hidden = true; el('.mt-list').hidden = false; T.walk = false; draw(); return false; } } },
       { label: 'Export…', run: () => { toggleExport(); return false; } },
       { label: 'Add to Radarr', title: 'Send the picked movies to Radarr: it downloads each one into its existing folder', run: () => { rdBulk(); return false; } },
       { label: 'Scan', primary: true, run: () => { startScan(); return false; } }], 'full mt-dlg sticky');
    const btns = $$('.dlg-foot .uc-btn', dlg), [bClose, bExport, bRadarr, bGo] = btns;
    dlg.toolLabel = () => `Movie folders${T.results.length ? ' · ' + T.results.filter(r => !r.done).length.toLocaleString() : T.scan ? ' · scanning' : ''}`;
    dlg.toolAttn = () => needs().length;
    bExport.hidden = bRadarr.hidden = true;
    T.rd = new Map();       // path -> { state: busy|added|exists|pick|err, msg, cand }
    dlg.beforeClose = () => { clearTimeout(T.timer); return true; };
    const el = c => $(c, dlg);
    const pk = el('.mt-pick'); if (pk) pk.addEventListener('change', () => { if (pk.value) el('.mt-root').value = '/mnt/user/' + pk.value; pk.value = ''; });
    el('.mt-root').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startScan(); } });

    async function startScan() {
      const root = el('.mt-root').value.trim();
      try { T.scan = (await api('movie_scan_start', { root })).id; } catch (e) { return toast(e.message, true); }
      store.set('root.movies', root);
      el('.tl-when').hidden = true;
      T.root = root; T.picked.clear(); T.asking = false; T.filter = 'all';
      el('.mt-res').hidden = true; el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = '<span class="spin"></span> Starting…';
      bGo.disabled = true; bGo.textContent = 'Scanning…'; bExport.hidden = bRadarr.hidden = true;
      T.t0 = Date.now();
      poll();
    }
    async function poll(fresh) {
      if (!dlg.contains(btns[0])) return;
      let st;
      try { st = (await api('scan_status', { id: T.scan, fresh: fresh ? 1 : 0 })).scan; }
      catch (e) {
        if (e.offline) { el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = `<div class="tv-offline">⚠ Lost contact with the server - trying again… <span class="muted">The scan keeps running on the server.</span></div>`; T.timer = setTimeout(() => poll(fresh), 3000); return; }
        el('.mt-prog').innerHTML = `<div class="uc-error">${esc(e.message)}</div>`; bGo.disabled = false; return;
      }
      if (['running', 'queued'].includes(st.state)) {
        el('.mt-prog').innerHTML = `<span class="spin"></span> Checking ${st.total ? st.total.toLocaleString() + ' movie folders' : 'the movie folders'}… ${st.seen ? st.seen.toLocaleString() + ' files read' : ''}`;
        T.timer = setTimeout(() => poll(fresh), 600); return;
      }
      if (T.t0) await scanSettle(T.t0);
      bGo.disabled = false; bGo.textContent = 'Scan again';
      el('.tl-when').innerHTML = whenLine(st); el('.tl-when').hidden = !(fresh && st.finished);
      /* always "fresh" here: it also brings in movies that arrived through Radarr */
      try { const rr = await api('scan_results', { id: T.scan, fresh: 1 }); T.results = rr.results; if (rr.radarr_note) toast(`Couldn't ask Radarr which movies arrived: ${rr.radarr_note}`, true); }
      catch (e) { T.results = []; toast(`Couldn't load the results: ${e.message}`, true); }
      /* what was sent to Radarr earlier is remembered on the server */
      T.rd = new Map(); T.results.forEach(r => { if (r.rd) T.rd.set(r.path, r.rd); });
      T.total = st.total;
      el('.mt-prog').hidden = true; el('.mt-res').hidden = false;
      bExport.hidden = bRadarr.hidden = !T.results.length;
      draw();
      if (T.t0) { const n = missing().length; toast(`Scan finished - ${n ? `${n} of ${(st.total || 0).toLocaleString()} movie folders have no video` : `all ${(st.total || 0).toLocaleString()} movie folders have a video`}`); flashCount(el('.mt-count')); T.t0 = 0; }
    }
    /* "arrived" rows (sent to Radarr, video now in the folder) are their own group */
    const missing = () => T.results.filter(r => !r.done), arrived = () => T.results.filter(r => r.done);
    /* movies Radarr couldn't settle by itself: more than one match, or the send failed */
    const needState = r => { const st = (T.rd.get(r.path) || {}).state; return st === 'pick' || st === 'err' ? st : null; };
    const needs = () => missing().filter(needState);
    const shown = () => missing().filter(r => T.filter === 'all' || r.kind === T.filter);
    const thumb = r => r.poster ? `<img class="mt-thumb" loading="lazy" alt="" src="${esc(rawUrl(r.path + '/' + r.poster))}">` : '<span class="mt-thumb none"></span>';
    function draw() {
      const rows = shown();
      for (const k of [...T.picked]) if (!rows.some(r => r.path === k)) T.picked.delete(k);
      const n = missing().length;
      drawArrived(); drawAttn();
      if (tmodal.hidden && tdlg === dlg && dlg.tool === 'movies') drawPill();
      el('.mt-count').textContent = (n ? `${n} of ${T.total.toLocaleString()} movie folders have no video` : `All ${T.total.toLocaleString()} movie folders have a video`)
        + (T.picked.size ? ` · ${T.picked.size} picked` : '');
      const count = k => missing().filter(r => r.kind === k).length;
      el('.mt-filters').innerHTML = n ? [['all', 'All', n], ...Object.keys(KIND).map(k => [k, KIND[k][0], count(k)])].filter(([, , c]) => c)
        .map(([k, l, c]) => `<button class="ct-f${T.filter === k ? ' on' : ''}" data-f="${k}">${l} <b>${c}</b></button>`).join('') : '';
      el('.mt-all').checked = rows.length && T.picked.size === rows.length; el('.mt-all').disabled = !rows.length;
      el('.mt-list').innerHTML = rows.map(r => `<label class="mt-row${T.picked.has(r.path) ? ' on' : ''}${needState(r) ? ' need' : ''}"><input type="checkbox" data-k="${esc(r.path)}" ${T.picked.has(r.path) ? 'checked' : ''}>
          ${thumb(r)}
          <span class="mt-main"><b>${esc(r.title || r.name)}</b>${r.year ? ` <span class="mt-year">(${esc(r.year)})</span>` : ''}${r.rating ? ` <span class="mt-rate">★ ${r.rating}</span>` : ''}
            <span class="mt-sub">${r.done ? '' : `<span class="mt-kind ${r.kind}" title="${esc(KIND[r.kind][1])}">${KIND[r.kind][0]}</span> `}<span class="mono">${esc(r.name)}</span>${r.files && !r.done ? ` · ${r.files} file${r.files === 1 ? '' : 's'}` : ''}</span>${rdChip(r)}</span>
          <span class="mt-acts">${r.done
            ? `${(T.rd.get(r.path) || {}).state !== 'removed' ? `<button class="ef-open rd-rm" data-rm="${esc(r.path)}" title="Take it out of Radarr - the movie's files stay where they are">Remove from Radarr</button>` : ''}<button class="ef-open" data-dis="${esc(r.path)}" title="Take this row off the list">Clear</button>`
            : `<button class="ef-open rd-one" data-rd="${esc(r.path)}" title="Send this movie to Radarr">Radarr</button><button class="ef-open" data-det="${esc(r.path)}">Details</button>`}<button class="ef-open" data-go="${esc(r.path)}" title="Show it in the active pane">Show</button>${r.done ? '' : `<button class="ef-open tv-del" data-mdel="${esc(r.path)}" title="Delete this movie's folder - to the trash or for good; asks first">Delete…</button>`}</span></label>`).join('')
        || `<div class="ef-none muted">${n ? 'Nothing in this group.' : 'Every movie folder here has a video file in it.'}</div>`;
      updateDel();
    }
    /* Arrived: movies sent from here whose video is now in the folder - a fixed panel above the list */
    function drawArrived() {
      const box = el('.mt-arrived'), list = arrived();
      box.hidden = !list.length;
      if (!list.length) return;
      const live = list.filter(r => (T.rd.get(r.path) || {}).state !== 'removed').length;
      box.innerHTML = `<div class="ma-h"><b>✓ Arrived through Radarr</b> <span class="muted">${list.length} movie${list.length === 1 ? '' : 's'} sent from here now ${list.length === 1 ? 'has its' : 'have their'} video</span>
          <span class="ma-acts">${live ? `<button class="ef-open rd-rm" data-rmall="1" title="Take them out of Radarr - the movie files stay where they are">Remove ${live > 1 ? 'all ' + live + ' ' : ''}from Radarr</button>` : ''}<button class="ef-open" data-disall="1">Clear ${list.length > 1 ? 'all' : ''}</button></span></div>
        <div class="ma-list">${list.map(r => {
          const x = T.rd.get(r.path) || {};
          return `<div class="ma-row">${thumb(r)}<span class="ma-t"><b>${esc(r.title || r.name)}</b>${r.year ? ` <span class="mt-year">(${esc(r.year)})</span>` : ''}
            <span class="ma-s">${x.state === 'removed' ? 'removed from Radarr' : x.state === 'busy' ? '<span class="spin"></span> removing from Radarr…' : 'still listed in Radarr'}</span></span>
            <span class="mt-acts">${x.state !== 'removed' && x.state !== 'busy' ? `<button class="ef-open rd-rm" data-rm="${esc(r.path)}" title="Take it out of Radarr - the movie's files stay where they are">Remove from Radarr</button>` : ''}<button class="ef-open" data-dis="${esc(r.path)}">Clear</button><button class="ef-open" data-go="${esc(r.path)}" title="Show it in the active pane">Show</button></span></div>`;
        }).join('')}</div>`;
    }
    /* Needs you: a fixed amber panel above everything, so a "which movie?"
     * question can't get lost in a long list. "Choose now" walks through them. */
    function drawAttn() {
      const box = el('.mt-attn'), list = needs();
      box.hidden = !list.length;
      if (!list.length) { T.walk = false; return; }
      const nPick = list.filter(r => needState(r) === 'pick').length, nErr = list.length - nPick;
      box.innerHTML = `<div class="na-h"><span class="na-ic">⚠</span><span class="na-t"><b>Radarr needs you for ${list.length} movie${list.length === 1 ? '' : 's'}</b>
          <span class="na-s">${[nPick && `${nPick} ${nPick === 1 ? 'has' : 'have'} more than one possible match - choose the right one`, nErr && `${nErr} couldn't be sent`].filter(Boolean).join(' · ')}</span></span>
          ${nPick ? `<button class="uc-btn primary na-go" data-walk="1">Choose now ›</button>` : ''}</div>
        <div class="na-list">${list.map(r => {
          const x = T.rd.get(r.path) || {}, err = x.state === 'err';
          return `<div class="na-row">${thumb(r)}<span class="ma-t"><b>${esc(r.title || r.name)}</b>${r.year ? ` <span class="mt-year">(${esc(r.year)})</span>` : ''}
            <span class="ma-s${err ? ' uc-error' : ''}">${err ? '✕ ' + esc(x.msg || 'failed') : `${(x.cand || []).length || 'No'} possible match${(x.cand || []).length === 1 ? '' : 'es'}`}</span></span>
            <span class="mt-acts">${err ? `<button class="ef-open" data-retry="${esc(r.path)}">Retry</button>` : `<button class="ef-open na-pick" data-pick="${esc(r.path)}">Pick ›</button>`}<button class="ef-open" data-go="${esc(r.path)}" title="Show it in the active pane">Show</button></span></div>`;
        }).join('')}</div>`;
    }
    /* ---------- Radarr ---------- */
    function rdChip(r) {
      const x = T.rd.get(r.path);
      if (r.done) return `<span class="rd-chip added">✓ Arrived${x && x.state === 'removed' ? ' · removed from Radarr' : x && x.state === 'busy' ? ' · <span class="spin"></span> removing from Radarr…' : ' · still listed in Radarr'}</span>`;
      if (!x) return '';
      const t = { busy: '<span class="spin"></span> Sending to Radarr…', added: `✓ Added to Radarr${x.searching ? ' · searching' : ''}`, exists: `✓ Already in Radarr${x.searching ? ' · search started' : ''}`,
                  pick: 'Radarr needs you to pick the movie ›', err: '✕ ' + esc(x.msg || 'failed') }[x.state];
      return `<span class="rd-chip ${x.state}"${x.state === 'pick' ? ` data-pick="${esc(r.path)}"` : ''} title="${esc(x.msg || '')}">${t}</span>`;
    }
    function rdButton() {
      const n = T.picked.size, busy = T.rdBusy;
      bRadarr.textContent = busy ? `${busy.verb} ${busy.done + 1} of ${busy.total}…` : n ? `Add ${n} to Radarr` : 'Add to Radarr';
      bRadarr.disabled = !!busy;
    }
    async function rdRemove(r) {
      T.rd.set(r.path, { ...(T.rd.get(r.path) || {}), state: 'busy' }); draw();
      try { const res = await api('radarr_remove', { path: r.path, id: (r.rd && r.rd.id) || (T.rd.get(r.path) || {}).id || 0 }); T.rd.set(r.path, res.rd); T.picked.delete(r.path); }
      catch (e) { T.rd.set(r.path, { state: 'added' }); toast(`${r.title || r.name}: ${e.message}`, true); draw(); return 'err'; }
      draw(); return 'removed';
    }
    async function rdDismiss(r) {
      try { await api('radarr_dismiss', { path: r.path }); } catch (e) { return toast(e.message, true); }
      T.results = T.results.filter(x => x.path !== r.path); T.picked.delete(r.path); draw();
    }
    /* bring the amber box into view and make it pulse, so it's noticed */
    function attnFlash() {
      const box = el('.mt-attn'); if (box.hidden) return;
      const d = el('.mt-detail'); if (!d.hidden && !T.walk) { d.hidden = true; el('.mt-list').hidden = false; }
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse');
      if (tmodal.hidden && dlg.tool === 'movies') { drawPill(); toolPill.classList.remove('pulse'); void toolPill.offsetWidth; toolPill.classList.add('pulse'); }
    }
    async function rdSend(r, tmdb) {
      T.rd.set(r.path, { state: 'busy' }); draw();
      try {
        const res = await api('radarr_add', { scan: T.scan || '', path: r.path, tmdb: tmdb || r.tmdb || 0, imdb: tmdb ? '' : (r.imdb || ''), title: r.title || r.name, year: r.year || 0 });
        if (res.status === 'pick') { T.rd.set(r.path, { state: 'pick', cand: res.candidates, msg: 'More than one possible match' }); T.picked.delete(r.path); }   // unticked: the amber box has it now
        else { T.rd.set(r.path, { state: res.status, searching: res.searching, msg: `${res.title} (${res.year}) → ${res.path}` }); T.picked.delete(r.path); }
      } catch (e) { T.rd.set(r.path, { state: 'err', msg: e.message }); }
      draw();
      return T.rd.get(r.path).state;
    }
    const rdReady = () => { if (SET.radarr && SET.radarr.ok) return true; toast('Set up Radarr first: Settings > Tools > Radarr (address, API key, quality profile)', true); return false; };
    async function rdRemoveAll() {
      if (!rdReady() || T.rdBusy) return;
      const list = arrived().filter(r => (T.rd.get(r.path) || {}).state !== 'removed');
      T.rdBusy = { done: 0, total: list.length, verb: 'Removing' }; rdButton();
      let ok = 0; for (const r of list) { if (await rdRemove(r) === 'removed') ok++; T.rdBusy.done++; rdButton(); }
      T.rdBusy = null; rdButton(); draw();
      toast(`Removed ${ok} from Radarr - the movie files stay where they are`);
    }
    async function rdBulk() {
      if (!rdReady() || T.rdBusy) return;
      const list = missing().filter(r => T.picked.has(r.path));
      if (!list.length) return toast('Tick the movies to send to Radarr first', true);
      T.rdBusy = { done: 0, total: list.length, verb: 'Adding' }; rdButton();
      const tally = {};
      for (const r of list) { const st = await rdSend(r); tally[st] = (tally[st] || 0) + 1; T.rdBusy.done++; rdButton(); }
      T.rdBusy = null; rdButton(); draw();
      toast([tally.added && `${tally.added} added`, tally.exists && `${tally.exists} already in Radarr`, tally.pick && `${tally.pick} need${tally.pick === 1 ? 's' : ''} you to choose the movie - see the amber box at the top`, tally.err && `${tally.err} failed`].filter(Boolean).join(' · ') || 'Done', !!(tally.err || tally.pick));
      if (tally.pick || tally.err) attnFlash();
    }
    function rdPicker(path) {
      const r = T.results.find(x => x.path === path), x = T.rd.get(path); if (!r || !x) return;
      const d = el('.mt-detail'), left = needs().filter(q => needState(q) === 'pick');
      const pos = left.findIndex(q => q.path === path) + 1;
      d.innerHTML = `<div class="rd-pickbar"><button class="ef-open mt-back">‹ Back to the list</button>${T.walk && left.length > 1 ? `<span class="rd-pos">Movie ${pos} of ${left.length}</span><button class="ef-open rd-skip">Skip ›</button>` : ''}</div>
        <div class="rd-pickh"><b>Which movie is "${esc(r.title || r.name)}"${r.year ? ` (${esc(r.year)})` : ''}?</b> <span class="muted">There's no TMDb or IMDb id in the folder <span class="mono">${esc(r.name)}</span>, and Radarr found more than one possible match.</span></div>
        <div class="rd-cands">${(x.cand || []).map(c => `<div class="rd-cand">${c.poster ? `<img src="${esc(c.poster)}" alt="" loading="lazy">` : '<span class="mt-thumb none"></span>'}
          <div><b>${esc(c.title)}</b> <span class="mt-year">(${esc(c.year || '?')})</span><p>${esc(c.overview || '')}</p>
          <button class="uc-btn primary rd-use" data-tmdb="${c.tmdb}">Use this one</button> <a href="https://www.themoviedb.org/movie/${c.tmdb}" target="_blank" rel="noopener">TMDb</a></div></div>`).join('') || '<div class="muted">Radarr found nothing.</div>'}</div>`;
      d.hidden = false; el('.mt-list').hidden = true; d.scrollTop = 0; updateDel();
      const back = () => { T.walk = false; d.hidden = true; el('.mt-list').hidden = false; draw(); };
      /* walking through them: after an answer (or Skip) go straight to the next one */
      const next = () => {
        const rest = needs().filter(q => needState(q) === 'pick');
        const after = rest.find((q, i) => i >= pos - 1 && q.path !== path) || rest.find(q => q.path !== path);
        if (T.walk && after && after.path !== path) rdPicker(after.path); else back();
      };
      $('.mt-back', d).addEventListener('click', back);
      const sk = $('.rd-skip', d); if (sk) sk.addEventListener('click', next);
      $$('.rd-use', d).forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Sending…';
        const st = await rdSend(r, +b.dataset.tmdb);
        if (st === 'added' || st === 'exists') toast(`${r.title || r.name}: ${st === 'added' ? 'added to Radarr' : 'already in Radarr'}`);
        next();
      }));
    }
    function updateDel() {
      let b = $('.mt-del', dlg);
      if (!b) { b = document.createElement('button'); b.className = 'uc-btn primary danger mt-del'; $('.dlg-foot', dlg).appendChild(b); b.addEventListener('click', onDelete); }
      const n = [...T.picked].filter(p => !(T.results.find(x => x.path === p) || {}).done).length;   // arrived movies are never offered for delete
      b.hidden = !n || T.filter === 'arrived'; b.textContent = T.asking ? `Yes, delete ${n} folder${n === 1 ? '' : 's'}` : `Delete ${n}…`;
      const inShow = !el('.mt-detail').hidden;
      bGo.hidden = bExport.hidden = bRadarr.hidden = T.asking;
      if (!T.asking) { bGo.hidden = false; bExport.hidden = bRadarr.hidden = !T.results.length; }
      rdButton();
      bClose.textContent = T.asking ? 'Cancel' : inShow ? '‹ Back to the list' : 'Close';
      if (inShow) { bGo.hidden = bExport.hidden = bRadarr.hidden = b.hidden = true; }
      const note = el('.mt-note');
      note.className = 'mt-note ' + (T.asking ? 'warnbox warn' : 'muted');
      note.innerHTML = T.asking ? `Move <b>${n}</b> folder${n === 1 ? '' : 's'} and everything in ${n === 1 ? 'it' : 'them'} (.nfo, posters, subtitles) to the trash? ${SET.trash === false ? '<b>The trash is off, so this deletes them for good.</b>' : 'Undo or the trash can bring them back.'}`
        : (T.results.length ? 'Plex keeps its posters and details in its own database, so folders it manages may show only the folder name here. Details come from a local .nfo file when there is one (Radarr, Emby, Jellyfin and tinyMediaManager write them).' : '');
    }
    async function onDelete() {
      if (SET.practice) return toast('Practice mode is on - deleting is locked. Turn it off in Settings > Safety.', true);
      if (!T.asking) { T.asking = true; updateDel(); return; }
      const paths = [...T.picked].filter(p => !(T.results.find(x => x.path === p) || {}).done);   // never an arrived movie
      if (!paths.length) { T.asking = false; draw(); return; }
      let r;
      try { r = await api('trash', { paths, label: `Deleted ${paths.length} movie folder${paths.length === 1 ? '' : 's'}` }); } catch (e) { T.asking = false; draw(); return toast(e.message, true); }
      T.asking = false;
      T.results = T.results.filter(x => !T.picked.has(x.path)); T.picked.clear(); draw();
      const msg = `Deleted ${r.count} folder${r.count === 1 ? '' : 's'}`;
      if (r.bins && r.bins.length) done(msg, r.hist);
      else toast(msg);
      refreshBoth();
    }
    function askMovieDelete(r) {
      const x = T.rd.get(r.path) || {};
      askFolderDelete({ name: r.title || r.name, year: r.year, poster: r.poster ? rawUrl(r.path + '/' + r.poster) : '', path: r.path,
        info: `${r.files ? `${r.files} file${r.files === 1 ? '' : 's'}${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''}` : 'Empty'} - everything in the folder (.nfo, posters, subtitles) goes with it`,
        app: 'Radarr', inApp: ['added', 'exists'].includes(x.state), removeApp: () => api('radarr_remove', { path: r.path, id: x.id || (r.rd && r.rd.id) || 0 }),
        onDeleted: () => { T.results = T.results.filter(q => q !== r); T.picked.delete(r.path); el('.mt-detail').hidden = true; el('.mt-list').hidden = false; draw(); } });
    }
    /* details: poster, plot, rating, ids, files */
    function showDetail(path) {
      const r = T.results.find(x => x.path === path); if (!r) return;
      const d = el('.mt-detail');
      const links = [r.imdb && `<a href="https://www.imdb.com/title/${esc(r.imdb)}/" target="_blank" rel="noopener">IMDb ${esc(r.imdb)}</a>`,
                     r.tmdb && `<a href="https://www.themoviedb.org/movie/${esc(r.tmdb)}" target="_blank" rel="noopener">TMDb ${esc(r.tmdb)}</a>`].filter(Boolean).join(' · ');
      d.innerHTML = `<button class="ef-open mt-back">‹ Back to the list</button>
        <div class="mt-dgrid">${r.poster ? `<img class="mt-poster" alt="" src="${esc(rawUrl(r.path + '/' + r.poster))}">` : '<div class="mt-poster none">No poster in the folder</div>'}
        <div class="mt-dtext">
          <h3>${esc(r.title || r.name)}${r.year ? ` <span class="mt-year">(${esc(r.year)})</span>` : ''}</h3>
          <div class="mt-facts">${[r.rating && `<span class="mt-rate">★ ${r.rating}</span>`, r.mpaa && esc(r.mpaa), r.runtime && `${esc(r.runtime)} min`, r.genres && esc(r.genres.join(', '))].filter(Boolean).join(' · ')}</div>
          ${r.tagline ? `<div class="mt-tag">${esc(r.tagline)}</div>` : ''}
          <p class="mt-plot">${r.plot ? esc(r.plot) : r.outline ? esc(r.outline) : `<span class="muted">${r.nfo ? 'The .nfo has no plot.' : 'No .nfo file in this folder, so there are no details beyond the folder name.'}</span>`}</p>
          ${links ? `<div class="mt-links">${links}</div>` : ''}
          <div class="mt-status"><span class="mt-kind ${r.kind}">${KIND[r.kind][0]}</span> ${esc(KIND[r.kind][1])}</div>
          <div class="mt-path mono">${esc(r.path)}</div>
          ${r.list && r.list.length ? `<div class="mt-files">${r.list.map(([n, sz]) => `<div><span class="mono">${esc(n)}</span><span>${fmtBytes(sz)}</span></div>`).join('')}${r.files > r.list.length ? `<div class="muted">…and ${r.files - r.list.length} more</div>` : ''}</div>` : ''}
        </div></div>
        ${r.done ? '' : `<div class="tv-delrow"><button class="ef-open tv-del" data-mdel1="1" title="Delete this movie's whole folder - asks first">Delete this movie's folder…</button></div>`}`;
      d.hidden = false; el('.mt-list').hidden = true; updateDel();
      const md = $('[data-mdel1]', d); if (md) md.addEventListener('click', () => askMovieDelete(r));
      $('.mt-back', d).addEventListener('click', () => { d.hidden = true; el('.mt-list').hidden = false; updateDel(); });
    }
    /* export: the picked folders, or everything listed */
    function exportRows() { const rows = shown(); return T.picked.size ? rows.filter(r => T.picked.has(r.path)) : rows; }
    function asText(fmt) {
      const rows = exportRows();
      if (fmt === 'csv') {
        const q = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
        return '﻿' + [['Title', 'Year', 'Status', 'Folder', 'Path', 'Files', 'Size (bytes)', 'Rating', 'IMDb', 'TMDb'],
          ...rows.map(r => [r.title || r.name, r.year, KIND[r.kind][0], r.name, r.path, r.files, r.bytes, r.rating, r.imdb, r.tmdb])].map(a => a.map(q).join(',')).join('\r\n') + '\r\n';
      }
      return `Movie folders without a video - ${T.root} - ${new Date().toLocaleString()}\n\n` + rows.map(r => `${r.title || r.name}${r.year ? ` (${r.year})` : ''} - ${KIND[r.kind][0]}${r.imdb ? ` - ${r.imdb}` : ''}\n    ${r.path}`).join('\n') + '\n';
    }
    const fileName = fmt => `movies-without-video-${new Date().toISOString().slice(0, 10)}.${fmt}`;
    function toggleExport() {
      const x = el('.mt-export');
      if (!x.hidden) { x.hidden = true; return; }
      const n = exportRows().length;
      x.innerHTML = `<div><b>Export ${n} ${T.picked.size ? 'picked' : 'listed'} movie${n === 1 ? '' : 's'}</b> <span class="muted">(pick some first to export only those)</span></div>
        <div class="mt-xrow"><span class="muted">To this device:</span><button class="uc-btn" data-dl="csv">Download CSV</button><button class="uc-btn" data-dl="txt">Download text</button></div>
        <div class="mt-xrow"><span class="muted">On the server, in</span><input type="text" class="mt-xdir" value="${esc(A().mode === 'dir' ? A().path : '/mnt/user')}" spellcheck="false" autocapitalize="off">
          <button class="uc-btn" data-sv="csv">Save CSV</button><button class="uc-btn" data-sv="txt">Save text</button></div>`;
      x.hidden = false;
    }
    el('.mt-export').addEventListener('click', async e => {
      const b = e.target.closest('[data-dl], [data-sv]'); if (!b) return;
      const fmt = b.dataset.dl || b.dataset.sv, text = asText(fmt);
      if (b.dataset.dl) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: fmt === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
        a.download = fileName(fmt); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return;
      }
      try { const r = await api('save_report', { dir: el('.mt-xdir').value.trim(), name: fileName(fmt), text }); toast(`Saved ${r.path}`); refreshBoth(); }
      catch (err) { toast(err.message, true); }
    });
    el('.mt-filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; T.filter = b.dataset.f; T.asking = false; el('.mt-detail').hidden = true; el('.mt-list').hidden = false; draw(); });
    el('.mt-list').addEventListener('change', e => { const c = e.target.closest('input[data-k]'); if (!c) return; c.checked ? T.picked.add(c.dataset.k) : T.picked.delete(c.dataset.k); T.asking = false; draw(); });
    el('.mt-list').addEventListener('click', e => {
      const det = e.target.closest('[data-det]'), go = e.target.closest('[data-go]');
      if (det) { e.preventDefault(); showDetail(det.dataset.det); }
      const mdel = e.target.closest('[data-mdel]');
      if (mdel) { e.preventDefault(); const r = T.results.find(x => x.path === mdel.dataset.mdel); if (r) askMovieDelete(r); return; }
      const rmb = e.target.closest('[data-rm]'), dis = e.target.closest('[data-dis]');
      if (rmb) { e.preventDefault(); if (rdReady() && !T.rdBusy) { const r = T.results.find(x => x.path === rmb.dataset.rm); if (r) rdRemove(r).then(st => st === 'removed' && toast('Removed from Radarr - the files stay where they are')); } }
      if (dis) { e.preventDefault(); const r = T.results.find(x => x.path === dis.dataset.dis); if (r) rdDismiss(r); }
      const one = e.target.closest('[data-rd]'), pk = e.target.closest('[data-pick]');
      if (one) { e.preventDefault(); if (rdReady() && !T.rdBusy) { const r = T.results.find(x => x.path === one.dataset.rd); if (r) rdSend(r).then(st => { if (st === 'pick') rdPicker(r.path); else if (st === 'err') attnFlash(); }); } }
      if (pk) { e.preventDefault(); rdPicker(pk.dataset.pick); }
      if (go) { e.preventDefault(); const p = go.dataset.go; parkTool(); load(A(), p); }
    });
    el('.mt-all').addEventListener('change', e => { T.picked = new Set(e.target.checked ? shown().map(r => r.path) : []); T.asking = false; draw(); });
    el('.mt-attn').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const r = T.results.find(x => x.path === (b.dataset.pick || b.dataset.retry || b.dataset.go));
      if (b.dataset.walk) { const first = needs().find(q => needState(q) === 'pick'); if (first) { T.walk = true; rdPicker(first.path); } }
      else if (b.dataset.pick && r) { T.walk = false; rdPicker(r.path); }
      else if (b.dataset.retry && r) { if (rdReady() && !T.rdBusy) rdSend(r).then(st => { if (st === 'pick') rdPicker(r.path); }); }
      else if (b.dataset.go && r) { parkTool(); load(A(), r.path); }
    });
    el('.mt-arrived').addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      const r = p => T.results.find(x => x.path === p);
      if (b.dataset.rm) { if (rdReady() && !T.rdBusy && r(b.dataset.rm)) { const st = await rdRemove(r(b.dataset.rm)); if (st === 'removed') toast('Removed from Radarr - the files stay where they are'); } }
      else if (b.dataset.rmall) rdRemoveAll();
      else if (b.dataset.dis) { if (r(b.dataset.dis)) rdDismiss(r(b.dataset.dis)); }
      else if (b.dataset.disall) { for (const x of arrived()) await api('radarr_dismiss', { path: x.path }).catch(() => {}); T.results = T.results.filter(x => !x.done); draw(); }
      else if (b.dataset.go) { const p = b.dataset.go; parkTool(); load(A(), p); }
    });
    /* bring back the last scan: its results, or its progress if it's still going */
    let lastId = null;
    try { lastId = (await api('scan_last', { tool: 'movies' })).id; } catch (e) {}
    if (lastId) {
      try {
        const st = (await api('scan_status', { id: lastId })).scan;
        T.scan = lastId; T.root = st.root; el('.mt-root').value = st.root; store.set('root.movies', st.root);
        el('.mt-prog').hidden = false; el('.mt-prog').innerHTML = '<span class="spin"></span> Loading the last scan…'; bGo.disabled = true;
        poll(true);
      } catch (e) {}
    }
    /* a poster that won't load (broken or not really an image): show the blank stripes instead */
    dlg.addEventListener('error', e => { const i = e.target; if (i.tagName !== 'IMG' || !i.matches('.mt-thumb, .mt-poster')) return;
      const ph = document.createElement(i.matches('.mt-poster') ? 'div' : 'span'); ph.className = i.className + ' none'; if (i.matches('.mt-poster')) ph.textContent = "The poster file couldn't be shown"; i.replaceWith(ph); }, true);
  }

  /* ---------- show / hide a pane (Left | Right toggle) ---------- */
  const paneTog = $('.uc-panetog');
  function applyPaneVis(animate) {
    const v = store.get('panesVis', 'both');
    root.classList.toggle('uc-anim', !!animate);
    root.classList.toggle('only-0', v === 'left'); root.classList.toggle('only-1', v === 'right');
    $$('.pt-seg', paneTog).forEach(b => { const on = v === 'both' || (b.dataset.p === '0' ? v === 'left' : v === 'right'); b.classList.toggle('off', !on); b.setAttribute('aria-pressed', on); });
    $$('.pt-rf', paneTog).forEach(b => { b.disabled = v === (b.dataset.rf === '0' ? 'right' : 'left'); });   // a hidden pane has nothing to refresh
    /* the hidden pane can't be the active one */
    if (v === 'left' && A() === panes[1]) setActive(0);
    if (v === 'right' && A() === panes[0]) setActive(1);
    setTimeout(() => panes.forEach(p => { drawRows(p); queueStat(p); }), animate ? 420 : 0);
  }
  paneTog.addEventListener('click', e => {
    /* ↻ refresh one pane: read its folder again, keeping the cursor on the same item */
    const rf = e.target.closest('.pt-rf');
    if (rf) {
      const p = panes[+rf.dataset.rf]; rf.blur();
      if (p.mode !== 'dir') return toast('This pane is showing a list, not a folder - nothing to refresh', true);
      rf.classList.remove('spin'); void rf.offsetWidth; rf.classList.add('spin');
      setTimeout(() => rf.classList.remove('spin'), 650);
      sound.play('click'); load(p, p.path, (p.items[p.cursor] || {}).n);
      return;
    }
    const b = e.target.closest('.pt-seg'); if (!b) return;
    const v = store.get('panesVis', 'both'), mine = b.dataset.p === '0' ? 'left' : 'right', other = mine === 'left' ? 'right' : 'left';
    /* tap a shown pane to hide it, a hidden one to bring it back; never both hidden */
    store.set('panesVis', v === 'both' ? other : 'both');
    sound.play('click'); applyPaneVis(true);
  });
  applyPaneVis(false);

  const bmBar = $('.uc-bookmarks');
  function renderBookmarks() {
    const cur = A().mode === 'dir' ? A().path : null, bms = SET.bookmarks || [];
    bmBar.innerHTML = bms.map((b, i) => `<button class="uc-bm${b.path === cur ? ' on' : ''}${ARR_PATH.test(b.path) ? ' arr' : ''}" data-i="${i}" title="${esc(b.path)}${SET.array === false && ARR_PATH.test(b.path) ? ' - the array is stopped' : ''}">${esc(b.label)}</button>`).join('')
      + `<button class="uc-bm-add" title="Add the active pane's folder as a shortcut">＋${bms.length ? '' : ' Add this folder as a shortcut'}</button>`;
  }
  bmBar.addEventListener('click', e => {
    const b = e.target.closest('.uc-bm');
    if (b) { const bm = (SET.bookmarks || [])[+b.dataset.i]; if (bm) load(A(), bm.path); return; }
    if (e.target.closest('.uc-bm-add')) addBookmark();
  });
  function addBookmark(path) {
    const p = A();
    if (!path && p.mode !== 'dir') return toast('Open a folder first', true);
    path = path || p.path;
    openDlg('Add shortcut', `
      <div class="field"><label>Button label</label><input type="text" class="f-label" value="${esc(base(path) || path)}"></div>
      <div class="field"><label>Folder</label><input type="text" class="f-path" value="${esc(path)}"></div>
      <div class="muted">Shortcuts sit in the bar under the top row. Reorder or remove them in ⚙ Settings.</div>`,
      [{ label: 'Cancel' }, { label: 'Add', primary: true, run: async () => {
        const next = JSON.parse(JSON.stringify(SET));
        next.bookmarks = (next.bookmarks || []).concat([{ label: $('.f-label', dlg).value.trim(), path: $('.f-path', dlg).value.trim() }]);
        await saveSettings(next); toast('Shortcut added');
      } }]);
  }

  /* ---------- settings ---------- */
  const customStyle = document.getElementById('uc-custom');
  function readRow() {
    const v = parseFloat(getComputedStyle(root).getPropertyValue('--row'));
    const r = Math.round((v >= 16 && v <= 80 ? v : 23) * fontScale());
    root.style.setProperty('--rowpx', r + 'px');
    return r;
  }
  /* ---------- text size: saved on this device only (Settings > Look & sound) ---------- */
  let fsPreview = null;   // the slider in Settings, before Save
  function fontScale() { if (fsPreview) return fsPreview; const v = +store.get('fontScale', 100); return (v >= 80 && v <= 140 ? v : 100) / 100; }
  function applyScale(pct) {
    if (pct != null) store.set('fontScale', pct);
    const f = fontScale();
    root.style.setProperty('--fs', String(f));
    root.classList.toggle('uc-big', f >= 1.1);
    ROW = readRow();
    panes.forEach(p => { p.spacer.style.height = (p.items.length * ROW) + 'px'; drawRows(p); queueStat(p); });
  }
  /* ---------- colours: built-in themes and your own ---------- */
  const PAL_KEYS = [['accent', 'Accent', 'buttons, folder names, the active pane'], ['accent-soft', 'Accent, pale', 'highlights, the selected-row tint'], ['accent-ink', 'Text on accent', 'words on accent buttons'],
    ['cursor', 'Cursor row', 'the highlighted row in the active pane'], ['cursor-off', 'Cursor row, other pane', ''], ['sel-count', 'Selection count', '"3 of 120 selected" in the other pane\'s header'],
    ['ok', 'Done', 'finished jobs, success'], ['warn', 'Warning', 'cut items, odd owners'], ['danger', 'Delete', 'delete, errors, tagged items']];
  /* backgrounds, text and lines: only themes that set them (Norton) show them in the editor */
  const PAL_EXTRA = [['ground', 'Page background', 'behind the panes and bars'], ['surface', 'Panes', 'the file lists and windows'], ['pane-active-bg', 'Active pane', 'the list you are working in'],
    ['surface-2', 'Bars', 'headers and toolbars'], ['surface-3', 'Buttons', 'buttons and deeper bars'], ['ink', 'Text', 'file names and most text'], ['ink-2', 'Text, softer', 'labels and details'],
    ['muted', 'Text, faint', 'hints and dates'], ['line', 'Lines', 'borders'], ['line-soft', 'Lines, faint', 'row and section dividers'],
    ['cursor-ink', 'Cursor row text', 'the words on the cursor bar'], ['sel-ink', 'Ticked row text', 'the words on ticked rows'],
    ['fk-bg', 'F-key buttons', 'the buttons along the bottom'], ['fk-ink', 'F-key text', 'View, Copy, Delete…'], ['fk-key', 'F-key numbers', 'F2, F5…'], ['fk-line', 'F-key outline', ''], ['fk-danger', 'F-key Delete text', 'the F8 Delete word'],
    ['arc-bg', 'Inside an archive', 'the strip under the pane header'], ['arc-line', 'Inside an archive, outline', 'the strip and the archive in the path bar'], ['input-bg', 'Text boxes', 'text boxes, drop-downs, Go to, the tab name and the path bars'], ['crumb-hover', 'Path bar hover', 'behind a folder name in the path bar'], ['crumb-hover-ink', 'Path bar hover text', 'the folder name you point at'], ['logo-ink', 'Logo', 'the "Commander" in the logo'],
    ['head-ink', 'Headings', 'section titles in Settings, Go to and Keyboard'], ['cols-bg', 'Column titles', 'the NAME / SIZE / DATE row'], ['menu-bg', 'Menu', 'the right-click menu'], ['menu-line', 'Menu outline', '']];
  const THEMES = {"uncommander": {"name": "unCommander blue", "desc": "the standard look", "light": {"accent": "#008cb4", "accent-soft": "#e0f3f8", "accent-ink": "#ffffff", "cursor": "#fbf3dc", "cursor-off": "#eceef0", "sel-count": "#008cb4", "ok": "#2f7d46", "warn": "#9a6a10", "danger": "#b5342c"}, "dark": {"accent": "#4c9aff", "accent-soft": "#13233a", "accent-ink": "#07111f", "cursor": "#3b3423", "cursor-off": "#2c3137", "sel-count": "#4c9aff", "ok": "#5fbe7d", "warn": "#e0ab48", "danger": "#f0736a"}}, "unraid": {"name": "unRAID orange", "desc": "unRAID's own orange", "light": {"accent": "#c4510a", "accent-soft": "#fdeee3", "accent-ink": "#ffffff", "cursor": "#fff4e8", "cursor-off": "#efedeb", "sel-count": "#c4510a", "ok": "#2e7a3e", "warn": "#8a6a00", "danger": "#c62828"}, "dark": {"accent": "#ff8c2f", "accent-soft": "#3a2414", "accent-ink": "#1a0c00", "cursor": "#3d2c1c", "cursor-off": "#2d2a27", "sel-count": "#ff8c2f", "ok": "#6cc27e", "warn": "#e8c35a", "danger": "#ff6b5e"}}, "graphite": {"name": "Graphite", "desc": "cool greys, quiet", "light": {"accent": "#3c4450", "accent-soft": "#e8ebef", "accent-ink": "#ffffff", "cursor": "#eef0f3", "cursor-off": "#f4f5f7", "sel-count": "#3c4450", "ok": "#3d7a52", "warn": "#8f6a1c", "danger": "#b4373a"}, "dark": {"accent": "#c5cdd6", "accent-soft": "#2c3138", "accent-ink": "#14171a", "cursor": "#363c44", "cursor-off": "#272b30", "sel-count": "#c5cdd6", "ok": "#7cc596", "warn": "#dcb35c", "danger": "#f07a74"}}, "mono": {"name": "Mono (black & white)", "desc": "pure greyscale, high contrast", "light": {"accent": "#222222", "accent-soft": "#ececec", "accent-ink": "#ffffff", "cursor": "#e4e4e4", "cursor-off": "#f2f2f2", "sel-count": "#222222", "ok": "#4a4a4a", "warn": "#6a6a6a", "danger": "#a32020"}, "dark": {"accent": "#e6e6e6", "accent-soft": "#2e2e2e", "accent-ink": "#111111", "cursor": "#3a3a3a", "cursor-off": "#262626", "sel-count": "#e6e6e6", "ok": "#bdbdbd", "warn": "#a8a8a8", "danger": "#ff7070"}}, "teal": {"name": "Teal", "desc": "calm blue-green", "light": {"accent": "#0381a5", "accent-soft": "#e0f2f7", "accent-ink": "#ffffff", "cursor": "#fbf3dc", "cursor-off": "#edf0f1", "sel-count": "#9b1c1c", "ok": "#2f7d46", "warn": "#946200", "danger": "#b5342c", "arc-bg": "#f7e6f1", "arc-line": "#c25a9c"}, "dark": {"accent": "#3cc4d8", "accent-soft": "#0f2c33", "accent-ink": "#04161a", "cursor": "#3a3424", "cursor-off": "#273034", "sel-count": "#f28b82", "ok": "#5fbe7d", "warn": "#e3b24c", "danger": "#f0736a", "arc-bg": "#3a2234", "arc-line": "#b8609a"}}, "violet": {"name": "Violet", "desc": "soft purple", "light": {"accent": "#6a45d9", "accent-soft": "#efeafd", "accent-ink": "#ffffff", "cursor": "#f7f2ff", "cursor-off": "#efedf3", "sel-count": "#6a45d9", "ok": "#2f7d46", "warn": "#9a6a10", "danger": "#b5342c"}, "dark": {"accent": "#a98bff", "accent-soft": "#251d3d", "accent-ink": "#140b2b", "cursor": "#2f2840", "cursor-off": "#29262f", "sel-count": "#a98bff", "ok": "#5fbe7d", "warn": "#e0ab48", "danger": "#f0736a"}}, "forest": {"name": "Forest", "desc": "deep green", "light": {"accent": "#1d7a55", "accent-soft": "#e4f4ec", "accent-ink": "#ffffff", "cursor": "#f6f3e4", "cursor-off": "#ecefed", "sel-count": "#1d7a55", "ok": "#1d7a55", "warn": "#8f6a10", "danger": "#b5342c"}, "dark": {"accent": "#4fc995", "accent-soft": "#12291f", "accent-ink": "#04150d", "cursor": "#33331f", "cursor-off": "#262d29", "sel-count": "#4fc995", "ok": "#4fc995", "warn": "#e0ab48", "danger": "#f0736a"}}, "norton": {"name": "Norton", "desc": "an homage", "always": "dark", "light": {"accent": "#33d1d6", "accent-soft": "#1d39aa", "accent-ink": "#04145c", "cursor": "#2cc4c9", "cursor-off": "#2240ae", "sel-count": "#ffff66", "ok": "#66e08a", "warn": "#ffff66", "danger": "#ff8080", "ground": "#08156f", "surface": "#102893", "surface-2": "#0c1f82", "surface-3": "#1a37a8", "line": "#5a6fcc", "line-soft": "#2c45ac", "ink": "#e6e9ff", "ink-2": "#c2c9f5", "muted": "#9aa6e8", "pane-active-bg": "#132c9c", "cursor-ink": "#071470", "sel-ink": "#ffff66", "fk-bg": "#2cc4c9", "fk-ink": "#06123d", "fk-key": "#123a7a", "fk-line": "#2cc4c9", "fk-danger": "#8e0f1c", "input-bg": "#000000", "crumb-hover": "#1a5f66", "logo-ink": "#ffff66", "head-ink": "#ffff66", "cols-bg": "#0d1f6f", "menu-bg": "#08124f", "menu-line": "#000000", "crumb-hover-ink": "#ffffff"}, "dark": {"accent": "#33d1d6", "accent-soft": "#1d39aa", "accent-ink": "#04145c", "cursor": "#2cc4c9", "cursor-off": "#2240ae", "sel-count": "#ffff66", "ok": "#66e08a", "warn": "#ffff66", "danger": "#ff8080", "ground": "#08156f", "surface": "#102893", "surface-2": "#0c1f82", "surface-3": "#1a37a8", "line": "#5a6fcc", "line-soft": "#2c45ac", "ink": "#e6e9ff", "ink-2": "#c2c9f5", "muted": "#9aa6e8", "pane-active-bg": "#132c9c", "cursor-ink": "#071470", "sel-ink": "#ffff66", "fk-bg": "#2cc4c9", "fk-ink": "#06123d", "fk-key": "#123a7a", "fk-line": "#2cc4c9", "fk-danger": "#8e0f1c", "input-bg": "#000000", "crumb-hover": "#1a5f66", "logo-ink": "#ffff66", "head-ink": "#ffff66", "cols-bg": "#0d1f6f", "menu-bg": "#08124f", "menu-line": "#000000", "crumb-hover-ink": "#ffffff"}}};
  function palTheme(base, mine) {
    if (base && base.startsWith('my:')) { const t = (mine || []).find(x => 'my:' + x.name === base); if (t) return t; }
    return THEMES[base] || THEMES.uncommander;
  }
  function palCss(p) {
    if (!p) return '';
    /* a saved theme is a copy taken when it was picked: colours added to that theme since then are filled in (nothing already saved changes) */
    const bt = THEMES[p.base]; if (bt) { p = { ...p }; for (const m of ['light', 'dark']) if (bt[m]) { p[m] = { ...(p[m] || {}) }; for (const [k, v] of Object.entries(bt[m])) if (!(k in p[m])) p[m][k] = v; } }
    const def = THEMES.uncommander, same = m => PAL_KEYS.every(([k]) => !p[m] || !p[m][k] || p[m][k] === def[m][k]);
    if ((p.base || 'uncommander') === 'uncommander' && same('light') && same('dark')) return '';      // the standard look: nothing to add
    return [['light', '#uc'], ['dark', '#uc.uc-dark']].map(([m, sel]) => p[m] && Object.keys(p[m]).length ? `${sel} { ${Object.entries(p[m]).map(([k, v]) => `--${k}: ${v};`).join(' ')} }`
      /* text colours for the cursor row and ticked rows, when the theme sets them (same rules as the server writes) */
      + (p[m]['cursor-ink'] ? `\n${sel} .uc-pane.active .uc-list .uc-row.cursor:not(.sel), ${sel} .uc-pane.active .uc-list .uc-row.cursor:not(.sel) * { color: ${p[m]['cursor-ink']} !important; }` : '')
      + (p[m]['sel-ink'] ? `\n${sel} .uc-list .uc-row.sel, ${sel} .uc-list .uc-row.sel * { color: ${p[m]['sel-ink']} !important; }` : '')
      + (p[m]['input-bg'] ? `\n${sel} input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), ${sel} select, ${sel} textarea, ${sel} .uc-path, ${sel} .uc-goto, ${sel} .uc-tabname { background-color: ${p[m]['input-bg']} !important; }` : '') : '').join('\n');
  }
  function applyPalette(p) {
    let el = document.getElementById('uc-palette');
    if (!el) { el = document.createElement('style'); el.id = 'uc-palette'; const c = document.getElementById('uc-custom'); c ? c.before(el) : document.head.appendChild(el); }
    el.textContent = palCss(p);
    /* a theme that is always dark (Norton) uses the dark look whatever unRAID's theme is */
    root.classList.toggle('uc-dark', (p && p.always === 'dark') || root.dataset.unraidTheme === 'dark');
  }
  function applyLook(css) {
    if (customStyle) customStyle.textContent = css;
    ROW = readRow();
    panes.forEach(p => { p.spacer.style.height = (p.items.length * ROW) + 'px'; drawRows(p); queueStat(p); });
  }
  async function saveSettings(next) {
    const r = await api('save_settings', { settings: next });
    const treeWas = !!SET.tree;
    SET = r.settings; applyPalette(SET.palette); applyLook(SET.css); applyToolBtns(); renderBookmarks(); applyPractice(); applySys(false); watchArm(); playerSetting(); plFilesAt = 0;
    if (watchOn()) panes.forEach(p => { if (p.mode === 'dir' && !p.sig) refresh(p); });   // fetch a starting fingerprint
    if (treeWas !== !!SET.tree) panes.forEach(p => { if (p.mode === 'dir') { if (!SET.tree) { p.tree = new Map(); saveTree(p); } applySort(p); } });
    drawClip();
  }

  const CSS_EXAMPLES = [
    ['Bigger rows for touch', '#uc { --row: 34px; }\n#uc .uc-row { font-size: 15px; }'],
    ['Green accent', '#uc { --accent: #1f8a4c; --accent-soft: #e6f4ec; }\n#uc.uc-dark { --accent: #4cc27f; --accent-soft: #15301f; }'],
    ['Bigger function-key buttons', '#uc .uc-fk { padding: 16px 6px; font-size: 14px; }'],
    ['Shortcut buttons as pills', '#uc .uc-bm { border-radius: 20px; }'],
    ['Square corners', '#uc { --r: 0px; }'],
    ['Larger file names', '#uc .col-name { font-size: 14.5px; }'],
  ];
  const CSS_REF = [
    ['Colours (set on #uc, and on #uc.uc-dark for the dark theme)', [
      ['--accent', 'buttons, folder names, active pane'], ['--accent-soft', 'selected rows, highlights'], ['--accent-ink', 'text on accent buttons'],
      ['--surface / --surface-2 / --surface-3', 'backgrounds, lightest to darkest'], ['--ink / --ink-2 / --muted', 'text, strongest to faintest'],
      ['--line / --line-soft', 'borders'], ['--ok / --warn / --danger', 'done, odd owner, delete'],
      ['--cursor', 'the cursor row in the active pane (cream)'], ['--cursor-off', 'the cursor row in the other pane'], ['--sel-count', '"3 of 120 selected" in the pane header'], ['--recent', 'names changed lately (Settings > General)'], ['--fk-bg / --fk-ink / --fk-key', 'the F-key buttons at the bottom: background, words, F-numbers (unset: like other buttons)'], ['--fk-line / --fk-danger', 'F-key outline, and the Delete word'], ['--crumb-hover / --crumb-hover-ink', 'path-bar hover: background and text'], ['--logo-ink / --head-ink', 'the logo, section headings'], ['--cols-bg / --menu-bg / --menu-line', 'column titles row, right-click menu and its outline'] ]],
    ['Sizes and fonts', [ ['--row', 'file row height (20–80px)'], ['--r', 'corner radius'], ['--sans / --mono', 'font stacks'] ]],
    ['Layout', [
      ['#uc', 'the whole app'], ['.uc-appbar', 'top bar'], ['.uc-bookmarks, .uc-bm, .uc-bm.on, .uc-bm-add', 'shortcut bar and buttons'],
      ['.uc-crumbs, .uc-path, .uc-path.active', 'path bars'], ['.tr-seg, .tr-seg.here, .tr-seg.ahead', 'breadcrumb names (current, greyed)'], ['.uc-jump', 'Jump to name box'], ['.uc-pane, .uc-pane.active', 'left/right panes'],
      ['.uc-pane-head, .uc-cols, .uc-pane-foot', 'pane header, column titles, footer'],
      ['.uc-row, .uc-row.cursor, .uc-row.sel', 'file rows, cursor row, ticked rows'],
      ['.col-sel, .col-name, .col-size, .col-date, .col-mode', 'columns'], ['.nm.dir, .nm.link', 'folder and symlink names'],
      ['.uc-selbar', 'Select / Sort bar'], ['.uc-fkeys, .uc-fk, .uc-fk[data-act="copy"]', 'function-key buttons (by action)'], ['.uc-fk-toggle, .uc-fk[data-more]', 'More toggle and More buttons'], ['.uc-alerts, .uc-alert', 'finished-job alert rows'], ['.uc-arcbar, .uc-arcclose, --arc-bg, --arc-line, --arc-bar-ink', 'inside an archive: the strip under the pane header and the archive in the path bar'], ['--fk-clear', 'space kept free at the right of the button row (default 56px)'],
      ['.uc-jobchip, .uc-job, .bar', 'jobs button in the top bar, jobs and progress bars'], ['.uc-dlg, .dlg-head, .dlg-body, .dlg-foot', 'dialogs'],
      ['.vw, .vw-l.hit, textarea.ed', 'viewer, highlighted line, editor'], ['.uc-toast', 'pop-up messages'] ]],
    ['Colour highlighting', [
      ['--hl-k / --hl-s / --hl-n / --hl-c', 'keywords, strings, numbers, comments'], ['--hl-p / --hl-v / --hl-h', 'keys and properties, variables, section headings'],
      ['--hl-t / --hl-a', 'XML/HTML tags and attributes'], ['--hl-e / --hl-w', 'errors and warnings in logs'] ]],
  ];

  /* ---------- colour picker (Settings > Look & sound) ----------
   * Saturation/brightness square, hue and transparency bars, HEX/RGB/HSL
   * fields, a palette, the theme's own colours and recent picks. */
  const colourRecent = v => { const r = store.get('colourRecent', []).filter(x => x !== v); r.unshift(v); store.set('colourRecent', r.slice(0, 14)); };
  const CP = {
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    hsv2rgb(h, s, v) { const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)].map(x => Math.round(x * 255)); },
    rgb2hsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx]; },
    rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
      const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0; const [h] = CP.rgb2hsv(r * 255, g * 255, b * 255); return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]; },
    hsl2rgb(h, s, l) { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0), f(8), f(4)].map(x => Math.round(x * 255)); },
    hex2: n => n.toString(16).padStart(2, '0'),
    /* any CSS colour the user types: #rgb #rgba #rrggbb #rrggbbaa rgb()/rgba() hsl()/hsla() or a name */
    parse(str) {
      str = String(str || '').trim(); let m;
      if ((m = str.match(/^#?([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i))) {
        let h = m[1]; if (h.length <= 4) h = h.split('').map(c => c + c).join('');
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
      }
      if ((m = str.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i)))
        return [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]].map((v, i) => i < 3 ? CP.clamp(Math.round(v), 0, 255) : CP.clamp(v, 0, 1));
      if ((m = str.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/i)))
        return [...CP.hsl2rgb(+m[1] % 360, CP.clamp(+m[2], 0, 100), CP.clamp(+m[3], 0, 100)), m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : CP.clamp(+m[4], 0, 1)];
      if (/^[a-z]+$/i.test(str)) {     // a colour name: let the browser translate it
        const c = document.createElement('canvas').getContext('2d'); c.fillStyle = '#010203'; c.fillStyle = str;
        if (c.fillStyle !== '#010203' || str.toLowerCase() === '#010203') return CP.parse(c.fillStyle);
      }
      return null;
    },
  };
  function openColourPicker(anchor, start, o) {
    const old = $('.cp-pop', dlg); if (old) { old.remove(); return; }
    const rgba0 = CP.parse(start) || [31, 111, 235, 1];
    let [h, sat, val] = CP.rgb2hsv(...rgba0), a = rgba0[3], fmt = store.get('colourFmt', 'hex');
    const theme = getComputedStyle(root), tv = n => theme.getPropertyValue(n).trim();
    const THEME = [['--accent', 'accent'], ['--accent-soft', 'accent (soft)'], ['--surface', 'background'], ['--surface-2', 'background 2'], ['--surface-3', 'background 3'],
                   ['--ink', 'text'], ['--ink-2', 'text 2'], ['--muted', 'faint text'], ['--line', 'borders'], ['--danger', 'delete red'], ['--hl-k', 'keywords'], ['--hl-s', 'strings']]
      .map(([n, l]) => [tv(n), `${l} (${n})`]).filter(([v]) => v);
    const HUES = [0, 15, 30, 45, 60, 90, 120, 150, 180, 200, 220, 245, 270, 290, 315, 340];
    const LIGHT = [92, 82, 70, 58, 46, 36, 26];
    const pal = LIGHT.map(l => HUES.map(hh => { const [r, g, b] = CP.hsl2rgb(hh, l > 85 ? 80 : 70, l); return '#' + [r, g, b].map(CP.hex2).join(''); }));
    const grays = Array.from({ length: HUES.length }, (_, i) => { const v = Math.round(255 - i * 255 / (HUES.length - 1)); return '#' + CP.hex2(v).repeat(3); });
    const sw = (c, t) => `<button class="cp-sw" data-c="${esc(c)}" title="${esc(t || c)}" style="--c:${esc(c)}"></button>`;
    const pop = document.createElement('div');
    pop.className = 'cp-pop';
    pop.innerHTML = `
      <div class="cp-top">
        <div class="cp-sv"><div class="cp-svk"></div></div>
        <div class="cp-hue"><div class="cp-k"></div></div>
        <div class="cp-alpha"><div class="cp-agrad"></div><div class="cp-k"></div></div>
        <div class="cp-side">
          <div class="cp-prev" title="Top: new · bottom: what you started with"><div class="cp-new"></div><div class="cp-old" style="--c:${esc(start)}"></div></div>
          <label class="cp-f"><span>HEX</span><input class="cp-hex" spellcheck="false" autocapitalize="off"></label>
          <div class="cp-trio"><label class="cp-f"><span>R</span><input class="cp-n" data-k="r" inputmode="numeric"></label><label class="cp-f"><span>G</span><input class="cp-n" data-k="g" inputmode="numeric"></label><label class="cp-f"><span>B</span><input class="cp-n" data-k="b" inputmode="numeric"></label></div>
          <div class="cp-trio"><label class="cp-f"><span>H</span><input class="cp-n" data-k="h" inputmode="numeric"></label><label class="cp-f"><span>S</span><input class="cp-n" data-k="s" inputmode="numeric"></label><label class="cp-f"><span>L</span><input class="cp-n" data-k="l" inputmode="numeric"></label></div>
          <label class="cp-f"><span>Opacity %</span><input class="cp-n" data-k="a" inputmode="numeric"></label>
        </div>
      </div>
      <div class="cp-lbl">Palette</div>
      <div class="cp-grid" style="--n:${HUES.length}">${grays.map(c => sw(c)).join('')}${pal.flat().map(c => sw(c)).join('')}</div>
      <div class="cp-lbl">unCommander's colours</div>
      <div class="cp-row">${THEME.map(([c, t]) => sw(c, t)).join('')}</div>
      <div class="cp-lbl cp-reclbl">Recent</div>
      <div class="cp-row cp-rec"></div>
      <div class="cp-foot">
        <div class="cp-fmt" role="group">${['hex', 'rgb', 'hsl'].map(k => `<button data-f="${k}">${k.toUpperCase()}</button>`).join('')}</div>
        <code class="cp-out"></code>
        ${window.EyeDropper ? '<button class="uc-btn cp-eye" title="Pick a colour from anywhere on the screen">Eyedropper</button>' : ''}
        <button class="uc-btn cp-copy">Copy</button>
        <button class="uc-btn primary cp-ins">Insert</button>
      </div>`;
    (anchor.closest('.st-row') || anchor.parentNode).after(pop);
    pop.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const q = c => $(c, pop);
    const rgb = () => CP.hsv2rgb(h, sat, val);
    const out = () => {
      const [r, g, b] = rgb();
      if (fmt === 'rgb') return a < 1 ? `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})` : `rgb(${r}, ${g}, ${b})`;
      if (fmt === 'hsl') { const [hh, ss, ll] = CP.rgb2hsl(r, g, b); return a < 1 ? `hsla(${hh}, ${ss}%, ${ll}%, ${+a.toFixed(2)})` : `hsl(${hh}, ${ss}%, ${ll}%)`; }
      return '#' + [r, g, b].map(CP.hex2).join('') + (a < 1 ? CP.hex2(Math.round(a * 255)) : '');
    };
    function paint(skip) {
      const [r, g, b] = rgb(), [hh, ss, ll] = CP.rgb2hsl(r, g, b), solid = `rgb(${r},${g},${b})`;
      q('.cp-sv').style.setProperty('--h', h);
      q('.cp-svk').style.cssText = `left:${sat * 100}%;top:${(1 - val) * 100}%;background:${solid}`;
      q('.cp-hue .cp-k').style.top = `${h / 360 * 100}%`;
      q('.cp-agrad').style.background = `linear-gradient(${solid}, transparent)`;
      q('.cp-alpha .cp-k').style.top = `${(1 - a) * 100}%`;
      q('.cp-new').style.setProperty('--c', `rgba(${r},${g},${b},${a})`);
      if (skip !== 'hex') q('.cp-hex').value = '#' + [r, g, b].map(CP.hex2).join('') + (a < 1 ? CP.hex2(Math.round(a * 255)) : '');
      const vals = { r, g, b, h: hh, s: ss, l: ll, a: Math.round(a * 100) };
      $$('.cp-n', pop).forEach(i => { if (i.dataset.k !== skip) i.value = vals[i.dataset.k]; });
      $$('.cp-fmt button', pop).forEach(bt => bt.classList.toggle('on', bt.dataset.f === fmt));
      q('.cp-out').textContent = out();
      o.onChange && o.onChange(out());
    }
    function setRGBA(r, g, b, al) { [h, sat, val] = CP.rgb2hsv(r, g, b); if (al != null) a = al; }
    /* dragging: works with mouse, finger or pencil */
    const drag = (el, fn) => el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const move = ev => { const rc = el.getBoundingClientRect(); fn(CP.clamp((ev.clientX - rc.left) / rc.width, 0, 1), CP.clamp((ev.clientY - rc.top) / rc.height, 0, 1)); paint(); };
      move(e);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    drag(q('.cp-sv'), (x, y) => { sat = x; val = 1 - y; });
    drag(q('.cp-hue'), (x, y) => { h = Math.min(359.9, y * 360); });
    drag(q('.cp-alpha'), (x, y) => { a = Math.round((1 - y) * 100) / 100; });
    q('.cp-hex').addEventListener('input', e => { const c = CP.parse(e.target.value); if (c) { setRGBA(c[0], c[1], c[2], c[3]); paint('hex'); } });
    $$('.cp-n', pop).forEach(i => i.addEventListener('input', () => {
      const v = Object.fromEntries($$('.cp-n', pop).map(x => [x.dataset.k, parseFloat(x.value)]));
      if (Object.values(v).some(n => isNaN(n))) return;
      const k = i.dataset.k;
      if ('rgb'.includes(k)) setRGBA(CP.clamp(v.r, 0, 255), CP.clamp(v.g, 0, 255), CP.clamp(v.b, 0, 255));
      else if ('hsl'.includes(k)) setRGBA(...CP.hsl2rgb(((v.h % 360) + 360) % 360, CP.clamp(v.s, 0, 100), CP.clamp(v.l, 0, 100)));
      else a = CP.clamp(v.a, 0, 100) / 100;
      paint(k);
    }));
    pop.addEventListener('click', e => {
      const s2 = e.target.closest('.cp-sw');
      if (s2) { const c = CP.parse(s2.dataset.c); if (c) { setRGBA(...c); paint(); } return; }
      const f2 = e.target.closest('.cp-fmt button');
      if (f2) { fmt = f2.dataset.f; store.set('colourFmt', fmt); paint(); }
    });
    q('.cp-old').addEventListener('click', () => { const c = CP.parse(start); if (c) { setRGBA(...c); paint(); } });
    q('.cp-copy').addEventListener('click', () => { copyText(out()); colourRecent(out()); drawRecent(); toast(`Copied ${out()}`); });
    q('.cp-ins').addEventListener('click', () => { o.onInsert(out()); store.set('colourLast', out()); drawRecent(); });
    const eye = q('.cp-eye');
    if (eye) eye.addEventListener('click', async () => { try { const r = await new window.EyeDropper().open(); const c = CP.parse(r.sRGBHex); if (c) { setRGBA(...c); paint(); } } catch (e) {} });
    function drawRecent() {
      const rec = store.get('colourRecent', []);
      q('.cp-rec').innerHTML = rec.map(c => sw(c)).join(''); q('.cp-rec').hidden = q('.cp-reclbl').hidden = !rec.length;
    }
    drawRecent(); paint();
    /* close when tapping outside it */
    const away = e => { if (!pop.isConnected) return document.removeEventListener('pointerdown', away, true);
      if (!pop.contains(e.target) && !anchor.contains(e.target)) { store.set('colourLast', out()); pop.remove(); document.removeEventListener('pointerdown', away, true); } };
    setTimeout(() => document.addEventListener('pointerdown', away, true));
  }

  /* ---------- Radarr settings (Settings > Tools) ---------- */
  /* Radarr and Sonarr share these: d is the app's settings box (data-app="radarr"/"sonarr") */
  const ARR_NAME = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' }, ARR_PORT = { radarr: 7878, sonarr: 8989, lidarr: 8686 };
  function rdMapRow(rp, hp, detected, app = 'radarr') {
    return `<div class="rd-pair"><span class="mono rd-rp">${esc(rp)}</span><span class="rd-arrow">⇄</span>
      <input type="text" class="rd-hp" data-rp="${esc(rp)}" value="${esc(hp || '')}" placeholder="/mnt/user/…" spellcheck="false" autocapitalize="off">
      ${detected ? `<span class="rd-det" title="Read from ${ARR_NAME[app]}'s Docker settings">from Docker</span>` : ''}</div>`;
  }
  function rdRead(d) {
    const app = d.dataset.app || 'radarr';
    const v = c => ($(c, d) || {}).value || '';
    const prof = $('.rd-prof', d), meta = $('.rd-meta', d);
    return { host: v('.rd-host').trim(), port: +v('.rd-port') || ARR_PORT[app], base: v('.rd-base').trim(), key: v('.rd-key').trim(),
      profile: prof && prof.value ? +prof.value : 0, profile_name: prof && prof.selectedOptions[0] ? prof.selectedOptions[0].textContent : '',
      meta: meta && meta.value ? +meta.value : 0, meta_name: meta && meta.selectedOptions[0] ? meta.selectedOptions[0].textContent : '',
      availability: v('.rd-avail') || 'released', search: !!($('.rd-search', d) || {}).checked,
      map: $$('.rd-hp', d).map(i => ({ [app]: i.dataset.rp, host: i.value.trim() })).filter(m => m.host) };
  }
  function rdWire(d, w) {
    const app = d.dataset.app || 'radarr', cfg = w[app] || {};
    const state = $('.rd-state', d), res = $('.rd-res', d);
    state.textContent = cfg.ok ? `· set up${cfg.profile_name ? ` (${cfg.profile_name})` : ''}` : cfg.host ? '· not finished' : '· not set up';
    $('.rd-test', d).addEventListener('click', async () => {
      res.className = 'rd-res muted'; res.innerHTML = '<span class="spin"></span> Connecting…';
      try {
        const r = await api(app + '_test', { [app]: rdRead(d) });
        res.className = 'rd-res ok'; res.textContent = `✓ Connected to ${r.name} ${r.version}`;
        const sel = $('.rd-prof', d), keep = +sel.value || cfg.profile;
        sel.innerHTML = r.profiles.map(p => `<option value="${p.id}"${p.id === keep ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
        const ms = $('.rd-meta', d); if (ms && r.metas) { const k2 = +ms.value || cfg.meta; ms.innerHTML = r.metas.map(p => `<option value="${p.id}"${p.id === k2 ? ' selected' : ''}>${esc(p.name)}</option>`).join(''); }
        $('.rd-map', d).innerHTML = r.roots.map(x => rdMapRow(x[app], x.host, x.detected && x.host === x.detected, app)).join('')
          || `<div class="muted">${ARR_NAME[app]} has no root folders yet - add one in ${ARR_NAME[app]} > Settings > Media Management.</div>`;
        $('.rd-more', d).hidden = false;
        if (r.roots.some(x => !x.host)) res.textContent += ` - fill in the server folder for each ${ARR_NAME[app]} folder below`;
      } catch (e) { res.className = 'rd-res err'; res.textContent = '✕ ' + e.message; }
    });
  }

  function openSettings(tab = 'gen', only = false) {
    const w = JSON.parse(JSON.stringify(SET));
    const SN = w.sonarr || (w.sonarr = {});
    const LD = w.lidarr || (w.lidarr = {});
    let savedOk = false;
    const tabs = [['gen', 'General'], ['bm', 'Shortcuts'], ['look', 'Look & sound'], ['safe', 'Safety & trash'], ['tools', 'Tools'], ['keys', 'Keyboard']];
    const sc = (k, label) => `<label class="chk"><input type="checkbox" data-s="${k}" ${w.sounds[k] ? 'checked' : ''}> ${label}</label>`;
    openDlg(only ? 'Tools' : root.dataset.version ? `Settings · version ${root.dataset.version}` : 'Settings', `
      <div class="st-tabs"${only ? ' hidden' : ''}>${tabs.map(([k, l]) => `<button class="st-tab" data-tab="${k}">${l}</button>`).join('')}</div>

      <div class="st-panel" data-panel="gen">
        <div class="st-solo">
          ${root.classList.contains('uc-solo') ? `<a class="uc-btn st-solo-b" href="/UnCommander" target="_blank" rel="noopener">Open unCommander inside unRAID</a><span class="muted">You're in unCommander's own tab. On an iPad, Share &gt; Add to Home Screen makes it an app icon.</span>`
            : `<a class="uc-btn primary st-solo-b" href="/plugins/uncommander/uncommander.php" target="_blank" rel="noopener">Open unCommander in its own tab</a><span class="muted">The whole browser window, with its own icon - on an iPad, Share &gt; Add to Home Screen makes it an app.</span>`}
        </div>
        <label class="st-radio"><input type="checkbox" class="st-menushow" ${w.menu_show !== false ? 'checked' : ''}><span><b>Show unCommander in unRAID's top menu bar</b><br>
          <span class="muted">Off: no entry in the menu bar - open it from its icon in unRAID's Settings &gt; User Utilities, or in its own tab. Reload the page after saving to see the change.</span></span></label>
        <div class="field"><label>Name in the unRAID menu bar</label>
          <input type="text" class="st-menu" maxlength="30" value="${esc(w.menu_name || 'unCommander')}" placeholder="unCommander"></div>
        <div class="muted">The label of unCommander's entry in the unRAID top menu. Reload the page after saving to see it there. Leave it empty to go back to "unCommander".</div>
        <label class="st-radio"><input type="checkbox" class="st-fkshow" ${store.get('fkHidden', false) ? '' : 'checked'}><span><b>Show the button bar</b> (F-keys and More)<br>
          <span class="muted">This device. Off: more room for the panes - the F-keys still work from the keyboard, and the <b>Buttons</b> box in the Select row brings the bar back.</span></span></label>
        <div class="st-row st-recent"><b>Mark what changed lately</b> <select class="st-recent-m">${[[0, 'Off'], [5, 'in the last 5 minutes'], [15, 'in the last 15 minutes'], [60, 'in the last hour'], [1440, 'in the last day']].map(([v, l]) => `<option value="${v}" ${recentMins() === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="muted">This device. Files and folders changed in that time get their name in another colour (<span class="mono">--recent</span> in Look &amp; sound's CSS). Folders count when something inside them was added, removed or renamed.</span></div>
        <label class="st-radio"><input type="checkbox" class="st-tabrow" ${store.get('tabrowAll', false) ? 'checked' : ''}><span><b>Tab row in every unCommander tab and window</b><br>
          <span class="muted">This device. Not only in Application windows: in an ordinary browser tab too, <b>New tab</b> then adds a tab to the row instead of opening a browser tab. The page reloads to switch it.</span></span></label>
      </div>

      <div class="st-panel" data-panel="tree">
        <label class="st-radio"><input type="checkbox" class="st-tree" ${w.tree ? 'checked' : ''}><span><b>Folder tree</b><br>
          <span class="muted">A small ▸ before each folder name opens it right there in the list, like the Mac Finder - so you can tick files from several folders at once. Click the name to go into the folder as usual. With the keyboard: → opens, ← closes. A ticked folder is copied with everything in it; files ticked inside open folders are pasted side by side.</span></span></label>
      </div>

      <div class="st-panel" data-panel="video">
        <div class="st-ff">
          <label class="st-radio st-vmain"><input type="checkbox" class="st-vplay" ${w.vplay !== false ? 'checked' : ''}><span><b>Play any video</b> <span class="st-ff-state"></span><br>
            <span class="muted">Many MKV films have sound browsers can't play (AC3, DTS, TrueHD), so they play silently, and Safari can't play MKV at all. With this on, unCommander converts the sound while the video plays - the picture is passed through as it is, so it's light on the server. It also adds subtitles and a choice of sound tracks. Off: videos play only if the browser can play them as they are.</span></span></label>
          <div class="st-ffdl">
            <div class="muted">It needs ffmpeg: Jellyfin's build of it, one program (about 58 MB) from GitHub, checked, and kept in unCommander's folder (not on the flash drive). It's fetched by itself the first time a video needs it - or get it now. It uses about 105 MB of RAM once a video has played.</div>
            <div class="st-row"><button type="button" class="uc-btn primary st-ff-get">Download ffmpeg now</button></div>
          </div>
          <div class="st-ff-more" hidden>
            <label class="st-radio"><input type="checkbox" class="st-vsmooth" ${w.vsmooth !== false ? 'checked' : ''}><span><b>Smooth playback</b><br><span class="muted">Every video plays through ffmpeg, which reads ahead in big steady pieces - much smoother for films on array disks. Off: videos the browser can play are sent as they are.</span></span></label>
            <div class="st-sub"><b>Convert the picture when the browser can't show it</b> <span class="muted">(H.265 in Firefox and most Chrome, MPEG-2, VC-1…)</span></div>
            <div class="st-vconv"></div>
            <div class="muted">The picture becomes H.264 (4K is made 1080p). Graphics do it with almost no load; the CPU uses several cores for one film. HDR videos look paler when converted.</div>
            <div class="st-row st-ffrm"><button type="button" class="uc-btn st-ff-rm">Remove ffmpeg</button><span class="muted">frees 58 MB in unCommander's folder; it's fetched again when a video needs it</span></div>
          </div>
        </div>
      </div>

      <div class="st-panel" data-panel="music">
        <label class="st-radio"><input type="checkbox" class="st-player" ${w.player !== false ? 'checked' : ''}><span><b>Music player</b><br>
          <span class="muted">A player at the bottom of unCommander that plays one playlist: right-click songs, albums or artists and pick <b>Play</b> or <b>Add to playlist</b>, or open a playlist file. The ♪ button at the top shows and hides it. Off: no player and no playlist editor - songs still preview with F2 or a double-click.</span></span></label>
        <div class="field"><label>Playlist folders</label>
          <textarea class="st-pldirs" rows="3" spellcheck="false" placeholder="/mnt/user/Media/Music/Playlists">${esc((w.pldirs || []).join('\n'))}</textarea></div>
        <div class="muted">One folder per line. The playlists in them are listed in the player and in the editor's Open… list, and Save as starts in the first one.</div>
      </div>

      <div class="st-panel" data-panel="watch">
        <div class="st-ar-box">
          <label class="chk st-big"><input type="checkbox" class="st-ar" ${w.autorefresh && w.autorefresh.on ? 'checked' : ''}> Automatically show directory changes</label>
          <label class="st-ar-every">Check every <select class="st-ar-secs">${[5, 10, 30, 60].map(n => `<option value="${n}" ${((w.autorefresh && w.autorefresh.secs) || 10) === n ? 'selected' : ''}>${n} s</option>`).join('')}</select></label>
          <div class="muted st-ar-note">Light on the server: it only checks each open folder's last-changed time.</div>
        </div>
      </div>

      <div class="st-panel" data-panel="keys">
        <div class="muted kb-intro">These work when unCommander has the focus - click or tap inside it once. Keys held with <kbd>Ctrl</kbd> or <kbd>Alt</kbd> (other than the ones below) are left to the browser.</div>
        <label class="chk st-ctxrow"><input type="checkbox" class="st-ctxmenu" ${store.get('ctxOff', false) ? '' : 'checked'}> <span><b>Right-click opens unCommander's menu</b> <span class="muted">(this device) - switch it off to get the browser's own menu, for Inspect and the like. <kbd>Shift</kbd> + right-click always gives the browser's menu.</span></span></label>
        <label class="chk st-ctxrow"><input type="checkbox" class="st-rtick" ${store.get('rtick', false) ? 'checked' : ''}> <span><b>Right-click ticks</b> <span class="muted">(this device, mouse) - a right-click ticks or unticks the row; drag with the right button held to tick a run of rows; hold it still for half a second to get the menu. Needs the option above on.</span></span></label>
        <div class="st-kgrp"><div class="st-kh">Typing a name</div>
          <label class="st-radio"><input type="radio" name="st-type" value="jump" ${filterMode() ? '' : 'checked'}><span><b>Jumps to it</b> <span class="muted">- the cursor goes to the first name that matches</span></span></label>
          <label class="st-radio"><input type="radio" name="st-type" value="filter" ${filterMode() ? 'checked' : ''}><span><b>Filters the list</b> <span class="muted">- only the names containing what you typed stay. <kbd>Esc</kbd> or opening another folder shows everything again; <kbd>Backspace</kbd> takes off a letter. Ticked items that get filtered out stay ticked, but actions only touch what you can see.</span></span></label>
        </div>
        <div class="st-kgrp"><div class="st-kh">Function keys <span class="muted">(this device)</span></div>
          ${Object.entries(FK_PRESETS).map(([k, [n, d]]) => `<label class="st-radio"><input type="radio" name="st-fkp" value="${k}" ${fkSaved().preset === k ? 'checked' : ''}><span><b>${esc(n)}</b> <span class="muted">- ${esc(d)}</span></span></label>`).join('')}
          <label class="st-radio"><input type="radio" name="st-fkp" value="custom" ${fkSaved().preset === 'custom' ? 'checked' : ''}><span><b>My own</b> <span class="muted">- pick what each key does below</span></span></label>
          <div class="st-fkgrid">${FK_KEYS.map(k => `<label class="st-fkk"><kbd>${k}</kbd><select data-fk="${k}"><option value="">(nothing)</option>${Object.entries(FK_ACTS).map(([a, l]) => `<option value="${a}" ${fkMap()[k] === a ? 'selected' : ''}>${esc(FK_LONG[a] || l)}</option>`).join('')}</select></label>`).join('')}</div>
        </div>
        <div class="kb-cols">
        <div class="kb-col">
        <div class="kb-group"><div class="kb-gh">Moving around</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>↑</kbd> <kbd>↓</kbd></div><div class="kb-d">Move the cursor up or down</div></div><div class="kb-row"><div class="kb-k"><kbd>PgUp</kbd> <kbd>PgDn</kbd></div><div class="kb-d">Move a page up or down</div></div><div class="kb-row"><div class="kb-k"><kbd>Home</kbd> <kbd>End</kbd></div><div class="kb-d">First or last item</div></div><div class="kb-row"><div class="kb-k"><kbd>Tab</kbd></div><div class="kb-d">Switch to the other pane</div></div><div class="kb-row"><div class="kb-k"><kbd>a</kbd>–<kbd>z</kbd>, <kbd>0</kbd>–<kbd>9</kbd></div><div class="kb-d">Type a name to jump to it</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Ticking</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Insert</kbd></div><div class="kb-d">Tick or untick, and move down (like MC)</div></div><div class="kb-row"><div class="kb-k"><kbd>Space</kbd></div><div class="kb-d">Tick or untick</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>A</kbd></div><div class="kb-d">Tick everything</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Other</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>C</kbd> / <kbd>X</kbd></div><div class="kb-d">Copy or Cut (onto the 📋 list)</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>V</kbd></div><div class="kb-d">Paste into the active pane's folder</div></div><div class="kb-row"><div class="kb-k"><kbd>Shift</kbd> <kbd>F10</kbd></div><div class="kb-d">The menu for the item under the cursor</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>Z</kbd></div><div class="kb-d">Undo the latest step - History (in the More row) has all of them</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>F5</kbd></div><div class="kb-d">Reload the browser page (plain F5 is Copy)</div></div><div class="kb-row"><div class="kb-k"><kbd>←</kbd> <kbd>→</kbd></div><div class="kb-d">Previous or next picture, in the picture viewer</div></div></div></div>
        </div>
        <div class="kb-col">
        <div class="kb-group"><div class="kb-gh">Opening</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Enter</kbd></div><div class="kb-d">Open the folder or file under the cursor</div></div><div class="kb-row"><div class="kb-k"><kbd>Backspace</kbd></div><div class="kb-d">Go up one folder</div></div><div class="kb-row"><div class="kb-k"><kbd>Esc</kbd></div><div class="kb-d">Close a window, or stop a folder that is taking long to open</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Function keys</div>
          <div class="kb-table">${FK_KEYS.filter(k => fkMap()[k]).map(k => `<div class="kb-row"><div class="kb-k"><kbd>${k}</kbd>${fkMap()[k] === 'delete' ? ' or <kbd>Delete</kbd>' : ''}</div><div class="kb-d">${esc(FK_LONG[fkMap()[k]] || FK_ACTS[fkMap()[k]])}</div></div>`).join('')}${fkKeyOf('delete') ? '' : '<div class="kb-row"><div class="kb-k"><kbd>Delete</kbd></div><div class="kb-d">Delete</div></div>'}</div></div>
        </div>
        </div>
      </div>

      <div class="st-panel" data-panel="safe">
        <label class="st-radio"><input type="checkbox" class="st-practice" ${w.practice ? 'checked' : ''}><span><b>Practice mode</b><br>
          <span class="muted">For learning unCommander without risk. Nothing can be lost or changed.</span></span></label>
        <div class="st-safe"><b>Still works</b><span>Browsing, View, Find, selecting, Copy (files already at the destination are always kept), New Folder, Edit (look only)</span>
          <b>Locked</b><span>Delete, Move, Rename, Permissions, Restore from trash, saving edits, replacing files when copying</span></div>
        <div class="muted">The server checks this too. It's a safety net for learning, not a password: anyone who can open Settings can switch it off.</div>
        <label class="st-radio st-collect-box"><input type="checkbox" class="st-collect" ${w.collect ? 'checked' : ''}><span><b>Collect from several folders</b> <span class="st-adv">advanced</span><br>
          <span class="muted">Copy and Cut add to one list instead of replacing it, so you can gather files from many folders and paste them all in one go - some copied, some moved. The list (the 📋 pill at the top) shows everything grouped by folder; untick what you don't want this time. It also adds <b>Tag for delete</b> to the right-click menu: tagged items wait on their own red list (the 🗑 half of the pill) and are only deleted when you press Delete there.</span><br>
          <span class="st-warn">It's easy to lose track of what's on a long list. The Paste window shows every item and where it comes from before anything happens, and History can undo it - but try it on a few test files first.</span></span></label>
      </div>

      <div class="st-panel" data-panel="sys">
        <label class="st-radio"><input type="checkbox" class="st-sysmode" ${w.sysmode ? 'checked' : ''}><span><b>Whole system view</b><br>
          <span class="muted">Adds a <b>Shares | Whole OS</b> switch next to the unCommander name. <b>Whole OS</b> shows the whole file system from <span class="mono">/</span>, like Midnight Commander on the console - <span class="mono">/boot</span>, <span class="mono">/etc</span>, <span class="mono">/var</span>, <span class="mono">/tmp</span>, <span class="mono">/usr</span> and the rest - with every action available.</span></span></label>
        <ul class="muted st-sysnotes">
          <li>Everything outside <span class="mono">/mnt</span> and <span class="mono">/boot</span> lives in RAM: changes there are gone after a reboot, and there's no trash - deleting there is for good.</li>
          <li>Deleting or editing system files can stop the server working until it's rebooted.</li>
          <li><span class="mono">/proc</span>, <span class="mono">/sys</span> and <span class="mono">/dev</span> are the kernel's live views - Find skips them when it starts at <span class="mono">/</span>.</li>
          <li>When this is off, the server refuses anything outside <span class="mono">/mnt</span> and <span class="mono">/boot</span>.</li>
        </ul>
      </div>

      <div class="st-panel" data-panel="bm">
        <div class="muted">Buttons in the bar under the top row. Tap one to open that folder in the active pane.</div>
        <div class="st-bms"></div>
        <div class="st-row"><button class="uc-btn st-add-cur">＋ Add the active pane's folder</button><button class="uc-btn st-add-blank">＋ Add blank</button></div>
      </div>

      <div class="st-panel" data-panel="size">
        <div class="fs-row"><button class="uc-btn fs-step" data-fs="-5" title="Smaller">−</button>
          <input type="range" class="fs-range" min="80" max="140" step="5" value="${Math.round(fontScale() * 100)}" aria-label="Text size on this device">
          <button class="uc-btn fs-step" data-fs="5" title="Bigger">+</button><span class="fs-val">${Math.round(fontScale() * 100)}%</span>
          <button class="uc-btn fs-reset" title="Back to 100%">Reset</button></div>
        <div class="muted fs-note">Makes all of unCommander's text bigger or smaller - file lists, buttons and windows - on <b>this device only</b> (each browser remembers its own). 100% is the standard size. From 110% the active pane's outline gets thicker too.</div>
      </div>

      <div class="st-panel" data-panel="colors">
        <div class="pal-top">
          <label class="pal-l">Theme <select class="pal-base"></select></label>
          <span class="pal-modes" role="group"><button type="button" data-pm="light">Light</button><button type="button" data-pm="dark">Dark</button></span>
          <span class="muted pal-now"></span>
        </div>
        <div class="pal-body">
          <div class="pal-grid"></div>
          <div class="pal-prev" aria-hidden="true">
            <div class="pp-head"><span class="pp-side">Left · active</span><span class="pp-count">3 of 12 selected</span></div>
            <div class="pp-row"><span class="pp-box"></span><span class="pp-dir">Movies</span></div>
            <div class="pp-row cur"><span class="pp-box"></span><span>poster.jpg</span></div>
            <div class="pp-row sel"><span class="pp-box on"></span><span class="nm-t copy">fanart.jpg</span><span class="clip-tag copy">⧉ copy</span></div>
            <div class="pp-row"><span class="pp-box"></span><span class="nm-t cut">trailer.mkv</span><span class="clip-tag cut">✂ cut</span></div>
            <div class="pp-row"><span class="pp-box"></span><span class="nm-t del">old.nfo</span><span class="clip-tag del">🗑 to delete</span></div>
            <div class="pp-foot"><span class="pp-btn">Paste</span><span class="pp-ok">2 finished</span><span class="pp-del">Delete</span></div>
          </div>
        </div>
        <div class="st-row pal-save"><input type="text" class="pal-name" maxlength="40" placeholder="Name for your theme"><button type="button" class="uc-btn pal-keep">Save as my theme</button><button type="button" class="uc-btn danger pal-drop" hidden>Delete this theme</button><button type="button" class="uc-btn pal-reset">Undo my changes</button></div>
        <div class="muted">Colours change live; <b>Save</b> below keeps them. Your own CSS (further down) still wins over these.</div>
      </div>

      <div class="st-panel" data-panel="look">
        <div class="muted">Your own CSS, applied on top of unCommander's. Changes preview live; Save keeps them. Start rules with <span class="mono">#uc</span> so they only affect unCommander.</div>
        <div class="st-row"><select class="st-example"><option value="">Insert an example…</option>${CSS_EXAMPLES.map(([l], i) => `<option value="${i}">${esc(l)}</option>`).join('')}</select>
          <span class="st-color"><button class="st-col" title="Open the colour picker"><i></i></button><input type="text" class="st-hex" value="#1f6feb" readonly title="The picked colour - Insert puts it in the CSS box where the cursor is">
            <button class="uc-btn st-col-ins">Insert</button></span>
          <button class="uc-btn st-css-def" title="Put the starting CSS back in the box - every part is labelled with what it changes">Starting CSS</button><button class="uc-btn st-css-clear">Clear</button></div>
        <textarea class="st-css" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="#uc { --accent: #7c3aed; }">${esc(w.css)}</textarea>
        <details class="st-ref"><summary>What can I change? — variables and class names</summary>
          ${CSS_REF.map(([h, rows]) => `<div class="st-ref-h">${esc(h)}</div><table>${rows.map(([k, d]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(d)}</td></tr>`).join('')}</table>`).join('')}
        </details>
      </div>

      <div class="st-panel" data-panel="hl">
        <label class="st-radio"><input type="checkbox" class="st-hl" ${w.highlight !== false ? 'checked' : ''}><span><b>Colour highlighting</b><br>
          <span class="muted">Colours the text in View (F2) and Edit (F3) by file type: settings and .cfg files, scripts, XML and .nfo, JSON, YAML (Docker compose), logs, PHP, CSS and more.
          The <b>Colours</b> menu at the top right of the viewer or editor changes the type, and unCommander remembers your choice for that kind of file.</span></span></label>
      </div>

      <div class="st-panel" data-panel="snd">
        <label class="chk st-big"><input type="checkbox" data-s="enabled" ${w.sounds.enabled ? 'checked' : ''}> Play sounds</label>
        <div class="field"><label>Volume <span class="st-vol-v">${w.sounds.volume}</span>%</label><input type="range" class="st-vol" min="0" max="100" step="5" value="${w.sounds.volume}"></div>
        <div class="st-snd-grid">
          ${sc('buttons', 'Button presses')}<button class="uc-btn" data-test="click">▶ Test</button>
          ${sc('nav', 'Opening folders / going back')}<button class="uc-btn" data-test="open">▶ Test</button>
          ${sc('taps', 'Picking a row (tablet tap)')}<button class="uc-btn" data-test="tap">▶ Test</button>
          ${sc('errors', 'Errors')}<button class="uc-btn" data-test="error">▶ Test</button>
        </div>
        <div class="muted">If you hear nothing on an iPad, check the volume and that Silent mode is off.</div>
      </div>

      <div class="st-panel" data-panel="touch">
        <div class="muted">How a tap or click on a row behaves.</div>
        ${[['auto', 'Automatic', 'Fingers and Apple Pencil: first tap picks the row, second tap opens it. Mouse and trackpad: clicking a folder name opens it.'],
           ['always', 'Always pick first', 'Every device: the first tap or click picks the row, the second opens it.'],
           ['never', 'Always open straight away', 'Every device: tapping or clicking a folder name opens it.']]
          .map(([v, l, d]) => `<label class="st-radio"><input type="radio" name="st-tap" value="${v}" ${(w.tap_mode || 'auto') === v ? 'checked' : ''}><span><b>${l}</b><br><span class="muted">${d}</span></span></label>`).join('')}
      </div>

      <div class="st-panel" data-panel="jobs">
        <div class="muted">Copies, moves and permission changes show a progress window. If you watch a job to the end there, that's it. If you close that window, close the tab or go to another page while it runs, unCommander tells you when it ends:</div>
        <ul class="st-list">
          <li>a row at the top of unCommander, on every device, until you dismiss it</li>
          <li>and, if switched on below, a normal unRAID notification (the bell, plus email or phone if set up in Settings &gt; Notifications)</li>
        </ul>
        <label class="st-radio"><input type="checkbox" class="st-notify" ${w.notify_unraid !== false ? 'checked' : ''}><span><b>Also send an unRAID notification</b><br><span class="muted">For jobs that finished while you weren't watching.</span></span></label>
      </div>

      <div class="st-panel" data-panel="about">
        <img class="st-logo" src="/plugins/uncommander/images/logo.png" alt="unCommander - two-pane file manager for unRAID">
        <div class="st-about">unCommander${root.dataset.version ? ` <span class="mono">${esc(root.dataset.version)}</span>` : ''} - source code, the full user guide, and a place to report bugs or ask for features:
          <a href="https://github.com/hernandito/unCommander" target="_blank" rel="noopener">github.com/hernandito/unCommander ↗</a></div>
        <a class="st-bmc" href="https://www.buymeacoffee.com/hernandito" target="_blank" rel="noopener" title="Like unCommander? Buy the author a coffee">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="cup" d="M4.5 8.5h12.2l-1.3 10.2a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8z"/><path class="rim" d="M3.6 6.3h14v2.2h-14z"/><path class="steam" d="M8.6 4.6c0-1 .9-1.1.9-2.1M11.6 4.6c0-1 .9-1.1.9-2.1"/><path class="handle" d="M16.6 10.3h1.6a2.2 2.2 0 0 1 0 4.4h-2.1"/></svg>
          Buy me a coffee</a>
      </div>

      <div class="st-panel" data-panel="tools">
        <div class="muted">Bigger jobs that look across your disks. Each one opens in its own window; nothing changes until you choose to.</div>
        <label class="chk tl-iconopt"><input type="checkbox" class="st-toolbtn" data-tb="tools" ${w.toolbtns && w.toolbtns.tools === false ? '' : 'checked'}> Display a Tools icon in UI <span class="muted">- a button next to Settings that opens this list</span></label>
        <div class="tl-card"><div class="tl-txt"><b>Empty folders on disks</b>
          <span class="muted">Finds folders with nothing at all inside (not even hidden files) on each disk and pool - usually leftovers where the same folder lives on another disk. Delete the ones you pick; Undo puts them back.</span></div>
          <button class="uc-btn primary" data-tool="empty">Open</button></div>
        <div class="tl-card"><div class="tl-txt"><b>Duplicates</b>
          <span class="muted">The same file on more than one disk (the share shows one; the others hide and take space), or identical files under other names and in other folders. Tick the extra copies; they go to the trash, and Undo brings them back.</span></div>
          <button class="uc-btn primary" data-tool="dupes">Open</button></div>
        <div class="tl-card"><div class="tl-txt"><b>What's using space</b>
          <span class="muted">A map and a list of what takes the space in a folder, a share or a whole disk - biggest first, click to go inside. Starts at the active pane's folder; also on the right-click menu of any folder.</span></div>
          <button class="uc-btn primary" data-tool="space">Open</button></div>
        <div class="tl-card tl-stack"><div class="tl-txt"><b>Music</b></div>
          <div class="tl-sub"><div class="tl-txt"><b>Music library check</b><span class="muted">Goes through your music folder and lists albums with no cover picture, the same album twice, album folders with no songs, names that aren't UTF-8, and albums with track numbers missing - with a fix for each.</span></div>
            <button class="uc-btn primary" data-tool="music">Open</button></div>
          <div class="tl-sub"><div class="tl-txt"><b>Playlist check</b><span class="muted">Opens one playlist file and checks every song in it: how its paths are written and where that is on this server, which songs are missing and why. Take the missing ones out, change how the paths start, or delete the playlist. Also on the right-click menu of any .m3u file.</span></div>
            <button class="uc-btn primary" data-tool="plcheck">Open</button></div>
        <details class="rd-box rd-acc" data-app="lidarr"${LD.ok ? '' : ' open'}>
          <summary class="rd-h"><b>Lidarr</b> <span class="rd-state muted"></span><span class="rd-chev" aria-hidden="true"></span></summary>
          <div class="muted rd-intro">So the music check can ask Lidarr for an album (Missing tracks, No songs). An artist Lidarr doesn't have is added with its existing folder and nothing wanted; then only the album you asked for is monitored and searched. It runs on the server, so closing the page doesn't stop it.</div>
          <div class="rd-grid">
            <label class="cp-f"><span>Address</span><input type="text" class="rd-host" placeholder="192.168.1.10" value="${esc(LD.host || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f"><span>Port</span><input type="text" class="rd-port" inputmode="numeric" value="${esc(LD.port || 8686)}"></label>
            <label class="cp-f"><span>URL base <i>(optional)</i></span><input type="text" class="rd-base" placeholder="/lidarr" value="${esc(LD.base || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f rd-keyf"><span>API key <i>(Lidarr > Settings > General)</i></span><input type="password" class="rd-key" placeholder="${LD.has_key ? 'saved - leave empty to keep it' : 'paste the API key'}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
          </div>
          <div class="rd-row"><button class="uc-btn rd-test">Test connection</button><span class="rd-res muted"></span></div>
          <div class="rd-more"${LD.ok || LD.profile ? '' : ' hidden'}>
            <div class="rd-grid"><label class="cp-f"><span>Quality profile</span><select class="rd-prof">${LD.profile ? `<option value="${LD.profile}">${esc(LD.profile_name || 'Profile ' + LD.profile)}</option>` : ''}</select></label>
              <label class="cp-f"><span>Metadata profile <i>(which releases Lidarr lists)</i></span><select class="rd-meta">${LD.meta ? `<option value="${LD.meta}">${esc(LD.meta_name || 'Profile ' + LD.meta)}</option>` : ''}</select></label></div>
            <div class="rd-maph">Folder pairs <span class="muted">- the folder Lidarr sees, and the same folder on this server</span></div>
            <div class="rd-map">${(LD.map || []).map(m => rdMapRow(m.lidarr, m.host, null, 'lidarr')).join('')}</div>
          </div>
          <div class="muted rd-foot">Saved with the <b>Save</b> button below. The API key stays on the server.</div>
        </details></div>
        <div class="tl-card tl-stack"><div class="tl-top"><div class="tl-txt"><b>Movie folders without a video</b>
          <span class="muted">Checks each folder in your movies share and lists the ones with no video file - only an .nfo, posters, a sample, or nothing. See the movie's details, export the list (CSV or text), or delete folders to the trash.</span></div>
          <button class="uc-btn primary" data-tool="movies">Open</button></div>
        <label class="chk tl-iconopt"><input type="checkbox" class="st-toolbtn" data-tb="movies" ${w.toolbtns && w.toolbtns.movies === false ? '' : 'checked'}> Display icon in UI <span class="muted">- a button next to Settings that opens this tool</span></label>
        <details class="rd-box rd-acc" data-app="radarr"${w.radarr.ok ? '' : ' open'}>
          <summary class="rd-h"><b>Radarr</b> <span class="rd-state muted"></span><span class="rd-chev" aria-hidden="true"></span></summary>
          <div class="muted rd-intro">So the movie tool can send folders that lost their video back to Radarr, to download again into the same folder.</div>
          <div class="rd-grid">
            <label class="cp-f"><span>Address</span><input type="text" class="rd-host" placeholder="192.168.1.10" value="${esc(w.radarr.host || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f"><span>Port</span><input type="text" class="rd-port" inputmode="numeric" value="${esc(w.radarr.port || 7878)}"></label>
            <label class="cp-f"><span>URL base <i>(optional)</i></span><input type="text" class="rd-base" placeholder="/radarr" value="${esc(w.radarr.base || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f rd-keyf"><span>API key <i>(Radarr > Settings > General)</i></span><input type="password" class="rd-key" placeholder="${w.radarr.has_key ? 'saved - leave empty to keep it' : 'paste the API key'}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
          </div>
          <div class="rd-row"><button class="uc-btn rd-test">Test connection</button><span class="rd-res muted"></span></div>
          <div class="rd-more"${w.radarr.ok || w.radarr.profile ? '' : ' hidden'}>
            <div class="rd-grid">
              <label class="cp-f"><span>Quality profile</span><select class="rd-prof">${w.radarr.profile ? `<option value="${w.radarr.profile}">${esc(w.radarr.profile_name || 'Profile ' + w.radarr.profile)}</option>` : ''}</select></label>
              <label class="cp-f"><span>Minimum availability</span><select class="rd-avail">${[['announced', 'Announced'], ['inCinemas', 'In cinemas'], ['released', 'Released']].map(([v, l]) => `<option value="${v}"${(w.radarr.availability || 'released') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            </div>
            <label class="chk"><input type="checkbox" class="rd-search" ${w.radarr.search !== false ? 'checked' : ''}> Search for the movie as soon as it's added</label>
            <div class="rd-maph">Folder pairs <span class="muted">- the folder Radarr sees, and the same folder on this server</span></div>
            <div class="rd-map">${(w.radarr.map || []).map(m => rdMapRow(m.radarr, m.host, null)).join('')}</div>
          </div>
          <div class="muted rd-foot">Saved with the <b>Save</b> button below. The API key stays on the server.</div>
        </details></div>
        <div class="tl-card tl-stack"><div class="tl-top"><div class="tl-txt"><b>TV shows with missing episodes</b>
          <span class="muted">Checks each show folder against its episode list on TVmaze and lists shows with missing episodes or seasons. Your episode files are only read, never changed. Specials are left out.</span></div>
          <button class="uc-btn primary" data-tool="tv">Open</button></div>
        <label class="chk tl-iconopt"><input type="checkbox" class="st-toolbtn" data-tb="tv" ${w.toolbtns && w.toolbtns.tv === false ? '' : 'checked'}> Display icon in UI <span class="muted">- a button next to Settings that opens this tool</span></label>
        <details class="rd-box rd-acc" data-app="sonarr"${SN.ok ? '' : ' open'}>
          <summary class="rd-h"><b>Sonarr</b> <span class="rd-state muted"></span><span class="rd-chev" aria-hidden="true"></span></summary>
          <div class="muted rd-intro">So the TV tool can ask Sonarr for missing episodes. A show Sonarr doesn't have is added with its existing folder, and only the missing episodes are searched - the files you have are left alone.</div>
          <div class="rd-grid">
            <label class="cp-f"><span>Address</span><input type="text" class="rd-host" placeholder="192.168.1.10" value="${esc(SN.host || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f"><span>Port</span><input type="text" class="rd-port" inputmode="numeric" value="${esc(SN.port || 8989)}"></label>
            <label class="cp-f"><span>URL base <i>(optional)</i></span><input type="text" class="rd-base" placeholder="/sonarr" value="${esc(SN.base || '')}" spellcheck="false" autocapitalize="off"></label>
            <label class="cp-f rd-keyf"><span>API key <i>(Sonarr > Settings > General)</i></span><input type="password" class="rd-key" placeholder="${SN.has_key ? 'saved - leave empty to keep it' : 'paste the API key'}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
          </div>
          <div class="rd-row"><button class="uc-btn rd-test">Test connection</button><span class="rd-res muted"></span></div>
          <div class="rd-more"${SN.ok || SN.profile ? '' : ' hidden'}>
            <div class="rd-grid"><label class="cp-f"><span>Quality profile</span><select class="rd-prof">${SN.profile ? `<option value="${SN.profile}">${esc(SN.profile_name || 'Profile ' + SN.profile)}</option>` : ''}</select></label></div>
            <label class="chk"><input type="checkbox" class="rd-search" ${SN.search !== false ? 'checked' : ''}> Search for the episodes as soon as they're sent</label>
            <div class="rd-maph">Folder pairs <span class="muted">- the folder Sonarr sees, and the same folder on this server</span></div>
            <div class="rd-map">${(SN.map || []).map(m => rdMapRow(m.sonarr, m.host, null, 'sonarr')).join('')}</div>
          </div>
          <div class="muted rd-foot">Saved with the <b>Save</b> button below. The API key stays on the server.</div>
        </details></div>
      </div>

      <div class="st-panel" data-panel="trash">
        <label class="st-radio"><input type="checkbox" class="st-trash" ${w.trash !== false ? 'checked' : ''}><span><b>Use the trash</b><br>
          <span class="muted">On: Delete moves things to the trash, where you can get them back. Off: Delete erases them immediately and for good.</span></span></label>
        <div class="field st-days-f"><label>Keep deleted items and History for (days)</label><input type="text" inputmode="numeric" class="st-days" value="${esc(w.trash_days)}"></div>
        <div class="muted">After this many days, deleted items are removed from the trash for good and History forgets its older steps. 0 keeps both until you empty them yourself.</div>
        <div class="field"><label>unCommander's folder</label><input type="text" class="st-histdir" value="${esc(w.hist_dir || '')}" placeholder="/mnt/user/appdata/uncommander" spellcheck="false"></div>
        <div class="muted">History, the tools' lists (playlists, Radarr, TV, Lidarr) and ffmpeg live here - on the array or a pool, so they don't wear the flash drive. Empty means /mnt/user/appdata/uncommander. Changing it moves the files along. While the array is stopped, History waits in memory and moves here when it starts. Once a day, if a list changed, a small copy (a few KB) is saved on the flash drive for unRAID's flash backup.</div>
        <div class="st-row st-empty-row"><button type="button" class="uc-btn primary st-clean">Clean up…</button>
          <span class="muted">See what unCommander keeps - the trash, History, caches, leftovers, ffmpeg - how much space each takes, and clear what you pick.</span></div>
        <div class="st-row st-empty-row"><button type="button" class="uc-btn danger st-empty-now" ${SET.practice ? 'disabled title="Practice mode is on"' : ''}>Empty the trash now</button>
          <span class="muted">Frees the space straight away: everything in every trash folder is deleted for good. History keeps its steps, but deletes can't be undone after this.</span></div>
        <div class="st-help">
          <h4>Where deleted things go</h4>
          <p>Delete (F8) doesn't erase anything. It moves the item into a hidden folder called <span class="mono">.uncommander-trash</span> at the top of the share, disk or pool it came from, e.g. <span class="mono">/mnt/user/Nextcloud/.uncommander-trash</span>. That makes deleting instant, even for huge folders, because nothing is copied.</p>
          <p>Each delete makes one dated folder inside it, like <span class="mono">20261013-093912-a1b2c3</span>, holding what you deleted and a note of where it came from. Deleted items still use disk space until the trash is emptied.</p>
          <div class="warnbox"><b>Not everything goes to the trash.</b> These are deleted for good straight away - they can't be got back from the trash, and Undo can't bring them back:
            <ul><li>anything deleted with <b>Delete permanently - skip the trash</b> ticked in the Delete window</li>
            <li>everything you delete while <b>Use the trash</b> (above) is off</li>
            <li>things deleted from inside a <span class="mono">.uncommander-trash</span> folder, and emptying the trash</li>
            <li>files outside <span class="mono">/mnt</span> and <span class="mono">/boot</span> (the Whole OS view has no trash)</li></ul></div>
          <h4>Getting something back</h4>
          <ol>
            <li>Turn on <b>Show hidden</b> (bottom bar), then open the share or disk you deleted from.</li>
            <li>Open <span class="mono">.uncommander-trash</span>. Open a dated folder to see what's in it, if you need to.</li>
            <li>Tick the dated folder(s) and press <b>Restore</b>. It only appears inside the trash folder.</li>
          </ol>
          <p>Each item goes back to exactly where it was, re-creating the folder if needed. If something with the same name is there now, that item is skipped so nothing gets overwritten. To get just one file out of a dated folder, open it and Copy or Move that file instead.</p>
          <h4>Emptying</h4>
          <p>Every day at 4:17 am, the server permanently removes dated folders older than the number of days above (History forgets its steps after the same number of days). <b>Empty the trash now</b> above clears everything at once. You can also open the trash, tick folders and press Delete: anything deleted from inside the trash is gone for good.</p>
          <h4>Good to know</h4>
          <ul>
            <li>This is unCommander's own trash. It's separate from unRAID's Recycle Bin plugin and doesn't need it.</li>
            <li>Deleting over the network (SMB), in the terminal or in another file manager doesn't use this trash.</li>
            <li>The trash folder is hidden from network shares if they use unRAID's default "hide dot files" setting.</li>
            <li>Switching the trash off doesn't empty it. Whatever is already there stays until the daily clean-up or until you delete it.</li>
          </ul>
        </div>
      </div>`,
      only ? [{ label: 'Close', primary: true }] : [{ label: 'Cancel' }, { label: 'Save', primary: true, run: () => saveAll() }], 'full settings sticky');
    /* the Tools window on its own (the top-bar button): just Close - anything changed in it is saved as it closes */
    const toolsState = () => JSON.stringify($$('[data-panel="tools"] input, [data-panel="tools"] select, [data-panel="tools"] textarea', dlg).map(x => x.type === 'checkbox' || x.type === 'radio' ? x.checked : x.value));
    const tools0 = only ? toolsState() : '';
    async function saveAll(quiet) {
        w.trash_days = parseInt($('.st-days', dlg).value, 10) || 0;
        w.practice = $('.st-practice', dlg).checked;
        w.sysmode = $('.st-sysmode', dlg).checked;
        w.collect = $('.st-collect', dlg).checked;
        w.tree = $('.st-tree', dlg).checked;
        w.vplay = $('.st-vplay', dlg).checked;
        if ($('.st-vsmooth', dlg)) w.vsmooth = $('.st-vsmooth', dlg).checked;
        const vc = $('input[name=st-vconv]:checked', dlg); if (vc) w.vconv = vc.value;
        w.player = $('.st-player', dlg).checked;
        w.pldirs = $('.st-pldirs', dlg).value.split('\n').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
        w.menu_show = $('.st-menushow', dlg).checked;
        store.set('ctxOff', !$('.st-ctxmenu', dlg).checked);
        store.set('rtick', $('.st-rtick', dlg).checked);
        store.set('typeMode', ($('input[name=st-type]:checked', dlg) || {}).value === 'filter' ? 'filter' : 'jump');
        jumpLabel(); if (!filterMode()) panes.forEach(q => { if (q.flt) { q.flt = ''; applySort(q); } }), jumpBox.classList.remove('filtering');
        { const pr = ($('input[name=st-fkp]:checked', dlg) || {}).value || 'uc', map = {};
          $$('select[data-fk]', dlg).forEach(x => { if (x.value) map[x.dataset.fk] = x.value; });
          store.set('fkeys', { preset: FK_PRESETS[pr] ? pr : 'custom', map: FK_PRESETS[pr] ? FK_PRESETS[pr][2] : map }); renderFk(); }
        fkShow($('.st-fkshow', dlg).checked);
        store.set('recentMins', +$('.st-recent-m', dlg).value || 0); panes.forEach(p => drawRows(p));
        const rowAll = $('.st-tabrow', dlg).checked, rowWas = !!store.get('tabrowAll', false);
        store.set('tabrowAll', rowAll); if (rowAll !== rowWas) setTimeout(() => location.reload(), 600);
        w.trash = $('.st-trash', dlg).checked;
        w.hist_dir = $('.st-histdir', dlg).value.trim();
        w.notify_unraid = $('.st-notify', dlg).checked;
        w.tap_mode = ($('input[name=st-tap]:checked', dlg) || {}).value || 'auto';
        w.highlight = $('.st-hl', dlg).checked;
        w.toolbtns = {}; $$('.st-toolbtn', dlg).forEach(c => { w.toolbtns[c.dataset.tb] = c.checked; });
        w.autorefresh = { on: $('.st-ar', dlg).checked, secs: parseInt($('.st-ar-secs', dlg).value, 10) || 10 };
        w.radarr = rdRead($('.rd-box[data-app="radarr"]', dlg));
        w.sonarr = rdRead($('.rd-box[data-app="sonarr"]', dlg));
        w.lidarr = rdRead($('.rd-box[data-app="lidarr"]', dlg));
        const oldMenu = SET.menu_name;
        w.menu_name = $('.st-menu', dlg).value.trim();
        savedOk = true; await saveSettings(w);
        toast(SET.menu_name !== oldMenu ? 'Saved — reload the page to see the new menu name' : quiet ? 'Tools settings saved' : 'Settings saved');
    }
    document.activeElement && document.activeElement.blur();
    dlg.beforeClose = () => { if (only && !savedOk && toolsState() !== tools0) saveAll(true).catch(e => toast(e.message, true)); if (!savedOk) { applyPalette(SET.palette); applyLook(SET.css); } fsPreview = null; applyScale(savedOk && dlg.fsPick ? dlg.fsPick : null); dlg.fsPick = null; return true; };
    /* text size: previews live; Save keeps it on this device, Cancel puts it back */
    const fs0 = Math.round(fontScale() * 100), fsR = $('.fs-range', dlg), fsV = $('.fs-val', dlg);
    const fsSet = v => { v = Math.max(80, Math.min(140, Math.round(v / 5) * 5)); fsR.value = v; fsV.textContent = v + '%'; fsPreview = v / 100; applyScale(); dlg.fsPick = v; };
    fsR.addEventListener('input', () => fsSet(+fsR.value));
    $$('.fs-step', dlg).forEach(b => b.addEventListener('click', () => fsSet(+fsR.value + +b.dataset.fs)));
    $('.fs-reset', dlg).addEventListener('click', () => fsSet(100));

    /* Four tabs, each grouping related sections under a small heading. */
    const GROUP = { colors: 'look', music: 'gen', gen: 'gen', tree: 'gen', video: 'gen', touch: 'gen', jobs: 'gen', watch: 'gen', about: 'gen', bm: 'bm', size: 'look', look: 'look', hl: 'look', snd: 'look', safe: 'safe', sys: 'safe', trash: 'safe', tools: 'tools', keys: 'keys' };
    $$('.rd-box[data-app]', dlg).forEach(box => rdWire(box, w));
    /* Function keys: a preset fills the boxes; changing a box makes it "My own" */
    $$('input[name=st-fkp]', dlg).forEach(r => r.addEventListener('change', () => { const pr = FK_PRESETS[r.value]; if (pr) $$('select[data-fk]', dlg).forEach(x => { x.value = pr[2][x.dataset.fk] || ''; }); }));
    $$('select[data-fk]', dlg).forEach(x => x.addEventListener('change', () => { const c = $('input[name=st-fkp][value=custom]', dlg); if (c) c.checked = true; }));
    /* Colours: pick a theme, adjust any colour (light and dark sets), keep it as your own */
    {
      w.mythemes = (w.mythemes || []).map(t => ({ ...t }));
      const P0 = SET.palette || {};
      const fill = base => { const t = palTheme(base, w.mythemes); return Object.assign({ base, light: { ...THEMES.uncommander.light, ...t.light }, dark: { ...THEMES.uncommander.dark, ...t.dark } }, t.always === 'dark' ? { always: 'dark' } : {}); };
      w.palette = Object.assign(fill(P0.base || 'uncommander'), { light: { ...fill(P0.base || 'uncommander').light, ...(P0.light || {}) }, dark: { ...fill(P0.base || 'uncommander').dark, ...(P0.dark || {}) } }, P0.always === 'dark' ? { always: 'dark' } : {});
      let pm = root.classList.contains('uc-dark') ? 'dark' : 'light';
      const box = $('[data-panel="colors"]', dlg), sel = $('.pal-base', box), grid = $('.pal-grid', box);
      const drawSel = () => { sel.innerHTML = `<optgroup label="Built in">${Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${esc(t.name)} - ${esc(t.desc)}</option>`).join('')}</optgroup>`
        + (w.mythemes.length ? `<optgroup label="My themes">${w.mythemes.map(t => `<option value="my:${esc(t.name)}">${esc(t.name)}</option>`).join('')}</optgroup>` : '');
        sel.value = w.palette.base; $('.pal-drop', box).hidden = !w.palette.base.startsWith('my:'); };
      const drawGrid = () => {
        grid.innerHTML = PAL_KEYS.concat(PAL_EXTRA.filter(([k]) => w.palette[pm][k])).map(([k, l, d]) => `<div class="pal-r"><input type="color" data-k="${k}" value="${w.palette[pm][k]}" aria-label="${esc(l)}"><span><b>${esc(l)}</b>${d ? `<br><span class="muted">${esc(d)}</span>` : ''}</span><input type="text" class="pal-hex" data-hex="${k}" value="${w.palette[pm][k]}" maxlength="7" spellcheck="false" autocomplete="off" title="Type or paste a colour: #0381a5 (or 0381a5, or #08b)" aria-label="${esc(l)} - hex code"></div>`).join('');
        $$('.pal-modes button', box).forEach(b => b.classList.toggle('on', b.dataset.pm === pm));
        $('.pal-now', box).textContent = `Editing the ${pm} colours - unRAID's display theme decides which set you see (now: ${root.classList.contains('uc-dark') ? 'dark' : 'light'}).`;
      };
      const live = () => applyPalette(w.palette);
      sel.addEventListener('change', () => { w.palette = fill(sel.value); drawSel(); drawGrid(); live(); });
      $('.pal-modes', box).addEventListener('click', e => { const b = e.target.closest('[data-pm]'); if (b) { pm = b.dataset.pm; drawGrid(); } });
      /* a colour from the picker, or typed / pasted as a hex code */
      const hexOf = v => { v = v.trim().replace(/^#/, '').toLowerCase(); if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/./g, c => c + c); return /^[0-9a-f]{6}$/.test(v) ? '#' + v : ''; };
      grid.addEventListener('input', e => {
        const i = e.target.closest('[data-k]'), t = e.target.closest('[data-hex]');
        if (i) { w.palette[pm][i.dataset.k] = i.value; i.parentNode.querySelector('.pal-hex').value = i.value; i.parentNode.querySelector('.pal-hex').classList.remove('bad'); live(); }
        if (t) { const h = hexOf(t.value); t.classList.toggle('bad', !h && t.value.trim() !== ''); if (h) { w.palette[pm][t.dataset.hex] = h; t.parentNode.querySelector('[data-k]').value = h; live(); } }
      });
      grid.addEventListener('change', e => { const t = e.target.closest('[data-hex]'); if (t) { const h = hexOf(t.value); t.value = h || w.palette[pm][t.dataset.hex]; t.classList.remove('bad'); } });
      grid.addEventListener('keydown', e => { if (!e.target.closest('[data-hex]')) return; if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key !== 'Escape') e.stopPropagation(); });
      $('.pal-reset', box).addEventListener('click', () => { w.palette = fill(w.palette.base); drawGrid(); live(); });
      $('.pal-keep', box).addEventListener('click', () => {
        const name = $('.pal-name', box).value.trim() || (w.palette.base.startsWith('my:') ? w.palette.base.slice(3) : '');
        if (!name) return toast('Give your theme a name first', true);
        w.mythemes = w.mythemes.filter(t => t.name !== name).concat([Object.assign({ name, light: { ...w.palette.light }, dark: { ...w.palette.dark } }, w.palette.always === 'dark' ? { always: 'dark' } : {})]);
        w.palette.base = 'my:' + name; drawSel(); toast(`"${name}" is on your theme list - press Save to keep it`);
      });
      $('.pal-drop', box).addEventListener('click', () => {
        const name = w.palette.base.slice(3);
        w.mythemes = w.mythemes.filter(t => t.name !== name); w.palette = fill('uncommander'); drawSel(); drawGrid(); live();
        toast(`"${name}" removed - press Save to make it final`);
      });
      drawSel(); drawGrid();
      /* your own CSS wins: say which of these colours it already sets */
      const ow = PAL_KEYS.map(([k, l]) => [k, l]).filter(([k]) => new RegExp('--' + k + '\\s*:').test(w.css || ''));
      if (ow.length) $('.pal-now', box).insertAdjacentHTML('afterend', `<div class="st-warn pal-ow">Your CSS (below) sets ${ow.map(([k]) => `<span class="mono">--${k}</span>`).join(', ')} - those win over this theme until you take them out of it.</div>`);
    }
    /* Empty the trash now: one more tap to be sure, then it runs on the server in the background */
    /* Play any video: ffmpeg (fetched by itself, or now), smooth playback, converting the picture - with a live status */
    const ffBox = $('.st-ff', dlg);
    if (ffBox) {
      const show = async () => {
        let r; try { r = await api('ffmpeg_status'); } catch (e) { return; }
        if (!ffBox.isConnected) return;
        const s = $('.st-ff-state', ffBox), g = $('.st-ff-get', ffBox);
        $('.st-ff-more', ffBox).hidden = r.state !== 'ready' || !$('.st-vplay', ffBox).checked;
        ffBox.dataset.ready = r.state === 'ready' ? '1' : '';
        const vb = $('.st-vconv', ffBox);
        if (!vb.dataset.done && r.state === 'ready') {
          vb.dataset.done = '1';
          const lab = { cpu: 'the CPU', nvidia: 'the NVIDIA graphics', vaapi: 'the Intel/AMD graphics' };
          const cur = w.vconv || 'auto', ch = [['auto', 'Automatic', 'the graphics when they work, else the CPU - recommended'], ['off', 'Off', "videos the browser can't show won't play"], ['cpu', 'Use the CPU', 'works everywhere; heavy']].concat((r.gpus || []).map(gp => [gp.id, `Use the ${gp.label}`, gp.id === 'nvidia' ? 'needs the Nvidia Driver plugin' : '']));
          vb.innerHTML = ch.map(([v, l, d]) => `<label class="st-radio st-vc"><input type="radio" name="st-vconv" value="${v}" ${cur === v ? 'checked' : ''}><span><b>${esc(l)}</b>${d ? ` <span class="muted">· ${esc(d)}</span>` : ''}${v !== 'off' ? ` <button type="button" class="uc-btn st-vtest" data-m="${v}">Test</button> <span class="st-vres">${v === 'auto' && r.vauto ? `<span class="st-ok">✓ using ${lab[r.vauto]}</span>` : ''}</span>` : ''}</span></label>`).join('')
            + ((r.gpus || []).length ? '' : '<div class="muted">No NVIDIA, Intel or AMD graphics were found on this server - Automatic uses the CPU.</div>');
          vb.addEventListener('click', async e => {
            const b = e.target.closest('.st-vtest'); if (!b) return; e.preventDefault();
            const res = $('.st-vres', b.parentNode); res.textContent = 'testing…'; res.style.color = '';
            try {
              if (b.dataset.m === 'auto') { const t = await api('vconv_auto'); res.textContent = `✓ works - using ${lab[t.mode]}`; res.style.color = 'var(--ok)'; }
              else { const t = await api('gpu_test', { mode: b.dataset.m }); res.textContent = t.ok ? `✓ works (${t.secs} s)` : '✕ failed: ' + t.error; res.style.color = t.ok ? 'var(--ok)' : 'var(--danger)'; }
            } catch (er) { res.textContent = er.message; }
          });
        }
        s.innerHTML = { ready: '<span class="st-ok">· ✓ ffmpeg ready</span>', downloading: `<span class="muted">· downloading ffmpeg ${r.pct}%</span>`, error: `<span class="st-bad">· ${esc(r.error)}</span>`, none: '<span class="muted">· ffmpeg not downloaded yet</span>', noarray: '<span class="muted">· ffmpeg is in unCommander\'s folder - start the array</span>' }[r.state] || '';
        $('.st-ffdl', ffBox).hidden = r.state === 'ready'; g.disabled = r.state === 'downloading' || r.state === 'noarray';
        g.textContent = r.state === 'downloading' ? `Downloading ${r.pct}%…` : r.state === 'error' ? 'Try the download again' : 'Download ffmpeg now';
        if (r.state === 'downloading') setTimeout(show, 1500);
      };
      $('.st-vplay', ffBox).addEventListener('change', e => { $('.st-ff-more', ffBox).hidden = !ffBox.dataset.ready || !e.target.checked; $('.st-ffdl', ffBox).hidden = !!ffBox.dataset.ready || !e.target.checked; });
      $('.st-ff-get', ffBox).addEventListener('click', async () => { try { await api('ffmpeg_get'); } catch (e) { return toast(e.message, true); } setTimeout(show, 800); });
      $('.st-ff-rm', ffBox).addEventListener('click', async () => { await api('ffmpeg_remove'); $('.st-vconv', ffBox).dataset.done = ''; show(); });
      show();
    }
    const cl = $('.st-clean', dlg); if (cl) cl.addEventListener('click', () => openCleanup());
    const emptyNow = $('.st-empty-now', dlg);
    if (emptyNow) emptyNow.addEventListener('click', async () => {
      if (!emptyNow.dataset.sure) { emptyNow.dataset.sure = '1'; emptyNow.textContent = 'Sure? Delete everything in the trash'; emptyNow.classList.add('primary'); return; }
      emptyNow.disabled = true;
      try { await api('trash_empty_now'); emptyNow.textContent = 'Emptying…'; toast('Emptying the trash on every share and disk - the space comes back in a moment (longer if a disk has to spin up)'); }
      catch (e) { toast(e.message, true); emptyNow.disabled = false; }
    });
    $$('[data-tool]', dlg).forEach(b => b.addEventListener('click', () => { closeDlg(); if (b.dataset.tool === 'empty') openEmptyTool(); if (b.dataset.tool === 'music') openMusicTool(); if (b.dataset.tool === 'plcheck') openPlaylistCheck(); if (b.dataset.tool === 'movies') openMovieTool(); if (b.dataset.tool === 'tv') openTvTool(); if (b.dataset.tool === 'dupes') openDupTool(); if (b.dataset.tool === 'space') openSpaceTool(); }));
    const HEAD = { music: 'Music player', about: 'About', gen: 'unCommander in unRAID', tree: 'Folder tree', video: 'Video and music', touch: 'Tapping rows', jobs: 'When a job finishes', watch: 'Auto-refresh', size: 'Text size on this device', keys: 'Keyboard shortcuts', look: 'Your own CSS', snd: 'Sounds', safe: 'Practice mode', sys: 'Whole system view', trash: 'Trash & History', colors: 'Colours' };
    $$('.st-panel', dlg).forEach(pn => {
      pn.dataset.group = GROUP[pn.dataset.panel] || pn.dataset.panel;
      if (HEAD[pn.dataset.panel]) pn.insertAdjacentHTML('afterbegin', `<h3 class="st-h">${HEAD[pn.dataset.panel]}</h3>`);
    });
    const show = k => {
      const g = GROUP[k] || k;
      $$('.st-tab', dlg).forEach(b => b.classList.toggle('on', b.dataset.tab === g));
      $$('.st-panel', dlg).forEach(pn => pn.hidden = pn.dataset.group !== g);
    };
    $$('.st-tab', dlg).forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    show(tab);

    /* shortcuts */
    const list = $('.st-bms', dlg);
    const drawBms = () => {
      list.innerHTML = w.bookmarks.length ? w.bookmarks.map((b, i) => `
        <div class="st-bm" data-i="${i}">
          <input type="text" class="st-label" value="${esc(b.label)}" placeholder="Label">
          <input type="text" class="st-path" value="${esc(b.path)}" placeholder="/mnt/user/…">
          <button class="uc-btn" data-mv="-1" title="Move up" ${i ? '' : 'disabled'}>🠉</button>
          <button class="uc-btn" data-mv="1" title="Move down" ${i < w.bookmarks.length - 1 ? '' : 'disabled'}>🠋</button>
          <button class="uc-btn danger" data-del title="Remove">✕</button>
        </div>`).join('') : '<div class="uc-empty">No shortcuts yet.</div>';
    };
    drawBms();
    list.addEventListener('input', e => {
      const row = e.target.closest('.st-bm'); if (!row) return;
      const b = w.bookmarks[+row.dataset.i];
      if (e.target.matches('.st-label')) b.label = e.target.value;
      if (e.target.matches('.st-path')) b.path = e.target.value;
    });
    list.addEventListener('click', e => {
      const row = e.target.closest('.st-bm'); if (!row) return;
      const i = +row.dataset.i, mv = e.target.closest('[data-mv]');
      if (mv) { const j = i + +mv.dataset.mv; [w.bookmarks[i], w.bookmarks[j]] = [w.bookmarks[j], w.bookmarks[i]]; drawBms(); }
      if (e.target.closest('[data-del]')) { w.bookmarks.splice(i, 1); drawBms(); }
    });
    $('.st-add-cur', dlg).addEventListener('click', () => {
      const p = A(); if (p.mode !== 'dir') return toast('Open a folder first', true);
      w.bookmarks.push({ label: base(p.path) || p.path, path: p.path }); drawBms();
    });
    $('.st-add-blank', dlg).addEventListener('click', () => { w.bookmarks.push({ label: '', path: '' }); drawBms(); $('.st-bm:last-child .st-label', list).focus(); });

    /* appearance */
    const ta = $('.st-css', dlg);
    ta.addEventListener('input', () => { w.css = ta.value; applyLook(w.css); });
    ta.addEventListener('keydown', e => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); } });
    $('.st-example', dlg).addEventListener('change', e => {
      const ex = CSS_EXAMPLES[+e.target.value]; e.target.value = '';
      if (!ex) return;
      ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') : '') + `/* ${ex[0]} */\n${ex[1]}\n`;
      ta.dispatchEvent(new Event('input'));
    });
    $('.st-css-clear', dlg).addEventListener('click', () => { ta.value = ''; ta.dispatchEvent(new Event('input')); });
    $('.st-css-def', dlg).addEventListener('click', () => {
      if (ta.value.trim() && ta.value.trim() !== (SET.css_default || '').trim() && !confirm('Replace what is in the box with the starting CSS?')) return;
      ta.value = SET.css_default || ''; ta.dispatchEvent(new Event('input'));
    });
    /* colour picker: shows the hex code, Insert drops it into the CSS where the cursor was */
    const col = $('.st-col', dlg), hex = $('.st-hex', dlg);
    let caret = null;
    ta.addEventListener('blur', () => { caret = [ta.selectionStart, ta.selectionEnd]; });
    hex.addEventListener('focus', () => hex.select());
    const insertColour = v => {
      const [a, b] = caret || [ta.value.length, ta.value.length];
      ta.setRangeText(v, a, b, 'end'); caret = [a + v.length, a + v.length];
      ta.dispatchEvent(new Event('input')); toast(`Inserted ${v}`); colourRecent(v);
    };
    const showColour = v => { hex.value = v; $('i', col).style.background = v; };
    showColour(store.get('colourLast', '#1f6feb'));
    $('.st-col-ins', dlg).addEventListener('click', () => insertColour(hex.value));
    col.addEventListener('click', e => { e.preventDefault(); openColourPicker(col, hex.value, { onChange: showColour, onInsert: insertColour }); });

    /* sounds */
    $$('[data-s]', dlg).forEach(c => c.addEventListener('change', () => { w.sounds[c.dataset.s] = c.checked; }));
    const vol = $('.st-vol', dlg);
    vol.addEventListener('input', () => { w.sounds.volume = +vol.value; $('.st-vol-v', dlg).textContent = vol.value; });
    $$('[data-test]', dlg).forEach(b => b.addEventListener('click', () => sound.play(b.dataset.test, { force: true, volume: w.sounds.volume })));
  }
  $('.uc-settings-btn').addEventListener('click', () => openSettings());
  $('.uc-practice').addEventListener('click', () => openSettings('safe'));
  /* the movie / TV tool buttons next to Settings (Settings > Tools > "Display icon in UI") */
  function applyToolBtns() { $$('.uc-toolbtn[data-opentool]').forEach(b => { b.hidden = !(SET.toolbtns && SET.toolbtns[b.dataset.opentool] !== false); }); }
  $$('.uc-toolbtn[data-opentool]').forEach(b => b.addEventListener('click', () => { b.blur(); sound.play('click'); if (b.dataset.opentool === 'tools') openSettings('tools', true); else if (b.dataset.opentool === 'movies') openMovieTool(); else openTvTool(); }));
  applyToolBtns();
  applyPractice(); applySys(false);
  { const p = SET.palette, bt = p && THEMES[p.base]; if (bt && ['light', 'dark'].some(m => bt[m] && Object.keys(bt[m]).some(k => !(p[m] && k in p[m])))) applyPalette(p); }   // the theme has colours the saved copy lacks: add them

  /* ---------- New tab: more unCommander tabs, each with its own two panes ----------
   * The square button in the top bar opens one inside unRAID, on a page of its own, or in a
   * small window of its own (no tabs or bookmarks bar). It starts where this one is: same
   * folders, views and active pane. Its name (top bar and browser tab) follows the active
   * folder until you give it one. Tabs see each other through a BroadcastChannel: playing in
   * one pauses any other, and the playlist is the same everywhere. */
  const TAB_KEYS = ['path0', 'path1', 'trail0', 'trail1', 'hist0', 'hist1', 'fwd0', 'fwd1', 'sel0', 'sel1', 'tree0', 'tree1', 'gal0', 'gal1', 'active', 'mus'];
  const tabReg = () => { try { return JSON.parse(localStorage.getItem('uc.tabs') || '{}') || {}; } catch (e) { return {}; } };
  const tabRegSet = r => { try { localStorage.setItem('uc.tabs', JSON.stringify(r)); } catch (e) {} };
  const tabNew = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const tabKind = () => /^uc-win-/.test(window.name || '') ? 'app' : /\/uncommander\.php/.test(location.pathname) ? 'page' : 'unraid';
  const IS_FF = /Firefox\//.test(navigator.userAgent);
  const IS_HOMEAPP = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || !!navigator.standalone;
  function tabCopy(from, to) {
    for (const k of TAB_KEYS) { try { const v = localStorage.getItem(tabKey(k, from)); if (v !== null) localStorage.setItem(tabKey(k, to), v); } catch (e) {} }
  }
  function tabForget(id) {
    if (id === 'main') return;
    for (const k of [...TAB_KEYS, 'tabname']) { try { localStorage.removeItem(tabKey(k, id)); } catch (e) {} }
  }
  /* closed tabs are kept a week (Reopen closed tab), at most 12 */
  function tabPrune() {
    const r = tabReg(), now = Date.now(), kept = new Set();
    /* tabs inside small windows: kept while their window's list has them (a window unused for 60 days is forgotten) */
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith('uc.win.')) continue;
      try { const v = JSON.parse(localStorage.getItem(k)); if (v && v.at && now - v.at > 60 * 864e5) { localStorage.removeItem(k); i--; continue; } (v.tabs || []).forEach(t => kept.add(t)); } catch (e) {}
    }
    const old = Object.entries(r).filter(([id, v]) => id !== 'main' && !kept.has(id) && (v.closed ? now - v.closed > 864e5 : now - (v.seen || 0) > 7 * 864e5));
    for (const [id] of old) { tabForget(id); delete r[id]; }
    tabRegSet(r);
  }
  function tabTouch(extra) {
    const r = tabReg(); r[TAB] = Object.assign(r[TAB] || {}, { seen: Date.now(), kind: tabKind(), name: tabName() }, extra || {});
    if (!extra || !('closed' in extra)) delete r[TAB].closed;
    tabRegSet(r);
  }
  /* the name: what you called it, else the active pane's folder (for the browser's tab and Reopen) */
  function tabName() {
    const own = store.get('tabname', '');
    if (own) return own;
    const p = A(); return (p && p.mode === 'dir' ? base(p.path) || '/' : '') || 'unCommander';
  }
  const tabEl = $('.uc-tabname'), tabBtn = $('.uc-tabbtn');
  const tabsAlive = new Map();             // the other unCommander tabs open in this browser: id -> last heard
  /* the box next to the New tab button shows the name you gave this tab (or "tab name…");
   * the browser's tab shows that name, else the active folder - kept up to date as you move */
  function tabShowName() {
    const own = store.get('tabname', '');
    if (tabEl) { tabEl.textContent = own || 'tab name…'; tabEl.classList.toggle('empty', !own); tabEl.title = own ? `This tab: ${own} - click to rename it` : 'Give this tab a name'; }
    const t = own || `uC · ${tabName()}`;
    if (document.title !== t) document.title = t;
    if (winTabs && winStrip) { const on = $('.wt.on .wt-n', winStrip), n = own || tabName(); if (on && on.textContent !== n) winDraw(); }
  }
  let tabCh = null;
  try { tabCh = new BroadcastChannel('uncommander'); } catch (e) {}
  const tabSay = m => { try { tabCh && tabCh.postMessage(Object.assign({ from: TAB }, m)); } catch (e) {} };
  if (tabCh) tabCh.onmessage = e => {
    const m = e.data || {};
    if (!m.from) return;
    if (m.t === 'hi' || m.t === 'here') {
      /* a second tab with this same id (the page opened twice, or a duplicated tab): it becomes a new tab */
      if (m.from === TAB && m.t === 'hi') { tabSay({ t: 'taken', nonce: m.nonce }); return; }
      tabsAlive.set(m.from, Date.now()); if (m.t === 'hi') tabSay({ t: 'here' }); tabShowName();
    }
    if (m.t === 'taken' && m.from === TAB && m.nonce === tabNonce) {
      const old = TAB, id = tabNew(); tabCopy(old, id);
      TAB = id; try { sessionStorage.setItem('uc.tab', id); } catch (er) {}
      /* a copied browser tab with a tab row: it gets a row of its own */
      if (WIN_T) { try { sessionStorage.removeItem('uc.win'); } catch (er) {} location.reload(); return; }
      tabTouch(); tabShowName();
    }
    if (m.t === 'bye') { tabsAlive.delete(m.from); tabShowName(); }
    /* someone pressed play in another tab: this one goes quiet */
    if (m.t === 'play' && m.from !== TAB) $$('audio, video').forEach(a => { if (!a.paused) a.pause(); });
  };
  const tabNonce = Math.random().toString(36).slice(2);
  tabSay({ t: 'hi', nonce: tabNonce });
  setInterval(() => { tabSay({ t: 'here' }); tabTouch(); tabShowName(); }, 30000);
  setInterval(() => { try { tabShowName(); } catch (e) {} }, 1500);   // the browser's tab title, in case a change slipped past
  window.addEventListener('pagehide', () => { tabSay({ t: 'bye' }); tabTouch({ closed: Date.now() }); });
  window.addEventListener('pageshow', e => { if (e.persisted) { tabSay({ t: 'hi', nonce: tabNonce }); tabTouch(); } });
  document.addEventListener('play', () => tabSay({ t: 'play' }), true);
  tabPrune(); tabTouch();
  /* the playlist changed in another tab: take it over (the song playing here keeps playing) */
  window.addEventListener('storage', e => {
    if (e.key !== 'uc.pl' || !e.newValue) return;
    let v; try { v = JSON.parse(e.newValue); } catch (er) { return; }
    if (!v || !Array.isArray(v.items)) return;
    const playing = pl.items[pl.i];
    const keepI = playing ? v.items.indexOf(playing) : -1;
    pl = Object.assign(PL_NEW(), v);
    if (keepI >= 0) pl.i = keepI;
    plUI();
  });
  /* open a new browser tab or a small window, where this one is */
  /* a new tab's layout (a copy of this one's) and its address */
  function tabPrep(kind) {
    const id = tabNew();
    tabCopy(TAB, id);
    try { localStorage.removeItem(tabKey('tabname', id)); } catch (e) {}
    const r = tabReg(); r[id] = { seen: Date.now(), kind }; tabRegSet(r);
    const withUnraid = store.get('tabshow', 'solo') === 'unraid';
    return { id, url: withUnraid ? `/UnCommander?uctab=${id}` : `/plugins/uncommander/uncommander.php?uctab=${id}` };
  }
  function tabOpen(kind, prepped) {
    const { id, url } = prepped || tabPrep(kind);
    if (kind === 'tab') return window.open(url, '_blank');
    const w = Math.min(1440, screen.availWidth - 40), h = Math.min(920, screen.availHeight - 60), at = `width=${w},height=${h},left=${Math.max(0, (screen.availWidth - w) / 2)},top=${Math.max(0, (screen.availHeight - h) / 3)}`;
    /* a normal browser window (its own tabs, address bar, menus): asking for the toolbars is what makes it one */
    const win = kind === 'win' ? window.open(url, '_blank', `toolbar=yes,location=yes,menubar=yes,personalbar=yes,status=yes,scrollbars=yes,resizable=yes,${at}`)
      : window.open(url + '&ucwin=' + id, 'uc-win-' + id, `popup=yes,${at}`);
    if (!win) toast('The browser blocked the new window - allow pop-ups for this server, then try again', true);
  }
  function tabRename() {
    openDlg('Name this tab', `<div class="field"><label>Name</label><input type="text" class="tn-in" value="${esc(store.get('tabname', ''))}" placeholder="tab name…" spellcheck="false" maxlength="40"></div>
      <div class="muted">Shown next to the New tab button and on the browser's tab. Empty: no name - the browser's tab shows the active folder.</div>`,
      [{ label: 'Cancel' }, { label: 'Save', primary: true, run: () => { store.set('tabname', $('.tn-in', dlg).value.trim()); tabTouch(); tabShowName(); winDraw(); } }]);
  }

  /* ---------- tabs inside unCommander, in a small window (and the iPad Home Screen app) ----------
   * Such a window can't hold browser tabs, so it gets its own thin row of tabs above the panes.
   * Each is a full pair of panes (the same per-tab layout a browser tab keeps); only the one
   * shown is live - switching saves this one's panes and opens the other's. */
  const IN_WIN = !!WIN_Q || !!WIN_T || IS_HOMEAPP;
  const WIN_ID = IS_HOMEAPP ? 'home' : WIN_Q || WIN_T;
  const winKey = 'uc.win.' + WIN_ID;
  const winGet = () => { try { const v = JSON.parse(localStorage.getItem(winKey) || 'null'); if (v && Array.isArray(v.tabs) && v.tabs.length) return v; } catch (e) {} return { tabs: [TAB], cur: TAB }; };
  const winSet = v => { try { v.at = Date.now(); localStorage.setItem(winKey, JSON.stringify(v)); } catch (e) {} };
  let winTabs = IN_WIN ? winGet() : null;
  if (winTabs) { if (!winTabs.tabs.includes(TAB)) winTabs.tabs.push(TAB); winTabs.cur = TAB; winSet(winTabs); }
  let winStrip = null, winBusy = false;
  const winLabel = id => { try { const own = JSON.parse(localStorage.getItem(tabKey('tabname', id)) || '""'); if (own) return [own, true]; const p = JSON.parse(localStorage.getItem(tabKey('active', id)) || '0'); const path = JSON.parse(localStorage.getItem(tabKey('path' + (p ? 1 : 0), id)) || '""'); return [base(path) || '/', false]; } catch (e) { return ['unCommander', false]; } };
  function winDraw() {
    if (!winTabs) return;
    if (!winStrip) {
      winStrip = document.createElement('div'); winStrip.className = 'uc-wintabs'; root.prepend(winStrip);
      winStrip.addEventListener('click', e => {
        const x = e.target.closest('[data-wx]'); if (x) { e.stopPropagation(); return winClose(x.dataset.wx); }
        if (e.target.closest('.wt-add')) return winAdd();
        const t = e.target.closest('[data-wt]'); if (t && t.dataset.wt !== TAB) winSwitch(t.dataset.wt);
      });
      winStrip.addEventListener('dblclick', e => { const t = e.target.closest('[data-wt]'); if (t && t.dataset.wt === TAB) tabRename(); });
    }
    winStrip.innerHTML = winTabs.tabs.map(id => { const [n, own] = id === TAB ? [store.get('tabname', '') || tabName(), !!store.get('tabname', '')] : winLabel(id); return `<div class="wt${id === TAB ? ' on' : ''}${own ? '' : ' auto'}" data-wt="${esc(id)}" title="${id === TAB ? 'This tab - double-click to name it' : 'Switch to this tab'}"><span class="wt-n">${esc(n)}</span>${winTabs.tabs.length > 1 ? `<button type="button" class="wt-x" data-wx="${esc(id)}" title="Close this tab" aria-label="Close">✕</button>` : ''}</div>`; }).join('')
      + '<button type="button" class="wt-add" title="New tab, where you are now" aria-label="New tab">+</button>';
  }
  /* this tab's saved layout, put into the panes */
  async function winOpenLayout() {
    const snap = { active: store.get('active', 0), pin: isPinned(), mus: store.get('mus', null), p: [0, 1].map(i => {
      const sel = store.get('sel' + i, null), tr = store.get('tree' + i, null), path = store.get('path' + i, i ? '/mnt' : '/mnt/user');
      return { path, gal: !!store.get('gal' + i, false), tree: tr && tr.path === path && Array.isArray(tr.open) ? tr.open : [], sel: sel && sel.path === path ? sel.names || [] : [], cur: sel && sel.path === path ? sel.cursor : null };
    }) };
    panes.forEach(p => { p.hist = store.get('hist' + p.i, []); p.fwd = store.get('fwd' + p.i, []); p.trail = store.get('trail' + p.i, ''); p.goingBack = true; });
    try { await layoutRestore(snap); } finally { panes.forEach(p => { p.goingBack = false; }); }
    updateChrome();
  }
  async function winSwitch(id) {
    if (winBusy || id === TAB) return; winBusy = true;
    try {
      /* what the panes show now stays with this tab (closing the music view or gallery below mustn't change it) */
      const keep = {}; for (const k of TAB_KEYS) { try { keep[k] = localStorage.getItem(tabKey(k)); } catch (e) {} }
      const old = TAB;
      if (mus) musExit();
      panes.forEach(q => { if (q.gal) galSet(q, false); });
      for (const k of TAB_KEYS) { try { if (keep[k] !== null) localStorage.setItem(tabKey(k, old), keep[k]); } catch (e) {} }
      TAB = id; try { sessionStorage.setItem('uc.tab', id); } catch (e) {}
      winTabs.cur = id; winSet(winTabs); winDraw();
      tabTouch(); tabShowName();
      await winOpenLayout();
    } finally { winBusy = false; winDraw(); }
  }
  function winAdd() {
    const id = tabNew(); tabCopy(TAB, id);
    try { localStorage.removeItem(tabKey('tabname', id)); } catch (e) {}
    winTabs.tabs.splice(winTabs.tabs.indexOf(TAB) + 1, 0, id); winSet(winTabs);
    winSwitch(id);
  }
  function winClose(id) {
    const i = winTabs.tabs.indexOf(id); if (i < 0 || winTabs.tabs.length < 2) return;
    const name = (id === TAB ? [store.get('tabname', '') || tabName()] : winLabel(id))[0];
    winTabs.tabs.splice(i, 1); winSet(winTabs);
    const undo = async () => {
      if (!winTabs.tabs.includes(id)) { winTabs.tabs.splice(Math.min(i, winTabs.tabs.length), 0, id); winSet(winTabs); }
      for (let k = 0; winBusy && k < 50; k++) await new Promise(ok => setTimeout(ok, 100));   // still switching away from it
      winDraw(); await winSwitch(id);
    };
    if (id === TAB) winSwitch(winTabs.tabs[Math.min(i, winTabs.tabs.length - 1)]); else winDraw();
    toast(`Closed ${name}`, false, undo);
  }
  if (winTabs) { root.classList.add('uc-inwin'); winDraw(); }

  /* ---------- the New tab panel ---------- */
  let tabPop = null;
  function tabPanel() {
    if (tabPop && !tabPop.hidden) { tabPop.hidden = true; return; }
    if (!tabPop) {
      tabPop = document.createElement('div'); tabPop.className = 'uc-tabpop'; tabPop.hidden = true; root.append(tabPop);
      document.addEventListener('pointerdown', e => { if (tabPop && !tabPop.hidden && !tabPop.contains(e.target) && !e.target.closest('.uc-tabcombo')) tabPop.hidden = true; }, true);
      tabPop.addEventListener('keydown', e => { if (e.key === 'Escape') { tabPop.hidden = true; root.focus({ preventScroll: true }); } e.stopPropagation(); });
    }
    const show = store.get('tabshow', 'solo'), canWin = !IS_HOMEAPP;
    tabPop.innerHTML = `<div class="tp-row"><button type="button" class="uc-btn tp-tab">New tab</button>${canWin ? `<a class="uc-btn tp-win" href="/plugins/uncommander/uncommander.php" target="_blank" rel="opener"${IS_FF ? ' title="Firefox opens this as a tab - hold Shift while clicking for a window"' : ''}>New window</a><button type="button" class="uc-btn tp-app">Application window</button>` : ''}</div>
      ${canWin && IS_FF ? '<div class="tp-tip">Firefox: Shift+click New window for a separate window</div>' : ''}
      ${canWin ? `<div class="tp-show"><span class="tp-l">Show:</span><label class="chk"><input type="radio" name="tp-show" value="unraid"${show === 'unraid' ? ' checked' : ''}> with unRAID</label><label class="chk"><input type="radio" name="tp-show" value="solo"${show !== 'unraid' ? ' checked' : ''}> unCommander only</label></div>` : ''}
      <div class="tp-name"><span class="tp-l">Name:</span><input type="text" class="tp-in" value="${esc(store.get('tabname', ''))}" placeholder="tab name…" spellcheck="false" maxlength="40"></div>`;
    $('.tp-tab', tabPop).addEventListener('click', () => { tabPop.hidden = true; tabOpen('tab'); });      // a browser tab - the + in the tab row adds one there
    if (canWin) {
      /* Chrome and Edge open a normal window when asked for one; Firefox puts it in a tab unless
       * the link is Shift+clicked - so this is a real link, with its new tab ready before the click */
      const tw = $('.tp-win', tabPop); let prep = null;
      const ready = () => { if (!prep) { prep = tabPrep('win'); tw.href = prep.url; } };
      tw.addEventListener('pointerdown', ready); tw.addEventListener('focus', ready);
      tw.addEventListener('click', e => {
        ready(); tabPop.hidden = true;
        if (e.shiftKey) return;                       // the browser's own "open in a new window"
        e.preventDefault(); tabOpen('win', prep); prep = null;
      });
      $('.tp-app', tabPop).addEventListener('click', () => { tabPop.hidden = true; tabOpen('app'); });
    }
    $$('input[name=tp-show]', tabPop).forEach(r => r.addEventListener('change', () => store.set('tabshow', r.value)));
    const inp = $('.tp-in', tabPop);
    inp.addEventListener('input', () => { store.set('tabname', inp.value.trim()); tabShowName(); winDraw(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { tabPop.hidden = true; tabTouch(); root.focus({ preventScroll: true }); } });
    const b = $('.uc-tabcombo').getBoundingClientRect();
    tabPop.hidden = false;
    tabPop.style.left = '0px'; tabPop.style.top = '0px';
    const o = tabPop.getBoundingClientRect();
    tabPop.style.left = (Math.max(6, Math.min(b.left, innerWidth - tabPop.offsetWidth - 6)) - o.left) + 'px';
    tabPop.style.top = (b.bottom + 6 - o.top) + 'px';
    sound.play('click');
  }
  if (tabBtn) tabBtn.addEventListener('click', tabPanel);
  if (tabEl) tabEl.addEventListener('click', () => { tabPanel(); const i = tabPop && $('.tp-in', tabPop); if (i && !tabPop.hidden) { i.focus(); i.select(); } });
  tabShowName();

  /* ---------- the array stopped: what still works, and back to normal when it starts ---------- */
  var ARR_PATH = /^\/mnt\/(?!(disks|remotes|addons|rootshare)(\/|$))[^/]+/;
  function arrayUi() {
    const down = SET.array === false;
    root.classList.toggle('uc-noarray', down);
    let bar = $('.uc-arraybar', root);
    if (down && !bar) {
      bar = document.createElement('div'); bar.className = 'uc-arraybar';
      bar.innerHTML = '<b>The array is stopped</b> - shares, disks and pools come back when it starts. The flash drive (/boot), Unassigned Devices drives and network shares, and the terminal work now.';
      root.prepend(bar);
    } else if (!down && bar) bar.remove();
  }
  let arrayT = 0;
  async function arrayWatch() {
    clearTimeout(arrayT);
    let r; try { r = await api('array_state'); } catch (e) { r = null; }
    if (r) {
      const was = SET.array !== false;
      SET.array = r.up;
      if (r.restored) toast('Your playlists and tool lists were brought back from the copy on the flash drive');
      if (r.up !== was) {
        arrayUi();
        if (r.up) { toast('The array started'); for (const p of panes) if (p.arrayWant) { const w = p.arrayWant; p.arrayWant = null; load(p, w); } }
        else for (const p of panes) if (p.mode === 'dir' && ARR_PATH.test(p.path)) load(p, p.path);
        renderBookmarks();
      }
    }
    arrayT = setTimeout(arrayWatch, SET.array === false ? 30000 : 120000);
  }
  arrayUi();
  setTimeout(arrayWatch, 5000);

  /* ---------- first launch: where unCommander's folder goes (required) ---------- */
  function openSetup() {
    const def = SET.data_dir || '/mnt/user/appdata/uncommander';
    openDlg('Welcome to unCommander', `<div class="su-intro">unCommander keeps a few working files: <b>History</b> (so changes can be undone), the <b>lists</b> its tools make (playlists, Radarr, TV, Lidarr), and <b>ffmpeg</b> when a video first needs it. None of it is needed to boot, so it goes on your array or a pool - <b>not on the flash drive</b>, which isn't made for constant writing.</div>
      <label class="tg-af"><span>Where should unCommander keep its files?</span><span class="pl-inrow"><input type="text" class="su-dir" value="${esc(def)}" spellcheck="false"><button type="button" class="uc-btn su-brw">Browse…</button></span></label>
      <div class="fb-box su-fb" hidden></div>
      <div class="su-res muted">Checking…</div>
      <div class="muted su-more">Your settings stay on the flash drive, so they're there before the array starts. Once a day, if anything changed, a small copy of the lists (a few KB) is saved there too, so unRAID's flash backup includes them. You can change this folder later in Settings › Trash &amp; History.</div>`,
      [{ label: 'Continue', primary: true, run: async () => {
        const d = $('.su-dir', dlg).value.trim();
        let r; try { r = await api('data_set', { path: d }); } catch (e) { toast(e.message, true); return false; }
        SET = Object.assign(SET, r.settings, { first: false }); applyPractice(); setTimeout(practiceIntro, 50); return true;
      } }], 'wide sticky su-dlg');
    const x = $('.dlg-x', dlg); if (x) x.remove();
    const inp = $('.su-dir', dlg), res = $('.su-res', dlg); let t = 0, brw = null;
    const check = async () => {
      let r; try { r = await api('data_check', { path: inp.value.trim() }); } catch (e) { r = { ok: false, msg: e.message }; }
      res.className = 'su-res ' + (r.ok ? (r.hdd ? 'su-warn' : 'su-ok') : 'su-bad'); res.textContent = (r.ok ? (r.hdd ? '⚠ ' : '✓ ') : '✕ ') + r.msg;
      const b = $$('.dlg-foot .uc-btn', dlg).pop(); if (b) b.disabled = !r.ok;
    };
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(check, 350); });
    $('.su-brw', dlg).addEventListener('click', () => { const fb = $('.su-fb', dlg); fb.hidden = !fb.hidden; if (!fb.hidden && !brw) brw = folderBrowser(fb, '/mnt/user', { onDir: d => { inp.value = d; check(); } }); });
    check();
  }
  if (SET.first) setTimeout(openSetup, 300);
  /* a new install starts in Practice mode: say what that means, and how to leave it */
  function practiceIntro() {
    openDlg('You\'re in Practice mode', `<div class="su-intro"><b>Nothing can be deleted, moved or overwritten</b> while you get to know unCommander - look around, open, view and copy as much as you like.</div>
      <div class="st-safe"><b>Works</b><span>Browsing, View, Find, selecting, Copy (files already at the destination are always kept), New Folder, looking at files in the editor</span>
        <b>Locked</b><span>Delete, Move, Rename, Permissions, Restore from trash, saving edits, replacing files when copying</span></div>
      <div class="su-more">When you're ready: <b>Settings › Safety &amp; trash</b>, untick <b>Practice mode</b>, and Save. The <b>🔒 Practice mode</b> pill at the top shows while it's on - click it to get there too.</div>`,
      [{ label: 'Open Settings', run: () => { openSettings('safe'); return false; } }, { label: 'Start exploring', primary: true }], 'wide su-dlg');
  }

  /* ---------- start ---------- */
  root.style.setProperty('--fs', String(fontScale())); root.classList.toggle('uc-big', fontScale() >= 1.1);
  ROW = readRow();
  saveSort();
  setActive(active);
  Promise.all(panes.map(p => load(p, p.path).then(() => p.error && p.path !== '/mnt' && load(p, '/mnt')))).then(() => {
    booting = false; watchArm();
    /* the music library was open: open it again when both panes are still in it */
    const mr = store.get('mus', null);
    if (mr && panes[0].mode === 'dir' && panes[0].path === mr && panes[1].mode === 'dir' && (panes[1].path === mr || panes[1].path.startsWith(mr + '/'))) {
      mus = { root: mr, busy: false, q: [], i: -1, now: null }; root.classList.add('uc-mus');
      panes.forEach(q => { if (q.gal) galSet(q, false); q.galItems = null; draw(q); }); musSync();
    } else if (mr) store.set('mus', null);
    const g = panes.find(p => store.get('gal' + p.i, false) && p.mode === 'dir' && !p.root);
    if (g) galSet(g, true);
  });
  pollJobs('init');
  /* unRAID draws its own title bar (icon + page name) above every page.
   * unCommander has its own top bar, so hide that one and give the space to
   * the lists. Walk up a few levels to find it, whatever the theme's markup. */
  (function hideUnraidTitle() {
    let el = root;
    for (let d = 0; d < 6 && el && el !== document.body; d++, el = el.parentElement) {
      let sib = el.previousElementSibling;
      while (sib && /^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) sib = sib.previousElementSibling;
      if (sib && sib.classList.contains('title') && sib.textContent.trim().length < 80) { sib.style.display = 'none'; return; }
    }
  })();

  /* Fit the app to the window below the unRAID header (and above its footer
   * bar, if that's pinned), so the top bars and function keys never scroll
   * away. Only the file lists change size. */
  /* Use the whole window width: unRAID's "boxed" page width (and any other
   * width cap on the boxes around unCommander) is lifted on this page only. */
  for (let e = root.parentElement; e && e !== document.documentElement; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.maxWidth !== 'none') e.style.setProperty('max-width', 'none', 'important');
  }
  function fit() {
    const top = root.getBoundingClientRect().top + window.scrollY;
    const ft = document.getElementById('footer');
    const foot = ft && getComputedStyle(ft).position === 'fixed' ? ft.offsetHeight : 0;
    root.style.height = Math.max(300, window.innerHeight - top - foot - 3) + 'px';
    /* A very short window can't fit everything: grow just enough that nothing
     * is cut off, and let the page scroll instead. */
    if (root.scrollHeight > root.clientHeight + 1) root.style.height = (root.scrollHeight + 2) + 'px';
    panes.forEach(p => { drawRows(p); queueStat(p); });
  }
  fit();
  let fitT;
  const refit = () => { clearTimeout(fitT); fitT = setTimeout(fit, 60); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  window.addEventListener('load', refit);
  root.focus({ preventScroll: true });
})();
