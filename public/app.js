/*
 * Power Outages — client.
 *
 * Watched areas, filter text and the lead time live in localStorage. Alerts are
 * real Web Push: the server keeps the subscription, polls DEDDIE on its own
 * schedule and notifies the device whether or not this page is open. All this
 * file does is register the subscription and keep the server's copy of
 * (areas, leadHours) in sync.
 */

const LS = {
  areas: 'po.areas',
  filter: 'po.filter',
  upcoming: 'po.upcomingOnly',
  lead: 'po.leadHours',
  push: 'po.pushOn'
};

const REFRESH_MS = 10 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const CACHE = 'power-outages-v2';   // must match sw.js

const $ = id => document.getElementById(id);
const el = { add:$('add'), areas:$('areas'), results:$('results'), status:$('status'),
             refresh:$('refresh'), filter:$('filter'), upcomingOnly:$('upcomingOnly'),
             lead:$('lead'), notify:$('notify'), testPush:$('testPush'), pushHint:$('pushHint') };

let areas = load(LS.areas, []);
let outages = [];          // deduped, merged across areas
let expanded = new Set();
let lastFetch = 0;
let loading = false;

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null ? fallback : v; }
  catch { return fallback; }
}
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- dates -------------------------------------------------------------------
// The API sends local-naive stamps ("2026-08-09T07:45:00"), which the Date
// constructor reads as local time — exactly the wall clock DEDDIE published.
const parse = s => (s ? new Date(s) : null);
const p2 = n => String(n).padStart(2, '0');
const hhmm = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const dayKey = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((that - today) / 86400000);
  const long = that.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long' });
  if (days === 0) return { title: 'Σήμερα', note: long, today: true };
  if (days === 1) return { title: 'Αύριο', note: long, today: false };
  return { title: long.charAt(0).toUpperCase() + long.slice(1), note: days > 1 ? `σε ${days} ημέρες` : '', today: false };
}

