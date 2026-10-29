// Area C e ZTL Milano: mappa con i dati del Comune, stato di Area C, controllo per la propria auto,
// percorsi che evitano le zone, guida passo passo e avvisi in base alla posizione del telefono
// (la posizione non lascia mai il dispositivo, tranne la partenza mandata al calcolo del percorso).

const S = {
  rules: null, zones: [], varchi: [], meta: null, avoid: [],
  tracking: false, watchId: null, fixed: false, follow: true, lastRank: 0, wakeLock: null, lastPos: null,
  picked: { from: null, to: null }, route: null, nav: null, voice: true, panel: null,
};
const CAR_KEY = 'milano-ztl-auto';
const RECENT_KEY = 'milano-ztl-recenti';
const VOICE_KEY = 'milano-ztl-voce';
const RANK = { ok: 1, warn: 2, bad: 3 };
let map, zoneLayer, meMarker, meCircle, routeLayer;

const $ = id => document.getElementById(id);
const eur = v => '€' + v.toFixed(2).replace('.', ',');
const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memoria non disponibile */ } },
};

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
  $('now').innerHTML = areaCActive()
    ? `<span class="pill on"><i></i>Area C attiva fino alle ${r.end}</span>`
    : `<span class="pill off"><i></i>Area C spenta · riparte ${nextActivation()}</span>`;
}

/* ---------- La mia auto ---------- */

