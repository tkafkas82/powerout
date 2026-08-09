/*
 * Power Outages — client.
 *
 * State lives in localStorage: the watched areas, the text filter, and which
 * outage ids we have already fired a notification for. Everything else is
 * derived from /api/outages on each refresh.
 */

const LS = {
  areas: 'po.areas',
  filter: 'po.filter',
  upcoming: 'po.upcomingOnly',
  lead: 'po.leadHours',
  notify: 'po.notifyOn',
  notified: 'po.notified'
};

const REFRESH_MS = 10 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;

const $ = id => document.getElementById(id);
const el = { prefecture:$('prefecture'), municipality:$('municipality'), add:$('add'),
             areas:$('areas'), results:$('results'), status:$('status'), refresh:$('refresh'),
             filter:$('filter'), upcomingOnly:$('upcomingOnly'), lead:$('lead'), notify:$('notify') };

let areas = load(LS.areas, []);
let notified = new Set(load(LS.notified, []));
let outages = [];          // deduped, merged across areas
let expanded = new Set();
let lastFetch = 0;
let loading = false;

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null ? fallback : v; }
  catch { return fallback; }
}
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

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

// ---- lookups -----------------------------------------------------------------
async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function loadPrefectures() {
  try {
    const list = await api('/api/prefectures');
    el.prefecture.innerHTML = '<option value="">[Επιλέξτε Νομό]</option>' +
      list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  } catch (err) {
    el.prefecture.innerHTML = '<option value="">Σφάλμα φόρτωσης</option>';
    setStatus(`Δεν φορτώθηκε η λίστα νομών: ${err.message}`, true);
  }
}

async function loadMunicipalities(prefectureId) {
  el.municipality.innerHTML = '<option value="">Φόρτωση…</option>';
  el.municipality.disabled = true;
  try {
    const list = await api(`/api/municipalities?prefecture=${prefectureId}`);
    el.municipality.innerHTML = '<option value="">Όλος ο νομός</option>' +
      list.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    el.municipality.disabled = false;
  } catch {
    el.municipality.innerHTML = '<option value="">Όλος ο νομός</option>';
    el.municipality.disabled = false;
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
  const prefectureId = Number(el.prefecture.value);
  if (!prefectureId) return;
  const municipalityId = Number(el.municipality.value) || null;
  const key = `${prefectureId}${municipalityId ? ':' + municipalityId : ''}`;
  if (areas.some(a => a.key === key)) return;

  areas.push({
    key, prefectureId, municipalityId,
    prefectureName: el.prefecture.selectedOptions[0].textContent,
    municipalityName: municipalityId ? el.municipality.selectedOptions[0].textContent : null
  });
  save(LS.areas, areas);
  renderAreas();
  refresh();
}

function removeArea(key) {
  areas = areas.filter(a => a.key !== key);
  save(LS.areas, areas);
  renderAreas();
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
    maybeNotify();
  } catch (err) {
    setStatus(`Σφάλμα ανάκτησης: ${err.message}`, true);
  } finally {
    loading = false;
    el.refresh.classList.remove('spin');
  }
}

// ---- render ------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
      <p class="desc${open ? ' open' : ''}" id="d-${esc(o.id)}">${esc(o.description)}</p>
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

// ---- notifications -----------------------------------------------------------
function notifyState() {
  const on = load(LS.notify, false) && 'Notification' in window && Notification.permission === 'granted';
  el.notify.classList.toggle('on', on);
  el.notify.textContent = on ? '🔔 Ειδοποιήσεις ενεργές' : 'Ενεργοποίηση ειδοποιήσεων';
  return on;
}

async function toggleNotifications() {
  if (!('Notification' in window)) { setStatus('Ο browser δεν υποστηρίζει ειδοποιήσεις.', true); return; }
  if (load(LS.notify, false) && Notification.permission === 'granted') {
    save(LS.notify, false);
  } else {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setStatus('Οι ειδοποιήσεις απορρίφθηκαν από τον browser.', true); notifyState(); return; }
    save(LS.notify, true);
  }
  notifyState();
  maybeNotify();
}

// Fire once per outage, when its start falls inside the chosen lead window.
function maybeNotify() {
  if (!notifyState()) return;
  const leadMs = Number(el.lead.value) * 3600000;
  const now = Date.now();

  for (const o of outages) {
    if (!o.fromDate || notified.has(o.id)) continue;
    const delta = o.fromDate.getTime() - now;
    if (delta > leadMs || (o.toDate && o.toDate.getTime() < now)) continue;

    const where = o.areaLabels[0] || o.municipalities[0] || '';
    const when = delta <= 0
      ? 'σε εξέλιξη τώρα'
      : `${o.fromDate.toLocaleString('el-GR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}–${hhmm(o.toDate || o.fromDate)}`;
    new Notification(`⚡ Διακοπή ρεύματος — ${where}`, {
      body: `${when}\n${o.description.slice(0, 160)}`,
      tag: `outage-${o.id}`,
      icon: 'icon-192.png'
    });
    notified.add(o.id);
  }

  // Keep the "already told you" set from growing forever.
  const live = new Set(outages.map(o => o.id));
  notified = new Set([...notified].filter(id => live.has(id)));
  save(LS.notified, [...notified]);
}

// ---- wiring ------------------------------------------------------------------
el.prefecture.addEventListener('change', () => {
  const id = Number(el.prefecture.value);
  el.add.disabled = !id;
  if (id) loadMunicipalities(id);
  else { el.municipality.innerHTML = '<option value="">Όλος ο νομός</option>'; el.municipality.disabled = true; }
});
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
el.lead.addEventListener('change', () => { save(LS.lead, el.lead.value); maybeNotify(); });
el.notify.addEventListener('click', toggleNotifications);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastFetch > STALE_MS) refresh();
});
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(render, 60000);   // keep "σε 2ω" / "ΣΕ ΕΞΕΛΙΞΗ" honest

// ---- boot --------------------------------------------------------------------
el.filter.value = load(LS.filter, '');
el.upcomingOnly.checked = load(LS.upcoming, true);
el.lead.value = load(LS.lead, '24');
notifyState();
renderAreas();
render();
loadPrefectures();
if (areas.length) refresh();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
