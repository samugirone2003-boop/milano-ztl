// Area C e ZTL Milano: mappa con i dati del Comune, stato di Area C, controllo per la propria auto
// e avvisi in base alla posizione del telefono (la posizione non lascia mai il dispositivo).

const S = { rules: null, zones: [], varchi: [], meta: null, tracking: false, watchId: null, fixed: false, lastRank: 0, wakeLock: null };
const CAR_KEY = 'milano-ztl-auto';
const RANK = { ok: 1, warn: 2, bad: 3 };
let map, zoneLayer, meMarker, meCircle;

const eur = v => '€' + v.toFixed(2).replace('.', ',');
const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---------- Orari di Area C (sempre con l'ora di Milano) ---------- */

function romeNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  return { iso, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const weekday = iso => new Date(iso + 'T12:00:00Z').getUTCDay() || 7; // 1 = lunedì … 7 = domenica
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function easterMonday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return addDays(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 1);
}

function isAreaCDay(iso) {
  const r = S.rules.areaC;
  const holiday = r.holidays.includes(iso.slice(5)) || (r.easterMonday && iso === easterMonday(Number(iso.slice(0, 4))));
  return r.days.includes(weekday(iso)) && !holiday;
}

function areaCActive(now = romeNow()) {
  const r = S.rules.areaC;
  return isAreaCDay(now.iso) && now.minutes >= toMin(r.start) && now.minutes < toMin(r.end);
}

function nextActivation(now = romeNow()) {
  const r = S.rules.areaC;
  for (let n = 0; n < 14; n++) {
    const iso = addDays(now.iso, n);
    if (!isAreaCDay(iso) || (n === 0 && now.minutes >= toMin(r.start))) continue;
    const day = n === 0 ? 'oggi' : n === 1 ? 'domani' : new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { weekday: 'long', timeZone: 'UTC' });
    return `${day} alle ${r.start.replace(/^0/, '')}`;
  }
  return '';
}

function renderNow() {
  const r = S.rules.areaC;
  document.getElementById('now').innerHTML = areaCActive()
    ? `<span class="pill on"><i></i>Area C attiva fino alle ${r.end}</span>`
    : `<span class="pill off"><i></i>Area C non attiva · riparte ${nextActivation()}</span>`;
}

/* ---------- La mia auto ---------- */

function readCar() {
  return {
    fuel: document.getElementById('fuel').value,
    euro: document.getElementById('euro').value === '' ? null : Number(document.getElementById('euro').value),
    sub: document.getElementById('sub').value,
    co2: document.getElementById('co2').checked,
  };
}

function carVerdict(car = readCar(), iso = romeNow().iso) {
  const r = S.rules.areaC;
  if (car.fuel === 'elettrica') return { level: 'ok', title: 'Puoi entrare gratis in Area C', note: 'Le auto elettriche non pagano il ticket.' };
  if (car.euro == null) return { level: 'none', title: 'Scegli la classe Euro per sapere se puoi entrare' };

  const base = car.fuel.endsWith('diesel') ? 'diesel' : 'benzina';
  const bans = r.bans[base].filter(b => b.euro.includes(car.euro) && (!b.sub || b.sub.includes(car.sub)));
  const now = bans.find(b => !b.from || b.from <= iso);
  const next = bans.find(b => b.from && b.from > iso);
  if (now) {
    return {
      level: 'bad', title: 'La tua auto non può entrare in Area C',
      note: `${now.from ? `Divieto in vigore dal ${fmtDate(now.from)}.` : 'Divieto già in vigore.'} Non puoi entrare nemmeno pagando, nei giorni e negli orari in cui Area C è attiva.`,
    };
  }
  const free = car.fuel.startsWith('ibrida') && car.co2;
  let note = free ? `Le ibride con CO₂ fino a ${r.hybridFreeMaxCo2} g/km entrano gratis.` : `Il ticket vale tutto il giorno: pagalo e attivalo ${r.payBy}.`;
  if (next) note += ` Attenzione: dal ${fmtDate(next.from)} la tua auto non potrà più entrare.`;
  return { level: free ? 'ok' : 'warn', title: free ? 'Puoi entrare gratis in Area C' : `Puoi entrare in Area C pagando ${eur(r.ticket)}`, note, next };
}

function initCar() {
  const form = document.getElementById('carForm');
  try {
    const saved = JSON.parse(localStorage.getItem(CAR_KEY) || 'null');
    if (saved) for (const [id, v] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
    }
  } catch { /* memoria del browser non disponibile: si riparte dai valori predefiniti */ }
  form.addEventListener('change', () => {
    const car = readCar();
    try { localStorage.setItem(CAR_KEY, JSON.stringify({ fuel: car.fuel, euro: car.euro ?? '', sub: car.sub, co2: car.co2 })); } catch { }
    renderCar();
  });
  document.getElementById('plateLink').href = S.rules.links.plateCheck;
  renderCar();
}

