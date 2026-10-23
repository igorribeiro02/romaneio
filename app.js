/* Mapa do Romaneio v2 — interface, mapa e localização das paradas.
 *
 * Como localiza (medido com o romaneio real, ver LEIA-ME):
 *  - Uma busca por RUA, não por pacote, no Nominatim (OpenStreetMap), respeitando 1 pedido/segundo.
 *  - O Nominatim devolve o desenho da rua e o bairro de cada trecho. O app junta os trechos
 *    e coloca cada número a N metros do começo da rua (ímpar e par em lados opostos).
 *  - Rua homônima em outro bairro perde pontos; o Viterbi escolhe, na ordem da rota,
 *    os candidatos coerentes entre paradas vizinhas.
 *  - Tudo fica guardado no celular: a mesma rua nunca é buscada duas vezes.
 *  - Navegação sempre pelo endereço escrito no Google Maps, que acha melhor que os mapas abertos.
 */
(function () {
  'use strict';
  const C = window.RomCore;
  const $ = id => document.getElementById(id);

  // ---------- Armazenamento ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const K = { geo: 'rm2.geo', fix: 'rm2.fix', zones: 'rm.zones.v1', done: 'rm2.done.', lastRoute: 'rm2.lastRoute' };

  let idbP = null;
  function idb() {
    if (!idbP) idbP = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('romaneio2', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('streets', { keyPath: 'k' }); r.result.createObjectStore('hub', { keyPath: 'k' }); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return idbP;
  }
  async function idbGet(storeName, key) {
    try {
      const db = await idb();
      return await new Promise(res => { const rq = db.transaction(storeName).objectStore(storeName).get(key); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
    } catch (e) { return null; }
  }
  async function idbPut(storeName, obj) {
    try {
      const db = await idb();
      await new Promise(res => { const tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).put(obj); tx.oncomplete = res; tx.onerror = res; });
    } catch (e) { /* sem armazenamento */ }
  }

  const S = {
    sheets: null, hubName: '', hubT: 0, code: '', stops: [], info: null,
    map: null, base: null, layer: null, markers: new Map(), rows: new Map(),
    selected: null, filter: 'all', zones: store.get(K.zones, []), zoneLayers: [],
    geo: store.get(K.geo, {}), fix: store.get(K.fix, {}),
    me: null, meMarker: null, follow: false, fixMarker: null, fixStop: null,
    riskMode: false, pendingZone: null, pendingLayer: null,
    done: new Set(), routeKey: '', sheetPx: 0, sheetState: 'half', runId: 0, userMoved: false
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Nominatim (fila única, 1 pedido por segundo) ----------
  async function fetchJSON(url, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 12000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  let lastReq = 0, queue = Promise.resolve();
  function nominatim(params) {
    const run = queue.then(async () => {
      const wait = lastReq + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      lastReq = Date.now();
      const p = new URLSearchParams(Object.assign({ format: 'jsonv2', addressdetails: '1', countrycodes: 'br', polygon_geojson: '1', polygon_threshold: '0.00002', limit: '30', 'accept-language': 'pt-BR' }, params));
      return fetchJSON('https://nominatim.openstreetmap.org/search?' + p, 12000);
    });
    queue = run.catch(() => null);
    return run;
  }

  const streetKey = (street, city) => C.norm(street) + '|' + C.norm(city);
  const TYPE_RE = /^(rua|avenida|travessa|estrada|alameda|praca|largo|ladeira|rodovia|beco|vila|via|servidao|caminho|condominio|cond)\s+/;

  function parseResults(arr, street, minSim, acceptAreas) {
    const ways = [], pts = [];
    for (const x of arr || []) {
      const a = x.address || {};
      const sub = a.suburb || a.neighbourhood || a.city_district || a.quarter || '';
      const name = x.name || '';
      const sim = Math.max(C.streetSimilarity(street, name), C.streetSimilarity(C.wordsToDigits(street), name), C.streetSimilarity(C.digitsToWords(street), name));
      if (!name || sim < minSim) continue;
      const g = x.geojson;
      if (x.category === 'highway' && g && (g.type === 'LineString' || g.type === 'MultiLineString')) {
        const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        lines.forEach(line => { if (line.length > 1) ways.push({ id: x.osm_id + ':' + ways.length, n: name, g: line.map(c => [+c[1].toFixed(6), +c[0].toFixed(6)]), sub }); });
      } else if (acceptAreas || x.category === 'highway') {
        pts.push({ lat: +x.lat, lng: +x.lon, n: name, sub });
      }
    }
    return { ways, pts };
  }

  // Busca uma rua (com as alternativas que funcionaram no teste real) e guarda o resultado
  async function fetchStreet(street, city) {
    const key = streetKey(street, city);
    const tries = [{ params: { street, city }, min: 0.8, areas: false }];
    const n = C.norm(street);
    const core = n.replace(TYPE_RE, '');
    if (core && core !== n) tries.push({ params: { q: core + ', ' + city }, min: 0.85, areas: false });
    const dig = C.wordsToDigits(street), wrd = C.digitsToWords(street);
    if (dig !== n) tries.push({ params: { q: dig + ', ' + city }, min: 0.85, areas: false });
    else if (wrd !== n) tries.push({ params: { q: wrd + ', ' + city }, min: 0.85, areas: false });
    if (/^(cond|condominio)\b/.test(n)) tries.push({ params: { q: street + ', ' + city }, min: 0.75, areas: true });
    let found = { ways: [], pts: [] }, failed = false;
    for (const t of tries) {
      try {
        found = parseResults(await nominatim(t.params), street, t.min, t.areas);
        if (found.ways.length || found.pts.length) break;
      } catch (e) { failed = true; break; }
    }
    if (failed) return null;
    const rec = { k: key, t: Date.now(), ways: found.ways, pts: found.pts, empty: !found.ways.length && !found.pts.length };
    await idbPut('streets', rec);
    return rec;
  }
  async function cachedStreet(street, city) {
    const r = await idbGet('streets', streetKey(street, city));
    if (!r) return null;
    const age = Date.now() - r.t;
    if (r.empty ? age > 7 * 864e5 : age > 120 * 864e5) return null;
    return r;
  }

  // ---------- Localização da rota ----------
  const CITY_DOWNTOWN = { 'niteroi': { lat: -22.8950, lng: -43.1235 }, 'sao goncalo': { lat: -22.8268, lng: -43.0634 }, 'marica': { lat: -22.9190, lng: -42.8190 } };

  function setLoc(s, lat, lng, conf, src) {
    s.lat = lat; s.lng = lng; s.conf = conf; s.src = src;
    s.risk = Number.isFinite(lat) && S.zones.some(z => C.pointInCircle(s, z));
  }
  function candidatesFor(s, rec) {
    if (!rec || rec.empty) return [];
    const chains = C.buildChains(rec.ways, 0.25);
    const list = C.nominatimCandidates(s, chains, { downtown: CITY_DOWNTOWN[C.norm(s.city)] || null });
    const bk = C.bairroKey(s.bairro);
    rec.pts.forEach(p => list.push({ lat: p.lat, lng: p.lng, score: (p.sub && C.bairroKey(p.sub) === bk) ? 0.8 : 0.62, src: 'ponto', inRange: false }));
    return list.sort((a, b) => b.score - a.score).slice(0, 8);
  }
  function confOf(c) {
    if (c.src === 'rua') return c.score >= 0.85 && c.inRange ? 'alta' : c.score >= 0.6 ? 'media' : 'baixa';
    return c.score >= 0.75 ? 'media' : 'baixa';
  }

  async function locate() {
    const run = ++S.runId;
    const t0 = performance.now();
    const groups = new Map();
    for (const s of S.stops) {
      s.cands = null;
      if (S.fix[s.key]) { setLoc(s, S.fix[s.key].lat, S.fix[s.key].lng, 'manual', 'ajuste'); continue; }
      const g = S.geo[s.key];
      if (g && Date.now() - g.t < 60 * 864e5) { setLoc(s, g.lat, g.lng, g.conf, 'cache'); continue; }
      setLoc(s, NaN, NaN, 'wait', '');
      if (!s.street) { s.conf = 'none'; continue; }
      const k = streetKey(s.street, s.city);
      if (!groups.has(k)) groups.set(k, { street: s.street, city: s.city, stops: [] });
      groups.get(k).stops.push(s);
    }
    renderAll(); fitAll(true); updateNav();
    const list = Array.from(groups.values());
    const total = list.length;
    let done = 0;
    const apply = (g, rec) => {
      g.stops.forEach(s => {
        s.cands = candidatesFor(s, rec);
        if (s.cands.length) { const c = s.cands[0]; setLoc(s, c.lat, c.lng, confOf(c), c.src); }
        else setLoc(s, NaN, NaN, 'none', '');
        updateStop(s);
      });
    };
    // 1) ruas já guardadas no celular: na hora
    const missing = [];
    for (const g of list) {
      const rec = await cachedStreet(g.street, g.city);
      if (run !== S.runId) return;
      if (rec) { apply(g, rec); done++; } else missing.push(g);
    }
    if (done) { chooseAll(); fitAll(true); }
    progress(done, total);
    // 2) ruas novas: uma por segundo, na ordem da rota (as primeiras paradas aparecem primeiro)
    let offline = false;
    for (const g of missing) {
      const rec = offline ? null : await fetchStreet(g.street, g.city);
      if (run !== S.runId) return;
      if (!rec) { offline = true; g.stops.forEach(s => { if (s.conf === 'wait') { s.conf = 'none'; updateStop(s); } }); }
      else apply(g, rec);
      done++;
      progress(done, total);
      if (done % 6 === 0) { chooseAll(); fitAll(true); }
    }
    chooseAll();
    S.stops.forEach(s => {
      if (s.cands && Number.isFinite(s.lat) && ['alta', 'media'].includes(s.conf)) S.geo[s.key] = { lat: s.lat, lng: s.lng, conf: s.conf, t: Date.now() };
    });
    const keys = Object.keys(S.geo);
    if (keys.length > 8000) keys.sort((a, b) => S.geo[a].t - S.geo[b].t).slice(0, keys.length - 8000).forEach(k => delete S.geo[k]);
    store.set(K.geo, S.geo);
    renderList(); renderSummary(); fitAll(false);
    const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
    const none = S.stops.filter(s => !Number.isFinite(s.lat)).length;
    $('chipInfo').textContent = S.stops.length + ' paradas · ' + countPk() + ' pacotes · pronto em ' + secs + ' s' + (none ? ' · ' + none + ' sem pino' : '');
    $('progressBar').style.width = '100%';
    S.lastRun = { secs, none, fetched: missing.length, total };
    if (offline) toast('Sem conexão com o mapa de ruas agora. O Google Maps continua funcionando pelo endereço.', 5000);
  }
  function progress(done, total) {
    if (done >= total) return;
    $('chipInfo').textContent = 'Localizando ruas ' + done + ' de ' + total + ' · o Google Maps já funciona';
    $('progressBar').style.width = Math.round(100 * done / Math.max(total, 1)) + '%';
  }
  const countPk = () => S.stops.reduce((a, s) => a + s.packages.length, 0);

  // Viterbi na ordem da rota: entre os candidatos de cada parada, fica o mais coerente com as vizinhas
  function chooseAll() {
    const ordered = S.stops.slice().sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || a.order - b.order);
    const seqStops = [], cands = [];
    for (const s of ordered) {
      if (s.cands && s.cands.length) { seqStops.push(s); cands.push(s.cands); }
      else if (!s.cands && Number.isFinite(s.lat)) { seqStops.push(s); cands.push([{ lat: s.lat, lng: s.lng, score: 1, src: 'fixo' }]); }
    }
    const pick = C.viterbi(cands, 0.3);
    seqStops.forEach((s, t) => {
      if (!s.cands) return;
      const c = cands[t][pick[t]];
      setLoc(s, c.lat, c.lng, confOf(c), c.src);
      updateStop(s);
    });
  }

  // ---------- Navegação pelo endereço escrito ----------
  function navText(s) {
    let st = String(s.original || '').split(',')[0].split('/')[0].split(/\s+-\s+/)[0].replace(/\(.*?\)/g, '').replace(/\s+\d+\s*$/, '').trim();
    if (!st) st = s.street;
    return st + (s.number ? ', ' + s.number : '') + (s.bairro ? ' - ' + s.bairro : '') + (s.city ? ', ' + s.city : '');
  }
  const gmapsStop = s => 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(navText(s));
  function wazeStop(s) {
    if (Number.isFinite(s.lat) && (s.conf === 'alta' || s.conf === 'manual')) return 'https://waze.com/ul?ll=' + s.lat.toFixed(6) + ',' + s.lng.toFixed(6) + '&navigate=yes';
    return 'https://waze.com/ul?q=' + encodeURIComponent(navText(s)) + '&navigate=yes';
  }
  function updateNav() {
    const pend = S.stops.filter(s => !S.done.has(s.key)).sort((a, b) => a.order - b.order).slice(0, 10);
    const btn = $('navBtn');
    if (!pend.length) { btn.textContent = 'Todas entregues'; btn.removeAttribute('href'); return; }
    const dest = pend[pend.length - 1];
    const wps = pend.slice(0, -1).map(navText).join('|');
    btn.href = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(navText(dest)) + (wps ? '&waypoints=' + encodeURIComponent(wps) : '');
    btn.textContent = 'Google Maps · paradas ' + pend[0].order + (pend.length > 1 ? '–' + dest.order : '');
  }

  // ---------- Planilha ----------
  let xlsxPromise = null;
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxPromise) xlsxPromise = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      sc.onload = res; sc.onerror = () => { xlsxPromise = null; rej(new Error('Não consegui carregar o leitor de planilhas. Confira a internet.')); };
      document.head.appendChild(sc);
    });
    return xlsxPromise;
  }
  async function readWorkbook(buf) {
    await ensureXLSX();
    const wb = window.XLSX.read(buf, { type: 'array' });
    return wb.SheetNames.map(name => ({ name, rows: window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }))
      .filter(sh => C.listRoutes(sh.rows));
  }
  function allRoutes() {
    const m = new Map();
    (S.sheets || []).forEach(sh => { const meta = C.listRoutes(sh.rows); (meta ? meta.routes : []).forEach(r => m.set(r.code, (m.get(r.code) || 0) + r.n)); });
    return Array.from(m, ([code, n]) => ({ code, n }));
  }
  function routeFrom(code) {
    let firstError = null;
    const results = S.sheets.map(sh => { const r = C.buildRoute(sh.rows, code); if (r.error && !firstError) firstError = r.error; return r; })
      .filter(r => !r.error && r.stops.length).sort((a, b) => b.stops.length - a.stops.length);
    if (!results.length) throw new Error(firstError || 'Não achei endereços nessa planilha.');
    return results[0];
  }

  // ---------- Tela inicial ----------
  async function initStart() {
    $('fileInput').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      $('startError').hidden = true;
      $('noFile').hidden = true; $('hasFile').hidden = false;
      $('fileTitle').textContent = 'Lendo planilha…'; $('fileSub').textContent = f.name;
      try {
        const sheets = await readWorkbook(await f.arrayBuffer());
        if (!sheets.length) throw new Error('Não achei endereços nessa planilha. Ela tem as colunas Corridor Cage e Destination Address?');
        S.sheets = sheets; S.hubName = f.name.replace(/\.[^.]+$/, ''); S.hubT = Date.now();
        await idbPut('hub', { k: 'last', name: S.hubName, t: S.hubT, sheets });
        showHub();
      } catch (err) {
        $('startError').textContent = err.message || 'Não consegui ler esse arquivo.'; $('startError').hidden = false;
        showHub();
      }
    });
    $('routeSearch').addEventListener('input', renderRoutes);
    $('routeSearch').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = C.normRouteCode($('routeSearch').value);
      const routes = allRoutes();
      const hit = routes.find(r => C.normRouteCode(r.code) === q) || routes.find(r => C.normRouteCode(r.code).includes(q));
      if (hit) openRoute(hit.code);
    });
    $('routes').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) openRoute(b.dataset.code); });
    const hub = await idbGet('hub', 'last');
    if (hub && hub.sheets) { S.sheets = hub.sheets; S.hubName = hub.name; S.hubT = hub.t; }
    showHub();
  }
  function showHub() {
    const has = !!(S.sheets && S.sheets.length);
    $('noFile').hidden = has; $('hasFile').hidden = !has; $('routeBox').hidden = !has;
    if (!has) return;
    const routes = allRoutes();
    const total = S.sheets.reduce((a, sh) => { const m = C.listRoutes(sh.rows); return a + (m ? m.total : 0); }, 0);
    $('fileTitle').textContent = S.hubName || 'Romaneio';
    const when = new Date(S.hubT || Date.now());
    const day = when.toDateString() === new Date().toDateString() ? 'aberto hoje' : 'aberto em ' + when.toLocaleDateString('pt-BR');
    $('fileSub').textContent = (routes.length ? routes.length + ' rotas · ' : '') + total.toLocaleString('pt-BR') + ' pacotes · ' + day;
    renderRoutes();
  }
  function renderRoutes() {
    const routes = allRoutes();
    if (!routes.length) { $('routes').innerHTML = '<button class="route" data-code=""><b>Rota</b><small>abrir</small></button>'; return; }
    const q = C.normRouteCode($('routeSearch').value);
    const last = store.get(K.lastRoute, '');
    const list = routes.filter(r => !q || C.normRouteCode(r.code).includes(q));
    list.sort((a, b) => (b.code === last) - (a.code === last));
    $('routes').innerHTML = list.length ? list.map(r =>
      '<button class="route' + (r.code === last ? ' last' : '') + '" role="listitem" data-code="' + esc(r.code) + '"><b>' + esc(r.code) + '</b><small class="num">' + r.n + ' pac.</small></button>').join('')
      : '<p class="hint">Nenhuma rota com esse código nesta planilha.</p>';
  }

  // ---------- Abrir rota ----------
  function openRoute(code) {
    let r;
    try { r = routeFrom(code); } catch (e) { $('startError').textContent = e.message; $('startError').hidden = false; return; }
    $('startError').hidden = true;
    store.set(K.lastRoute, code);
    S.code = code; S.stops = r.stops; S.info = r.info; S.selected = null; S.filter = 'all';
    S.routeKey = (S.hubName || 'rom') + '|' + (code || 'rota');
    S.done = new Set(store.get(K.done + S.routeKey, []));
    $('start').hidden = true; $('mapScreen').hidden = false;
    $('chipCode').textContent = code || 'Rota';
    $('chipInfo').textContent = S.stops.length + ' paradas · ' + countPk() + ' pacotes';
    $('progressBar').style.width = '0';
    initMap(); setSheet('half'); keepAwake();
    locate();
  }
  function backToStart() {
    S.runId++; // interrompe a busca em andamento
    $('mapScreen').hidden = true; $('start').hidden = false;
    closePanels(); setRiskMode(false);
    if (S.follow) toggleFollow();
    renderRoutes();
  }

  // ---------- Mapa ----------
  const BASEMAPS = [
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, attribution: 'Tiles © Esri · © OpenStreetMap' } }
  ];
  function addBaseMap(dark, idx) {
    idx = idx || 0;
    if (S.base) S.base.remove();
    let errors = 0, loaded = 0;
    S.base = L.tileLayer(BASEMAPS[idx].url, Object.assign({ className: dark ? 'tiles-dark' : '' }, BASEMAPS[idx].opts)).addTo(S.map);
    S.base.on('tileload', () => { loaded++; });
    S.base.on('tileerror', () => { errors++; if (errors >= 4 && errors > loaded && idx + 1 < BASEMAPS.length) addBaseMap(dark, idx + 1); });
  }
  function initMap() {
    if (!S.map) {
      S.map = L.map('map', { zoomControl: false }).setView([-22.9, -43.1], 12);
      addBaseMap(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      S.layer = L.layerGroup().addTo(S.map);
      S.map.on('click', onMapClick);
      S.map.on('dragstart', () => { S.userMoved = true; if (S.follow) toggleFollow(); });
    }
    S.userMoved = false;
    S.layer.clearLayers(); S.markers.clear();
    drawZones();
    setTimeout(() => S.map.invalidateSize(), 60);
  }
  // Paradas no mesmo ponto exato abrem um pouco em volta (raro, já que o número separa as casas)
  function displayPos(s) {
    const same = S.stops.filter(o => Number.isFinite(o.lat) && Math.abs(o.lat - s.lat) < 1.5e-5 && Math.abs(o.lng - s.lng) < 1.5e-5).sort((a, b) => a.order - b.order);
    if (same.length < 2) return [s.lat, s.lng];
    const i = same.indexOf(s), n = same.length, r = 0.00012, ang = 2 * Math.PI * i / n;
    return [s.lat + r * Math.cos(ang), s.lng + r * Math.sin(ang) / Math.cos(s.lat * Math.PI / 180)];
  }
  function pinClass(s) { return [s.conf, s.risk ? 'risco' : '', S.done.has(s.key) ? 'done' : '', S.selected === s.id ? 'sel' : ''].join(' '); }
  function upsertMarker(s) {
    let m = S.markers.get(s.id);
    if (!Number.isFinite(s.lat)) { if (m) { S.layer.removeLayer(m); S.markers.delete(s.id); } return; }
    const pos = displayPos(s);
    const icon = L.divIcon({ className: '', html: '<div class="pin ' + pinClass(s) + '"><span>' + s.order + '</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] });
    if (!m) {
      m = L.marker(pos, { icon, keyboard: false });
      m.on('click', () => select(s.id, true));
      S.layer.addLayer(m); S.markers.set(s.id, m);
    } else { m.setLatLng(pos); m.setIcon(icon); }
    m.setZIndexOffset(S.selected === s.id ? 1000 : 0);
  }
  function fitAll(soft) {
    if (!S.map || (soft && S.userMoved)) return;
    const pts = S.stops.filter(s => Number.isFinite(s.lat)).map(s => [s.lat, s.lng]);
    if (!pts.length) return;
    S.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [60, 90], paddingBottomRight: [70, S.sheetPx + 20], maxZoom: 17, animate: !soft });
  }
  function panVisible(s) {
    const z = Math.max(S.map.getZoom(), 16);
    const pt = S.map.project([s.lat, s.lng], z).add([0, (S.sheetPx - 70) / 2]);
    S.map.setView(S.map.unproject(pt, z), z, { animate: true });
  }

  // ---------- Lista ----------
  const CONF_LABEL = { alta: 'Pelo número na rua', media: 'Rua certa, número aproximado', baixa: 'Duvidoso, confira', manual: 'Ajustado por você', none: 'Rua não está no mapa aberto (use o Google Maps)', wait: 'Localizando' };
  const ICON = {
    map: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
    waze: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-8-8 18-2-8z"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
  };
  function rowHTML(s) {
    const done = S.done.has(s.key);
    const ref = (s.complements || []).join(' · ');
    const seqs = (s.seqs || []).slice().sort((a, b) => a - b);
    const seqTxt = seqs.length ? 'seq ' + (seqs.length > 4 ? seqs.slice(0, 4).join(', ') + '…' : seqs.join(', ')) : '';
    const pk = s.packages.length;
    const tags = [];
    if (s.risk) tags.push('<span class="tag risco">Risco</span>');
    if (s.conf === 'none') tags.push('<span class="tag nopin">sem pino</span>');
    if (s.conf === 'wait') tags.push('<span>localizando…</span>');
    let html = '<div class="badge ' + s.conf + '">' + s.order + '</div>' +
      '<div style="min-width:0"><div class="addr">' + esc(s.original || s.street) + '</div>' +
      (ref ? '<div class="ref">' + esc(ref) + '</div>' : '') +
      '<div class="meta">' + (s.bairro ? '<span>' + esc(s.bairro) + '</span>' : '') +
      '<span class="num">' + pk + (pk > 1 ? ' pacotes' : ' pacote') + (seqTxt ? ' · ' + seqTxt : '') + '</span>' + tags.join('') + '</div></div>' +
      '<div class="acts">' +
      '<a class="act" href="' + gmapsStop(s) + '" target="_blank" rel="noopener" aria-label="Navegar no Google Maps">' + ICON.map + '</a>' +
      '<a class="act" href="' + wazeStop(s) + '" target="_blank" rel="noopener" aria-label="Abrir no Waze">' + ICON.waze + '</a>' +
      '<button class="act check' + (done ? ' on' : '') + '" data-done aria-label="Marcar entregue" aria-pressed="' + done + '">' + ICON.check + '</button></div>';
    if (S.selected === s.id) {
      html += '<div class="detail"><dl>' +
        (s.city ? '<dt>Cidade</dt><dd>' + esc(s.city) + '</dd>' : '') +
        '<dt>Pacotes</dt><dd class="num">' + esc(s.packages.join(', ')) + '</dd>' +
        '<dt>Local</dt><dd>' + esc(CONF_LABEL[s.conf] || '') + '</dd>' +
        '<dt>Navega para</dt><dd>' + esc(navText(s)) + '</dd>' +
        '</dl><div class="row"><button class="btn btn-small" data-fix>' + (Number.isFinite(s.lat) ? 'Ajustar pino' : 'Marcar no mapa') + '</button></div></div>';
    }
    return html;
  }
  function visible(s, f) {
    switch (f || S.filter) {
      case 'nopin': return !Number.isFinite(s.lat);
      case 'risk': return s.risk;
      case 'todo': return !S.done.has(s.key);
      default: return true;
    }
  }
  function renderList() {
    const list = $('list'); list.innerHTML = ''; S.rows.clear();
    const items = S.stops.slice().sort((a, b) => a.order - b.order).filter(s => visible(s));
    if (!items.length) { list.innerHTML = '<p class="empty">Nenhuma parada neste filtro.</p>'; return; }
    const frag = document.createDocumentFragment();
    items.forEach(s => {
      const el = document.createElement('div');
      el.className = 'stop' + (S.done.has(s.key) ? ' done' : '') + (S.selected === s.id ? ' sel' : '');
      el.setAttribute('role', 'listitem'); el.dataset.id = s.id; el.innerHTML = rowHTML(s);
      S.rows.set(s.id, el); frag.appendChild(el);
    });
    list.appendChild(frag);
  }
  function updateStop(s) {
    upsertMarker(s);
    const el = S.rows.get(s.id);
    if (el) { el.className = 'stop' + (S.done.has(s.key) ? ' done' : '') + (S.selected === s.id ? ' sel' : ''); el.innerHTML = rowHTML(s); }
    scheduleSummary();
  }
  let sumTimer;
  function scheduleSummary() { clearTimeout(sumTimer); sumTimer = setTimeout(renderSummary, 150); }
  function renderSummary() {
    const n = S.stops.length;
    const pills = [['all', 'Todas ' + n, 'var(--accent)'], ['todo', 'Faltam ' + S.stops.filter(s => visible(s, 'todo')).length, 'var(--muted)'],
      ['nopin', 'Sem pino ' + S.stops.filter(s => visible(s, 'nopin')).length, 'var(--none)'], ['risk', 'Risco ' + S.stops.filter(s => s.risk).length, 'var(--risk)']];
    $('summary').innerHTML = pills.map(([k, label, color]) => '<button class="pill num' + (S.filter === k ? ' f-on' : '') + '" data-filter="' + k + '"><i style="background:' + color + '"></i>' + label + '</button>').join('');
  }
  function renderAll() { S.stops.forEach(upsertMarker); renderList(); renderSummary(); }
  function select(id, fromMap) {
    S.selected = S.selected === id && !fromMap ? null : id;
    const s = S.stops.find(x => x.id === id);
    if (fromMap && s && !visible(s)) { S.filter = 'all'; renderSummary(); }
    renderList(); S.stops.forEach(upsertMarker);
    if (S.selected && s) {
      if (fromMap && S.sheetState === 'peek') setSheet('half');
      if (Number.isFinite(s.lat)) panVisible(s);
      const el = S.rows.get(id); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  function toggleDone(s) {
    if (S.done.has(s.key)) S.done.delete(s.key); else S.done.add(s.key);
    store.set(K.done + S.routeKey, Array.from(S.done));
    if (S.filter === 'todo') renderList(); else updateStop(s);
    upsertMarker(s); renderSummary(); updateNav();
  }

  // ---------- Gaveta ----------
  function sheetHeights() { const h = window.innerHeight; return { peek: 132, half: Math.round(h * 0.46), full: Math.round(h * 0.86) }; }
  function setSheet(state, px) {
    S.sheetState = state; S.sheetPx = px != null ? px : sheetHeights()[state];
    document.documentElement.style.setProperty('--sheet-h', S.sheetPx + 'px');
  }
  function initSheet() {
    const handle = $('handle'), sheet = $('sheet');
    let startY = 0, startH = 0, dragging = false, moved = false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-filter], a, button')) return;
      dragging = true; moved = false; startY = e.clientY; startH = S.sheetPx;
      sheet.classList.add('dragging'); handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy = startY - e.clientY; if (Math.abs(dy) > 4) moved = true;
      const H = sheetHeights(); setSheet(S.sheetState, Math.max(H.peek, Math.min(H.full, startH + dy)));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; sheet.classList.remove('dragging');
      const H = sheetHeights();
      if (!moved) { setSheet(S.sheetState === 'peek' ? 'half' : S.sheetState === 'half' ? 'full' : 'peek'); return; }
      setSheet(Object.entries(H).sort((a, b) => Math.abs(a[1] - S.sheetPx) - Math.abs(b[1] - S.sheetPx))[0][0]);
    };
    handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => setSheet(S.sheetState || 'half'));
  }

  // ---------- Áreas de risco ----------
  const riskColor = () => getComputedStyle(document.documentElement).getPropertyValue('--risk').trim() || '#b0195b';
  function drawZones() {
    S.zoneLayers.forEach(l => l.remove()); S.zoneLayers = [];
    if (!S.map) return;
    S.zones.forEach(z => {
      S.zoneLayers.push(L.circle([z.lat, z.lng], { radius: z.radius, color: riskColor(), weight: 2, fillColor: riskColor(), fillOpacity: 0.16, dashArray: '6 6', interactive: false }).addTo(S.map));
    });
  }
  function recomputeRisk() { S.stops.forEach(s => { s.risk = Number.isFinite(s.lat) && S.zones.some(z => C.pointInCircle(s, z)); }); renderAll(); }
  function setRiskMode(on) { S.riskMode = on; $('riskBtn').classList.toggle('on', on); $('riskBanner').hidden = !on; }
  function onMapClick(e) {
    if (!S.riskMode) return;
    setRiskMode(false);
    S.pendingZone = { lat: e.latlng.lat, lng: e.latlng.lng, radius: +$('zoneRadius').value, name: '' };
    S.pendingLayer = L.circle(e.latlng, { radius: S.pendingZone.radius, color: riskColor(), weight: 3, fillOpacity: 0.25 }).addTo(S.map);
    $('zoneName').value = ''; closePanels(true); $('zonePanel').hidden = false;
  }
  function saveZone() {
    const z = S.pendingZone; if (!z) return;
    z.name = $('zoneName').value.trim() || 'Área de risco'; z.id = 'z' + Date.now();
    S.zones.push(z); store.set(K.zones, S.zones);
    cancelZone(); drawZones(); recomputeRisk();
    const n = S.stops.filter(s => s.risk).length;
    toast('Área salva. ' + n + (n === 1 ? ' parada' : ' paradas') + ' em área de risco.');
  }
  function cancelZone() { if (S.pendingLayer) S.pendingLayer.remove(); S.pendingLayer = null; S.pendingZone = null; $('zonePanel').hidden = true; }
  function openZones() {
    closePanels();
    const list = $('zonesList');
    list.innerHTML = S.zones.length ? '' : '<p class="hint">Nenhuma área marcada ainda.</p>';
    S.zones.forEach(z => {
      const row = document.createElement('div'); row.className = 'zone-item';
      row.innerHTML = '<div><b>' + esc(z.name) + '</b><div class="hint num">raio ' + z.radius + ' m</div></div>';
      const box = document.createElement('div'); box.style.display = 'flex'; box.style.gap = '6px';
      const go = document.createElement('button'); go.className = 'btn btn-small'; go.textContent = 'Ver';
      go.onclick = () => { closePanels(); S.map.setView([z.lat, z.lng], 15); };
      const del = document.createElement('button'); del.className = 'btn btn-small'; del.textContent = 'Apagar';
      del.onclick = () => {
        if (del.dataset.confirm) { S.zones = S.zones.filter(x => x.id !== z.id); store.set(K.zones, S.zones); drawZones(); recomputeRisk(); openZones(); }
        else { del.dataset.confirm = '1'; del.textContent = 'Confirmar'; }
      };
      box.append(go, del); row.appendChild(box); list.appendChild(row);
    });
    $('zonesPanel').hidden = false;
  }
  function exportZones() {
    const blob = new Blob([JSON.stringify({ tipo: 'areas-de-risco', versao: 1, areas: S.zones }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'areas-de-risco.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importZones(file) {
    try {
      const j = JSON.parse(await file.text());
      const arr = (j.areas || j).filter(z => Number.isFinite(z.lat) && Number.isFinite(z.lng) && Number.isFinite(z.radius));
      const have = new Set(S.zones.map(z => z.lat.toFixed(5) + z.lng.toFixed(5)));
      let added = 0;
      arr.forEach(z => { const k = z.lat.toFixed(5) + z.lng.toFixed(5); if (!have.has(k)) { S.zones.push({ id: 'z' + Date.now() + added, lat: z.lat, lng: z.lng, radius: z.radius, name: String(z.name || 'Área de risco') }); added++; } });
      store.set(K.zones, S.zones); drawZones(); recomputeRisk(); openZones();
      toast(added + ' áreas importadas.');
    } catch (e) { toast('Esse arquivo não é uma lista de áreas de risco.'); }
  }

  // ---------- Ajuste manual ----------
  function startFix(s) {
    closePanels();
    S.fixStop = s;
    const start = Number.isFinite(s.lat) ? [s.lat, s.lng] : S.map.getCenter();
    S.fixMarker = L.marker(start, { draggable: true, zIndexOffset: 2000,
      icon: L.divIcon({ className: '', html: '<div class="pin manual sel"><span>' + s.order + '</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(S.map);
    const m = S.markers.get(s.id); if (m) m.setOpacity(0.3);
    S.map.setView(start, Math.max(S.map.getZoom(), 17));
    $('fixText').textContent = 'Arraste o pino até a porta de ' + (s.original || s.street) + '. Fica salvo para as próximas rotas com esse endereço.';
    setSheet('peek'); $('fixPanel').hidden = false;
  }
  function endFix(save) {
    const s = S.fixStop;
    if (s && save && S.fixMarker) {
      const p = S.fixMarker.getLatLng();
      setLoc(s, p.lat, p.lng, 'manual', 'ajuste'); s.cands = null;
      S.fix[s.key] = { lat: p.lat, lng: p.lng, t: Date.now() }; store.set(K.fix, S.fix);
      toast('Local salvo.');
    }
    if (S.fixMarker) S.fixMarker.remove();
    const m = s && S.markers.get(s.id); if (m) m.setOpacity(1);
    S.fixMarker = null; S.fixStop = null; $('fixPanel').hidden = true;
    if (s) updateStop(s);
    setSheet('half');
  }

  // ---------- Posição ----------
  let watchId = null;
  function toggleFollow() {
    S.follow = !S.follow;
    $('meBtn').classList.toggle('on-accent', S.follow); $('meBtn').setAttribute('aria-pressed', String(S.follow));
    if (S.follow) {
      if (!navigator.geolocation) { toast('Este navegador não informa a localização.'); S.follow = false; return; }
      toast('Seguindo sua posição. Arraste o mapa para parar.');
      watchId = navigator.geolocation.watchPosition(pos => {
        S.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
        if (S.meMarker) S.meMarker.setLatLng([S.me.lat, S.me.lng]); else S.meMarker = L.marker([S.me.lat, S.me.lng], { icon, interactive: false, zIndexOffset: 3000 }).addTo(S.map);
        if (S.follow) S.map.setView([S.me.lat, S.me.lng], Math.max(S.map.getZoom(), 16), { animate: true });
      }, () => { toast('Não consegui sua localização. Libere o GPS para este site.'); if (S.follow) toggleFollow(); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    } else if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }
  let wakeLock = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* opcional */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('mapScreen').hidden) keepAwake(); });

  function closePanels(keepPending) {
    ['zonesPanel', 'helpPanel'].forEach(id => { $(id).hidden = true; });
    if (!keepPending && S.pendingLayer) cancelZone();
  }

  // ---------- Eventos ----------
  function initMapScreen() {
    $('backBtn').onclick = backToStart;
    $('zoomInBtn').onclick = () => S.map.zoomIn();
    $('zoomOutBtn').onclick = () => S.map.zoomOut();
    $('fitBtn').onclick = () => { S.userMoved = false; fitAll(false); };
    $('meBtn').onclick = toggleFollow;
    $('listBtn').onclick = () => setSheet(S.sheetState === 'peek' ? 'half' : 'peek');
    $('helpBtn').onclick = () => { closePanels(); $('helpPanel').hidden = false; };
    $('helpClose').onclick = () => { $('helpPanel').hidden = true; };
    $('riskBtn').onclick = () => { if (S.riskMode) { setRiskMode(false); return; } openZones(); };
    $('zoneNew').onclick = () => { closePanels(); setRiskMode(true); };
    $('zonesClose').onclick = () => closePanels();
    $('zonesExport').onclick = exportZones;
    $('zonesImport').onchange = e => { if (e.target.files[0]) importZones(e.target.files[0]); e.target.value = ''; };
    $('zoneSave').onclick = saveZone;
    $('zoneCancel').onclick = cancelZone;
    $('zoneRadius').oninput = e => { const r = +e.target.value; $('zoneRadiusLabel').textContent = r + ' m'; if (S.pendingLayer) { S.pendingLayer.setRadius(r); S.pendingZone.radius = r; } };
    $('fixSave').onclick = () => endFix(true);
    $('fixCancel').onclick = () => endFix(false);
    $('summary').addEventListener('click', e => {
      const b = e.target.closest('[data-filter]'); if (!b) return;
      S.filter = b.dataset.filter; renderSummary(); renderList();
      if (S.sheetState === 'peek') setSheet('half');
    });
    $('list').addEventListener('click', e => {
      const row = e.target.closest('.stop'); if (!row) return;
      const s = S.stops.find(x => x.id === row.dataset.id); if (!s) return;
      if (e.target.closest('[data-done]')) { toggleDone(s); return; }
      if (e.target.closest('[data-fix]')) { startFix(s); return; }
      if (e.target.closest('a')) return;
      select(s.id, false);
    });
    initSheet();
  }

  initStart();
  initMapScreen();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__romaneio = { S, navText }; // usado nos testes
})();
