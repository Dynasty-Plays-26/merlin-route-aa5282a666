/* Merlin Route — offline-first PWA. All data lives on this device (localStorage). */
(() => {
  'use strict';

  const KEY = 'milkroute.v1';
  const APP_VERSION = '1.1.0';

  // ---------- Storage ----------
  const blank = () => ({
    settings: { routeName: 'Route', driver: '', webhookUrl: '', webhookToken: '', autoPush: false, deviceId: uid() },
    stops: [],
    days: {},
    outbox: []
  });

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const d = JSON.parse(raw);
      const b = blank();
      return { ...b, ...d, settings: { ...b.settings, ...(d.settings || {}) } };
    } catch (e) { console.error(e); return blank(); }
  }
  let db = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('Storage full or blocked — export a CSV now'); }
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- Helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const prettyDate = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); };

  let viewDate = localDate();
  let tab = (location.hash.replace('#', '') || 'route');
  if (!['route', 'summary', 'stops', 'settings'].includes(tab)) tab = 'route';
  let routeFilter = 'todo';

  function day(ds = localDate()) {
    if (!db.days[ds]) db.days[ds] = { date: ds, stops: {}, pushes: [] };
    return db.days[ds];
  }
  function rec(stopId, ds = localDate()) {
    const d = day(ds);
    if (!d.stops[stopId]) d.stops[stopId] = { status: 'pending', at: null, returns: 0, absent: null, spills: [], notes: [], handoff: null };
    return d.stops[stopId];
  }
  // Stops for a given day: today uses the live list; past days use the snapshot saved when work started.
  function stopsFor(ds) {
    const d = db.days[ds];
    if (d && d.snapshot) return d.snapshot;
    return db.stops;
  }
  function snapshotIfNeeded(ds = localDate()) {
    const d = day(ds);
    d.snapshot = db.stops.map(s => ({ ...s }));
  }
  const hasException = r => !!(r && (r.absent || (r.spills || []).length || (r.notes || []).length));
  const isDone = r => r && (r.status === 'delivered' || r.status === 'skipped');

  // ---------- Icons ----------
  const ic = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>'
  };

  // ---------- Header ----------
  function renderHeader() {
    $('#routeName').textContent = db.settings.routeName || 'Route';
    $('#routeDate').textContent = prettyDate(viewDate) + (db.settings.driver ? ' · ' + db.settings.driver : '');
    const list = stopsFor(viewDate);
    const d = db.days[viewDate];
    const done = list.filter(s => isDone(d && d.stops[s.id])).length;
    const pct = list.length ? Math.round(done / list.length * 100) : 0;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = list.length ? `${done} of ${list.length} stops complete · ${list.length - done} to go` : 'No stops yet';
    const net = $('#netPill');
    net.textContent = navigator.onLine ? 'Online' : 'Offline';
    net.classList.toggle('off', !navigator.onLine);
    const q = $('#queuePill');
    q.hidden = !db.outbox.length;
    q.textContent = `${db.outbox.length} queued`;
  }

  // ---------- Route view ----------
  function stopCard(s, i, r, nextId) {
    const tags = [];
    if (r.returns) tags.push(`<span class="tag blue">${r.returns} bottle${r.returns === 1 ? '' : 's'} back</span>`);
    if (r.absent) tags.push(`<span class="tag amber">Absent · ${r.absent.outcome === 'left' ? 'left at door' : 'brought back'}</span>`);
    r.spills.forEach(sp => tags.push(`<span class="tag red">Spill · ${sp.crates} crate${sp.crates === 1 ? '' : 's'}${sp.bottles ? `, ${sp.bottles} btl lost` : ''}</span>`));
    if (r.handoff) tags.push(`<span class="tag green">Took it: ${esc(r.handoff.acceptedBy || '—')}${r.handoff.next ? ' · ' + esc(r.handoff.next) : ''}</span>`);
    if (r.notes.length) tags.push(`<span class="tag amber">${r.notes.length} note${r.notes.length === 1 ? '' : 's'}</span>`);
    const tagHtml = tags.length ? `<div class="tags">${tags.join('')}</div>` : '';

    if (isDone(r)) {
      const exc = hasException(r) || r.status === 'skipped';
      return `<article class="card done ${exc ? 'exc' : ''}" data-id="${s.id}">
        <div class="done-row">
          <div class="check ${exc ? 'amber' : ''}">${r.status === 'skipped' ? ic.alert : ic.check}</div>
          <div class="grow">
            <div class="card-title">${i + 1}. ${esc(s.name)}</div>
            <div class="card-addr">${r.status === 'skipped' ? 'Not delivered' : 'Delivered'} ${timeStr(r.at)}</div>
            ${tagHtml}
          </div>
          <button class="btn-ghost" data-act="exception" data-id="${s.id}">Log</button>
          <button class="btn-ghost" data-act="undo" data-id="${s.id}">Undo</button>
        </div>
      </article>`;
    }
    return `<article class="card ${s.id === nextId ? 'next' : ''}" data-id="${s.id}">
      <div class="card-head">
        <div class="seq">${i + 1}</div>
        <div>
          <div class="card-title">${esc(s.name)}</div>
          ${s.address ? `<div class="card-addr">${esc(s.address)}</div>` : ''}
          ${s.contact ? `<div class="card-contact">${esc(s.contact)}</div>` : ''}
          ${s.order ? `<div class="card-order">${esc(s.order)}</div>` : ''}
          ${s.segment ? ` <span class="tag ${/over/i.test(s.segment) ? 'blue' : 'amber'}">${esc(s.segment)}</span>` : ''}
          ${s.notes ? `<div class="card-note">${esc(s.notes)}</div>` : ''}
          ${tagHtml}
        </div>
      </div>
      ${s.brief ? `<details class="brief"><summary>411</summary><p>${esc(s.brief)}</p></details>` : ''}
      <button class="btn-deliver" data-act="deliver" data-id="${s.id}">${ic.check}Delivered</button>
      <div class="actions">
        <button class="act blue" data-act="returns" data-id="${s.id}">Bottles back</button>
        <button class="act amber" data-act="absent" data-id="${s.id}">Not home</button>
        <button class="act red" data-act="spill" data-id="${s.id}">Spilled crate</button>
        <button class="act teal" data-act="handoff" data-id="${s.id}">Who took it</button>
      </div>
    </article>`;
  }

  function renderRoute() {
    const today = localDate();
    const list = db.stops;
    if (!list.length) {
      return `<div class="empty"><h3>No stops on this route yet</h3><p>Open your roster link, or add stops once. They carry over every day.</p>
        <div class="row" style="justify-content:center;margin-top:18px">
          <button class="btn" data-go="stops">Add stops</button>
          <button class="btn secondary" data-act="sample">Load sample route</button>
        </div></div>`;
    }
    const d = db.days[today];
    const recs = list.map(s => (d && d.stops[s.id]) || { status: 'pending', returns: 0, absent: null, spills: [], notes: [] });
    const next = list.find((s, i) => !isDone(recs[i]));
    const shown = list.map((s, i) => ({ s, i, r: recs[i] })).filter(x => routeFilter === 'all' || !isDone(x.r));
    const left = list.length - recs.filter(isDone).length;
    return `<div class="toolbar">
        <h2>${left ? `${left} stop${left === 1 ? '' : 's'} left` : 'Route complete'}</h2>
        <div class="seg" role="group" aria-label="Show">
          <button data-filter="todo" aria-pressed="${routeFilter === 'todo'}">To do</button>
          <button data-filter="all" aria-pressed="${routeFilter === 'all'}">All stops</button>
        </div>
      </div>
      ${!left ? `<div class="panel"><h3>Every stop is done.</h3><p class="hint">Review the day, then export or send it.</p><button class="btn wide" data-go="summary">Open daily summary</button></div>` : ''}
      <div class="stops grid2">${shown.map(x => stopCard(x.s, x.i, x.r, next && next.id)).join('')}</div>`;
  }

  // ---------- Summary ----------
  function computeDay(ds) {
    const list = stopsFor(ds);
    const d = db.days[ds] || { stops: {} };
    const rows = list.map((s, i) => {
      const r = { status: 'pending', at: null, returns: 0, absent: null, spills: [], notes: [], handoff: null, ...(d.stops[s.id] || {}) };
      const crates = r.spills.reduce((a, b) => a + (b.crates || 0), 0);
      const lost = r.spills.reduce((a, b) => a + (b.bottles || 0), 0);
      let status = r.status;
      if (r.status === 'skipped') status = 'not_delivered';
      return {
        seq: i + 1, stop_id: s.id, stop: s.name, address: s.address || '', contact: s.contact || '', segment: s.segment || '', order: s.order || '',
        accepted_by: r.handoff ? r.handoff.acceptedBy || '' : '', next_action: r.handoff ? r.handoff.next || '' : '',
        status, completed_at: r.at || '', bottles_returned: r.returns || 0,
        customer_absent: r.absent ? 'yes' : 'no', absent_outcome: r.absent ? (r.absent.outcome === 'left' ? 'left_at_door' : 'brought_back') : '',
        spilled_crates: crates, bottles_lost: lost,
        notes: [...(r.handoff && r.handoff.note ? [r.handoff.note] : []), ...(r.spills.map(x => x.note).filter(Boolean)), ...(r.absent && r.absent.note ? [r.absent.note] : []), ...r.notes.map(n => n.text)].join(' | ')
      };
    });
    const events = [];
    list.forEach(s => {
      const r = d.stops[s.id]; if (!r) return;
      if (r.absent) events.push({ at: r.absent.at, stop: s.name, type: 'customer_absent', qty: '', detail: (r.absent.outcome === 'left' ? 'Left at door' : 'Brought back') + (r.absent.note ? ' — ' + r.absent.note : '') });
      (r.spills || []).forEach(sp => events.push({ at: sp.at, stop: s.name, type: 'spilled_crate', qty: sp.crates, detail: `${sp.bottles || 0} bottles lost${sp.note ? ' — ' + sp.note : ''}` }));
      if (r.returns) events.push({ at: r.returnsAt || r.at || '', stop: s.name, type: 'bottle_return', qty: r.returns, detail: '' });
      (r.notes || []).forEach(n => events.push({ at: n.at, stop: s.name, type: 'note', qty: '', detail: n.text }));
      if (r.handoff) events.push({ at: r.handoff.at, stop: s.name, type: 'handoff', qty: '', detail: [r.handoff.acceptedBy && 'Took it: ' + r.handoff.acceptedBy, r.handoff.next && 'Next: ' + r.handoff.next, r.handoff.note].filter(Boolean).join(' — ') });
    });
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const totals = {
      stops: rows.length,
      delivered: rows.filter(r => r.status === 'delivered').length,
      not_delivered: rows.filter(r => r.status === 'not_delivered').length,
      pending: rows.filter(r => r.status === 'pending').length,
      customer_absent: rows.filter(r => r.customer_absent === 'yes').length,
      handoffs_named: rows.filter(r => r.accepted_by).length,
      bottles_returned: rows.reduce((a, r) => a + r.bottles_returned, 0),
      spilled_crates: rows.reduce((a, r) => a + r.spilled_crates, 0),
      bottles_lost: rows.reduce((a, r) => a + r.bottles_lost, 0)
    };
    const done = rows.filter(r => r.completed_at).map(r => r.completed_at).sort();
    totals.first_stop_at = done[0] || '';
    totals.last_stop_at = done[done.length - 1] || '';
    return { rows, events, totals };
  }

  function renderSummary() {
    const { rows, events, totals: t } = computeDay(viewDate);
    const days = Object.keys(db.days).filter(k => Object.keys(db.days[k].stops).length).sort().reverse();
    const pushes = (db.days[viewDate] && db.days[viewDate].pushes) || [];
    const lastPush = pushes[pushes.length - 1];
    const queued = db.outbox.filter(o => o.date === viewDate).length;
    return `<div class="toolbar">
        <h2>Daily summary</h2>
        <input type="date" id="sumDate" value="${viewDate}" max="${localDate()}" aria-label="Summary date" style="width:auto">
      </div>
      <div class="kpis">
        <div class="kpi green"><div class="v">${t.delivered}</div><div class="l">Delivered of ${t.stops}</div></div>
        <div class="kpi amber"><div class="v">${t.customer_absent}</div><div class="l">Customer absent</div></div>
        <div class="kpi blue"><div class="v">${t.bottles_returned}</div><div class="l">Bottles returned</div></div>
        <div class="kpi red"><div class="v">${t.spilled_crates}</div><div class="l">Spilled crates${t.bottles_lost ? ` · ${t.bottles_lost} btl lost` : ''}</div></div>
      </div>
      <div class="panel">
        <h3>Send the day</h3>
        <p class="hint">${t.pending ? `${t.pending} stop${t.pending === 1 ? '' : 's'} still pending. ` : ''}${t.first_stop_at ? `First stop ${timeStr(t.first_stop_at)}, last ${timeStr(t.last_stop_at)}.` : 'No stops completed yet.'}</p>
        <div class="row">
          <button class="btn" data-act="csv">Export stops CSV</button>
          <button class="btn secondary" data-act="csv-log">Export exception log</button>
          <button class="btn secondary" data-act="push" ${db.settings.webhookUrl ? '' : 'disabled'}>Push to webhook</button>
        </div>
        <p class="hint" style="margin:12px 0 0">${!db.settings.webhookUrl ? 'Add a webhook URL in Settings to enable push.' :
          queued ? `${queued} push waiting for signal — sends automatically when back online.` :
          lastPush ? `Last push ${timeStr(lastPush.at)} · ${esc(lastPush.result)}` : 'Not pushed yet.'}</p>
      </div>
      <div class="panel">
        <h3>Stops</h3>
        ${rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Stop</th><th>Status</th><th>Time</th><th class="num">Back</th><th class="num">Spill</th><th>Notes</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${r.seq}</td><td><strong>${esc(r.stop)}</strong><div class="muted">${esc([r.address, r.accepted_by && 'Took it: ' + r.accepted_by].filter(Boolean).join(' · '))}</div></td>
            <td class="st ${r.customer_absent === 'yes' ? 'absent' : r.status === 'not_delivered' ? 'skipped' : r.status}">${r.status === 'not_delivered' ? 'Not delivered' : r.status === 'delivered' ? (r.customer_absent === 'yes' ? 'Left at door' : 'Delivered') : 'Pending'}</td>
            <td>${timeStr(r.completed_at)}</td><td class="num">${r.bottles_returned || ''}</td><td class="num">${r.spilled_crates || ''}</td><td>${esc(r.notes)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No stops for this day.</p>'}
      </div>
      <div class="panel">
        <h3>Exception log</h3>
        ${events.length ? `<ul class="log">${events.map(e => `<li><strong>${timeStr(e.at)}</strong> · ${esc(e.stop)} · ${esc(e.type.replace('_', ' '))}${e.qty !== '' ? ` × ${e.qty}` : ''}${e.detail ? ` — ${esc(e.detail)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">Clean day so far. No exceptions logged.</p>'}
      </div>
      ${days.length > 1 ? `<div class="panel"><h3>Past days on this iPad</h3><div class="row">${days.slice(0, 14).map(k => `<button class="btn secondary" data-day="${k}">${prettyDate(k)}</button>`).join('')}</div></div>` : ''}`;
  }

  // ---------- Stops editor ----------
  function renderStops() {
    return `<div class="toolbar"><h2>Route stops</h2><button class="btn" data-act="add-stop">Add stop</button></div>
      ${db.stops.length ? `<ul class="edit-list">${db.stops.map((s, i) => `<li class="edit-item">
          <div class="seq">${i + 1}</div>
          <div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc([s.address, s.order].filter(Boolean).join(' · '))}</div></div>
          <button class="icon-btn" data-act="move" data-dir="-1" data-id="${s.id}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ic.up}</button>
          <button class="icon-btn" data-act="move" data-dir="1" data-id="${s.id}" aria-label="Move down" ${i === db.stops.length - 1 ? 'disabled' : ''}>${ic.down}</button>
          <button class="icon-btn" data-act="edit-stop" data-id="${s.id}" aria-label="Edit">${ic.edit}</button>
        </li>`).join('')}</ul>` : '<div class="empty"><h3>No stops yet</h3><p>Add stops one at a time or paste a list below.</p></div>'}
      <div class="panel" style="margin-top:16px">
        <h3>Load a roster link</h3>
        <p class="hint">Paste the private roster link Merlin sent you. It replaces the stop list; past days stay.</p>
        <input type="url" id="rosterLink" placeholder="https://…#load=…" autocapitalize="off" autocorrect="off">
        <div class="row" style="margin-top:12px"><button class="btn" data-act="roster-link">Load roster</button></div>
      </div>
      <div class="panel">
        <h3>Paste a stop list</h3>
        <p class="hint">One stop per line: <code>Name, Address, Drop, Note, Contact, Segment</code>. Adds to the end of the route.</p>
        <textarea id="bulk" placeholder="Garcia Family, 1408 Elm St, 4 qt whole + 1 cream, Side porch cooler"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn" data-act="bulk">Add these stops</button>
          ${db.stops.length ? '' : '<button class="btn secondary" data-act="sample">Load sample route</button>'}
        </div>
      </div>`;
  }

  // ---------- Settings ----------
  function renderSettings() {
    const s = db.settings;
    const bytes = new Blob([localStorage.getItem(KEY) || '']).size;
    return `<div class="toolbar"><h2>Settings</h2></div>
      <div class="panel">
        <h3>Route</h3>
        <label class="field"><span>Route name</span><input type="text" id="setRoute" value="${esc(s.routeName)}"></label>
        <label class="field"><span>Driver</span><input type="text" id="setDriver" value="${esc(s.driver)}" placeholder="Name on the day's report"></label>
      </div>
      <div class="panel">
        <h3>Webhook</h3>
        <p class="hint">The summary is sent as JSON with a POST. Offline pushes queue and retry automatically.</p>
        <label class="field"><span>Webhook URL</span><input type="url" id="setHook" value="${esc(s.webhookUrl)}" placeholder="https://hooks.zapier.com/…" inputmode="url" autocapitalize="off" autocorrect="off"></label>
        <label class="field"><span>Bearer token (optional)</span><input type="password" id="setToken" value="${esc(s.webhookToken)}" autocomplete="off"></label>
        <label class="field" style="display:flex;align-items:center;gap:12px"><input type="checkbox" id="setAuto" ${s.autoPush ? 'checked' : ''} style="width:28px;height:28px"><span style="margin:0">Auto-push when the last stop is completed</span></label>
        <div class="row"><button class="btn" data-act="save-settings">Save settings</button><button class="btn secondary" data-act="test-hook" ${s.webhookUrl ? '' : 'disabled'}>Send test</button></div>
      </div>
      <div class="panel">
        <h3>Data on this iPad</h3>
        <p class="hint">${Object.keys(db.days).length} day(s) stored · ${(bytes / 1024).toFixed(1)} KB · ${db.outbox.length} queued push(es). Nothing leaves the iPad unless you export or push.</p>
        <div class="row">
          <button class="btn secondary" data-act="backup">Download full backup</button>
          <button class="btn secondary" data-act="restore">Restore backup</button>
          <button class="btn danger" data-act="reset-today">Clear today's log</button>
        </div>
        <input type="file" id="restoreFile" accept="application/json,.json" hidden>
      </div>
      <p class="muted" style="text-align:center">Merlin Route v${APP_VERSION} · Add to Home Screen from the Share menu for full-screen offline use.</p>`;
  }

  // ---------- Render ----------
  function render() {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-current', t.dataset.tab === tab ? 'page' : 'false'));
    if (tab !== 'summary') viewDate = localDate();
    renderHeader();
    const v = $('#view');
    v.innerHTML = tab === 'route' ? renderRoute() : tab === 'summary' ? renderSummary() : tab === 'stops' ? renderStops() : renderSettings();
  }
  function go(t) {
    tab = t;
    try { history.replaceState(null, '', '#' + t); } catch (e) {}
    render(); window.scrollTo(0, 0);
  }

  // ---------- Toast & sheet ----------
  let toastTimer;
  function toast(msg, undoFn) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${undoFn ? '<button type="button">Undo</button>' : ''}`;
    t.hidden = false;
    if (undoFn) t.querySelector('button').onclick = () => { undoFn(); t.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undoFn ? 6000 : 3000);
  }
  function openSheet(html, onMount) {
    const sh = $('#sheet');
    sh.innerHTML = html;
    sh.hidden = false; $('#sheetBackdrop').hidden = false;
    onMount && onMount(sh);
    const f = sh.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 50);
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true; $('#sheet').innerHTML = ''; }
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  function stepper(label, id, start = 0) {
    return `<p class="stepper-label">${label}</p>
      <div class="stepper"><button type="button" data-step="-1" data-for="${id}" aria-label="Less">−</button><output id="${id}">${start}</output><button type="button" data-step="1" data-for="${id}" aria-label="More">+</button></div>`;
  }
  function wireSteppers(sh) {
    sh.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      const o = sh.querySelector('#' + b.dataset.for);
      o.textContent = Math.max(0, (parseInt(o.textContent, 10) || 0) + Number(b.dataset.step));
    }));
    sh.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
      sh.querySelector('#' + b.dataset.for).textContent = b.dataset.set;
    }));
  }
  const stopById = id => db.stops.find(s => s.id === id);

  // ---------- Stop actions ----------
  function touchDay() { const d = day(); if (!d.snapshot || d.snapshot.length !== db.stops.length) snapshotIfNeeded(); }

  function deliver(id) {
    touchDay();
    const r = rec(id); const prev = JSON.stringify(r);
    r.status = 'delivered'; r.at = new Date().toISOString();
    save(); render();
    const s = stopById(id);
    toast(`${s.name} delivered`, () => { day().stops[id] = JSON.parse(prev); save(); render(); });
    maybeAutoPush();
  }

  function sheetReturns(id) {
    const s = stopById(id); const r = rec(id);
    openSheet(`<h2>Bottles back</h2><p class="sub">${esc(s.name)}</p>
      ${stepper('Empty bottles collected', 'retN', r.returns || 0)}
      <div class="quick">${[1, 2, 3, 4, 6, 8, 12].map(n => `<button type="button" data-set="${n}" data-for="retN">${n}</button>`).join('')}</div>
      <div class="row"><button class="btn" id="ok">Save count</button><button class="btn secondary" id="okDeliver">Save + Delivered</button></div>
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      wireSteppers(sh);
      const apply = () => { touchDay(); const rr = rec(id); rr.returns = parseInt(sh.querySelector('#retN').textContent, 10) || 0; rr.returnsAt = new Date().toISOString(); save(); };
      sh.querySelector('#ok').onclick = () => { apply(); closeSheet(); render(); toast(`${rec(id).returns} bottles logged`); };
      sh.querySelector('#okDeliver').onclick = () => { apply(); closeSheet(); deliver(id); };
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function sheetAbsent(id) {
    const s = stopById(id);
    let outcome = 'left';
    openSheet(`<h2>Customer not home</h2><p class="sub">${esc(s.name)}</p>
      <div class="choice" role="group">
        <button type="button" data-o="left" aria-pressed="true">Left order at the door / cooler</button>
        <button type="button" data-o="back" aria-pressed="false">Brought the order back</button>
      </div>
      <label class="field"><span>Note (optional)</span><input type="text" id="absNote" placeholder="Gate locked, dog out, no cooler…"></label>
      <button class="btn wide" id="ok">Log and complete stop</button>
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      sh.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { outcome = b.dataset.o; sh.querySelectorAll('[data-o]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
      sh.querySelector('#ok').onclick = () => {
        touchDay();
        const r = rec(id); const prev = JSON.stringify(r);
        r.absent = { outcome, note: sh.querySelector('#absNote').value.trim(), at: new Date().toISOString() };
        r.status = outcome === 'left' ? 'delivered' : 'skipped'; r.at = r.absent.at;
        save(); closeSheet(); render();
        toast(`${s.name}: absent logged`, () => { day().stops[id] = JSON.parse(prev); save(); render(); });
        maybeAutoPush();
      };
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function sheetSpill(id) {
    const s = stopById(id);
    openSheet(`<h2>Spilled crate</h2><p class="sub">Logged against ${esc(s.name)}</p>
      ${stepper('Crates spilled', 'spC', 1)}
      ${stepper('Bottles lost or broken', 'spB', 0)}
      <label class="field"><span>Note (optional)</span><input type="text" id="spNote" placeholder="Dropped at curb, glass cleaned up…"></label>
      <button class="btn wide" id="ok">Log spill</button>
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      wireSteppers(sh);
      sh.querySelector('#ok').onclick = () => {
        const crates = parseInt(sh.querySelector('#spC').textContent, 10) || 0;
        const bottles = parseInt(sh.querySelector('#spB').textContent, 10) || 0;
        if (!crates && !bottles) { toast('Add at least one crate or bottle'); return; }
        touchDay();
        rec(id).spills.push({ crates, bottles, note: sh.querySelector('#spNote').value.trim(), at: new Date().toISOString() });
        save(); closeSheet(); render(); toast('Spill logged');
      };
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function sheetLog(id) {
    const s = stopById(id); const r = rec(id);
    openSheet(`<h2>${esc(s.name)}</h2><p class="sub">Add to this stop's log</p>
      <div class="choice">
        <button type="button" id="lRet">Bottles back (${r.returns || 0})</button>
        <button type="button" id="lSpill">Spilled crate</button>
        <button type="button" id="lNote">Add a note</button>
      </div>
      <button class="btn secondary wide" id="cancel">Close</button>`, sh => {
      sh.querySelector('#lRet').onclick = () => sheetReturns(id);
      sh.querySelector('#lSpill').onclick = () => sheetSpill(id);
      sh.querySelector('#lNote').onclick = () => sheetNote(id);
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function sheetNote(id) {
    const s = stopById(id);
    openSheet(`<h2>Note</h2><p class="sub">${esc(s.name)}</p>
      <label class="field"><span>What happened?</span><input type="text" id="nT" autofocus></label>
      <button class="btn wide" id="ok">Save note</button>
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      sh.querySelector('#ok').onclick = () => {
        const t = sh.querySelector('#nT').value.trim(); if (!t) return;
        touchDay(); rec(id).notes.push({ text: t, at: new Date().toISOString() });
        save(); closeSheet(); render(); toast('Note saved');
      };
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function sheetHandoff(id) {
    const s = stopById(id); const r = rec(id); const h = r.handoff || {};
    const nexts = ['Send menu', 'Follow up next week', 'Return later', 'Wants a tasting', 'No next step'];
    let next = h.next || '';
    openSheet(`<h2>Who took it</h2><p class="sub">${esc(s.name)}${s.contact ? ' · ' + esc(s.contact) : ''}</p>
      <label class="field"><span>Name of the person who took it</span><input type="text" id="hBy" value="${esc(h.acceptedBy || '')}" placeholder="First name is fine" autofocus></label>
      <p class="stepper-label">Next step</p>
      <div class="choice" role="group">${nexts.map(n => `<button type="button" data-n="${esc(n)}" aria-pressed="${n === next}">${esc(n)}</button>`).join('')}</div>
      <label class="field"><span>Note (optional)</span><input type="text" id="hNote" value="${esc(h.note || '')}" placeholder="Email, best day, what they said…"></label>
      <div class="row"><button class="btn" id="okDeliver">Save + Delivered</button><button class="btn secondary" id="ok">Save only</button></div>
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      sh.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { next = next === b.dataset.n ? '' : b.dataset.n; sh.querySelectorAll('[data-n]').forEach(x => x.setAttribute('aria-pressed', x.dataset.n === next)); });
      const apply = () => { touchDay(); rec(id).handoff = { acceptedBy: sh.querySelector('#hBy').value.trim(), next, note: sh.querySelector('#hNote').value.trim(), at: new Date().toISOString() }; save(); };
      sh.querySelector('#ok').onclick = () => { apply(); closeSheet(); render(); toast('Handoff saved'); };
      sh.querySelector('#okDeliver').onclick = () => { apply(); closeSheet(); if (isDone(rec(id))) { render(); toast('Handoff saved'); } else deliver(id); };
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  // Private roster links carry the stop list in the URL fragment, which never reaches the server.
  function decodeRoster(str) {
    const m = String(str || '').match(/[#&]load=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
      const json = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      const d = JSON.parse(json);
      return d && Array.isArray(d.stops) ? d : null;
    } catch (e) { console.warn(e); return null; }
  }
  function importRoster(str) {
    const d = decodeRoster(str);
    if (!d) return false;
    db.stops = d.stops.map(x => ({ id: x.id || uid(), name: x.name || 'Stop', address: x.address || '', contact: x.contact || '', segment: x.segment || '', order: x.order || '', notes: x.notes || '', brief: x.brief || '' }));
    if (d.routeName) db.settings.routeName = d.routeName;
    if (d.driver && !db.settings.driver) db.settings.driver = d.driver;
    if (db.days[localDate()]) snapshotIfNeeded();
    save();
    toast(`${db.stops.length} stops loaded${d.routeName ? ' · ' + d.routeName : ''}`);
    return true;
  }

  function undo(id) {
    const r = rec(id);
    const prev = JSON.stringify(r);
    r.status = 'pending'; r.at = null;
    if (r.absent) r.absent = null;
    save(); render();
    toast('Stop reopened', () => { day().stops[id] = JSON.parse(prev); save(); render(); });
  }

  // ---------- Stop editing ----------
  function sheetStop(id) {
    const s = id ? stopById(id) : { name: '', address: '', contact: '', segment: '', order: '', notes: '', brief: '' };
    openSheet(`<h2>${id ? 'Edit stop' : 'New stop'}</h2><p class="sub">${id ? 'Changes apply from today forward.' : 'Added to the end of the route.'}</p>
      <label class="field"><span>Customer / stop name</span><input type="text" id="sN" value="${esc(s.name)}" autofocus></label>
      <label class="field"><span>Address / suite</span><input type="text" id="sA" value="${esc(s.address)}"></label>
      <label class="field"><span>Contact · title</span><input type="text" id="sC" value="${esc(s.contact || '')}"></label>
      <label class="field"><span>Segment</span><input type="text" id="sS" value="${esc(s.segment || '')}" placeholder="Over 50 · Under 50 · Unknown"></label>
      <label class="field"><span>Standing order</span><input type="text" id="sO" value="${esc(s.order)}" placeholder="4 qt whole, 1 pt cream"></label>
      <label class="field"><span>Driver note</span><input type="text" id="sX" value="${esc(s.notes)}" placeholder="Side porch cooler"></label>
      <label class="field"><span>411 (back-pocket notes)</span><textarea id="sB" style="font-family:inherit;min-height:90px">${esc(s.brief || '')}</textarea></label>
      <button class="btn wide" id="ok">${id ? 'Save stop' : 'Add stop'}</button>
      ${id ? '<button class="btn danger wide" id="del" style="margin-top:10px">Remove from route</button>' : ''}
      <button class="btn secondary wide" id="cancel" style="margin-top:10px">Cancel</button>`, sh => {
      sh.querySelector('#ok').onclick = () => {
        const v = { name: sh.querySelector('#sN').value.trim(), address: sh.querySelector('#sA').value.trim(), order: sh.querySelector('#sO').value.trim(), notes: sh.querySelector('#sX').value.trim(), contact: sh.querySelector('#sC').value.trim(), segment: sh.querySelector('#sS').value.trim(), brief: sh.querySelector('#sB').value.trim() };
        if (!v.name) { toast('Name is required'); return; }
        if (id) Object.assign(stopById(id), v); else db.stops.push({ id: uid(), ...v });
        if (db.days[localDate()]) snapshotIfNeeded();
        save(); closeSheet(); render();
      };
      const del = sh.querySelector('#del');
      if (del) {
        let armed = false;
        del.onclick = () => {
          if (!armed) { armed = true; del.textContent = 'Tap again to remove'; return; }
          db.stops = db.stops.filter(x => x.id !== id);
          if (db.days[localDate()]) snapshotIfNeeded();
          save(); closeSheet(); render(); toast('Stop removed');
        };
      }
      sh.querySelector('#cancel').onclick = closeSheet;
    });
  }

  function parseCSVLine(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',' || c === '\t') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim()); return out;
  }

  function bulkAdd(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let n = 0;
    lines.forEach(l => {
      const [name, address = '', order = '', notes = '', contact = '', segment = ''] = parseCSVLine(l);
      if (!name || /^name$/i.test(name)) return;
      db.stops.push({ id: uid(), name, address, order, notes, contact, segment }); n++;
    });
    if (db.days[localDate()]) snapshotIfNeeded();
    save(); render(); toast(`${n} stop${n === 1 ? '' : 's'} added`);
  }

  function loadSample() {
    const sample = [
      ['Garcia Family', '1408 Elm St', '4 qt whole, 1 pt cream', 'Side porch cooler'],
      ['Whitfield', '1422 Elm St', '2 qt 2%', ''],
      ['Corner Café', '210 Main St', '12 qt whole, 6 qt oat, 4 pt half & half', 'Back door before 7'],
      ['Okafor', '35 Willow Ln', '3 qt whole', 'Dog in yard'],
      ['Benson', '41 Willow Ln', '1 qt skim, 1 dozen eggs', ''],
      ['Lakeside Daycare', '900 Lake Dr', '10 qt whole', 'Sign at front desk'],
      ['Nguyen', '17 Birch Ct', '2 qt whole, 1 qt chocolate', ''],
      ['Patel', '22 Birch Ct', '2 qt 2%', 'Collect empties from crate'],
      ['Holloway', '5 Ridge Rd', '1 qt whole', 'Gate code 4410'],
      ['St. Mark Rectory', '88 Chapel St', '4 qt whole', '']
    ];
    sample.forEach(([name, address, order, notes]) => db.stops.push({ id: uid(), name, address, order, notes }));
    if (!db.settings.routeName || db.settings.routeName === 'Route') db.settings.routeName = 'Sample Route';
    save(); go('route'); toast('Sample route loaded — edit it in Stops');
  }

  // ---------- Export ----------
  const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function toCSV(rows, cols) { return '\ufeff' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n'); }
  const slug = s => (s || 'route').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function deliverFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    // iPad: the share sheet lets the driver save to Files, AirDrop, Mail or Messages.
    try {
      const file = new File([blob], name, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`${name} saved`);
  }

  function exportCSV(kind) {
    const { rows, events, totals } = computeDay(viewDate);
    const meta = { route: db.settings.routeName, driver: db.settings.driver, date: viewDate };
    if (kind === 'log') {
      const cols = ['date', 'route', 'driver', 'time', 'stop', 'type', 'qty', 'detail'];
      const data = events.map(e => ({ ...meta, time: e.at ? new Date(e.at).toLocaleTimeString() : '', stop: e.stop, type: e.type, qty: e.qty, detail: e.detail }));
      deliverFile(`${slug(meta.route)}-${viewDate}-exceptions.csv`, toCSV(data, cols), 'text/csv');
    } else {
      const cols = ['date', 'route', 'driver', 'seq', 'stop', 'address', 'contact', 'segment', 'order', 'status', 'completed_at', 'accepted_by', 'next_action', 'bottles_returned', 'customer_absent', 'absent_outcome', 'spilled_crates', 'bottles_lost', 'notes'];
      const data = rows.map(r => ({ ...meta, ...r, completed_at: r.completed_at ? new Date(r.completed_at).toLocaleString() : '' }));
      data.push({ date: viewDate, route: meta.route, driver: meta.driver, seq: '', stop: 'TOTAL', address: '', contact: '', segment: '', order: '', accepted_by: totals.handoffs_named ? `${totals.handoffs_named} named` : '', next_action: '', status: `${totals.delivered} delivered / ${totals.stops}`, completed_at: '', bottles_returned: totals.bottles_returned, customer_absent: totals.customer_absent, absent_outcome: '', spilled_crates: totals.spilled_crates, bottles_lost: totals.bottles_lost, notes: '' });
      deliverFile(`${slug(meta.route)}-${viewDate}-stops.csv`, toCSV(data, cols), 'text/csv');
    }
  }

  // ---------- Webhook ----------
  function buildPayload(ds, test = false) {
    const { rows, events, totals } = computeDay(ds);
    return {
      type: test ? 'merlin_route.test' : 'merlin_route.daily_summary',
      app_version: APP_VERSION,
      device_id: db.settings.deviceId,
      generated_at: new Date().toISOString(),
      date: ds, route: db.settings.routeName, driver: db.settings.driver,
      totals, stops: rows, exceptions: events
    };
  }

  async function sendOne(item) {
    const url = db.settings.webhookUrl;
    const headers = { 'Content-Type': 'application/json' };
    if (db.settings.webhookToken) headers.Authorization = 'Bearer ' + db.settings.webhookToken;
    const body = JSON.stringify(item.payload);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, mode: 'cors' });
      if (res.ok) return { ok: true, result: `delivered (HTTP ${res.status})` };
      if (res.status >= 400 && res.status < 500) return { ok: false, fatal: true, result: `rejected (HTTP ${res.status})` };
      return { ok: false, result: `server error (HTTP ${res.status})` };
    } catch (e) {
      if (!navigator.onLine) return { ok: false, result: 'offline' };
      // Many no-code webhooks (Zapier, Make, Apps Script) don't answer CORS preflight.
      // Fall back to a "simple" request: still delivered, but the response can't be read.
      try {
        await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });
        return { ok: true, result: 'sent (receiver did not confirm — check it arrived)' };
      } catch (e2) { return { ok: false, result: 'network error' }; }
    }
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !db.outbox.length || !navigator.onLine || !db.settings.webhookUrl) return;
    flushing = true;
    try {
      for (const item of [...db.outbox]) {
        const r = await sendOne(item);
        item.tries = (item.tries || 0) + 1;
        if (r.ok || r.fatal) {
          db.outbox = db.outbox.filter(o => o.id !== item.id);
          if (!item.test) day(item.date).pushes.push({ at: new Date().toISOString(), result: r.result, ok: r.ok });
          toast(item.test ? `Test ${r.result}` : `Summary ${r.result}`);
        } else if (r.result === 'offline') break;
        save();
      }
    } finally { flushing = false; render(); }
  }

  function queuePush(ds, test = false) {
    if (!db.settings.webhookUrl) { toast('Add a webhook URL in Settings'); return; }
    // Replace any queued summary for the same day with the latest numbers.
    db.outbox = db.outbox.filter(o => test || o.test || o.date !== ds);
    db.outbox.push({ id: uid(), date: ds, test, payload: buildPayload(ds, test), queuedAt: new Date().toISOString(), tries: 0 });
    save(); render();
    if (!navigator.onLine) toast('No signal — queued, will send when back online');
    flushOutbox();
  }

  function maybeAutoPush() {
    if (!db.settings.autoPush || !db.settings.webhookUrl) return;
    const { totals } = computeDay(localDate());
    if (totals.stops && totals.pending === 0) queuePush(localDate());
  }

  window.addEventListener('online', () => { render(); flushOutbox(); });
  window.addEventListener('offline', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); flushOutbox(); } });
  setInterval(flushOutbox, 60000);

  // ---------- Backup ----------
  function restoreFrom(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (!d || !Array.isArray(d.stops) || typeof d.days !== 'object') throw new Error('bad');
        db = { ...blank(), ...d, settings: { ...blank().settings, ...d.settings } };
        save(); render(); toast('Backup restored');
      } catch (e) { toast('That file is not a Merlin Route backup'); }
    };
    fr.readAsText(file);
  }

  // ---------- Events ----------
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });

  let armedReset = false;
  $('#view').addEventListener('click', e => {
    const goB = e.target.closest('[data-go]'); if (goB) return go(goB.dataset.go);
    const f = e.target.closest('[data-filter]'); if (f) { routeFilter = f.dataset.filter; return render(); }
    const dB = e.target.closest('[data-day]'); if (dB) { viewDate = dB.dataset.day; return render(); }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'deliver': return deliver(id);
      case 'returns': return sheetReturns(id);
      case 'absent': return sheetAbsent(id);
      case 'spill': return sheetSpill(id);
      case 'handoff': return sheetHandoff(id);
      case 'roster-link': { const v = $('#rosterLink').value.trim(); if (!importRoster(v)) toast('That link has no roster in it'); return; }
      case 'exception': return sheetLog(id);
      case 'undo': return undo(id);
      case 'sample': return loadSample();
      case 'add-stop': return sheetStop(null);
      case 'edit-stop': return sheetStop(id);
      case 'move': {
        const i = db.stops.findIndex(s => s.id === id); const j = i + Number(b.dataset.dir);
        if (j < 0 || j >= db.stops.length) return;
        [db.stops[i], db.stops[j]] = [db.stops[j], db.stops[i]];
        if (db.days[localDate()]) snapshotIfNeeded();
        save(); return render();
      }
      case 'bulk': { const t = $('#bulk').value; if (t.trim()) bulkAdd(t); return; }
      case 'csv': return exportCSV('stops');
      case 'csv-log': return exportCSV('log');
      case 'push': return queuePush(viewDate);
      case 'save-settings': {
        Object.assign(db.settings, {
          routeName: $('#setRoute').value.trim() || 'Route', driver: $('#setDriver').value.trim(),
          webhookUrl: $('#setHook').value.trim(), webhookToken: $('#setToken').value.trim(), autoPush: $('#setAuto').checked
        });
        save(); render(); return toast('Settings saved');
      }
      case 'test-hook': return queuePush(localDate(), true);
      case 'backup': return deliverFile(`merlin-route-backup-${localDate()}.json`, JSON.stringify(db, null, 2), 'application/json');
      case 'restore': { const inp = $('#restoreFile'); inp.onchange = () => inp.files[0] && restoreFrom(inp.files[0]); return inp.click(); }
      case 'reset-today': {
        if (!armedReset) { armedReset = true; b.textContent = 'Tap again to clear today'; setTimeout(() => { armedReset = false; }, 4000); return; }
        armedReset = false; delete db.days[localDate()]; save(); render(); return toast("Today's log cleared");
      }
    }
  });
  $('#view').addEventListener('change', e => { if (e.target.id === 'sumDate' && e.target.value) { viewDate = e.target.value; render(); } });

  // Roll over at midnight without a reload.
  let lastDate = localDate();
  setInterval(() => { if (localDate() !== lastDate) { lastDate = localDate(); render(); } }, 30000);

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
  }

  const sampleNames = ['Garcia Family', 'Corner Café'];
  const onlySample = db.stops.length && db.stops.some(x => sampleNames.includes(x.name)) && !db.stops.some(x => /^t01-/.test(x.id));
  if (window.MERLIN_DEFAULT_ROSTER && (!db.stops.length || onlySample)) {
    const d = window.MERLIN_DEFAULT_ROSTER;
    db.stops = d.stops.map(x => ({ ...x }));
    db.settings.routeName = d.routeName;
    if (!db.settings.driver) db.settings.driver = d.driver || '';
    if (db.days[localDate()]) snapshotIfNeeded();
    save();
  }
  if (/[#&]load=/.test(location.hash)) {
    importRoster(location.hash);
    tab = 'route';
    try { history.replaceState(null, '', location.pathname + '#route'); } catch (e) {}
  }
  render();
  flushOutbox();
})();