function renderCar() {
  const car = readCar();
  document.getElementById('euroField').hidden = car.fuel === 'elettrica';
  document.getElementById('subField').hidden = !(car.fuel.endsWith('diesel') && car.euro === 6);
  document.getElementById('co2Field').hidden = !car.fuel.startsWith('ibrida');
  const v = carVerdict(car);
  const ztl = car.fuel === 'elettrica' || car.euro != null
    ? '<small>Le ZTL hanno regole proprie: di solito possono entrare solo residenti e autorizzati, indipendentemente dall\'auto.</small>' : '';
  document.getElementById('carResult').innerHTML =
    `<div class="verdict ${v.level}">${v.title}${v.note ? `<small>${v.note}</small>` : ''}${ztl}</div>`;
  if (S.lastPos) evaluate(S.lastPos);
}

/* ---------- Area C ---------- */

function renderAreaC() {
  const r = S.rules.areaC, l = S.rules.links;
  document.getElementById('areacInfo').innerHTML = `
    <ul class="facts">
      <li>Quando è attiva <b>lun–ven ${r.start}–${r.end}, festivi esclusi</b></li>
      <li>Ticket giornaliero <b>${eur(r.ticket)}</b></li>
      <li>Entro quando pagare <b>${r.payBy}</b></li>
      <li>Se paghi in ritardo <b>${eur(r.lateTicket)}, ${r.lateBy}</b></li>
      <li>Telecamere <b>solo in ingresso, ma se l'auto è vietata è vietato anche circolare dentro</b></li>
    </ul>
    <div class="links">
      <a class="btn primary" href="${l.buyTicket}" target="_blank" rel="noopener">Compra e attiva il ticket</a>
      <a class="btn" href="${l.calendar}" target="_blank" rel="noopener">Calendario divieti</a>
      <a class="btn" href="${l.faq}" target="_blank" rel="noopener">Domande frequenti</a>
    </div>
    <p class="hint">Regole controllate il ${fmtDate(S.rules.checked)} sulle pagine ufficiali del Comune. Per entrare a Milano conta anche <a href="${l.areaB}" target="_blank" rel="noopener">Area B</a>.</p>`;
}

/* ---------- Mappa ---------- */

const isAlways = p => p.always || /00:00 alle (ore )?24:00/.test(p.schedule || '');

