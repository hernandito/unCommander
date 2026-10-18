/* unCommander — two-pane file manager for the unRAID webGUI.
 * Core rule: never stat a file you are not about to draw. Listings arrive as
 * names + types only; sizes, dates and perms are fetched for visible rows. */
(function () {
  'use strict';
  const root = document.getElementById('uc');
  /* touch or mouse? (row hover shading is for mice only - see .uc-touch in the CSS) */
  root.addEventListener('touchstart', () => root.classList.add('uc-touch'), { passive: true, capture: true });
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
  window.addEventListener('unhandledrejection', ev => { const r = ev.reason; if (benign(r && (r.name || r.message))) return; errBar(errText(r, 'async')); });
  const API = '/plugins/uncommander/include/api.php';
  const CSRF = root.dataset.csrf || (window.csrf_token || '');
  let ROW = 25;
  let booting = true;          // true until both panes have loaded once
  const UP_ICON = '<svg class="up" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 3 7.5h3.3V13.5h3.4V7.5H13z"/></svg>';
  let SET = window.UC_SETTINGS || { bookmarks: [], css: '', sounds: {}, trash_days: 30 };
  const $ = (s, el = root) => el.querySelector(s);
  const $$ = (s, el = root) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('uc.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('uc.' + k, JSON.stringify(v)); } catch (e) {} },
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
  const A = () => panes[active], B = () => panes[1 - active];
  const fullPath = (p, it) => it.abs || join(p.path, it.n);

  /* ---------- columns each pane shows ---------- */
  const COL_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"/><circle cx="5" cy="3.5" r="1.4" fill="currentColor"/><circle cx="10.5" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="12.5" r="1.4" fill="currentColor"/></svg>';
  const COLS = [['size', 'Size', '52px'], ['disk', 'Disk', '62px'], ['date', 'Date', '80px'], ['mode', 'Mode', '38px']];
  /* Disk is off unless switched on, and only shows where it means something:
   * /mnt/user (and search results, which can be anywhere). */
  const colWanted = (c, k) => k === 'disk' ? c.disk === true : c[k] !== false;
  const userView = p => p.mode !== 'dir' || /^\/mnt\/user0?(\/|$)/.test(p.path || '');
  const showsDisk = p => colWanted(store.get('cols' + p.i, {}), 'disk') && userView(p);
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
      <div class="uc-pane-head"><span class="uc-headl"><button class="uc-back" disabled title="Back to the folder you were in before" aria-label="Back"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button><span class="side"></span><button class="uc-fwd" disabled title="Forward" aria-label="Forward"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button><span class="act"></span></span><button class="uc-endfind" hidden title="Leave the search results and go back to the folder">✕ Close results</button><button class="uc-cancel" hidden title="Stop waiting for this folder">✕ Cancel</button><span class="count"></span></div>
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
    $('.uc-cancel', p.el).addEventListener('click', () => cancelLoad(p));
    p.hist = store.get('hist' + p.i, []); p.fwd = store.get('fwd' + p.i, []);
    $('.uc-back', p.el).addEventListener('click', e => { e.stopPropagation(); goBack(p); });
    $('.uc-fwd', p.el).addEventListener('click', e => { e.stopPropagation(); goForward(p); });
    p.list.addEventListener('scroll', () => { drawRows(p); queueStat(p); }, { passive: true });
    p.el.addEventListener('mousedown', () => setActive(p.i));
    p.list.addEventListener('click', e => onRowClick(p, e));
    /* Remember whether the last press was a finger or a mouse — taps get
     * tablet behaviour (tap to pick, tap again to open). */
    p.list.addEventListener('pointerdown', e => { p.pointer = e.pointerType; });
    /* iPad Safari runs in "desktop" mode and can report finger taps as mouse
     * pointers — but it can't fake touch events, so those are the real tell. */
    p.list.addEventListener('touchstart', () => { p.touchAt = Date.now(); }, { passive: true });
    p.list.addEventListener('dblclick', e => {
      const r = e.target.closest('.uc-row'); if (!r || e.target.closest('.col-sel')) return;
      if (tabletTap(p)) return;
      if (Date.now() - (p.navAt || 0) < 450) return;   // folder already opened on the first click
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
    if (p.mode === 'find') { p.trailEl.innerHTML = `<span class="tr-find">Find: ${esc(p.findInfo.label)}</span>`; return; }
    const here = p.path;
    const full = p.trail && p.trail.startsWith(here === '/' ? '/' : here + '/') ? p.trail : here;
    const segs = full.split('/').filter(Boolean);
    let html = sysOn() ? `<span class="tr-seg tr-root${here === '/' ? ' here' : ''}" data-path="/" title="/ - the whole system">/</span>`
      : `<span class="tr-seg tr-root" data-path="/mnt" title="/mnt - shares, disks, pools and Unassigned Devices">/</span>`, acc = '';
    segs.forEach((s, k) => {
      acc += '/' + s;
      const ahead = acc.length > here.length;
      if (k) html += `<span class="tr-sep${ahead ? ' ahead' : ''}">/</span>`;
      html += `<span class="tr-seg${ahead ? ' ahead' : ''}${acc === here ? ' here' : ''}" data-path="${esc(acc)}">${esc(s)}</span>`;
    });
    p.trailEl.innerHTML = html;
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
    active = i; store.set('active', i);
    panes.forEach(p => {
      p.el.classList.toggle('active', p.i === i);
      p.crumb.classList.toggle('active', p.i === i);
      p.pathEl.classList.toggle('active', p.i === i);
      $('.side', p.el).textContent = p.i ? 'Right' : 'Left';
      $('.act', p.el).textContent = p.i === i ? '· active' : '';
      drawRows(p);
    });
    if (cmpOn) tickCompare();
    const arrow = i === 0 ? '→' : '←';
    $('[data-act="copy"] .t').textContent = i === 0 ? `Copy ${arrow}` : `${arrow} Copy`;
    $('[data-act="move"] .t').textContent = i === 0 ? `Move ${arrow}` : `${arrow} Move`;
    updateChrome();
  }

  /* ---------- loading ---------- */
  /* Only the newest navigation in a pane counts: opening another folder (or a
   * shortcut, or ..) while one is still loading replaces it instead of queuing
   * behind it. A slow folder shows "Opening… 5 s" with a Cancel button. */
  const LOAD_TIMEOUT = 60000;
  async function load(p, path, focusName) {
    path = (path || '/').replace(/\/+$/, '') || '/';
    if (p.ctl) p.ctl.abort();
    const ctl = p.ctl = new AbortController(), seq = p.seq = (p.seq || 0) + 1;
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; ctl.abort(); }, LOAD_TIMEOUT);
    p.navAt = Date.now();
    p.loading = true; p.error = null; if (!p.quiet) { draw(p); waitStart(p, path); }
    const t0 = performance.now();
    try {
      const r = await api('list', Object.assign({ path }, watchOn() ? { watch: '1' } : {}, path === '/' && sysOn() ? { sys: '1' } : {}), ctl.signal);
      if (seq !== p.seq) return;
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
      p.path = r.path; p.sig = r.sig || null; p.free = r.free; p.trash = r.trash; p.origins = r.origins || null;
      /* keep the deeper folders you came from (shown greyed) while you're
       * somewhere above them; going anywhere else starts a new trail */
      if (!(p.trail && (p.trail === r.path || p.trail.startsWith(r.path === '/' ? '/' : r.path + '/')))) p.trail = r.path;
      store.set('trail' + p.i, p.trail);
      p.all = r.items.map(([n, t, abs]) => abs ? { n, t, abs } : { n, t });
      p.root = !!r.root;
      p.stats = new Map(); p.dirSizes = new Map(); p.locs = new Map(); p.sel.clear(); p.cursor = 0; p.armed = null;
      applyCols(p);
      store.set('path' + p.i, p.path);
      if (!p.quiet) { if (p === A() && document.activeElement !== jumpBox) clearJump(); p.list.scrollTop = 0; }
      await applySort(p, true);
      if (focusName) { const ix = p.items.findIndex(it => it.n === focusName); if (ix >= 0) moveCursor(p, ix, true); }
      /* first load after coming back to the page: put the ticks and cursor back */
      if (booting && !p.selRestored) {
        p.selRestored = true;
        const saved = store.get('sel' + p.i, null);
        if (saved && saved.path === p.path) {
          const want = new Set(saved.names || []);
          p.items.forEach((it, i) => { if (!it.up && want.has(it.n)) p.sel.add(i); });
          if (saved.cursor) { const ix = p.items.findIndex(it => it.n === saved.cursor); if (ix >= 0) moveCursor(p, ix, true); }
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
    p.loading = false; draw(p); updateChrome();
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

  function filtered(p) {
    return p.all.filter(it => showHidden || p.mode !== 'dir' || !it.n.startsWith('.'));
  }

  async function applySort(p, fresh) {
    const keep = !fresh && p.items[p.cursor] ? p.items[p.cursor] : null;
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
    items.sort((a, b) => (isDir(b) - isDir(a)) || (sortRev ? -cmp(a, b) : cmp(a, b)));
    if (p.mode === 'dir' && p.path !== '/' && (sysOn() || p.path !== '/mnt')) items.unshift({ n: '..', t: 'd', up: true });   // the top: /mnt, or / in the system view
    if (p.mode === 'find') items.unshift({ n: '..', t: 'd', up: true, exit: true });
    p.items = items;
    p.cursor = keep ? Math.max(0, items.indexOf(keep)) : Math.min(p.cursor, Math.max(0, items.length - 1));
    draw(p);
    if (missing) {
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
    p.spacer.style.height = (p.items.length * ROW) + 'px';
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
    const [a, b] = visibleRange(p);
    let html = '';
    if (!p.items.length && !p.loading) {
      html = `<div class="uc-empty ${p.error ? 'uc-error' : ''}">${esc(p.error || (p.mode === 'find' ? 'No matches.' : 'This folder is empty.'))}</div>`;
    }
    for (let i = a; i < b; i++) {
      const it = p.items[i];
      const s = it.up ? null : p.stats.get(it.abs || it.n);
      const isDir = it.t === 'd' || (it.t === 'l' && s && s.d);
      const sel = p.sel.has(i);
      const cs = p.cmp && !it.up ? p.cmp.get(it.n) : null;
      const cls = 'uc-row' + (sel ? ' sel' : '') + (i === p.cursor ? ' cursor' : '') + (cs ? ' cmp-' + cs : '') + (p.flash && !it.up && p.flash.has(it.n) ? ' uc-new' : '');
      const perm = s && s.p ? s.p : (it.up ? '—' : '');
      const odd = s && s.p && (s.o !== 'nobody' || s.g !== 'users');
      html += `<div class="${cls}" data-idx="${i}" style="top:${i * ROW}px">
        <div class="col-sel">${it.up ? '' : `<span class="box${sel ? ' on' : ''}"></span>`}</div>
        <div class="nm col-name${isDir ? ' dir' : ''}${it.t === 'l' ? ' link' : ''}${it.up ? ' up' : ''}" title="${esc(it.n)}${s && s.l ? ' → ' + esc(s.l) : ''}">${it.up ? UP_ICON : ''}${it.exit ? 'Back to ' + esc(p.findInfo.start) : binLabel(p, it) || esc(it.n)}${cs && CMP_TAG[cs] ? `<span class="cmp-tag ${cs}">${CMP_TAG[cs]}</span>` : ''}</div>
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
      const names = [...p.sel].map(i => p.items[i]).filter(it => it && !it.up).map(it => it.n);
      const cur = p.items[p.cursor];
      store.set('sel' + p.i, { path: p.path, names: names.slice(0, 5000), cursor: cur && !cur.up ? cur.n : null });
    }), 250);
  }
  function updateSelInfo(p) {
    if (!booting) saveSel();
    const el = $('.selinfo', p.el);
    const total = p.items.filter(it => !it.up).length;
    if (p.sel.size) {
      let bytes = 0, known = true;
      for (const i of p.sel) {
        const it = p.items[i], s = p.stats.get(it.abs || it.n), ds = dirSize(p, it);
        if (ds != null) bytes += ds; else if (s && s.s != null) bytes += s.s; else if (!(s && s.d)) known = false;
      }
      el.innerHTML = `Selected <b>${p.sel.size} of ${total.toLocaleString()}</b>${bytes ? ' · ' + fmtBytes(bytes) + (known ? '' : '+') : ''}`;
      /* the footer is hidden, so the pane header shows the selection instead of the item count */
      if (!p.loading) $('.count', p.el).textContent = `${p.sel.size} of ${total.toLocaleString()} selected${bytes ? ' · ' + fmtBytes(bytes) + (known ? '' : '+') : ''}`;
    } else {
      el.textContent = p.mode === 'find' ? `in ${p.findInfo.start}` : '';
      if (!p.loading) $('.count', p.el).textContent = p.mode === 'find' ? `${total} search results` : `${total.toLocaleString()} items`;
    }
    if (!p.loading) $('.freeinfo', p.el).textContent = p.free != null ? `${fmtBytes(p.free)} free` : '';
  }
  function updateChrome() {
    const p = A();
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
    if (Date.now() - (p.navAt || 0) < 450) return;   // swallow the 2nd click of a double-click after we already navigated
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
      drawRows(p); updateSelInfo(p);
      if (!store.get('tapHint', false)) { store.set('tapHint', true); toast('Tap again to open'); }
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
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey && lastClick != null) selectRange(p, lastClick, i, !p.sel.has(i));
      else toggle(p, i);
      lastClick = i;
    } else if (e.shiftKey && lastClick != null) {
      selectRange(p, lastClick, i, true);
    } else {
      lastClick = i;
    }
    p.cursor = i; drawRows(p); updateSelInfo(p);
    if (it && it.up) return;
  }
  function toggle(p, i) { if (p.items[i] && !p.items[i].up) { p.sel.has(i) ? p.sel.delete(i) : p.sel.add(i); } }
  function selectRange(p, a, b, on) {
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!p.items[i].up) on ? p.sel.add(i) : p.sel.delete(i);
  }
  function moveCursor(p, i, center) {
    p.armed = null;
    p.cursor = Math.max(0, Math.min(p.items.length - 1, i));
    const top = p.cursor * ROW, h = p.list.clientHeight;
    if (center) p.list.scrollTop = Math.max(0, top - h / 2);
    else if (top < p.list.scrollTop) p.list.scrollTop = top;
    else if (top + ROW > p.list.scrollTop + h) p.list.scrollTop = top + ROW - h;
    drawRows(p); queueStat(p);
  }
  function openItem(p, i) {
    const it = p.items[i]; if (!it) return;
    if (it.up) return p.mode === 'find' ? load(p, p.findInfo.start) : load(p, parent(p.path), base(p.path));
    const s = p.stats.get(it.abs || it.n);
    if (it.t === 'd' || (it.t === 'l' && s && s.d)) return load(p, fullPath(p, it));
    if (p.mode === 'find') return load(p, parent(it.abs), base(it.abs));
    if (it.t === 'l' && !s) return load(p, fullPath(p, it));
    act('view');
  }
  /* Operations act on the selection, or on the cursor row if nothing is ticked. */
  function targets(p = A()) {
    const idx = p.sel.size ? [...p.sel].sort((a, b) => a - b) : [p.cursor];
    return idx.map(i => p.items[i]).filter(it => it && !it.up).map(it => ({ it, path: fullPath(p, it) }));
  }

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
  /* an ✕ inside the Jump and pattern boxes to empty them (shown only when there's text) */
  [[jumpBox, 'j', () => { clearJump(); jumpBox.focus(); }], [$('.uc-pat'), 'p', () => { const i = $('.uc-pat'); i.value = ''; i.focus(); }]].forEach(([inp, k, clear]) => {
    if (!inp) return;
    const w = document.createElement('span'); w.className = 'uc-clrwrap ' + k;
    inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
    w.insertAdjacentHTML('beforeend', '<button type="button" class="uc-clr" tabindex="-1" title="Clear" aria-label="Clear">✕</button>');
    $('.uc-clr', w).addEventListener('pointerdown', e => e.preventDefault());       // keep the keyboard where it is
    $('.uc-clr', w).addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); clear(); });
  });
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
  function clearJump() { prefix = ''; jumpBox.value = ''; jumpBox.classList.remove('miss'); }
  function typeAhead(ch) {
    prefix += ch;
    jumpBox.value = prefix;               // show what's been typed
    clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => { if (document.activeElement !== jumpBox) clearJump(); }, 1200);
    jumpTo(prefix);
  }
  jumpBox.addEventListener('input', () => { clearTimeout(prefixTimer); jumpTo(jumpBox.value); });
  jumpBox.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); jumpTo(jumpBox.value, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); jumpTo(jumpBox.value, -1); }
    else if (e.key === 'Enter') {               // open the item it landed on; keep typing for the next level
      e.preventDefault();
      const p = A(), it = p.items[p.cursor];
      if (it && jumpBox.value) { clearJump(); openItem(p, p.cursor); }
    }
    else if (e.key === 'Escape') { clearJump(); jumpBox.blur(); root.focus({ preventScroll: true }); }
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
    /* Ctrl/Alt/Cmd + an F-key belongs to the browser (Ctrl+F5 = reload the page) */
    if (/^F\d+$/.test(e.key) && (e.ctrlKey || e.altKey || e.metaKey)) return;
    const fk = { F2: 'view', F3: 'edit', F4: 'rename', F5: 'copy', F6: 'move', F7: 'mkdir', F8: 'delete', F9: 'find', F10: 'perms', Delete: 'delete' }[e.key];
    if (fk) { e.preventDefault(); sound.play('click'); return act(fk); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); return doUndo(); }
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
      case ' ': if (!prefix) { e.preventDefault(); toggle(p, p.cursor); drawRows(p); updateSelInfo(p); return; }
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return selectCmd('all'); }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAhead(e.key); }
  });
  root.addEventListener('mousedown', e => { if (!e.target.closest('input, select, textarea, button, .uc-trail')) setTimeout(() => root.focus({ preventScroll: true }), 0); });

  /* ---------- top controls ---------- */
  $('.uc-swap').addEventListener('click', () => { const a = panes[0].path, b = panes[1].path; load(panes[0], b); load(panes[1], a); });
  $('.uc-same').addEventListener('click', () => load(B(), A().mode === 'find' ? A().findInfo.start : A().path));
  $('.uc-goto').addEventListener('change', e => { if (e.target.value) load(A(), e.target.value); e.target.value = ''; });

  /* ---------- the top folder: /mnt (shares) or / (the whole system, Settings > Safety) ---------- */
  const sysOn = () => !!SET.sysmode && store.get('sysView', false) === true;
  const inShares = path => path === '/mnt' || path.startsWith('/mnt/') || path === '/boot' || path.startsWith('/boot/');
  function applySys(switching) {
    const on = sysOn(), seg = $('.uc-sysseg');
    seg.hidden = !SET.sysmode;
    $$('.sys-b', seg).forEach(b => { const me = (b.dataset.sys === '1') === on; b.classList.toggle('on', me); b.setAttribute('aria-pressed', me); });
    root.classList.toggle('uc-sys', on);
    const go = $('.uc-goto'); let o = $('option[value="/"]', go);
    if (on && !o) { o = document.createElement('option'); o.value = '/'; o.textContent = '/ — the whole system'; go.insertBefore(o, go.options[1]); }
    if (!on && o) o.remove();
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

  /* ---------- More row: one button slides between the F-keys and More ---------- */
  const fkeys = $('.uc-fkeys'), fkTog = $('.uc-fk-toggle');
  let slideT;
  function setMore(on, animate) {
    if (animate) { fkeys.classList.add('sliding'); clearTimeout(slideT); slideT = setTimeout(() => fkeys.classList.remove('sliding'), 450); }
    fkeys.classList.toggle('more', on);
    fkTog.title = on ? 'Back to the F-keys' : 'More buttons';
    fkTog.setAttribute('aria-label', fkTog.title);
    store.set('more', on);
  }
  setMore(!!store.get('more', false), false);
  fkTog.addEventListener('click', () => { sound.play('click'); setMore(!fkeys.classList.contains('more'), true); });
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
    D.className = 'uc-dlg' + (wide === true ? ' wide' : wide ? ' ' + wide : '');
    D.extraKey = null; D.beforeClose = null;
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
    D.beforeClose = null; D.extraKey = null;
    M.hidden = true; D.innerHTML = '';
    if (D === tdlg) { D.tool = null; toolPill.hidden = true; }
    root.focus({ preventScroll: true });
  }
  const openDlg = (...a) => openDlgIn(dlg, modal, ...a);
  const closeDlg = () => closeDlgIn(dlg, modal);
  const openToolDlg = (kind, ...a) => { if (!tmodal.hidden || tdlg.tool) closeDlgIn(tdlg, tmodal); openDlgIn(tdlg, tmodal, ...a); tdlg.tool = kind; };
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
  function unparkTool() { if (!tdlg.tool) return; toolPill.hidden = true; tmodal.hidden = false; tdlg.focus({ preventScroll: true }); }
  toolPill.addEventListener('click', unparkTool);
  modal.addEventListener('mousedown', e => { if (e.target === modal && !dlg.sticky) closeDlg(); });

  let toastTimer;
  function toast(msg, err, withUndo) {
    const t = $('.uc-toast'); t.textContent = msg; t.className = 'uc-toast' + (err ? ' err' : ''); t.hidden = false;
    if (withUndo) {
      const a = document.createElement('button'); a.className = 't-undo'; a.textContent = 'Undo';
      a.addEventListener('click', () => { t.hidden = true; root.focus({ preventScroll: true }); doUndo(); });
      t.appendChild(a);
    }
    if (err) sound.play('error');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, err ? 6000 : withUndo ? 10000 : 2600);
  }

  /* ---------- Undo (the most recent rename, move, delete or new folder) ----------
   * The confirmation message carries an Undo link for 10 s; the Undo button
   * in the More row (or Ctrl/Cmd+Z) works until something else replaces it. */
  let undoItem = null;
  function setUndo(u) { undoItem = u; drawUndoBtn(); }
  function drawUndoBtn() {
    const b = $('.uc-fk[data-act="undo"]'); if (!b) return;
    b.classList.toggle('off', !undoItem);
    b.title = undoItem ? `Undo: ${undoItem.label}` : 'Nothing to undo yet';
  }
  function done(msg, u) { setUndo(u); toast(msg, false, true); }
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
  async function doUndo() {
    if (!undoItem) return toast('Nothing to undo');
    const u = undoItem;
    for (const id of [].concat(u.job || [])) { const j = lastJobs.find(x => x.id === id); if (j && ['running', 'queued'].includes(j.state)) return toast('Wait for it to finish, then undo it', true); }
    setUndo(null);
    sound.play('back');
    try { await u.run(); } catch (e) { toast(`Couldn't undo: ${e.message}`, true); }
  }
  drawUndoBtn();
  /* Undo a copy: the new copies go to the trash, replaced files come back */
  async function undoCopy(ids) {
    const r = await api('undo_job', { ids });
    const parts = [r.removed && `${r.removed.toLocaleString()} cop${r.removed === 1 ? 'y' : 'ies'} moved to the trash`,
                   r.restored && `${r.restored.toLocaleString()} replaced file${r.restored === 1 ? '' : 's'} put back`].filter(Boolean);
    toast(parts.length ? 'Undone: ' + parts.join(', ') : 'Undone - nothing needed changing');
    refreshBoth();
  }
  /* Asked before any copy replaces files. */
  function confirmReplace(c, what, go) {
    const n = c.count, keep = SET.trash !== false, days = SET.trash_days;
    const list = c.sample.map(x => `<div class="mono">${esc(x)}</div>`).join('') + (n > c.sample.length ? `<div class="muted">…and ${(n - c.sample.length).toLocaleString()} more${c.cut ? ' (stopped counting - there may be more)' : ''}</div>` : '');
    openDlg(`Replace ${n.toLocaleString()} file${n === 1 ? '' : 's'}?`, `
      <div>${esc(what)} will overwrite ${n === 1 ? 'a file' : `${n.toLocaleString()} files`} already there (${fmtBytes(c.bytes)}):</div>
      <div class="cr-list">${list}</div>
      <div class="warnbox warn">${keep
        ? `<b>The files at the destination get overwritten.</b> unCommander keeps the old versions in the trash on that share or disk, so <b>Undo</b> (in the More row) can put them back straight after. Once the trash is purged${days ? ` (after ${days} day${days === 1 ? '' : 's'})` : ''} - or if another action takes Undo's place - <b>this cannot be undone</b> except by restoring from the trash by hand.`
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
    const ticked = new Set([...p.sel].map(i => p.items[i]).filter(it => it && !it.up).map(it => it.n));
    const cur = p.items[p.cursor], curName = cur && !cur.up ? cur.n : null;
    const before = new Set(p.all.map(it => it.n)), top = p.list.scrollTop;
    p.quiet = true;
    try { await load(p, path); } finally { p.quiet = false; }
    if (p.error || p.path !== path || p.mode !== 'dir') return;
    p.items.forEach((it, i) => { if (!it.up && ticked.has(it.n)) p.sel.add(i); });
    if (curName) { const ix = p.items.findIndex(it => it.n === curName); if (ix >= 0) p.cursor = ix; }
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
      list = p.items.filter(it => !it.up && it.t !== 'd' && IMG_EXT.has((it.n.split('.').pop() || '').toLowerCase())).map(it => join(p.path, it.n));
    let i = Math.max(0, list.indexOf(path));
    const cur = () => list[i];
    openDlg(base(path), `
      <div class="mv-stage"><img class="mv-img" alt=""></div>
      <div class="mv-meta"><span class="mv-name mono"></span><span class="mv-info muted"></span></div>`,
      [...backBtn,
       { label: '‹ Prev', run: () => { show(i - 1); return false; } },
       { label: 'Next ›', run: () => { show(i + 1); return false; } },
       newTab, { label: 'Close', primary: true }], 'full');
    const stage = $('.mv-stage', dlg), img = $('.mv-img', dlg);
    const btns = $$('.dlg-foot .uc-btn', dlg), off = backBtn.length;
    function show(n) {
      if (n < 0 || n >= list.length) return;
      i = n;
      stage.classList.remove('zoom'); stage.classList.add('loading');
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
    img.addEventListener('error', () => { stage.classList.remove('loading'); $('.mv-info', dlg).textContent = "This browser can't show this image type."; });
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

  /* ---------- viewer (F2) ---------- */
  /* if anything in the viewer or editor goes wrong, say so instead of doing nothing */
  async function openViewer(...a) { try { return await viewFile(...a); } catch (e) { console.error(e); toast(`Couldn't open it: ${e.message || e}`, true); errBar(errText(e, 'View')); } }
  async function viewFile(path, o = {}) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (IMG_EXT.has(ext) || ext === 'pdf') return openMedia(path, o);
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
      <div class="vw-top"><div class="vw-meta mono">${esc(path)} · ${fmtBytes(v.size)}${v.partial ? ` · lines ${v.first.toLocaleString()}–${last.toLocaleString()}${v.more ? ' (file continues)' : ''}` : ''}</div>${o.re ? '' : hlPicker(lang)}</div>
      <div class="vw" style="--gw:${String(last).length + 1}ch">${body}</div>`,
      [...backBtn, { label: 'Edit', run: edit }, { label: 'Close', primary: true }], 'full');
    const box = $('.vw', dlg), hit = $('.vw-l.hit', box);
    const pick = $('.hl-pick select', dlg);
    if (pick) pick.addEventListener('change', () => { lang = pick.value; store.set(hlKey(path), lang); const top = box.scrollTop; box.innerHTML = render(); box.scrollTop = top; box.focus({ preventScroll: true }); });
    if (hit) box.scrollTop = hit.offsetTop - box.clientHeight / 3;
    box.tabIndex = 0; box.focus({ preventScroll: true });
    dlg.extraKey = e => { if (e.key === 'F3') { e.preventDefault(); edit(); } };
  }

  /* ---------- editor (F3) ---------- */
  async function openEditor(...a) { try { return await editFile(...a); } catch (e) { console.error(e); toast(`Couldn't open it: ${e.message || e}`, true); errBar(errText(e, 'Edit')); } }
  async function editFile(path, o = {}) {
    let f;
    try { f = await api('open_edit', { path }); } catch (e) { return toast(e.message, true); }
    let saved = f.text, mtime = f.mtime;
    const backBtn = o.back ? [{ label: '‹ Results', run: () => { if (dlg.beforeClose && !dlg.beforeClose()) return false; dlg.beforeClose = null; o.back(); return false; } }] : [];
    openDlg(`Edit · ${base(path)}`, `
      <div class="vw-top"><div class="vw-meta mono">${esc(path)}${SET.practice ? ' · <span class="uc-error">practice mode - look only, saving is locked</span>' : f.writable ? '' : ' · <span class="uc-error">read-only — saving will fail</span>'}${f.crlf ? ' · Windows line endings (kept)' : ''}</div>${f.text.length > HL_EDIT_MAX ? '<span class="hl-pick muted" title="Colours are switched off for very large files so typing stays fast">No colours (large file)</span>' : hlPicker(hlLang(path, f.text))}</div>
      <div class="ed-wrap"><div class="ed-hl" hidden></div><pre class="ed-pre" aria-hidden="true"></pre><textarea class="ed" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" wrap="off"></textarea></div>
      <div class="ed-status mono"><span class="ed-pos"></span><span class="ed-dirty"></span></div>`,
      [...backBtn, { label: 'Close' }, ...(SET.practice ? [] : [{ label: 'Save', primary: true, run: async () => { await save(); return false; } }])], 'full');
    const ta = $('.ed', dlg);
    ta.value = f.text;
    /* colours: a <pre> drawn behind the textarea (whose own text is made
     * transparent), redrawn as you type and scrolled in step with it */
    const pre = $('.ed-pre', dlg), wrap = $('.ed-wrap', dlg);
    let lang = f.text.length > HL_EDIT_MAX ? 'none' : hlLang(path, f.text), hlRaf = 0;
    const paint = () => {
      cancelAnimationFrame(hlRaf);
      hlRaf = requestAnimationFrame(() => {
        const on = lang !== 'none' && ta.value.length <= HL_EDIT_MAX;
        let h = null;
        if (on) { try { h = getHL().html(ta.value, lang); } catch (e) { h = null; } }
        wrap.classList.toggle('hl-on', h != null);
        if (h != null) { pre.innerHTML = h + '\n'; pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
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
    if (o.line) {
      hl.hidden = false; placeHl();
      ta.addEventListener('scroll', placeHl);
      ta.addEventListener('input', () => { hl.hidden = true; ta.removeEventListener('scroll', placeHl); }, { once: true });
    }
    status();
    dlg.extraKey = e => {
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
      <div class="cb-dir" title="Copy direction">${src.i ? '←' : '→'}</div>
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
    panes.forEach(p => { drawRows(p); queueStat(p); });
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
    const ids = [];
    if (toR.length) ids.push((await api('job_start', { type: 'sync', root: ct.L, dest: ct.R, rel: toR.map(x => x.p), overwrite: over ? 1 : 0 })).job);
    if (toL.length) ids.push((await api('job_start', { type: 'sync', root: ct.R, dest: ct.L, rel: toL.map(x => x.p), overwrite: over ? 1 : 0 })).job);
    if (cmpOn) endCompare();
    if (over && SET.trash === false) setUndo(null); else setUndo({ label: `Compare copy (${toR.length + toL.length} item${toR.length + toL.length === 1 ? '' : 's'})`, job: ids, run: () => undoCopy(ids) });
    openProgress(ids[0]);
    if (progress) ids.forEach(i => progress.ids.add(i));
    return false;          // the progress window replaces this one
  }
  function endCompare(quiet) {
    if (!cmpOn) return;
    cmpOn = false;
    panes.forEach(p => { p.cmp = null; if (!quiet) p.sel.clear(); drawRows(p); updateSelInfo(p); });
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
    const items = t.map(x => ({ n: x.it.n, dir: x.it.t === 'd', m: (p.stats.get(x.it.abs || x.it.n) || {}).m || 0, on: true }));
    const renaming = new Set(items.map(i => i.n));
    const others = new Set(p.all.map(i => i.n).filter(n => !renaming.has(n)));   // names staying put in this folder
    const st = { mode: 'replace', find: '', repl: '', mcase: false, first: false, regex: false, keepExt: true,
                 addText: '', addWhere: 'before', pattern: '[name] [n]', start: 1, digits: 2, order: 'name', caseTo: 'lower' };
    const folder = base(p.path);
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
      try { r = await api('batch_rename', { path: p.path, pairs }); }
      catch (e) { toast(e.message, true); drawRows(); return false; }
      const dir = p.path;
      closeDlg();
      await brReload(p, dir, pairs.map(x => x[1]));
      done(`Renamed ${r.count} item${r.count === 1 ? '' : 's'}`, { label: `Batch rename of ${r.count}`, run: async () => {
        await api('batch_rename', { path: dir, pairs: pairs.map(([a, b]) => [b, a]) });
        toast(`Put back ${r.count} old name${r.count === 1 ? '' : 's'}`);
        await brReload(p, dir, pairs.map(x => x[0]));
      } });
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
    /* the "/" overview only lists places to open - nothing to change there */
    const isRoot = x => x.root && x.mode === 'dir';
    if ((isRoot(p) || (isRoot(q) && ['copy', 'move'].includes(name))) && !['find', 'sizes', 'undo', 'view'].includes(name))
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
            done(`Created ${r.name}`, { label: `New folder ${r.name}`, run: async () => {
              await api('rmdir_empty', { path: join(dir, r.name) }); toast(`Removed ${r.name}`); refreshBoth(); } });
          } }]);
      }
      case 'rename': {
        if (t.length !== 1 || p.mode !== 'dir') return toast('Put the cursor on one item to rename', true);
        const old = t[0].it.n;
        openDlg('Rename', `<div class="field"><label>New name</label><input type="text" class="f-name" value="${esc(old)}"></div>`,
          [{ label: 'Cancel' }, { label: 'Rename', primary: true, run: async () => {
            const dir = p.path, r = await api('rename', { path: dir, from: old, to: $('.f-name', dlg).value });
            await load(p, dir, r.name);
            if (r.name !== old) done(`Renamed to ${r.name}`, { label: `Rename ${old} → ${r.name}`, run: async () => {
              await api('rename', { path: dir, from: r.name, to: old }); toast(`Renamed back to ${old}`); refreshBoth(); } });
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
            if (name === 'copy') setUndo(ex !== 'skip' && SET.trash === false ? null : { label: `Copy ${desc} → ${dest}`, job: r.job, run: () => undoCopy([r.job]) });
            if (name === 'move') {
              /* undo = move each item back to the folder it came from */
              const pairs = t.map(x => [x.path, join(dest, base(x.path))]);
              const u = { label: `Move ${desc} → ${dest}`, job: r.job || null, run: async () => {
                const groups = new Map();
                for (const [from, to] of pairs) { const d = parent(from); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(to); }
                for (const [d, srcs] of groups) {
                  const rr = await api('job_start', { type: 'move', sources: srcs, dest: d, exists: 'skip' });
                  if (!rr.instant) { openProgress(rr.job); if (r.job) toast('Moving back. Any files the move replaced are in the trash - restore them from there.'); return; }
                }
                /* files the move replaced were set aside in the trash: put them back too */
                let back = 0;
                if (r.job) try { back = (await api('undo_job', { ids: [r.job], mode: 'backups' })).restored; } catch (e) {}
                toast(back ? `Moved back, and put back ${back} replaced file${back === 1 ? '' : 's'}` : 'Moved back'); refreshBoth();
              } };
              if (r.instant) { done(`Moved ${desc}`, u); refreshBoth(); return; }
              setUndo(u);
            }
            if (r.instant) { toast(`Moved ${desc}`); refreshBoth(); return; }
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
            if (r.bins && r.bins.length) done(msg, { label: `Delete ${desc}`, run: async () => {
              const rr = await api('restore', { paths: r.bins }); toast(`Put back ${rr.restored.length} item${rr.restored.length === 1 ? '' : 's'}`); refreshBoth(); } });
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
      case 'brename': {
        if (p.mode !== 'dir') return toast('Open a folder first', true);
        if (!p.sel.size) return toast('Tick the files to rename first (Select All ticks everything)', true);
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
    for (const j of jobs) if (!['running', 'queued'].includes(j.state) && !seenDone.has(j.id)) { seenDone.add(j.id); changed = true; }
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
      const verb = { copy: 'Copy', move: 'Move', perms: 'Permissions change' }[j.type] || 'Job';
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

  /* ---------- Tools > Empty folders on disks ---------- */
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
        <div class="ef-sec ef-opts">
          <label class="ef-sharef"><span class="ef-lbl">Share</span>
            <select class="ef-share"><option value="">All shares</option>${info.shares.map(n => `<option>${esc(n)}</option>`).join('')}</select></label>
          ${APP_SHARES.some(n => info.shares.includes(n)) ? `<label class="ef-toggle ef-skipbox"><input type="checkbox" class="ef-skip" checked><span class="ef-sw"></span>
            <span>Skip ${APP_SHARES.filter(n => info.shares.includes(n)).join(', ')}<small>Apps and VMs often keep empty folders there on purpose - deleting them can break things</small></span></label>` : ''}
        </div>
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

    async function startScan() {
      const disks = $$('.ef-disks input:checked', dlg).map(i => i.value);
      if (!disks.length) return toast('Pick at least one disk or pool', true);
      const skipBox = el('.ef-skip'), skip = skipBox && skipBox.checked && !el('.ef-share').value ? APP_SHARES.filter(n => info.shares.includes(n)) : [];
      try { T.scan = (await api('empty_scan_start', { disks, share: el('.ef-share').value, skip })).id; } catch (e) { return toast(e.message, true); }
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
      el('.ef-prog').innerHTML = `<div class="ef-prog-h">${st.share ? `Share <b>${esc(st.share)}</b>` : `All shares${st.skip && st.skip.length ? ` except ${esc(st.skip.join(', '))}` : ''}`} · ${st.disks.length} disk${st.disks.length === 1 ? '' : 's'}</div>` +
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
      if (r.undo) done(msg, { label: `Delete ${gone.size} empty folders`, run: async () => { const u = await api('empty_undo', { token: r.undo }); toast(`Put back ${u.restored} folder${u.restored === 1 ? '' : 's'}`); refreshBoth(); } });
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
        el('.ef-share').value = st.share || '';
        if (el('.ef-skip')) el('.ef-skip').checked = !!(st.skip && st.skip.length) || !!st.share;
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
        try { res = await api('trash', { paths: [o.path], forever: perm ? '1' : '0' }); } catch (e) { toast(e.message, true); return false; }
        let appNote = '';
        if (alsoApp) { try { await o.removeApp(); appNote = ` and removed from ${o.app}`; } catch (e) { appNote = ` - but ${o.app}: ${e.message}`; } }
        o.onDeleted(perm, res);
        const msg = `${perm ? 'Deleted for good' : 'Moved to the trash'}: ${o.name}${appNote}`;
        if (!perm && res.bins && res.bins.length) done(msg, { label: `Delete ${o.name}`, run: async () => { const rr = await api('restore', { paths: res.bins }); toast(`Put back ${o.name}${alsoApp ? ` - add it to ${o.app} again if you want it there` : ''} (scan again to list it)`); refreshBoth(); } });
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
            ${snChip(r) ? `<div>${snChip(r)}</div>` : ''}
            ${s ? `<div class="mt-facts">${[s.status && `<span class="tv-status ${s.status === 'Ended' ? 'ended' : 'running'}">${esc(s.status)}</span>`, s.network && esc(s.network), s.type && esc(s.type)].filter(Boolean).join(' · ')}</div>
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
        ${grid ? `<div class="tv-legend"><span class="tv-cell have"></span> in the folder ${o.renum ? '<span class="tv-cell nf"></span> not found by this number' : '<span class="tv-cell miss"></span> missing'}${askedEps.size ? ' <span class="tv-cell asked"></span> asked Sonarr for it' : ''} <span class="tv-cell future"></span> not aired yet</div><div class="tv-grid">${grid}</div>` : ''}
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
      try { r = await api('trash', { paths }); } catch (e) { T.asking = false; draw(); return toast(e.message, true); }
      T.asking = false;
      T.results = T.results.filter(x => !T.picked.has(x.path)); T.picked.clear(); draw();
      const msg = `Deleted ${r.count} folder${r.count === 1 ? '' : 's'}`;
      if (r.bins && r.bins.length) done(msg, { label: `Delete ${r.count} movie folders`, run: async () => { const rr = await api('restore', { paths: r.bins }); toast(`Put back ${rr.restored.length} folder${rr.restored.length === 1 ? '' : 's'}`); refreshBoth(); } });
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
    bmBar.innerHTML = bms.map((b, i) => `<button class="uc-bm${b.path === cur ? ' on' : ''}" data-i="${i}" title="${esc(b.path)}">${esc(b.label)}</button>`).join('')
      + `<button class="uc-bm-add" title="Add the active pane's folder as a shortcut">＋${bms.length ? '' : ' Add this folder as a shortcut'}</button>`;
  }
  bmBar.addEventListener('click', e => {
    const b = e.target.closest('.uc-bm');
    if (b) { const bm = (SET.bookmarks || [])[+b.dataset.i]; if (bm) load(A(), bm.path); return; }
    if (e.target.closest('.uc-bm-add')) addBookmark();
  });
  function addBookmark() {
    const p = A();
    if (p.mode !== 'dir') return toast('Open a folder first', true);
    openDlg('Add shortcut', `
      <div class="field"><label>Button label</label><input type="text" class="f-label" value="${esc(base(p.path) || p.path)}"></div>
      <div class="field"><label>Folder</label><input type="text" class="f-path" value="${esc(p.path)}"></div>
      <div class="muted">Shortcuts sit in the bar under the top row. Reorder or remove them in ⚙ Settings.</div>`,
      [{ label: 'Cancel' }, { label: 'Add', primary: true, run: async () => {
        const next = JSON.parse(JSON.stringify(SET));
        next.bookmarks = (next.bookmarks || []).concat([{ label: $('.f-label', dlg).value.trim(), path: $('.f-path', dlg).value.trim() }]);
        await saveSettings(next); toast('Shortcut added');
      } }]);
  }

  /* ---------- settings ---------- */
  const customStyle = document.getElementById('uc-custom');
  /* Theme: Standard, or Midnight Commander (its own stylesheet, scoped to #uc.uc-mc) */
  function applyTheme(t) {
    root.classList.toggle('uc-mc', t === 'mc');
    setTimeout(() => { ROW = readRow(); panes.forEach(p => { p.spacer.style.height = (p.items.length * ROW) + 'px'; drawRows(p); queueStat(p); }); }, 0);
  }
  function readRow() {
    const v = parseFloat(getComputedStyle(root).getPropertyValue('--row'));
    const r = Math.round((v >= 20 && v <= 80 ? v : 25) * fontScale());
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
  function applyLook(css) {
    if (customStyle) customStyle.textContent = css;
    ROW = readRow();
    panes.forEach(p => { p.spacer.style.height = (p.items.length * ROW) + 'px'; drawRows(p); queueStat(p); });
  }
  async function saveSettings(next) {
    const r = await api('save_settings', { settings: next });
    SET = r.settings; applyLook(SET.css); applyTheme(SET.theme); applyToolBtns(); renderBookmarks(); applyPractice(); applySys(false); watchArm();
    if (watchOn()) panes.forEach(p => { if (p.mode === 'dir' && !p.sig) refresh(p); });   // fetch a starting fingerprint
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
      ['--line / --line-soft', 'borders'], ['--ok / --warn / --danger', 'done, odd owner, delete'] ]],
    ['Sizes and fonts', [ ['--row', 'file row height (20–80px)'], ['--r', 'corner radius'], ['--sans / --mono', 'font stacks'] ]],
    ['Layout', [
      ['#uc', 'the whole app'], ['.uc-appbar', 'top bar'], ['.uc-bookmarks, .uc-bm, .uc-bm.on, .uc-bm-add', 'shortcut bar and buttons'],
      ['.uc-crumbs, .uc-path, .uc-path.active', 'path bars'], ['.tr-seg, .tr-seg.here, .tr-seg.ahead', 'breadcrumb names (current, greyed)'], ['.uc-jump', 'Jump to name box'], ['.uc-pane, .uc-pane.active', 'left/right panes'],
      ['.uc-pane-head, .uc-cols, .uc-pane-foot', 'pane header, column titles, footer'],
      ['.uc-row, .uc-row.cursor, .uc-row.sel', 'file rows, cursor row, ticked rows'],
      ['.col-sel, .col-name, .col-size, .col-date, .col-mode', 'columns'], ['.nm.dir, .nm.link', 'folder and symlink names'],
      ['.uc-selbar', 'Select / Sort bar'], ['.uc-fkeys, .uc-fk, .uc-fk[data-act="copy"]', 'function-key buttons (by action)'], ['.uc-fk-toggle, .uc-fk[data-more]', 'More toggle and More buttons'], ['.uc-alerts, .uc-alert', 'finished-job alert rows'], ['--fk-clear', 'space kept free at the right of the button row (default 56px)'],
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
  const ARR_NAME = { radarr: 'Radarr', sonarr: 'Sonarr' }, ARR_PORT = { radarr: 7878, sonarr: 8989 };
  function rdMapRow(rp, hp, detected, app = 'radarr') {
    return `<div class="rd-pair"><span class="mono rd-rp">${esc(rp)}</span><span class="rd-arrow">⇄</span>
      <input type="text" class="rd-hp" data-rp="${esc(rp)}" value="${esc(hp || '')}" placeholder="/mnt/user/…" spellcheck="false" autocapitalize="off">
      ${detected ? `<span class="rd-det" title="Read from ${ARR_NAME[app]}'s Docker settings">from Docker</span>` : ''}</div>`;
  }
  function rdRead(d) {
    const app = d.dataset.app || 'radarr';
    const v = c => ($(c, d) || {}).value || '';
    const prof = $('.rd-prof', d);
    return { host: v('.rd-host').trim(), port: +v('.rd-port') || ARR_PORT[app], base: v('.rd-base').trim(), key: v('.rd-key').trim(),
      profile: prof && prof.value ? +prof.value : 0, profile_name: prof && prof.selectedOptions[0] ? prof.selectedOptions[0].textContent : '',
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
        $('.rd-map', d).innerHTML = r.roots.map(x => rdMapRow(x[app], x.host, x.detected && x.host === x.detected, app)).join('')
          || `<div class="muted">${ARR_NAME[app]} has no root folders yet - add one in ${ARR_NAME[app]} > Settings > Media Management.</div>`;
        $('.rd-more', d).hidden = false;
        if (r.roots.some(x => !x.host)) res.textContent += ` - fill in the server folder for each ${ARR_NAME[app]} folder below`;
      } catch (e) { res.className = 'rd-res err'; res.textContent = '✕ ' + e.message; }
    });
  }

  function openSettings(tab = 'gen') {
    const w = JSON.parse(JSON.stringify(SET));
    const SN = w.sonarr || (w.sonarr = {});
    let savedOk = false;
    const tabs = [['gen', 'General'], ['bm', 'Shortcuts'], ['look', 'Look & sound'], ['safe', 'Safety & trash'], ['tools', 'Tools'], ['keys', 'Keyboard']];
    const sc = (k, label) => `<label class="chk"><input type="checkbox" data-s="${k}" ${w.sounds[k] ? 'checked' : ''}> ${label}</label>`;
    openDlg(root.dataset.version ? `Settings · version ${root.dataset.version}` : 'Settings', `
      <div class="st-tabs">${tabs.map(([k, l]) => `<button class="st-tab" data-tab="${k}">${l}</button>`).join('')}</div>

      <div class="st-panel" data-panel="gen">
        <div class="field"><label>Name in the unRAID menu bar</label>
          <input type="text" class="st-menu" maxlength="30" value="${esc(w.menu_name || 'unCommander')}" placeholder="unCommander"></div>
        <div class="muted">The label of unCommander's entry in the unRAID top menu. Reload the page after saving to see it there. Leave it empty to go back to "unCommander".</div>
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
        <div class="kb-cols">
        <div class="kb-col">
        <div class="kb-group"><div class="kb-gh">Moving around</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>↑</kbd> <kbd>↓</kbd></div><div class="kb-d">Move the cursor up or down</div></div><div class="kb-row"><div class="kb-k"><kbd>PgUp</kbd> <kbd>PgDn</kbd></div><div class="kb-d">Move a page up or down</div></div><div class="kb-row"><div class="kb-k"><kbd>Home</kbd> <kbd>End</kbd></div><div class="kb-d">First or last item</div></div><div class="kb-row"><div class="kb-k"><kbd>Tab</kbd></div><div class="kb-d">Switch to the other pane</div></div><div class="kb-row"><div class="kb-k"><kbd>a</kbd>–<kbd>z</kbd>, <kbd>0</kbd>–<kbd>9</kbd></div><div class="kb-d">Type a name to jump to it</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Ticking</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Insert</kbd></div><div class="kb-d">Tick or untick, and move down (like MC)</div></div><div class="kb-row"><div class="kb-k"><kbd>Space</kbd></div><div class="kb-d">Tick or untick</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>A</kbd></div><div class="kb-d">Tick everything</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Other</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>Z</kbd></div><div class="kb-d">Undo the last action</div></div><div class="kb-row"><div class="kb-k"><kbd>Ctrl</kbd> <kbd>F5</kbd></div><div class="kb-d">Reload the browser page (plain F5 is Copy)</div></div><div class="kb-row"><div class="kb-k"><kbd>←</kbd> <kbd>→</kbd></div><div class="kb-d">Previous or next picture, in the picture viewer</div></div></div></div>
        </div>
        <div class="kb-col">
        <div class="kb-group"><div class="kb-gh">Opening</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>Enter</kbd></div><div class="kb-d">Open the folder or file under the cursor</div></div><div class="kb-row"><div class="kb-k"><kbd>Backspace</kbd></div><div class="kb-d">Go up one folder</div></div><div class="kb-row"><div class="kb-k"><kbd>Esc</kbd></div><div class="kb-d">Close a window, or stop a folder that is taking long to open</div></div></div></div>
        <div class="kb-group"><div class="kb-gh">Function keys</div>
          <div class="kb-table"><div class="kb-row"><div class="kb-k"><kbd>F2</kbd></div><div class="kb-d">View</div></div><div class="kb-row"><div class="kb-k"><kbd>F3</kbd></div><div class="kb-d">Edit</div></div><div class="kb-row"><div class="kb-k"><kbd>F4</kbd></div><div class="kb-d">Rename</div></div><div class="kb-row"><div class="kb-k"><kbd>F5</kbd></div><div class="kb-d">Copy to the other pane</div></div><div class="kb-row"><div class="kb-k"><kbd>F6</kbd></div><div class="kb-d">Move to the other pane</div></div><div class="kb-row"><div class="kb-k"><kbd>F7</kbd></div><div class="kb-d">New folder</div></div><div class="kb-row"><div class="kb-k"><kbd>F8</kbd> or <kbd>Delete</kbd></div><div class="kb-d">Delete</div></div><div class="kb-row"><div class="kb-k"><kbd>F9</kbd></div><div class="kb-d">Find</div></div><div class="kb-row"><div class="kb-k"><kbd>F10</kbd></div><div class="kb-d">Owner and permissions</div></div></div></div>
        </div>
        </div>
      </div>

      <div class="st-panel" data-panel="safe">
        <label class="st-radio"><input type="checkbox" class="st-practice" ${w.practice ? 'checked' : ''}><span><b>Practice mode</b><br>
          <span class="muted">For learning unCommander without risk. Nothing can be lost or changed.</span></span></label>
        <table class="st-safe">
          <tr><td>Still works</td><td>Browsing, View, Find, selecting, Copy (files already at the destination are always kept), New Folder, Edit (look only)</td></tr>
          <tr><td>Locked</td><td>Delete, Move, Rename, Permissions, Restore from trash, saving edits, replacing files when copying</td></tr>
        </table>
        <div class="muted">The server checks this too. It's a safety net for learning, not a password: anyone who can open Settings can switch it off.</div>
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

      <div class="st-panel" data-panel="theme">
        <div class="th-pick">
          <label class="th-card"><input type="radio" name="st-theme" value="standard" ${w.theme !== 'mc' ? 'checked' : ''}>
            <span class="th-sw std"><i></i><i></i><b></b></span><span><b>Standard</b><br><span class="muted">unCommander's own look - with your CSS below</span></span></label>
          <label class="th-card"><input type="radio" name="st-theme" value="mc" ${w.theme === 'mc' ? 'checked' : ''}>
            <span class="th-sw mc"><i></i><i></i><b></b></span><span><b>Midnight Commander</b><br><span class="muted">Blue panels and cyan bars, like MC on the console - windows keep the Standard look</span></span></label>
        </div>
        <div class="muted st-thnote">The Midnight Commander theme is separate: your CSS below and the Whole OS colours stay as they are and come back when you switch to Standard.</div>
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
        <div class="st-about">unCommander${root.dataset.version ? ` <span class="mono">${esc(root.dataset.version)}</span>` : ''} - source code, the full user guide, and a place to report bugs or ask for features:
          <a href="https://github.com/hernandito/unCommander" target="_blank" rel="noopener">github.com/hernandito/unCommander ↗</a></div>
        <a class="st-bmc" href="https://www.buymeacoffee.com/hernandito" target="_blank" rel="noopener" title="Like unCommander? Buy the author a coffee">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="cup" d="M4.5 8.5h12.2l-1.3 10.2a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8z"/><path class="rim" d="M3.6 6.3h14v2.2h-14z"/><path class="steam" d="M8.6 4.6c0-1 .9-1.1.9-2.1M11.6 4.6c0-1 .9-1.1.9-2.1"/><path class="handle" d="M16.6 10.3h1.6a2.2 2.2 0 0 1 0 4.4h-2.1"/></svg>
          Buy me a coffee</a>
      </div>

      <div class="st-panel" data-panel="tools">
        <div class="muted">Bigger jobs that look across your disks. Each one opens in its own window; nothing changes until you choose to.</div>
        <div class="tl-card"><div class="tl-txt"><b>Empty folders on disks</b>
          <span class="muted">Finds folders with nothing at all inside (not even hidden files) on each disk and pool - usually leftovers where the same folder lives on another disk. Delete the ones you pick; Undo puts them back.</span></div>
          <button class="uc-btn primary" data-tool="empty">Open</button></div>
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
        <div class="field st-days-f"><label>Empty the trash after (days)</label><input type="text" inputmode="numeric" class="st-days" value="${esc(w.trash_days)}"></div>
        <div class="muted">0 keeps everything until you delete it yourself.</div>
        <div class="st-help">
          <h4>Where deleted things go</h4>
          <p>Delete (F8) doesn't erase anything. It moves the item into a hidden folder called <span class="mono">.uncommander-trash</span> at the top of the share, disk or pool it came from, e.g. <span class="mono">/mnt/user/Nextcloud/.uncommander-trash</span>. That makes deleting instant, even for huge folders, because nothing is copied.</p>
          <p>Each delete makes one dated folder inside it, like <span class="mono">20261013-093912-a1b2c3</span>, holding what you deleted and a note of where it came from. Deleted items still use disk space until the trash is emptied.</p>
          <h4>Getting something back</h4>
          <ol>
            <li>Turn on <b>Show hidden</b> (bottom bar), then open the share or disk you deleted from.</li>
            <li>Open <span class="mono">.uncommander-trash</span>. Open a dated folder to see what's in it, if you need to.</li>
            <li>Tick the dated folder(s) and press <b>Restore</b>. It only appears inside the trash folder.</li>
          </ol>
          <p>Each item goes back to exactly where it was, re-creating the folder if needed. If something with the same name is there now, that item is skipped so nothing gets overwritten. To get just one file out of a dated folder, open it and Copy or Move that file instead.</p>
          <h4>Emptying</h4>
          <p>Every day at 4:17 am, the server permanently removes dated folders older than the number of days above. You can also open the trash, tick folders and press Delete: anything deleted from inside the trash is gone for good.</p>
          <h4>Good to know</h4>
          <ul>
            <li>This is unCommander's own trash. It's separate from unRAID's Recycle Bin plugin and doesn't need it.</li>
            <li>Deleting over the network (SMB), in the terminal or in another file manager doesn't use this trash.</li>
            <li>The trash folder is hidden from network shares if they use unRAID's default "hide dot files" setting.</li>
            <li>Switching the trash off doesn't empty it. Whatever is already there stays until the daily clean-up or until you delete it.</li>
          </ul>
        </div>
      </div>`,
      [{ label: 'Cancel' }, { label: 'Save', primary: true, run: async () => {
        w.trash_days = parseInt($('.st-days', dlg).value, 10) || 0;
        w.practice = $('.st-practice', dlg).checked;
        w.sysmode = $('.st-sysmode', dlg).checked;
        w.trash = $('.st-trash', dlg).checked;
        w.notify_unraid = $('.st-notify', dlg).checked;
        w.tap_mode = ($('input[name=st-tap]:checked', dlg) || {}).value || 'auto';
        w.highlight = $('.st-hl', dlg).checked;
        w.theme = ($('input[name=st-theme]:checked', dlg) || {}).value === 'mc' ? 'mc' : 'standard';
        w.toolbtns = {}; $$('.st-toolbtn', dlg).forEach(c => { w.toolbtns[c.dataset.tb] = c.checked; });
        w.autorefresh = { on: $('.st-ar', dlg).checked, secs: parseInt($('.st-ar-secs', dlg).value, 10) || 10 };
        w.radarr = rdRead($('.rd-box[data-app="radarr"]', dlg));
        w.sonarr = rdRead($('.rd-box[data-app="sonarr"]', dlg));
        const oldMenu = SET.menu_name;
        w.menu_name = $('.st-menu', dlg).value.trim();
        await saveSettings(w); savedOk = true;
        toast(SET.menu_name !== oldMenu ? 'Saved — reload the page to see the new menu name' : 'Settings saved');
      } }], 'full settings sticky');
    document.activeElement && document.activeElement.blur();
    dlg.beforeClose = () => { if (!savedOk) { applyLook(SET.css); applyTheme(SET.theme); } fsPreview = null; applyScale(savedOk && dlg.fsPick ? dlg.fsPick : null); dlg.fsPick = null; return true; };
    /* the theme previews as soon as it's picked; Cancel puts it back */
    $$('input[name=st-theme]', dlg).forEach(i => i.addEventListener('change', () => applyTheme(i.value)));
    /* text size: previews live; Save keeps it on this device, Cancel puts it back */
    const fs0 = Math.round(fontScale() * 100), fsR = $('.fs-range', dlg), fsV = $('.fs-val', dlg);
    const fsSet = v => { v = Math.max(80, Math.min(140, Math.round(v / 5) * 5)); fsR.value = v; fsV.textContent = v + '%'; fsPreview = v / 100; applyScale(); dlg.fsPick = v; };
    fsR.addEventListener('input', () => fsSet(+fsR.value));
    $$('.fs-step', dlg).forEach(b => b.addEventListener('click', () => fsSet(+fsR.value + +b.dataset.fs)));
    $('.fs-reset', dlg).addEventListener('click', () => fsSet(100));

    /* Four tabs, each grouping related sections under a small heading. */
    const GROUP = { gen: 'gen', touch: 'gen', jobs: 'gen', watch: 'gen', about: 'gen', bm: 'bm', size: 'look', theme: 'look', look: 'look', hl: 'look', snd: 'look', safe: 'safe', sys: 'safe', trash: 'safe', tools: 'tools', keys: 'keys' };
    $$('.rd-box[data-app]', dlg).forEach(box => rdWire(box, w));
    $$('[data-tool]', dlg).forEach(b => b.addEventListener('click', () => { closeDlg(); if (b.dataset.tool === 'empty') openEmptyTool(); if (b.dataset.tool === 'movies') openMovieTool(); if (b.dataset.tool === 'tv') openTvTool(); }));
    const HEAD = { about: 'About', gen: 'Menu name', touch: 'Tapping rows', jobs: 'When a job finishes', watch: 'Auto-refresh', size: 'Text size on this device', theme: 'Theme', keys: 'Keyboard shortcuts', look: 'Your own CSS', snd: 'Sounds', safe: 'Practice mode', sys: 'Whole system view', trash: 'Trash' };
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
          <button class="uc-btn" data-mv="-1" title="Move up" ${i ? '' : 'disabled'}>↑</button>
          <button class="uc-btn" data-mv="1" title="Move down" ${i < w.bookmarks.length - 1 ? '' : 'disabled'}>↓</button>
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
  function applyToolBtns() { $$('.uc-toolbtn').forEach(b => { b.hidden = !(SET.toolbtns && SET.toolbtns[b.dataset.opentool] !== false); }); }
  $$('.uc-toolbtn').forEach(b => b.addEventListener('click', () => { b.blur(); sound.play('click'); if (b.dataset.opentool === 'movies') openMovieTool(); else openTvTool(); }));
  applyToolBtns();
  applyPractice(); applySys(false);

  /* ---------- start ---------- */
  root.style.setProperty('--fs', String(fontScale())); root.classList.toggle('uc-big', fontScale() >= 1.1);
  ROW = readRow();
  saveSort();
  setActive(active);
  Promise.all(panes.map(p => load(p, p.path).then(() => p.error && p.path !== '/mnt' && load(p, '/mnt')))).then(() => { booting = false; watchArm(); });
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