function duration(from, to) {
  if (!from || !to) return '';
  const mins = Math.round((to - from) / 60000);
  if (mins < 60) return `${mins}′`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}ω ${m}′` : `${h}ω`;
}

function state(o, now) {
  if (!o.fromDate) return { key: 'later', label: '' };
  if (o.toDate && now > o.toDate) return { key: 'past', label: 'Ολοκληρώθηκε' };
  if (now >= o.fromDate) return { key: 'live', label: 'ΣΕ ΕΞΕΛΙΞΗ' };
  const mins = Math.round((o.fromDate - now) / 60000);
  if (mins < 60) return { key: 'soon', label: `σε ${mins}′` };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { key: hours <= 3 ? 'soon' : 'later', label: `σε ${hours}ω` };
  return { key: 'later', label: `σε ${Math.round(hours / 24)} ημ.` };
}

// ---- api ---------------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(json.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return json;
}

const postJson = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

/* ---------------------------------------------------------------------------
 * Combobox: a <select> can't be typed into, and some of these lists are long
 * (60 prefectures, and municipalities per prefecture). Matching is
 * accent- and case-insensitive, and every typed word has to appear somewhere in
 * the name — so "ιωανν" and "δημ ιωανν" both find ΔΗΜΟΣ ΙΩΑΝΝΙΤΩΝ.
 * ------------------------------------------------------------------------- */
const norm = s => String(s).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function createCombo(inputId, listId, { onSelect, emptyLabel } = {}) {
  const input = $(inputId);
  const list = $(listId);
  const toggle = input.parentElement.querySelector('.combo-toggle');
  let items = [];
  let shown = [];
  let active = -1;
  let selected = null;

  const open = () => { list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };

  function matches(query) {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter(it => words.every(w => norm(it.name).includes(w)));
  }

  function draw() {
    if (!shown.length) {
      list.innerHTML = `<li class="combo-empty">${esc(emptyLabel || 'Καμία αντιστοιχία')}</li>`;
      return;
    }
    const words = norm(input.value).split(/\s+/).filter(Boolean);
    list.innerHTML = shown.map((it, i) => `
      <li role="option" data-i="${i}" aria-selected="${i === active}"
          class="${i === active ? 'active' : ''}${selected && selected.id === it.id ? ' chosen' : ''}">
        ${highlight(it.name, words[0])}
      </li>`).join('');
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function highlight(name, word) {
    if (!word) return esc(name);
    const at = norm(name).indexOf(word);
    if (at < 0) return esc(name);
    // norm() is 1:1 on length for these names (uppercasing + dropping combining
    // marks), so offsets carry over to the original string.
    return esc(name.slice(0, at)) + '<b>' + esc(name.slice(at, at + word.length)) + '</b>' +
           esc(name.slice(at + word.length));
  }

  function filter() {
    shown = matches(input.value);
    active = shown.length ? 0 : -1;
    draw();
    open();
  }

  function choose(i) {
    const it = shown[i];
    if (!it) return;
    selected = it;
    input.value = it.name;
    close();
    onSelect?.(it);
  }

  input.addEventListener('input', () => {
    // Typing past a previous pick means the pick is no longer what's in the box.
    if (selected && input.value !== selected.name) { selected = null; onSelect?.(null); }
    filter();
  });
  input.addEventListener('focus', () => { shown = matches(''); active = -1; draw(); open(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) filter();
      if (!shown.length) return;
      active = e.key === 'ArrowDown'
        ? (active + 1) % shown.length
        : (active - 1 + shown.length) % shown.length;
      draw();
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); }
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => {
    // Let a click on the list win the race against blur.
    setTimeout(() => {
      close();
      if (selected) input.value = selected.name;
      else if (input.value) { input.value = ''; onSelect?.(null); }
    }, 150);
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
  });
  toggle?.addEventListener('mousedown', e => {
    e.preventDefault();
    if (list.hidden) { input.focus(); shown = matches(''); draw(); open(); }
    else close();
  });

  return {
    setItems(next) { items = next; selected = null; input.value = ''; },
    setEnabled(on) { input.disabled = !on; if (!on) { items = []; selected = null; input.value = ''; } },
    setPlaceholder(text) { input.placeholder = text; },
    get selected() { return selected; }
  };
}

const municipalityCombo = createCombo('municipality', 'municipalityList', {
  onSelect: () => {},
  emptyLabel: 'Κανένας δήμος δεν ταιριάζει'
});

const prefectureCombo = createCombo('prefecture', 'prefectureList', {
  emptyLabel: 'Κανένας νομός δεν ταιριάζει',
  onSelect: async pref => {
    el.add.disabled = !pref;
    municipalityCombo.setEnabled(false);
    if (!pref) return;
    municipalityCombo.setPlaceholder('Φόρτωση…');
    try {
      const list = await api(`/api/municipalities?prefecture=${pref.id}`);
      municipalityCombo.setItems(list);
      municipalityCombo.setEnabled(true);
      municipalityCombo.setPlaceholder('Όλος ο νομός — ή πληκτρολόγησε δήμο');
    } catch {
      municipalityCombo.setPlaceholder('Όλος ο νομός');
    }
  }
});

async function loadPrefectures() {
  try {
    prefectureCombo.setItems(await api('/api/prefectures'));
  } catch (err) {
    setStatus(`Δεν φορτώθηκε η λίστα νομών: ${err.message}`, true);
  }
}

// ---- watched areas -----------------------------------------------------------
function renderAreas() {
  el.areas.innerHTML = areas.map(a => `
    <span class="chip">
      <b>${esc(a.municipalityName || a.prefectureName)}</b>
      ${a.municipalityName ? `<small>${esc(a.prefectureName)}</small>` : '<small>όλος ο νομός</small>'}
      <button data-key="${esc(a.key)}" title="Αφαίρεση" aria-label="Αφαίρεση">×</button>
    </span>`).join('');
}

function addArea() {
  const pref = prefectureCombo.selected;
  if (!pref) return;
  const mun = municipalityCombo.selected;
  const key = `${pref.id}${mun ? ':' + mun.id : ''}`;
  if (areas.some(a => a.key === key)) return;

  areas.push({
    key, prefectureId: pref.id, municipalityId: mun ? mun.id : null,
    prefectureName: pref.name, municipalityName: mun ? mun.name : null
  });
  save(LS.areas, areas);
  renderAreas();
  syncPush();
  refresh();
}

function removeArea(key) {
  areas = areas.filter(a => a.key !== key);
  save(LS.areas, areas);
  renderAreas();
  syncPush();
  if (areas.length) refresh(); else { outages = []; render(); }
}

// ---- fetch + merge -----------------------------------------------------------
async function refresh() {
  if (!areas.length) { outages = []; setStatus(''); render(); return; }
  if (loading) return;
  loading = true;
  el.refresh.classList.add('spin');
  setStatus('Ανάκτηση από ΔΕΔΔΗΕ…');

  try {
    const data = await api(`/api/outages?areas=${areas.map(a => a.key).join(',')}`);

    // The same outage can surface under several watched areas (a prefecture watch
    // and one of its municipalities). Keep one copy, remember every area it hit.
    const byId = new Map();
    for (const area of data.areas) {
      const label = area.municipalityName || area.prefectureName;
      for (const o of area.outages) {
        const hit = byId.get(o.id);
        if (hit) { if (!hit.areaLabels.includes(label)) hit.areaLabels.push(label); continue; }
        byId.set(o.id, { ...o, fromDate: parse(o.from), toDate: parse(o.to), areaLabels: [label] });
      }
    }
    outages = [...byId.values()].sort((a, b) => (a.fromDate || 0) - (b.fromDate || 0));

    const failed = data.areas.filter(a => a.error);
    lastFetch = Date.now();
    setStatus(
      failed.length
        ? `Ενημερώθηκε ${hhmm(new Date())} · αποτυχία σε: ${failed.map(a => a.municipalityName || a.prefectureName).join(', ')}`
        : `Ενημερώθηκε ${hhmm(new Date())} · ${outages.length} ${outages.length === 1 ? 'διακοπή' : 'διακοπές'}`,
      failed.length > 0
    );
    render();
  } catch (err) {
    setStatus(`Σφάλμα ανάκτησης: ${err.message}`, true);
  } finally {
    loading = false;
    el.refresh.classList.remove('spin');
  }
}

// ---- render ------------------------------------------------------------------
function visible() {
  const now = new Date();
  const q = el.filter.value.trim().toLowerCase();
  return outages.filter(o => {
    if (el.upcomingOnly.checked && o.toDate && o.toDate < now) return false;
    if (!q) return true;
    return [o.description, o.reason, o.note, o.municipalities.join(' '), o.areaLabels.join(' ')]
      .join(' ').toLowerCase().includes(q);
  });
}

function render() {
  const list = visible();

  if (!areas.length) {
    el.results.innerHTML = emptyBox('📍', 'Δεν έχεις επιλέξει περιοχές.',
      'Διάλεξε νομό (και προαιρετικά δήμο) παραπάνω και πάτα «Προσθήκη».');
    return;
  }
  if (!list.length) {
    el.results.innerHTML = outages.length
      ? emptyBox('🔍', 'Κανένα αποτέλεσμα με αυτά τα φίλτρα.', 'Δοκίμασε άλλον όρο ή ξετσέκαρε το «Μόνο επερχόμενες».')
      : emptyBox('✅', 'Καμία προγραμματισμένη διακοπή.', 'Δεν υπάρχουν ανακοινωμένες διακοπές για τις περιοχές σου.');
    return;
  }

  const now = new Date();
  const multiArea = areas.length > 1;
  let html = '';
  let day = null;

  for (const o of list) {
    const k = o.fromDate ? dayKey(o.fromDate) : 'x';
    if (k !== day) {
      day = k;
      const d = o.fromDate ? dayLabel(o.fromDate) : { title: 'Χωρίς ημερομηνία', note: '' };
      html += `<div class="day${d.today ? ' today' : ''}"><h3>${esc(d.title)}</h3><span>${esc(d.note)}</span></div>`;
    }
    html += card(o, now, multiArea);
  }
  el.results.innerHTML = html;
}

function card(o, now, multiArea) {
  const st = state(o, now);
  const open = expanded.has(o.id);
  const longDesc = o.description.length > 150 || o.description.includes('\n');

  return `
  <article class="outage ${st.key}">
    <div class="when">
      <div class="t">${o.fromDate ? hhmm(o.fromDate) : '—'}</div>
      <div class="arrow">▼</div>
      <div class="t">${o.toDate ? hhmm(o.toDate) : '—'}</div>
      <div class="dur">${esc(duration(o.fromDate, o.toDate))}</div>
    </div>
    <div class="body">
      <div class="line1">
        ${st.label ? `<span class="tag state ${st.key}">${esc(st.label)}</span>` : ''}
        ${o.municipalities.map(m => `<span class="tag mun">${esc(m)}</span>`).join('')}
        ${o.reason ? `<span class="tag reason">${esc(o.reason)}</span>` : ''}
      </div>
      <p class="desc${open ? ' open' : ''}">${esc(o.description)}</p>
      ${longDesc ? `<button class="more" data-more="${esc(o.id)}">${open ? 'Λιγότερα' : 'Περισσότερα'}</button>` : ''}
      <div class="meta">
        ${o.note ? `<span>Σημείωμα ${esc(o.note)}</span>` : ''}
        ${multiArea ? `<span>Περιοχή: ${esc(o.areaLabels.join(', '))}</span>` : ''}
      </div>
    </div>
  </article>`;
}

const emptyBox = (icon, title, sub) =>
  `<div class="empty"><span class="big">${icon}</span><b>${esc(title)}</b><br>${esc(sub)}</div>`;

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('err', isError);
}

/* ---------------------------------------------------------------------------
 * Web Push
 *
 * The server does the watching; this only registers the device and keeps the
 * server's copy of (areas, leadHours) current. Nothing here fires a
 * notification — that would stop the moment the tab closed, which is the whole
 * thing we're avoiding.
 * ------------------------------------------------------------------------- */
const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlB64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

const pushSettings = () => ({ areas: areas.map(a => a.key), leadHours: Number(el.lead.value) || 24 });

// The service worker can't read localStorage, but it needs these if the browser
// swaps the subscription out from under us (pushsubscriptionchange).
async function mirrorSettings() {
  try {
    const cache = await caches.open(CACHE);
    await cache.put('push-settings.json', new Response(JSON.stringify(pushSettings()), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch { /* best effort */ }
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function setPushUi(on, hint) {
  el.notify.classList.toggle('on', on);
  el.notify.textContent = on ? '🔔 Ειδοποιήσεις ενεργές' : 'Ενεργοποίηση ειδοποιήσεων';
  el.testPush.hidden = !on;
  if (hint) el.pushHint.textContent = hint;
}

async function enablePush() {
  if (!pushSupported()) {
    setPushUi(false, 'Ο browser δεν υποστηρίζει push ειδοποιήσεις.');
    return;
  }
  if (!areas.length) {
    setStatus('Πρόσθεσε πρώτα τουλάχιστον μία περιοχή.', true);
    return;
  }
  try {
    const { publicKey } = await api('/api/vapid-public-key');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setPushUi(false, 'Οι ειδοποιήσεις είναι μπλοκαρισμένες στις ρυθμίσεις του browser.');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription() ||
      await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey)
      });

    const res = await postJson('/api/subscribe', {
      subscription, ...pushSettings(), userAgent: navigator.userAgent
    });
    save(LS.push, true);
    await mirrorSettings();
    setPushUi(true, `Ενεργές για ${res.areas.length} ${res.areas.length === 1 ? 'περιοχή' : 'περιοχές'} · υπενθύμιση ${res.leadHours}ω πριν. Φτάνουν και με την εφαρμογή κλειστή.`);
  } catch (err) {
    save(LS.push, false);
    setPushUi(false, err.status === 503
      ? 'Ο server δεν έχει ρυθμισμένα κλειδιά VAPID, οπότε δεν μπορεί να στείλει push.'
      : `Αποτυχία ενεργοποίησης: ${err.message}`);
  }
}

async function disablePush() {
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      await postJson('/api/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
  } finally {
    save(LS.push, false);
    setPushUi(false, 'Οι ειδοποιήσεις είναι απενεργοποιημένες.');
  }
}

// Push settings that changed while the device is registered (areas added or
// removed, different lead time) have to reach the server, or it keeps watching
// the old set.
async function syncPush() {
  if (!load(LS.push, false) || !pushSupported()) return;
  const subscription = await currentSubscription();
  if (!subscription) return;
  await mirrorSettings();
  if (!areas.length) {
    await postJson('/api/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
    return;
  }
  await postJson('/api/subscribe', { subscription, ...pushSettings(), userAgent: navigator.userAgent })
    .catch(() => {});
}

async function restorePushState() {
  if (!pushSupported()) { setPushUi(false, 'Ο browser δεν υποστηρίζει push ειδοποιήσεις.'); return; }
  if (!load(LS.push, false)) return;
  const subscription = await currentSubscription();
  if (subscription && Notification.permission === 'granted') {
    setPushUi(true);
    syncPush();
  } else {
    save(LS.push, false);
    setPushUi(false);
  }
}

async function sendTestPush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  el.testPush.disabled = true;
  try {
    await postJson('/api/test-push', { endpoint: subscription.endpoint });
    setStatus('Στάλθηκε δοκιμαστική ειδοποίηση.');
  } catch (err) {
    setStatus(`Η δοκιμή απέτυχε: ${err.message}`, true);
  } finally {
    el.testPush.disabled = false;
  }
}

// ---- wiring ------------------------------------------------------------------
el.add.addEventListener('click', addArea);
el.areas.addEventListener('click', e => {
  const key = e.target.dataset.key;
  if (key) removeArea(key);
});
el.results.addEventListener('click', e => {
  const id = e.target.dataset.more;
  if (!id) return;
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  render();
});
el.refresh.addEventListener('click', () => refresh());
el.filter.addEventListener('input', () => { save(LS.filter, el.filter.value); render(); });
el.upcomingOnly.addEventListener('change', () => { save(LS.upcoming, el.upcomingOnly.checked); render(); });
el.lead.addEventListener('change', () => { save(LS.lead, el.lead.value); syncPush(); });
el.notify.addEventListener('click', () => (load(LS.push, false) ? disablePush() : enablePush()));
el.testPush.addEventListener('click', sendTestPush);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastFetch > STALE_MS) refresh();
});
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(render, 60000);   // keep "σε 2ω" / "ΣΕ ΕΞΕΛΙΞΗ" honest

// ---- boot --------------------------------------------------------------------
el.filter.value = load(LS.filter, '');
el.upcomingOnly.checked = load(LS.upcoming, true);
el.lead.value = load(LS.lead, '24');
renderAreas();
render();
loadPrefectures();
if (areas.length) refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(restorePushState)
    .catch(() => setPushUi(false, 'Το service worker δεν καταχωρήθηκε — οι push ειδοποιήσεις απαιτούν HTTPS ή localhost.'));
}