function zonePopup(p) {
  const fonte = p.manual ? `${esc(p.source)} Controllato il ${fmtDate(p.checked)}.` : 'Dati aperti del Comune di Milano.';
  if (p.kind === 'AREA_C') {
    const v = carVerdict();
    return `<b>Area C</b><br>${areaCActive() ? 'Attiva ora' : 'Non attiva ora'} · lun–ven ${S.rules.areaC.start}–${S.rules.areaC.end}<br>${v.title}.`;
  }
  return `<b>ZTL ${esc(p.name)}</b>${isAlways(p) ? ' · sempre attiva' : ''}
    ${p.schedule ? `<br>${esc(p.schedule)}` : ''}
    ${p.rules ? `<br><span style="color:var(--muted)">Possono entrare: ${esc(p.rules)}</span>` : ''}
    <br><small style="color:var(--muted)">${fonte} ${p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">Fonte</a>` : ''}</small>`;
}

function initMap() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  // niente pulsanti +/-: sul telefono si zooma con le dita e in alto c'è lo spazio per gli avvisi
  map = L.map('map', { zoomControl: false }).setView([45.4642, 9.19], 14);
  const esri = name => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? 'Dark' : 'Light'}_Gray_${name}/MapServer/tile/{z}/{y}/{x}`;
  const tiles = { maxZoom: 19, maxNativeZoom: 16 };
  L.tileLayer(esri('Base'), { ...tiles, attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap' }).addTo(map);
  L.tileLayer(esri('Reference'), tiles).addTo(map);

  const css = getComputedStyle(document.documentElement);
  const color = kind => css.getPropertyValue(kind === 'AREA_C' ? '--areac' : '--ztl').trim();
  zoneLayer = L.geoJSON({ type: 'FeatureCollection', features: S.zones }, {
    style: f => ({
      color: color(f.properties.kind),
      weight: f.properties.kind === 'AREA_C' ? 3 : 2,
      fillOpacity: f.properties.kind === 'AREA_C' ? 0.08 : 0.3,
      dashArray: f.properties.manual ? '6 5' : null,
    }),
    onEachFeature: (f, layer) => layer.bindPopup(() => zonePopup(f.properties), { maxWidth: 280 }),
  }).addTo(map);
  // le ZTL sopra Area C, così si possono toccare anche quando stanno dentro
  zoneLayer.eachLayer(l => { if (l.feature.properties.kind === 'ZTL') l.bringToFront(); });

  for (const v of S.varchi) {
    const [lon, lat] = v.geometry.coordinates;
    L.circleMarker([lat, lon], { radius: 6, weight: 3, color: css.getPropertyValue('--text').trim(), fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Varco Area C · ${esc(v.properties.name)}`, { direction: 'top' })
      .addTo(map);
  }
  const areaC = S.zones.find(z => z.properties.kind === 'AREA_C');
  if (areaC) map.fitBounds(L.geoJSON(areaC).getBounds(), { padding: [20, 20] });
}

/* ---------- Elenco ZTL ---------- */

function renderZtl() {
  const list = S.zones.filter(z => z.properties.kind === 'ZTL').sort((a, b) =>
    (isAlways(b.properties) - isAlways(a.properties)) || a.properties.name.localeCompare(b.properties.name, 'it'));
  const ul = document.getElementById('ztlList');
  ul.innerHTML = list.map((z, i) => {
    const p = z.properties;
    const rules = p.rules && p.rules.length > 140 ? p.rules.slice(0, 140) + '…' : p.rules;
    return `<li><button data-i="${i}"><b>${esc(p.name)}${isAlways(p) ? '<span class="tag always">sempre attiva</span>' : ''}${p.manual ? '<span class="tag manual">disegnata a mano</span>' : ''}</b>
      ${p.schedule ? `<span>${esc(p.schedule)}</span>` : '<span>Orari non indicati nei dati del Comune: controlla i cartelli</span>'}
      ${rules ? `<span>Possono entrare: ${esc(rules)}</span>` : ''}</button></li>`;
  }).join('');
  ul.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const feature = list[Number(btn.dataset.i)];
    zoneLayer.eachLayer(l => {
      if (l.feature !== feature) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      map.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 17 });
      l.openPopup();
    });
  });
}

/* ---------- Fonti ---------- */

function renderSources() {
  const m = S.meta;
  const zones = m.sources[0], gates = m.sources[1];
  const old = zones.updated && (Date.now() - Date.parse(zones.updated)) / 864e5 > 365;
  document.getElementById('sources').innerHTML = `
    <p><b>Perimetri di Area C e ZTL:</b> <a href="${zones.url}" target="_blank" rel="noopener">${esc(zones.name)}</a>, aggiornato dal Comune il ${fmtDate(zones.updated)}.</p>
    <p><b>Varchi di Area C:</b> <a href="${gates.url}" target="_blank" rel="noopener">${esc(gates.name)}</a>, aggiornato dal Comune il ${fmtDate(gates.updated)}.</p>
    ${old ? `<p class="warnbox">Il Comune non aggiorna i perimetri delle ZTL da più di un anno, quindi le ZTL nuove possono mancare.${m.manualZones.length ? ` Per questo ${m.manualZones.join(', ')} è stata disegnata a mano dalla mappa ufficiale (bordo tratteggiato).` : ''}</p>` : ''}
    <p><b>Aggiornamento automatico:</b> ogni lunedì il sito scarica di nuovo i dati del Comune. Ultimo controllo: ${new Date(m.checkedAt).toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' })}.</p>
    <p><b>Regole e orari:</b> presi dalle pagine ufficiali del Comune, controllati il ${fmtDate(S.rules.checked)}.</p>`;
}

/* ---------- Posizione e avvisi ---------- */

function inRing(x, y, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const polygons = g => g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
const contains = (g, lat, lon) => polygons(g).some(poly => inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h)));

// Distanza in metri dal bordo di una zona (approssimazione piana, ottima su scala cittadina).
function edgeDistance(g, lat, lon) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  let best = Infinity;
  for (const poly of polygons(g)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
    const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const pointDistance = (lat, lon, [plon, plat]) =>
  Math.hypot((plon - lon) * 111320 * Math.cos(lat * Math.PI / 180), (plat - lat) * 110540);
const meters = d => d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`;

function showAlert(level, title, note) {
  const el = document.getElementById('alert');
  el.hidden = false;
  el.className = `alert ${level}`;
  el.innerHTML = `${title}${note ? `<small>${note}</small>` : ''}`;
  if (RANK[level] > S.lastRank && S.lastRank) navigator.vibrate?.([200, 100, 200]);
  S.lastRank = RANK[level];
}

function evaluate(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const active = areaCActive();
  const v = carVerdict();
  const inside = S.zones.filter(z => contains(z.geometry, lat, lon));
  const ztl = inside.find(z => z.properties.kind === 'ZTL');
  const inAreaC = inside.some(z => z.properties.kind === 'AREA_C');
  const imprecise = accuracy > 80 ? ` Posizione imprecisa (±${Math.round(accuracy)} m).` : '';

  if (ztl) {
    const p = ztl.properties;
    return showAlert(isAlways(p) ? 'bad' : 'warn', `Sei dentro la ZTL ${p.name}`, (p.schedule || 'Controlla gli orari sui cartelli.') + imprecise);
  }
  if (inAreaC && active) {
    const text = { bad: 'Sei in Area C: la tua auto non può circolare qui', warn: `Sei in Area C: ricordati il ticket da ${eur(S.rules.areaC.ticket)}`, ok: 'Sei in Area C: per la tua auto è gratis', none: 'Sei in Area C, attiva ora' };
    return showAlert(v.level === 'none' ? 'warn' : v.level, text[v.level], (v.level === 'warn' ? `Pagalo e attivalo ${S.rules.areaC.payBy}.` : v.level === 'none' ? 'Imposta la tua auto qui sotto.' : '') + imprecise);
  }
  if (inAreaC) return showAlert('ok', 'Sei in Area C, ma ora non è attiva', `Riparte ${nextActivation()}.` + imprecise);

  const varco = S.varchi.map(g => ({ g, d: pointDistance(lat, lon, g.geometry.coordinates) })).sort((a, b) => a.d - b.d)[0];
  const near = S.zones.filter(z => z.properties.kind === 'ZTL')
    .map(z => ({ z, d: edgeDistance(z.geometry, lat, lon) })).sort((a, b) => a.d - b.d)[0];
  if (active && varco && varco.d < 350) {
    return showAlert(v.level === 'bad' ? 'bad' : 'warn', `Varco Area C “${varco.g.properties.name}” a ${meters(varco.d)}`, v.title + '.' + imprecise);
  }
  if (near && near.d < 150) {
    return showAlert('warn', `ZTL ${near.z.properties.name} a ${meters(near.d)}`, (near.z.properties.schedule || 'Controlla gli orari sui cartelli.') + imprecise);
  }
  showAlert('ok', 'Fuori da Area C e dalle ZTL', (active ? 'Area C è attiva ora.' : `Area C non è attiva, riparte ${nextActivation()}.`) + imprecise);
}

function onPosition(pos) {
  S.lastPos = pos;
  const ll = [pos.coords.latitude, pos.coords.longitude];
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#1971c2', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
  }
  if (!S.fixed) { map.setView(ll, 16); S.fixed = true; }
  else if (!map.getBounds().pad(-0.2).contains(ll)) map.panTo(ll);
  evaluate(pos);
}

function onPositionError(err) {
  stopTracking();
  const msg = err.code === 1
    ? 'Hai negato l\'accesso alla posizione: attivalo nelle impostazioni del browser per questo sito.'
    : 'Non riesco a leggere la posizione. Riprova all\'aperto o controlla che il GPS sia attivo.';
  showAlert('warn', 'Posizione non disponibile', msg);
}

async function keepScreenOn() {
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* non supportato: pazienza */ }
}

function startTracking() {
  if (!navigator.geolocation) return showAlert('warn', 'Posizione non disponibile', 'Questo browser non permette di leggere la posizione.');
  S.tracking = true;
  S.fixed = false;
  S.lastRank = 0;
  S.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  document.getElementById('locate').setAttribute('aria-pressed', 'true');
  document.querySelector('#locate span').textContent = 'Posizione attiva';
  showAlert('ok', 'Cerco la tua posizione…', 'Lo schermo resta acceso finché la posizione è attiva.');
  keepScreenOn();
}

function stopTracking() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.tracking = false;
  S.watchId = null;
  S.lastPos = null;
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
  meMarker?.remove(); meCircle?.remove();
  meMarker = meCircle = null;
  document.getElementById('locate').setAttribute('aria-pressed', 'false');
  document.querySelector('#locate span').textContent = 'Usa la mia posizione';
  document.getElementById('alert').hidden = true;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.tracking) keepScreenOn();
});

/* ---------- Avvio ---------- */

const load = path => fetch(path, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(path); return r.json(); });

Promise.all([load('data/rules.json'), load('data/zones.geojson'), load('data/varchi.geojson'), load('data/meta.json')])
  .then(([rules, zones, varchi, meta]) => {
    Object.assign(S, { rules, zones: zones.features, varchi: varchi.features, meta });
    renderNow();
    setInterval(() => { renderNow(); if (S.lastPos) evaluate(S.lastPos); }, 60000);
    initMap();
    initCar();
    renderAreaC();
    renderZtl();
    renderSources();
    document.getElementById('locate').addEventListener('click', () => S.tracking ? stopTracking() : startTracking());
  })
  .catch(() => showAlert('bad', 'Dati non disponibili', 'Controlla la connessione e ricarica la pagina.'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