function readCar() {
  return {
    fuel: $('fuel').value,
    euro: $('euro').value === '' ? null : Number($('euro').value),
    sub: $('sub').value,
    co2: $('co2').checked,
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
  const saved = store.get(CAR_KEY, null);
  if (saved) for (const [id, v] of Object.entries(saved)) {
    const el = $(id);
    if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
  }
  $('carForm').addEventListener('change', () => {
    const car = readCar();
    store.set(CAR_KEY, { fuel: car.fuel, euro: car.euro ?? '', sub: car.sub, co2: car.co2 });
    renderCar();
  });
  $('plateLink').href = S.rules.links.plateCheck;
  $('carChip').addEventListener('click', () => { openPanel('infoPanel'); $('auto').scrollIntoView(); });
  renderCar();
}

const FUEL = { benzina: 'Benzina', gas: 'GPL/metano', diesel: 'Diesel', 'ibrida-benzina': 'Ibrida', 'ibrida-diesel': 'Ibrida diesel', elettrica: 'Elettrica' };

function renderCar() {
  const car = readCar();
  $('euroField').hidden = car.fuel === 'elettrica';
  $('subField').hidden = !(car.fuel.endsWith('diesel') && car.euro === 6);
  $('co2Field').hidden = !car.fuel.startsWith('ibrida');
  const v = carVerdict(car);
  const ztl = car.fuel === 'elettrica' || car.euro != null
    ? '<small>Le ZTL hanno regole proprie: di solito possono entrare solo residenti e autorizzati, indipendentemente dall\'auto.</small>' : '';
  $('carResult').innerHTML = `<div class="verdict ${v.level}">${v.title}${v.note ? `<small>${v.note}</small>` : ''}${ztl}</div>`;
  const chip = $('carChip');
  chip.textContent = car.fuel !== 'elettrica' && car.euro == null
    ? '🚗 Imposta la tua auto'
    : `🚗 ${FUEL[car.fuel]}${car.fuel === 'elettrica' ? '' : ' Euro ' + car.euro}${v.level === 'bad' ? ' · vietata in Area C' : ''}`;
  chip.classList.toggle('bad', v.level === 'bad');
  if (S.lastPos) evaluate(S.lastPos);
}

/* ---------- Area C ---------- */

function renderAreaC() {
  const r = S.rules.areaC, l = S.rules.links;
  $('areacInfo').innerHTML = `
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
  const on = ztlActiveNow(p);
  return `<b>ZTL ${esc(p.name)}</b>${isAlways(p) ? ' · sempre attiva' : on === true ? ' · attiva ora' : on === false ? ' · non attiva ora' : ''}
    ${p.schedule ? `<br>${esc(p.schedule)}` : ''}
    ${p.rules ? `<br><span style="color:var(--muted)">Possono entrare: ${esc(p.rules)}</span>` : ''}
    <br><small style="color:var(--muted)">${fonte} ${p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">Fonte</a>` : ''}</small>`;
}

// Spazio occupato da ricerca e pannello, per non nascondere il percorso sotto di loro.
function mapPadding() {
  const wide = innerWidth >= 900;
  const top = document.querySelector('.top-ui').offsetHeight + 16;
  const sheet = $('sheet').offsetHeight;
  return { paddingTopLeft: [wide ? 430 : 30, top], paddingBottomRight: [wide ? 80 : 30, wide ? 30 : sheet + 20] };
}

function initMap() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  // niente pulsanti +/-: sul telefono si zooma con le dita
  map = L.map('map', { zoomControl: false }).setView([45.4642, 9.19], 14);
  // Mappa stradale a colori: ha dettagli fino a zoom 18, quindi resta nitida anche in guida (zoom 17).
  // Al buio la stessa mappa viene scurita (classe tiles-dark nel CSS).
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 18, className: dark ? 'tiles-dark' : '',
    attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap',
  }).addTo(map);

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
    L.circleMarker([lat, lon], { radius: 6, weight: 3, color: '#15171a', fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Varco Area C · ${esc(v.properties.name)}`, { direction: 'top' })
      .addTo(map);
  }
  const areaC = S.zones.find(z => z.properties.kind === 'AREA_C');
  if (areaC) map.fitBounds(L.geoJSON(areaC).getBounds(), mapPadding());

  // tenendo premuto sulla mappa (o con il tasto destro) scegli lì l'arrivo
  map.on('contextmenu', e => {
    S.picked.to = { lat: e.latlng.lat, lon: e.latlng.lng, label: 'Punto sulla mappa' };
    $('to').value = 'Punto sulla mappa';
    planRoute();
  });
  // se sposti la mappa a mano smetto di seguirti finché non tocchi "Ricentra"
  map.on('dragstart', () => {
    if (!S.tracking) return;
    S.follow = false;
    $('recenter').hidden = false;
  });
}

/* ---------- Elenco ZTL ---------- */

function renderZtl() {
  const list = S.zones.filter(z => z.properties.kind === 'ZTL').sort((a, b) =>
    (isAlways(b.properties) - isAlways(a.properties)) || a.properties.name.localeCompare(b.properties.name, 'it'));
  const ul = $('ztlList');
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
    closePanels();
    zoneLayer.eachLayer(l => {
      if (l.feature !== feature) return;
      map.fitBounds(l.getBounds(), { ...mapPadding(), maxZoom: 17 });
      l.openPopup();
    });
  });
}

/* ---------- Fonti ---------- */

function renderSources() {
  const m = S.meta;
  const zones = m.sources[0], gates = m.sources[1];
  const old = zones.updated && (Date.now() - Date.parse(zones.updated)) / 864e5 > 365;
  $('sources').innerHTML = `
    <p><b>Perimetri di Area C e ZTL:</b> <a href="${zones.url}" target="_blank" rel="noopener">${esc(zones.name)}</a>, aggiornato dal Comune il ${fmtDate(zones.updated)}.</p>
    <p><b>Varchi di Area C:</b> <a href="${gates.url}" target="_blank" rel="noopener">${esc(gates.name)}</a>, aggiornato dal Comune il ${fmtDate(gates.updated)}.</p>
    ${old ? `<p class="warnbox">Il Comune non aggiorna i perimetri delle ZTL da più di un anno, quindi le ZTL nuove possono mancare.${m.manualZones.length ? ` Per questo ${m.manualZones.join(', ')} è stata disegnata a mano dalla mappa ufficiale (bordo tratteggiato).` : ''}</p>` : ''}
    <p><b>Aggiornamento automatico:</b> ogni lunedì il sito scarica di nuovo i dati del Comune. Ultimo controllo: ${new Date(m.checkedAt).toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' })}.</p>
    <p><b>Regole e orari:</b> presi dalle pagine ufficiali del Comune, controllati il ${fmtDate(S.rules.checked)}.</p>`;
}

/* ---------- Geometria ---------- */

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
const zonesAt = (lat, lon) => S.zones.filter(z => contains(z.geometry, lat, lon));

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
const meters = d => d < 1000 ? `${Math.max(10, Math.round(d / 10) * 10)} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`;
const spokenMeters = d => d < 1000 ? `${Math.max(10, Math.round(d / 50) * 50)} metri` : `${(d / 1000).toFixed(1).replace('.', ',')} chilometri`;

/* ---------- Avvisi in base alla posizione ---------- */

function speak(text) {
  if (!S.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'it-IT';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function showAlert(level, title, note) {
  const el = $('alert');
  el.hidden = false;
  el.className = `alert ${level}`;
  el.innerHTML = `${title}${note ? `<small>${note}</small>` : ''}`;
  if (RANK[level] > S.lastRank && S.lastRank) {
    navigator.vibrate?.([200, 100, 200]);
    if (S.nav && level !== 'ok') speak(title);
  }
  S.lastRank = RANK[level];
}

function evaluate(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const active = areaCActive();
  const v = carVerdict();
  const inside = zonesAt(lat, lon);
  const ztl = inside.find(z => z.properties.kind === 'ZTL');
  const inAreaC = inside.some(z => z.properties.kind === 'AREA_C');
  const imprecise = accuracy > 80 ? ` Posizione imprecisa (±${Math.round(accuracy)} m).` : '';

  if (ztl) {
    const p = ztl.properties;
    const on = ztlActiveNow(p);
    if (on === false) return showAlert('ok', `Sei nella ZTL ${p.name}, ora non attiva`, p.schedule + imprecise);
    return showAlert(on ? 'bad' : 'warn', `Sei dentro la ZTL ${p.name}`, (p.schedule || 'Controlla gli orari sui cartelli.') + imprecise);
  }
  if (inAreaC && active) {
    const text = { bad: 'Sei in Area C: la tua auto non può circolare qui', warn: `Sei in Area C: ricordati il ticket da ${eur(S.rules.areaC.ticket)}`, ok: 'Sei in Area C: per la tua auto è gratis', none: 'Sei in Area C, attiva ora' };
    return showAlert(v.level === 'none' ? 'warn' : v.level, text[v.level], (v.level === 'warn' ? `Pagalo e attivalo ${S.rules.areaC.payBy}.` : v.level === 'none' ? 'Imposta la tua auto dal menu.' : '') + imprecise);
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
  // in navigazione lo spazio in alto serve alle indicazioni: l'avviso "tutto ok" lo nascondo
  if (S.nav) { $('alert').hidden = true; S.lastRank = RANK.ok; return; }
  showAlert('ok', 'Fuori da Area C e dalle ZTL', (active ? 'Area C è attiva ora.' : `Area C non è attiva, riparte ${nextActivation()}.`) + imprecise);
}

function onPosition(pos) {
  S.lastPos = pos;
  const ll = [pos.coords.latitude, pos.coords.longitude];
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
  }
  if (!S.fixed) { map.setView(ll, S.nav ? 17 : 16); S.fixed = true; }
  else if (S.follow) map.panTo(ll);
  evaluate(pos);
  if (S.nav) updateNav(pos);
}

function onPositionError(err) {
  stopTracking();
  const msg = err.code === 1
    ? 'Hai negato l\'accesso alla posizione: attivalo nelle impostazioni del telefono per il browser e per questo sito.'
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
  S.follow = true;
  S.lastRank = 0;
  S.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  $('locate').setAttribute('aria-pressed', 'true');
  showAlert('ok', 'Cerco la tua posizione…', 'Lo schermo resta acceso finché la posizione è attiva.');
  keepScreenOn();
}

function stopTracking() {
  if (S.nav) endNav();
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.tracking = false;
  S.watchId = null;
  S.lastPos = null;
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
  meMarker?.remove(); meCircle?.remove();
  meMarker = meCircle = null;
  $('locate').setAttribute('aria-pressed', 'false');
  $('recenter').hidden = true;
  $('alert').hidden = true;
}

function recenter() {
  S.follow = true;
  $('recenter').hidden = true;
  if (S.lastPos) map.setView([S.lastPos.coords.latitude, S.lastPos.coords.longitude], Math.max(map.getZoom(), S.nav ? 17 : 16));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.tracking) keepScreenOn();
});

/* ---------- Orari delle ZTL ---------- */

// Orario giornaliero di una ZTL in minuti, solo se scritto in modo chiaro ("tutti i giorni dalle 19:30 alle 6:00").
function ztlHours(p) {
  const m = (p.schedule || '').match(/^attiv[ao] tutti i giorni dalle (?:dalle )?(?:ore )?(\d{1,2})[:.](\d{2}) alle (?:ore )?(\d{1,2})[:.](\d{2})\s*$/i);
  return m ? { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) } : null;
}

// true/false se l'orario della ZTL è chiaro, null se non si capisce (= prudenza).
function ztlActiveNow(p, now = romeNow()) {
  if (isAlways(p)) return true;
  const h = ztlHours(p);
  if (!h) return null;
  return h.start < h.end ? now.minutes >= h.start && now.minutes < h.end : now.minutes >= h.start || now.minutes < h.end;
}

// Minuti che mancano all'attivazione di una zona ora spenta (null se non si sa o se manca più di un giorno).
function minutesToActivation(zone, now = romeNow()) {
  if (zone.properties.kind === 'AREA_C') {
    const start = toMin(S.rules.areaC.start);
    return isAreaCDay(now.iso) && now.minutes < start ? start - now.minutes : null;
  }
  const h = ztlHours(zone.properties);
  return h ? (h.start - now.minutes + 1440) % 1440 : null;
}

const clock = minutes => `${Math.floor(minutes / 60) % 24}:${String(minutes % 60).padStart(2, '0')}`;
const duration = min => min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
const arrivalTime = sec => new Date(Date.now() + sec * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

/* ---------- Pannelli: ricerca, informazioni, pannello dal basso ---------- */

function openPanel(id) {
  if (S.panel === id) return;
  if (S.panel) $(S.panel).hidden = true;
  else history.pushState({ panel: id }, ''); // il tasto Indietro del telefono chiude il pannello
  S.panel = id;
  $(id).hidden = false;
}

function closePanels() {
  if (!S.panel) return;
  $(S.panel).hidden = true;
  S.panel = null;
  if (history.state?.panel) history.back();
}

addEventListener('popstate', () => {
  if (!S.panel) return;
  $(S.panel).hidden = true;
  S.panel = null;
});

function setSheet(state) {
  $('sheet').dataset.state = state;
}

function initSheet() {
  const sheet = $('sheet');
  new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', sheet.offsetHeight + 'px')).observe(sheet);
  $('sheetHandle').addEventListener('click', () => setSheet(sheet.dataset.state === 'full' ? 'peek' : 'full'));
  // trascinando la maniglia su o giù si apre o si chiude
  let y0 = null;
  sheet.addEventListener('touchstart', e => { y0 = e.target.closest('.handle, .trip, .nav-sum') ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    if (dy < -30) setSheet('full');
    if (dy > 30) setSheet('peek');
    y0 = null;
  });
}

function setResult(html) {
  $('routeResult').innerHTML = html;
  $('home').hidden = !!html;
}

/* ---------- Ricerca indirizzi ---------- */

const KEY_STORE = 'milano-ztl-ors-key';
// HeiGIT ha spostato OpenRouteService da api.openrouteservice.org (in dismissione) ad api.heigit.org.
const ORS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';
const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };

function showKeySetup(show) {
  $('keySetup').hidden = !show;
  $('suggest').hidden = show;
  $('keyMsg').innerHTML = '';
}

function openSearch(field = 'to') {
  openPanel('searchPanel');
  showKeySetup(!getKey());
  $(field).focus();
  suggest(field);
}

// Indirizzo -> coordinate con Nominatim (OpenStreetMap), cercando prima nell'area di Milano.
async function geocode(text) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&viewbox=9.04,45.54,9.28,45.38&q='
    + encodeURIComponent(/milano/i.test(text) ? text : text + ', Milano');
  const res = await fetch(url, { headers: { 'Accept-Language': 'it' } });
  const [hit] = res.ok ? await res.json() : [];
  if (!hit) throw new Error(`Non trovo “${text}”: prova ad aggiungere il numero civico o il quartiere.`);
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name.split(',').slice(0, 2).join(',') };
}

function currentPosition() {
  if (S.lastPos) return Promise.resolve({ lat: S.lastPos.coords.latitude, lon: S.lastPos.coords.longitude, label: 'La mia posizione' });
  return new Promise((ok, ko) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(
      p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'La mia posizione' }),
      () => ko(new Error('Non riesco a leggere la tua posizione: scrivi l\'indirizzo di partenza oppure permetti al sito di usare la posizione.')),
      { enableHighAccuracy: true, timeout: 15000 })
    : ko(new Error('Questo browser non permette di leggere la posizione.')));
}

function resolvePlace(which) {
  const text = $(which).value.trim();
  if (which === 'from' && (!text || /^la mia posizione$/i.test(text))) return currentPosition();
  const p = S.picked[which];
  if (p && p.label === text && p.lat != null) return Promise.resolve(p);
  return geocode(text);
}

// Tipi di luogo di OpenStreetMap -> nome italiano mostrato nei suggerimenti.
const CATEGORY = {
  bar: 'Bar', cafe: 'Bar', pub: 'Pub', restaurant: 'Ristorante', fast_food: 'Fast food', ice_cream: 'Gelateria',
  pizza: 'Pizzeria', bakery: 'Panetteria', pastry: 'Pasticceria', nightclub: 'Discoteca', biergarten: 'Birreria',
  parking: 'Parcheggio', fuel: 'Benzinaio', charging_station: 'Ricarica auto', car_wash: 'Autolavaggio',
  supermarket: 'Supermercato', convenience: 'Minimarket', mall: 'Centro commerciale', department_store: 'Grande magazzino',
  clothes: 'Abbigliamento', shoes: 'Scarpe', pharmacy: 'Farmacia', hospital: 'Ospedale', clinic: 'Clinica', doctors: 'Medico',
  hotel: 'Hotel', hostel: 'Ostello', guest_house: 'B&B', museum: 'Museo', theatre: 'Teatro', cinema: 'Cinema',
  university: 'Università', school: 'Scuola', college: 'Scuola', library: 'Biblioteca', bank: 'Banca', atm: 'Bancomat',
  post_office: 'Posta', place_of_worship: 'Chiesa', park: 'Parco', stadium: 'Stadio', sports_centre: 'Centro sportivo',
  fitness_centre: 'Palestra', station: 'Stazione', hairdresser: 'Parrucchiere', marketplace: 'Mercato', attraction: 'Attrazione',
};

// Zona in cui si trova un luogo, da mostrare accanto al suggerimento.
function zoneTag(lat, lon) {
  if (lat == null) return null;
  const zones = zonesAt(lat, lon);
  const ztl = zones.find(z => z.properties.kind === 'ZTL');
  if (ztl) return { text: `ZTL ${ztl.properties.name}`, bad: ztlActiveNow(ztl.properties) !== false };
  if (zones.length) return { text: 'Area C', bad: areaCActive() };
  return null;
}

// Suggerimenti mentre scrivi con Photon (OpenStreetMap), che a differenza di Nominatim li permette.
// Trova vie, numeri civici e locali per nome (bar, ristoranti, negozi…).
function photonPlace(f, query = '') {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const category = p.osm_key !== 'highway' && p.osm_key !== 'place' && p.osm_key !== 'building' ? CATEGORY[p.osm_value] : '';
  let title = p.name || street;
  const sub = [category, p.name && street !== p.name ? street : '', p.locality || p.district, p.city || p.county]
    .filter((v, i, a) => v && a.indexOf(v) === i).join(' · ');
  const [lon, lat] = f.geometry.coordinates;
  // se hai scritto il civico e Photon trova solo la via, tengo il civico e lo cerco con Nominatim
  const number = query.match(/\b\d+[a-z]?\b/i)?.[0];
  if (number && !p.housenumber && p.osm_key === 'highway') {
    title = `${title} ${number}`;
    return { title, sub, label: title + (p.city ? ', ' + p.city : ''), lat: null, lon: null };
  }
  // per un locale l'etichetta porta anche l'indirizzo, così nella barra si capisce dov'è
  const where = p.name && street && street !== p.name ? `, ${street}` : p.city && !title.includes(p.city) ? `, ${p.city}` : '';
  return { title, sub, label: title + where, lat, lon, poi: !!category, zone: zoneTag(lat, lon) };
}

// Punto attorno a cui cercare: l'arrivo del percorso, la tua posizione o il centro della mappa.
function searchCenter() {
  if (S.route) return { lat: S.route.to.lat, lon: S.route.to.lon, where: 'all\'arrivo' };
  if (S.lastPos) return { lat: S.lastPos.coords.latitude, lon: S.lastPos.coords.longitude, where: 'a te' };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, where: 'alla zona della mappa' };
}

// Pulsanti rapidi: luoghi di una categoria nei dintorni (Photon, ricerca inversa con filtro).
const NEARBY = {
  parking: { label: 'Parcheggi', tags: ['amenity:parking'] },
  bar: { label: 'Bar', tags: ['amenity:cafe', 'amenity:bar'] },
  restaurant: { label: 'Ristoranti', tags: ['amenity:restaurant', 'amenity:fast_food'] },
  fuel: { label: 'Benzinai', tags: ['amenity:fuel'] },
  charging: { label: 'Ricarica', tags: ['amenity:charging_station'] },
};

async function nearby(which, kind, around) {
  const c = around ? { lat: around.lat, lon: around.lon, where: 'all\'arrivo' } : searchCenter();
  const k = NEARBY[kind];
  $('suggest').innerHTML = `<li class="s-title">Cerco ${k.label.toLowerCase()} vicino ${c.where}…</li>`;
  sugAbort?.abort();
  sugAbort = new AbortController();
  try {
    const tags = k.tags.map(t => '&osm_tag=' + t).join('');
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${c.lat}&lon=${c.lon}&radius=2${tags}&limit=15`, { signal: sugAbort.signal });
    const items = (await res.json()).features.map(f => photonPlace(f))
      .map(p => ({ ...p, dist: pointDistance(c.lat, c.lon, [p.lon, p.lat]) }))
      .filter(p => p.title)
      // prima quelli raggiungibili adesso (fuori da zone attive), poi i più vicini
      .sort((a, b) => (!!a.zone?.bad - !!b.zone?.bad) || a.dist - b.dist);
    renderSuggest(which, items, `${k.label} vicino ${c.where}`);
  } catch { /* ricerca interrotta o senza rete */ }
}

let sugTimer, sugAbort;
function suggest(which) {
  clearTimeout(sugTimer);
  const q = $(which).value.trim();
  if (q.length < 3) return renderSuggest(which, null);
  sugTimer = setTimeout(async () => {
    sugAbort?.abort();
    sugAbort = new AbortController();
    try {
      const c = searchCenter();
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lat=${c.lat}&lon=${c.lon}`, { signal: sugAbort.signal });
      const data = await res.json();
      const seen = new Set();
      // tolgo i doppioni e i luoghi lontani (oltre 60 km: un Bar Basso a Zurigo non serve)
      const items = data.features.filter(f => pointDistance(c.lat, c.lon, f.geometry.coordinates) < 60000)
        .map(f => photonPlace(f, q)).filter(p => {
          const k = p.title + '|' + p.sub;
          return !seen.has(k) && seen.add(k);
        });
      renderSuggest(which, items);
    } catch { /* ricerca interrotta o senza rete: restano i suggerimenti di prima */ }
  }, 250);
}

const ICON = {
  pin: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="currentColor"/><circle cx="12" cy="10" r="2.6" fill="var(--surface)"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  me: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4" fill="#1a73e8"/><circle cx="12" cy="12" r="8" fill="none" stroke="#1a73e8" stroke-width="2"/></svg>',
  shop: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9.5 5.5 4h13L20 9.5M4 9.5h16M4 9.5c0 1.7 1.3 3 3 3s3-1.3 3-3m0 0c0 1.7 1 3 2 3s2-1.3 2-3m0 0c0 1.7 1.3 3 3 3s3-1.3 3-3M5.5 12.5V20h13v-7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

function renderSuggest(which, items, heading = '') {
  const recents = store.get(RECENT_KEY, []);
  let html = heading ? `<li class="s-title">${esc(heading)}</li>` : '';
  let list = items;
  $('cats').hidden = !!items && !heading;
  if (!items) {
    list = [...(which === 'from' ? [{ title: 'La mia posizione', label: 'La mia posizione', me: true }] : []), ...recents.map(r => ({ ...r, recent: true }))];
    if (recents.length && which === 'to') html = '<li class="s-title">Recenti</li>';
  }
  html += list.map((p, i) => `<li><button type="button" data-i="${i}"><span class="s-ico">${p.me ? ICON.me : p.recent ? ICON.clock : p.poi ? ICON.shop : ICON.pin}</span>
    <span class="s-text"><b>${esc(p.title)}</b>${p.sub ? `<small>${esc(p.sub)}</small>` : ''}${p.zone ? `<span class="tag ${p.zone.bad ? 'always' : 'off'}">${esc(p.zone.text)}${p.zone.bad ? ' attiva' : ' spenta'}</span>` : ''}</span>
    ${p.dist != null ? `<span class="s-dist">${meters(p.dist)}</span>` : ''}</button></li>`).join('');
  if (items && !items.length) html += `<li class="s-title">${heading ? 'Nessun risultato qui vicino' : 'Nessun suggerimento: premi Invio per cercare comunque'}</li>`;
  const ul = $('suggest');
  ul.innerHTML = html;
  ul.onclick = e => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    const p = list[Number(btn.dataset.i)];
    $(which).value = p.label;
    S.picked[which] = p.me ? null : p;
    if (which === 'from') { $('to').focus(); suggest('to'); }
    else planRoute();
  };
}

function saveRecent(place) {
  if (place.label === 'La mia posizione' || place.label === 'Punto sulla mappa') return;
  const recents = store.get(RECENT_KEY, []).filter(r => r.label !== place.label);
  recents.unshift({ title: place.title || place.label.split(',')[0], sub: place.sub || place.label.split(',').slice(1).join(',').trim(), label: place.label, lat: place.lat, lon: place.lon });
  store.set(RECENT_KEY, recents.slice(0, 8));
}

/* ---------- Percorso che evita Area C e ZTL (OpenRouteService) ---------- */

const PARK_BTN = '<button class="btn primary" data-act="parking">🅿️ Parcheggi vicino all\'arrivo</button>';

function routeMessage(level, title, note, extra = '') {
  if (S.nav) { speak(title); endNav(); }
  setResult(`<div class="verdict ${level}">${title}${note ? `<small>${note}</small>` : ''}</div>
    <div class="actions">${extra}<button class="btn" data-act="clear">Chiudi</button></div>`);
  setSheet('peek');
}

async function planRoute(e) {
  e?.preventDefault();
  const toText = $('to').value.trim();
  if (!getKey()) { openSearch('to'); return; }
  if (!toText) { openSearch('to'); return; }
  closePanels();
  if (S.nav) endNav();
  $('searchLabel').textContent = toText;
  $('searchOpen').classList.add('filled');
  setResult('<div class="loading"><span class="spinner"></span>Calcolo il percorso…</div>');
  setSheet('peek');
  try {
    const [from, to] = await Promise.all([resolvePlace('from'), resolvePlace('to')]);
    if (await computeRoute(from, to)) saveRecent({ ...to, ...(S.picked.to?.label === toText ? S.picked.to : {}) });
  } catch (err) {
    routeMessage('warn', 'Non sono riuscito a calcolare il percorso', esc(err.message));
  }
}

// Calcola e mostra il percorso. Restituisce true se l'ha trovato.
async function computeRoute(from, to, { recalc = false } = {}) {
  let avoidC = $('avoidC').checked;
  const notes = [];

  // Arrivo dentro una zona: se in questo momento la zona è spenta ti ci porto, se è attiva no.
  const toZones = zonesAt(to.lat, to.lon), fromZones = zonesAt(from.lat, from.lon);
  const entering = []; // zone spente in cui il percorso entra per arrivare a destinazione
  const toZtl = toZones.find(z => z.properties.kind === 'ZTL');
  if (toZtl) {
    const on = ztlActiveNow(toZtl.properties);
    if (on !== false) {
      routeMessage('bad', `L'arrivo è dentro la ZTL ${toZtl.properties.name}${on ? ', attiva ora' : ''}`,
        `${on ? toZtl.properties.schedule || '' : 'L\'orario di questa ZTL nei dati del Comune non è chiaro, quindi per prudenza non ti ci porto.'} Per non prendere la multa parcheggia fuori dalla ZTL e prosegui a piedi: scegli un arrivo appena fuori dal bordo rosa sulla mappa.`,
        PARK_BTN);
      S.parkNear = to;
      return false;
    }
    entering.push(toZtl);
  }
  const toAreaC = toZones.find(z => z.properties.kind === 'AREA_C');
  const fromAreaC = fromZones.find(z => z.properties.kind === 'AREA_C');
  if (toAreaC && areaCActive() && carVerdict().level === 'bad') {
    routeMessage('bad', 'L\'arrivo è dentro Area C, attiva ora, e la tua auto non può entrare',
      `Area C è attiva fino alle ${S.rules.areaC.end}. Parcheggia fuori dalla cerchia dei Bastioni oppure parti dopo le ${S.rules.areaC.end}.`, PARK_BTN);
    S.parkNear = to;
    return false;
  }
  if (toAreaC && !areaCActive()) entering.push(toAreaC);
  if (avoidC && (toAreaC || fromAreaC)) {
    avoidC = false;
    if (areaCActive()) notes.push(`Il percorso entra in Area C perché ${toAreaC ? 'l\'arrivo' : 'la partenza'} è dentro: serve il ticket da ${eur(S.rules.areaC.ticket)}.`);
  }
  const allowed = [...fromZones, ...entering];

  // Le ZTL interne ad Area C sono già escluse con Area C: non le ripeto (poligoni sovrapposti non sono validi).
  const areaC = S.zones.find(z => z.properties.kind === 'AREA_C');
  const insideC = f => f.geometry.coordinates.every(p => p[0].every(([lon, lat]) => contains(areaC.geometry, lat, lon)));
  const polys = S.avoid
    .filter(f => f.properties.kind === 'ZTL'
      ? !allowed.some(z => z.properties.name === f.properties.name) && !(avoidC && insideC(f))
      : avoidC)
    .flatMap(f => f.geometry.coordinates);
  const res = await fetch(ORS_URL, {
    method: 'POST',
    headers: { Authorization: getKey(), 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
    body: JSON.stringify({
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
      language: 'it', units: 'km', instructions: true,
      options: { avoid_polygons: { type: 'MultiPolygon', coordinates: polys } },
    }),
  }).catch(() => {
    // con una chiave sbagliata il servizio risponde senza le intestazioni CORS e il browser vede solo un errore di rete
    throw new Error('OpenRouteService non ha risposto. Di solito è la connessione, oppure il limite della chiave gratuita (40 percorsi al minuto, 2000 al giorno): riprova tra un minuto. Se continua, la chiave potrebbe essere sbagliata: cambiala dal menu ☰.');
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error('La chiave di OpenRouteService non è valida: cambiala dal menu ☰.');
  if (res.status === 429) throw new Error('Hai raggiunto il limite della chiave gratuita (40 percorsi al minuto, 2000 al giorno): riprova tra un minuto.');
  if (!res.ok && polys.length && /could not be found|Unable to find a route/i.test(data?.error?.message || '')) {
    // Senza percorso evitando le zone: provo senza, per capire se il punto si raggiunge solo passando da una ZTL o da Area C.
    const free = await fetch(ORS_URL, {
      method: 'POST',
      headers: { Authorization: getKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] }),
    }).catch(() => null);
    if (free?.ok) {
      S.parkNear = to;
      routeMessage('warn', 'Ci si arriva solo passando da una ZTL' + (avoidC ? ' o da Area C' : ''),
        `La partenza o l'arrivo stanno in una strada che si raggiunge solo attraversando una zona vietata (o un'area pedonale). Per non prendere la multa scegli un arrivo vicino, appena fuori, per esempio un parcheggio.${avoidC && areaCActive() && carVerdict().level !== 'bad' ? ' Se puoi entrare in Area C pagando, prova anche a togliere “Evita Area C”.' : ''}`,
        PARK_BTN);
      return false;
    }
    throw new Error('Questo punto non si raggiunge in auto (area pedonale, cortile o strada chiusa): scegli un indirizzo vicino.');
  }
  if (!res.ok) throw new Error(data?.error?.message ? `Percorso non trovato (${data.error.message}).` : 'Percorso non trovato: prova con indirizzi diversi.');

  const route = data.features[0];
  const line = route.geometry.coordinates;
  // Controllo di sicurezza: il percorso non deve attraversare le zone evitate.
  const crossed = new Set();
  for (const [lon, lat] of line) for (const z of zonesAt(lat, lon)) {
    if (z.properties.kind === 'ZTL' && !allowed.includes(z)) crossed.add('ZTL ' + z.properties.name);
    if (z.properties.kind === 'AREA_C' && avoidC) crossed.add('Area C');
  }
  const sum = route.properties.summary;
  const steps = route.properties.segments.flatMap(s => s.steps);
  const tripMin = Math.max(1, Math.round(sum.duration / 60));

  // Entri in una zona spenta: controllo che non si accenda prima che tu arrivi.
  const zoneName = z => z.properties.kind === 'AREA_C' ? 'Area C' : `la ZTL ${z.properties.name}`;
  let level = 'ok';
  for (const z of entering) {
    const wait = minutesToActivation(z);
    const at = wait == null ? '' : clock(romeNow().minutes + wait);
    if (wait != null && wait <= tripMin + 10) {
      level = 'bad';
      notes.unshift(`Attenzione: ${zoneName(z)} si attiva alle ${at}, tra ${wait} minuti, e il viaggio dura circa ${tripMin}. Rischi di entrare quando è già attiva: parti subito o parcheggia fuori.`);
    } else {
      const when = z.properties.kind === 'AREA_C' ? `riparte ${nextActivation()}` : at ? `si attiva alle ${at}` : '';
      const into = z.properties.kind === 'AREA_C' ? 'in Area C' : `nella ZTL ${z.properties.name}`;
      notes.unshift(`Entri ${into} perché ora non è attiva${when ? `: ${when}` : ''}. Per non prendere la multa esci prima di quell'ora${z.properties.kind === 'AREA_C' ? ' o paga il ticket' : ''}.`);
    }
  }
  let headline = `Percorso fuori dalle ZTL${avoidC ? ' e da Area C' : ''}`;
  if (entering.length) headline = `Arrivo dentro ${entering.map(zoneName).join(' e ')}, ora non attiva`;
  else if (toAreaC && areaCActive()) {
    headline = 'Arrivo dentro Area C, attiva ora';
    if (level === 'ok') level = 'warn';
  }
  if (crossed.size) level = 'bad';

  S.route = { line: line.map(([lon, lat]) => [lat, lon]), steps, sum, from, to, warning: level !== 'ok' ? headline : '' };
  setResult(`
    <div class="trip"><b class="${level}">${duration(tripMin)}</b><span>(${sum.distance.toFixed(1).replace('.', ',')} km)</span></div>
    <div class="trip-sub">Arrivo alle ${arrivalTime(sum.duration)} · ${esc(to.label)}</div>
    <div class="actions">
      <button class="btn primary big" data-act="nav">▲ Avvia</button>
      <button class="btn" data-act="steps">Indicazioni</button>
      <button class="btn" data-act="clear" aria-label="Chiudi il percorso">✕</button>
    </div>
    ${crossed.size
      ? `<div class="verdict bad">Attenzione: il percorso tocca ${[...crossed].join(', ')}<small>Può succedere ai bordi delle zone. Controlla sulla mappa prima di partire. ${notes.join(' ')}</small></div>`
      : `<div class="verdict ${level}">${headline}<small>${notes.join(' ') || 'Tocca Avvia per la guida con la posizione e gli avvisi.'}</small></div>`}
    <ol class="steps-list">${steps.map(s => `<li><span class="st-ico">${turnIcon(s.type)}</span><span>${esc(s.instruction)}${s.distance >= 0.05 ? `<small>${meters(s.distance * 1000)}</small>` : ''}</span></li>`).join('')}</ol>`);
  drawRoute(S.route.line, !recalc); // dopo il riepilogo, così l'inquadratura tiene conto dell'altezza del pannello
  if (recalc) startNav(true);
  return true;
}

function drawRoute(line, fit = true) {
  routeLayer?.remove();
  const css = getComputedStyle(document.documentElement);
  const end = line[line.length - 1];
  routeLayer = L.layerGroup([
    L.polyline(line, { color: css.getPropertyValue('--route-edge').trim(), weight: 10, opacity: 0.9, interactive: false }),
    L.polyline(line, { color: css.getPropertyValue('--route').trim(), weight: 6, opacity: 1, interactive: false }),
    L.circleMarker(line[0], { radius: 7, weight: 3, color: '#fff', fillColor: '#5f6670', fillOpacity: 1, interactive: false }),
    L.marker(end, { interactive: false, icon: L.divIcon({ className: '', iconSize: [30, 40], iconAnchor: [15, 38],
      html: '<svg class="pin" viewBox="0 0 30 40"><path d="M15 39s13-12.4 13-23.5A13 13 0 0 0 2 15.5C2 26.6 15 39 15 39z" fill="#ea4335" stroke="#a52714" stroke-width="1.5"/><circle cx="15" cy="15.5" r="5" fill="#a52714"/></svg>' }) }),
  ]).addTo(map);
  if (fit) map.fitBounds(L.latLngBounds(line), mapPadding());
}

function clearRoute() {
  if (S.nav) endNav();
  routeLayer?.remove();
  routeLayer = null;
  S.route = null;
  setResult('');
  setSheet('peek');
  $('searchLabel').textContent = 'Dove vuoi andare?';
  $('searchOpen').classList.remove('filled');
  $('to').value = '';
  S.picked.to = null;
}

/* ---------- Guida passo passo ---------- */

// Tipi di manovra di OpenRouteService -> freccia ruotata (gradi), rotonda o arrivo.
const TURN = { 0: -90, 1: 90, 2: -135, 3: 135, 4: -45, 5: 45, 6: 0, 9: 180, 11: 0, 12: -25, 13: 25 };
function turnIcon(type) {
  if (type === 7 || type === 8) return '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 15v7M17 10l3-3m0 0v4m0-4h-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (type === 10) return '<svg viewBox="0 0 24 24"><path d="M6 22V3m0 1h11l-2.5 4L17 12H6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  return `<svg viewBox="0 0 24 24"><g transform="rotate(${TURN[type] ?? 0} 12 12)"><path d="M12 21V4m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

function startNav(restart = false) {
  const r = S.route;
  if (!r) return;
  // distanze progressive lungo il percorso, per sapere quanto manca a ogni manovra
  const cum = [0];
  for (let i = 1; i < r.line.length; i++) {
    const [alat, alon] = r.line[i - 1], [blat, blon] = r.line[i];
    cum.push(cum[i - 1] + pointDistance(alat, alon, [blon, blat]));
  }
  const prev = S.nav;
  S.nav = { ...r, cum, total: cum[cum.length - 1], along: 0, off: 0, lastRecalc: prev?.lastRecalc || 0, spoken: -1, near: -1, arrived: false };
  document.body.classList.add('navigating');
  $('navBanner').hidden = false;
  $('voice').hidden = false;
  $('alert').hidden = true;
  S.routeHtml = $('routeResult').innerHTML; // riepilogo del percorso, da rimettere quando esci dalla guida
  if (!restart && S.route.warning) speak(S.route.warning);
  setResult(`<div class="nav-sum"><div><b id="navRemain"></b><span id="navRemainSub"></span></div>
    <button class="btn exit" data-act="exit">Esci</button></div>`);
  setSheet('peek');
  S.follow = true;
  $('recenter').hidden = true;
  if (!S.tracking) startTracking();
  if (S.lastPos) {
    map.setView([S.lastPos.coords.latitude, S.lastPos.coords.longitude], 17);
    updateNav(S.lastPos);
  } else {
    const first = r.steps[1] || r.steps[0];
    showManeuver(r.steps[0].distance * 1000, first);
    updateRemaining(S.nav.total);
  }
}

function endNav() {
  if (!S.nav) return;
  S.nav = null;
  window.speechSynthesis?.cancel();
  document.body.classList.remove('navigating');
  $('navBanner').hidden = true;
  $('voice').hidden = true;
  if (S.route && S.routeHtml) setResult(S.routeHtml);
  if (S.route) map.fitBounds(L.latLngBounds(S.route.line), mapPadding());
  if (S.lastPos) evaluate(S.lastPos);
}

function showManeuver(dist, step, text) {
  $('navArrow').innerHTML = turnIcon(step?.type ?? 6);
  $('navDist').textContent = text ? '' : meters(dist);
  $('navInstr').textContent = text || step?.instruction || '';
}

function updateRemaining(remaining) {
  const N = S.nav;
  const sec = N.sum.duration * remaining / (N.total || 1);
  $('navRemain').textContent = duration(Math.max(1, Math.round(sec / 60)));
  $('navRemainSub').textContent = `${meters(remaining)} · arrivo alle ${arrivalTime(sec)}`;
}

function updateNav(pos) {
  const N = S.nav;
  if (!N || N.arrived) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  // punto del percorso più vicino, senza tornare indietro di molto (il percorso può ripassare vicino a sé)
  let best = { d: Infinity, along: N.along };
  for (let i = 1; i < N.line.length; i++) {
    if (N.cum[i] < N.along - 150) continue;
    const [alat, alon] = N.line[i - 1], [blat, blon] = N.line[i];
    const ax = (alon - lon) * kx, ay = (alat - lat) * ky, bx = (blon - lon) * kx, by = (blat - lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, along: N.cum[i - 1] + t * Math.sqrt(len2) };
  }

  // fuori percorso per tre letture di fila: ricalcolo dalla posizione attuale
  if (best.d > Math.max(45, Math.min(accuracy, 100))) {
    N.off++;
    if (N.off >= 3 && Date.now() - N.lastRecalc > 20000) {
      N.lastRecalc = Date.now();
      N.off = 0;
      showManeuver(0, null, 'Ricalcolo il percorso…');
      speak('Ricalcolo il percorso');
      computeRoute({ lat, lon, label: 'La mia posizione' }, N.to, { recalc: true })
        .catch(() => showManeuver(0, null, 'Non riesco a ricalcolare: controlla la connessione'));
    }
    return;
  }
  N.off = 0;
  N.along = best.along;
  const remaining = N.total - N.along;

  if (remaining < 30 || pointDistance(lat, lon, [N.to.lon, N.to.lat]) < 30) {
    N.arrived = true;
    showManeuver(0, { type: 10 }, `Sei arrivato: ${N.to.label}`);
    speak('Sei arrivato a destinazione');
    $('navRemain').textContent = 'Arrivato';
    $('navRemainSub').textContent = N.to.label;
    return;
  }

  // la manovra da fare è l'inizio del tratto successivo
  let k = N.steps.findIndex(s => N.cum[s.way_points[1]] > N.along);
  if (k < 0) k = N.steps.length - 1;
  const next = N.steps[k + 1];
  const dist = next ? N.cum[N.steps[k].way_points[1]] - N.along : remaining;
  const step = next || { type: 10, instruction: `Arrivo: ${N.to.label}` };
  showManeuver(dist, step);
  updateRemaining(remaining);

  if (N.spoken !== k + 1 && dist > 80) {
    N.spoken = k + 1;
    speak(`Tra ${spokenMeters(dist)}, ${step.instruction}`);
  } else if (N.near !== k + 1 && dist <= 80) {
    N.near = N.spoken = k + 1;
    speak(step.instruction);
  }
}

/* ---------- Avvio dei comandi ---------- */

function initRoute() {
  $('searchOpen').addEventListener('click', () => openSearch('to'));
  $('infoOpen').addEventListener('click', () => openPanel('infoPanel'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closePanels));
  for (const which of ['from', 'to']) {
    $(which).addEventListener('input', () => suggest(which));
    $(which).addEventListener('focus', () => { if (getKey()) showKeySetup(false); suggest(which); });
  }
  $('cats').addEventListener('click', e => {
    const kind = e.target.closest('[data-kind]')?.dataset.kind;
    if (!kind) return;
    const which = document.activeElement === $('from') ? 'from' : 'to';
    nearby(which, kind);
  });
  $('from').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('to').focus(); } });
  $('swap').addEventListener('click', () => {
    const f = $('from').value, t = $('to').value;
    $('from').value = t === 'Punto sulla mappa' ? '' : t;
    $('to').value = f || 'La mia posizione';
    [S.picked.from, S.picked.to] = [S.picked.to, S.picked.from];
    if (/^la mia posizione$/i.test($('to').value)) $('to').value = '';
    $('to').focus();
  });
  $('routeForm').addEventListener('submit', planRoute);

  $('keyForm').addEventListener('submit', e => {
    e.preventDefault();
    const key = $('keyInput').value.trim();
    if (!key) return;
    if (key.length < 30) {
      $('keyMsg').innerHTML = `<div class="verdict warn">Questa non sembra la chiave<small>Hai incollato ${key.length} caratteri: la chiave di OpenRouteService è molto più lunga. Copiala per intero dal tuo account su account.heigit.org, non il nome che le hai dato.</small></div>`;
      return;
    }
    try { localStorage.setItem(KEY_STORE, key); } catch { /* senza memoria la chiave vale solo per questa visita */ }
    $('keyInput').value = '';
    showKeySetup(false);
    if ($('to').value.trim()) planRoute(); else $('to').focus();
  });
  $('keyChange').addEventListener('click', () => { closePanels(); openSearch('to'); showKeySetup(true); });

  $('routeResult').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'nav') startNav();
    if (act === 'steps') setSheet($('sheet').dataset.state === 'full' ? 'peek' : 'full');
    if (act === 'clear') clearRoute();
    if (act === 'exit') endNav();
    if (act === 'parking' && S.parkNear) { openSearch('to'); nearby('to', 'parking', S.parkNear); }
  });

  S.voice = store.get(VOICE_KEY, true);
  $('voice').setAttribute('aria-pressed', String(S.voice));
  $('voice').addEventListener('click', () => {
    S.voice = !S.voice;
    store.set(VOICE_KEY, S.voice);
    $('voice').setAttribute('aria-pressed', String(S.voice));
    if (!S.voice) window.speechSynthesis?.cancel(); else speak('Voce attiva');
  });
  $('locate').addEventListener('click', () => {
    if (!S.tracking) startTracking();
    else if (!S.follow) recenter();
    else stopTracking();
  });
  $('recenter').addEventListener('click', recenter);
}

// Installazione sul telefono: su Android il browser offre il pulsante, su iPhone si passa da Condividi.
function initInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) { $('install').hidden = true; return; }
  let prompt;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    prompt = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice.catch(() => {});
    prompt = null;
    $('installBtn').hidden = true;
  });
}

const load = path => fetch(path, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(path); return r.json(); });

Promise.all([load('data/rules.json'), load('data/zones.geojson'), load('data/varchi.geojson'), load('data/meta.json'), load('data/avoid.geojson')])
  .then(([rules, zones, varchi, meta, avoid]) => {
    Object.assign(S, { rules, zones: zones.features, varchi: varchi.features, meta, avoid: avoid.features });
    initSheet();
    initRoute();
    renderNow();
    setInterval(() => { renderNow(); if (S.lastPos) evaluate(S.lastPos); }, 60000);
    initMap();
    initCar();
    renderAreaC();
    renderZtl();
    renderSources();
    initInstall();
  })
  .catch(() => showAlert('bad', 'Dati non disponibili', 'Controlla la connessione e ricarica la pagina.'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
