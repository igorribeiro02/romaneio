/* Mapa do Romaneio — interface, mapa e busca de endereços. */
(function () {
  'use strict';
  const C = window.RomCore;
  const $ = id => document.getElementById(id);

  // ---------- Armazenamento local (sempre protegido: pode falhar em aba anônima) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const K = { geo: 'rm.geo.v3', fix: 'rm.fix.v1', cep: 'rm.cep.v1', zones: 'rm.zones.v1', last: 'rm.last.v2', done: 'rm.done.', place: 'rm.place.v1' };
  // Centros conhecidos para começar a busca sem esperar a rede
  const CITY_SEED = {
    'niteroi': { lat: -22.8950, lng: -43.0900 },
    'sao goncalo': { lat: -22.8270, lng: -43.0540 },
    'rio de janeiro': { lat: -22.9100, lng: -43.3500 },
    'marica': { lat: -22.9190, lng: -42.8190 },
    'itaborai': { lat: -22.7440, lng: -42.8590 }
  };

  const S = {
    code: '', fileBuf: null, fileName: '', stops: [], info: null, example: false,
    selected: null, filter: 'all', zones: store.get(K.zones, []), markers: new Map(), rows: new Map(),
    zoneLayers: [], me: null, meMarker: null, fixMarker: null, fixStop: null, riskMode: false, pendingZone: null,
    pendingLayer: null, anchor: null, cepCache: store.get(K.cep, {}), geo: store.get(K.geo, {}), fix: store.get(K.fix, {}),
    places: store.get(K.place, {}), sheets: null,
    done: new Set(), routeKey: '', busy: false, t0: 0, map: null, sheetPx: 0
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase());
  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  // ---------- Rede ----------
  async function fetchJSON(url, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; try { await fn(item); } catch (e) { /* segue */ } }
    });
    await Promise.all(workers);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // CEP → rua, bairro, cidade e (às vezes) coordenada. Um pedido por CEP, nunca por pacote.
  async function lookupCep(cep) {
    if (!cep || S.cepCache[cep]) return S.cepCache[cep];
    let info = null;
    try {
      const j = await fetchJSON('https://brasilapi.com.br/api/cep/v2/' + cep, 6000);
      const co = j.location && j.location.coordinates;
      const lat = co ? parseFloat(co.latitude) : NaN, lng = co ? parseFloat(co.longitude) : NaN;
      info = { street: j.street || '', bairro: j.neighborhood || '', city: j.city || '', uf: j.state || '',
        lat: C.inBrazil(lat, lng) ? lat : null, lng: C.inBrazil(lat, lng) ? lng : null };
    } catch (e) {
      try {
        const j = await fetchJSON('https://viacep.com.br/ws/' + cep + '/json/', 6000);
        if (!j.erro) info = { street: j.logradouro || '', bairro: j.bairro || '', city: j.localidade || '', uf: j.uf || '', lat: null, lng: null };
      } catch (e2) { /* sem CEP */ }
    }
    if (info) S.cepCache[cep] = info;
    return info;
  }

  // Centro de cidade e de bairro (um pedido por bairro da rota, guardado para sempre)
  const placeKey = (bairro, city) => C.norm(bairro) + '|' + C.norm(city);
  function cityCenter(city) {
    const k = C.norm(city);
    return CITY_SEED[k] || S.places['|' + k] || null;
  }
  async function lookupCity(city) {
    const k = '|' + C.norm(city);
    if (!city || CITY_SEED[C.norm(city)] || S.places[k]) return;
    try {
      const j = await fetchJSON('https://photon.komoot.io/api/?limit=5&osm_tag=place&q=' + encodeURIComponent(city), 7000);
      const f = (j.features || []).find(f => f.properties.countrycode === 'BR' && C.jaroWinkler(f.properties.name, city) >= 0.9);
      if (f) S.places[k] = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    } catch (e) { /* sem centro */ }
  }
  async function lookupBairro(bairro, city) {
    const k = placeKey(bairro, city);
    if (!bairro || S.places[k] !== undefined) return;
    const cc = cityCenter(city);
    let url = 'https://photon.komoot.io/api/?limit=8&osm_tag=place&q=' + encodeURIComponent(bairro + ', ' + city);
    if (cc) url += '&lat=' + cc.lat + '&lon=' + cc.lng + '&bbox=' + [cc.lng - 0.3, cc.lat - 0.3, cc.lng + 0.3, cc.lat + 0.3].map(v => v.toFixed(3)).join(',');
    try {
      const j = await fetchJSON(url, 7000);
      let best = null, bs = 0;
      (j.features || []).forEach(f => {
        const p = f.properties;
        if (p.countrycode && p.countrycode !== 'BR') return;
        if (!/suburb|neighbourhood|quarter|district|village|hamlet|city_district|locality/.test(p.osm_value || p.type || '')) return;
        const sc = C.jaroWinkler(p.name, bairro);
        if (sc > bs) { bs = sc; best = f; }
      });
      S.places[k] = best && bs >= 0.86 ? { lat: best.geometry.coordinates[1], lng: best.geometry.coordinates[0] } : null;
    } catch (e) { /* tenta de novo outro dia */ }
  }

  function photonCands(j) {
    return (j.features || []).filter(f => !f.properties.countrycode || f.properties.countrycode === 'BR').map(f => {
      const p = f.properties, [lng, lat] = f.geometry.coordinates;
      const street = p.street || ((p.type === 'street' || p.osm_key === 'highway') ? p.name : '');
      return { lat, lng, street, name: p.name, housenumber: p.housenumber, postcode: p.postcode,
        district: p.district || p.locality || p.suburb || '', city: p.city || p.county || '', type: p.type };
    });
  }
  function nominatimCands(arr) {
    return (arr || []).map(it => {
      const a = it.address || {};
      return { lat: +it.lat, lng: +it.lon, street: a.road || a.pedestrian || '', name: it.name, housenumber: a.house_number,
        postcode: a.postcode, district: a.suburb || a.neighbourhood || a.city_district || '',
        city: a.city || a.town || a.village || a.municipality || '', type: it.addresstype === 'building' || a.house_number ? 'house' : 'street' };
    });
  }

  function buildQuery(s) {
    const cep = S.cepCache[s.cep];
    let street = s.street;
    if (cep && cep.street) {
      const sim = C.streetSimilarity(street, cep.street);
      // corrige erro de digitação usando a grafia oficial do CEP
      if (!street || (sim >= 0.55 && sim < 1)) street = C.expandAbbrev(cep.street);
    }
    const bairro = s.bairro || (cep && cep.bairro) || '';
    const city = s.city || (cep && cep.city) || S.cityGuess || '';
    const bc = bairro ? S.places[placeKey(bairro, city)] : null;
    let anchor = null, tight = false;
    if (cep && cep.lat != null) { anchor = { lat: cep.lat, lng: cep.lng }; tight = true; }
    else if (bc) { anchor = bc; tight = true; }
    else anchor = S.anchor || cityCenter(city);
    return { street, number: s.number, cep: s.cep, bairro, city, anchor, tight, box: cityCenter(city) || anchor };
  }

  function pickBest(q, cands) {
    let best = null;
    for (const c of cands) {
      const sc = C.scoreCandidate(q, c);
      if (!best || sc.score > best.score) best = Object.assign({ cand: c }, sc);
    }
    return best;
  }

  function photonURL(text, q) {
    let url = 'https://photon.komoot.io/api/?limit=8&q=' + encodeURIComponent(text);
    if (q.anchor) url += '&lat=' + q.anchor.lat.toFixed(5) + '&lon=' + q.anchor.lng.toFixed(5);
    const b = q.box;
    if (b) { const d = 0.25; url += '&bbox=' + [b.lng - d, b.lat - d, b.lng + d, b.lat + d].map(v => v.toFixed(4)).join(','); }
    return url;
  }
  async function geocodePhoton(s) {
    const q = buildQuery(s);
    if (!q.street && !q.cep) return null;
    // 1ª tentativa: rua + número + bairro + cidade
    const t1 = [q.street, q.number].filter(Boolean).join(' ') + (q.bairro || q.city ? ', ' + [q.bairro, q.city].filter(Boolean).join(', ') : '');
    let best = pickBest(q, photonCands(await fetchJSON(photonURL(t1 || q.cep, q), 8000)));
    // 2ª tentativa só se ficou fraco: rua + cidade (às vezes o bairro do romaneio não bate com o do mapa)
    if ((!best || best.score < 0.8) && q.street) {
      const b2 = pickBest(q, photonCands(await fetchJSON(photonURL([q.street, q.number].filter(Boolean).join(' ') + (q.city ? ', ' + q.city : ''), q), 8000)));
      if (b2 && (!best || b2.score > best.score)) best = b2;
    }
    return { q, best };
  }

  let lastNominatim = 0;
  async function geocodeNominatim(s) {
    const q = buildQuery(s);
    if (!q.street) return null;
    const wait = lastNominatim + 1100 - Date.now(); // regra de uso: 1 pedido por segundo
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '5', countrycodes: 'br',
      street: [q.number, q.street].filter(Boolean).join(' ') });
    if (q.city) params.set('city', q.city);
    if (q.cep) params.set('postalcode', q.cep.slice(0, 5) + '-' + q.cep.slice(5));
    const arr = await fetchJSON('https://nominatim.openstreetmap.org/search?' + params, 9000);
    return { q, best: pickBest(q, nominatimCands(arr)) };
  }

  function setLoc(s, lat, lng, conf, src) {
    s.lat = lat; s.lng = lng; s.conf = conf; s.src = src;
    s.risk = S.zones.some(z => C.pointInCircle(s, z));
  }
  function remember(s) {
    // duvidosos também ficam guardados por 3 dias, para reabrir a rota na hora
    if (Number.isFinite(s.lat) && ['alta', 'media', 'baixa'].includes(s.conf)) S.geo[s.key] = { lat: s.lat, lng: s.lng, conf: s.conf, src: s.src, t: Date.now() };
  }
  function saveCaches() {
    const keys = Object.keys(S.geo);
    if (keys.length > 6000) keys.sort((a, b) => S.geo[a].t - S.geo[b].t).slice(0, keys.length - 6000).forEach(k => delete S.geo[k]);
    store.set(K.geo, S.geo);
    const ck = Object.keys(S.cepCache);
    if (ck.length > 4000) ck.slice(0, ck.length - 4000).forEach(k => delete S.cepCache[k]);
    store.set(K.cep, S.cepCache);
  }

  // ---------- O algoritmo de localização em etapas ----------
  async function locateAll() {
    S.busy = true; S.t0 = performance.now();
    const need = [];
    for (const s of S.stops) {
      if (S.fix[s.key]) setLoc(s, S.fix[s.key].lat, S.fix[s.key].lng, 'manual', 'ajuste');
      else if (Number.isFinite(s.sheetLat)) setLoc(s, s.sheetLat, s.sheetLng, 'planilha', 'planilha');
      else if (S.geo[s.key] && (S.geo[s.key].conf !== 'baixa' || Date.now() - S.geo[s.key].t < 3 * 864e5)) {
        const g = S.geo[s.key]; setLoc(s, g.lat, g.lng, g.conf, g.src === 'bairro' ? 'bairro' : 'cache');
      }
      else { s.conf = 'wait'; need.push(s); }
    }
    // 1) Coordenadas da planilha: confere se alguma caiu longe do resto da rota
    const outl = C.findOutliers(S.stops.filter(s => s.conf === 'planilha'));
    S.stops.forEach(s => { if (outl.has(s.id)) { s.conf = 'fora'; if (s.street) need.push(s); } });
    renderAll(); fitAll(true);
    updateProgress(need.length);

    if (need.length) {
      // 2) CEPs únicos em paralelo
      const ceps = Array.from(new Set(need.map(s => s.cep).filter(c => c && !S.cepCache[c])));
      await pool(ceps, 6, lookupCep);

      // 2b) Centro de cada cidade e bairro da rota (poucos pedidos, guardados para sempre)
      const cityList = Array.from(new Set(need.map(s => s.city).filter(Boolean)));
      await pool(cityList, 3, lookupCity);
      const bairroList = Array.from(new Map(need.filter(s => s.bairro).map(s => [placeKey(s.bairro, s.city), s])).values());
      await pool(bairroList, 5, s => lookupBairro(s.bairro, s.city));
      store.set(K.place, S.places);

      // 3) Âncora da rota: mediana dos pontos já conhecidos, senão dos CEPs
      const known = S.stops.filter(s => Number.isFinite(s.lat) && s.conf !== 'fora');
      const cepPts = need.map(s => S.cepCache[s.cep]).filter(c => c && c.lat != null);
      if (known.length) S.anchor = C.centroid(known);
      else if (cepPts.length) S.anchor = C.centroid(cepPts);
      const cities = need.map(s => s.city || (S.cepCache[s.cep] || {}).city).filter(Boolean);
      S.cityGuess = cities.length ? mostCommon(cities) : '';

      // 4) Photon em paralelo (4 por vez); cada parada aparece no mapa assim que sai
      let done = 0;
      await pool(need, 5, async s => {
        try {
          const r = await geocodePhoton(s);
          applyResult(s, r);
        } catch (e) { applyResult(s, null); }
        if (!S.anchor && Number.isFinite(s.lat) && s.conf === 'alta') S.anchor = { lat: s.lat, lng: s.lng };
        updateProgress(need.length - (++done));
        updateStop(s);
        if (done === Math.min(8, need.length)) fitAll(true);
      });

      saveCaches();
    }
    // 6) Com todos os pontos na mão, procura quem caiu longe do resto da rota (inclusive
    //    coordenadas erradas vindas da planilha) e tenta localizar de novo pelo endereço.
    const out2 = C.findOutliers(S.stops.filter(s => Number.isFinite(s.lat) && s.conf !== 'manual' && s.conf !== 'fora'));
    const recheck = S.stops.filter(s => out2.has(s.id));
    if (recheck.length) {
      recheck.forEach(s => { s.conf = 'fora'; delete S.geo[s.key]; updateStop(s); });
      const ceps = Array.from(new Set(recheck.map(s => s.cep).filter(c => c && !S.cepCache[c])));
      await pool(ceps, 6, lookupCep);
      const known = S.stops.filter(s => Number.isFinite(s.lat) && s.conf !== 'fora');
      if (known.length) S.anchor = C.centroid(known);
      await pool(recheck.filter(s => s.street || s.cep), 4, async s => {
        try { applyResult(s, await geocodePhoton(s)); } catch (e) { /* mantém como fora */ }
        if (s.conf !== 'fora' && S.anchor && C.haversineKm(S.anchor, s) > 25) s.conf = 'fora';
        updateStop(s);
      });
      saveCaches();
    }
    const secs = ((performance.now() - S.t0) / 1000).toFixed(1).replace('.', ',');
    updateProgress(0, secs);
    renderSummary(); fitAll(false); saveLast();

    // 5) Segunda opinião (Nominatim) em segundo plano, só para os duvidosos, no máximo 25.
    //    O mapa já está pronto; os pinos vão se corrigindo sozinhos.
    const weak = need.filter(s => s.conf === 'baixa' || s.conf === 'wait').slice(0, 25);
    if (weak.length) {
      await refine(weak, secs);
      saveCaches(); saveLast(); renderSummary();
    }
    S.busy = false;
  }

  function applyResult(s, r) {
    const prev = s.conf;
    const cep = S.cepCache[s.cep];
    if (prev === 'fora' && !(r && r.best && r.best.score >= 0.6) && !(cep && cep.lat != null)) return;
    if (r && r.best && r.best.score >= 0.6) {
      setLoc(s, r.best.cand.lat, r.best.cand.lng, C.confidenceFromScore(r.best.score), 'busca');
      s.score = r.best.score;
    } else if (cep && cep.lat != null) {
      setLoc(s, cep.lat, cep.lng, 'media', 'cep'); s.score = 0.6;
    } else if (r && r.best && r.best.score > 0.45) {
      setLoc(s, r.best.cand.lat, r.best.cand.lng, 'baixa', 'busca'); s.score = r.best.score;
    } else if (S.places[placeKey(s.bairro, s.city)]) {
      const b = S.places[placeKey(s.bairro, s.city)];
      setLoc(s, b.lat, b.lng, 'baixa', 'bairro'); s.score = 0.3;
    } else if (prev === 'fora') {
      // coordenada da planilha suspeita e a busca não confirmou: mantém e pede conferência
    } else {
      s.conf = 'baixa'; s.lat = NaN; s.lng = NaN; s.score = 0;
    }
    remember(s);
  }

  async function refine(list, readySecs) {
    let left = list.length;
    const show = () => readySecs != null
      ? updateProgress(0, readySecs, null, left ? 'conferindo ' + left : '')
      : updateProgress(left, null, 'Refinando');
    show();
    for (const s of list) {
      try {
        const r = await geocodeNominatim(s);
        if (r && r.best && r.best.score > (s.score || 0) + 0.05) {
          setLoc(s, r.best.cand.lat, r.best.cand.lng, C.confidenceFromScore(r.best.score), 'busca');
          s.score = r.best.score; remember(s); updateStop(s);
        }
      } catch (e) { /* sem rede ou limite */ }
      left--; show();
    }
  }

  function mostCommon(arr) {
    const m = new Map(); let best = arr[0], n = 0;
    arr.forEach(x => { const k = C.norm(x); const c = (m.get(k) || 0) + 1; m.set(k, c); if (c > n) { n = c; best = x; } });
    return best;
  }

  // ---------- Leitura da planilha ----------
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

  // Lê a planilha uma vez (quando o arquivo é escolhido) e guarda as linhas de cada aba
  async function readWorkbook(buf) {
    await ensureXLSX();
    const wb = window.XLSX.read(buf, { type: 'array', cellDates: false });
    return wb.SheetNames.map(name => {
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      return { name, rows, meta: C.listRoutes(rows) };
    }).filter(sh => sh.meta);
  }

  function routeFrom(sheets, code) {
    if (!sheets.length) throw new Error('Não achei endereços nessa planilha. Ela tem colunas como Endereço, Bairro e Cidade?');
    const codeN = C.normRouteCode(code);
    let firstError = null;
    const results = sheets.map(sh => {
      const r = C.buildRoute(sh.rows, code);
      r.nameMatch = codeN && C.normRouteCode(sh.name) === codeN;
      if (r.error && !firstError) firstError = r.error;
      return r;
    }).filter(r => !r.error && r.stops.length);
    if (!results.length) throw new Error(firstError || 'Não achei endereços nessa planilha.');
    results.sort((a, b) => (b.nameMatch - a.nameMatch) || (b.stops.length - a.stops.length));
    return results[0];
  }

  // ---------- Tela inicial ----------
  function initStart() {
    $('fileInput').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      S.fileName = f.name; S.sheets = null;
      $('fileTitle').textContent = 'Lendo planilha…';
      $('fileName').textContent = f.name;
      $('fileDrop').classList.add('has-file');
      $('startError').hidden = true;
      try {
        S.sheets = await readWorkbook(await f.arrayBuffer());
        const routes = S.sheets.flatMap(sh => sh.meta.routes);
        const total = S.sheets.reduce((a, sh) => a + sh.meta.total, 0);
        $('fileTitle').textContent = routes.length > 1 ? routes.length + ' rotas · ' + total.toLocaleString('pt-BR') + ' pacotes' : total.toLocaleString('pt-BR') + ' pacotes';
        $('routeList').innerHTML = routes.map(r => '<option value="' + esc(r.code) + '">' + r.n + ' pacotes</option>').join('');
        $('routeHint').textContent = routes.length > 1
          ? 'Rotas nesta planilha: ' + routes.slice(0, 12).map(r => r.code).join(', ') + (routes.length > 12 ? '…' : '')
          : 'A planilha tem uma rota só. Pode deixar em branco.';
        $('goBtn').disabled = false;
        if ($('routeCode').value) validateCode();
      } catch (err) {
        $('fileTitle').textContent = 'Escolher planilha';
        $('startError').textContent = err.message || 'Não consegui ler esse arquivo.'; $('startError').hidden = false;
      }
    });
    $('routeCode').addEventListener('input', validateCode);
    $('routeCode').addEventListener('blur', () => { $('routeCode').value = prettyCode($('routeCode').value); });
    $('routeCode').value = store.get('rm.code', '');
    $('goBtn').addEventListener('click', openFromFile);
    $('routeCode').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('goBtn').disabled) openFromFile(); });
    $('demoBtn').addEventListener('click', openExample);
    renderRecent();
  }

  // "h19", "H 19" e "h-19" viram "H-19"
  function prettyCode(v) {
    const t = String(v || '').trim().toUpperCase();
    const m = t.match(/^([A-Z]{1,3})\s*-?\s*(\d{1,4})$/);
    return m ? m[1] + '-' + m[2] : t;
  }

  async function openFromFile() {
    const code = prettyCode($('routeCode').value);
    $('routeCode').value = code;
    store.set('rm.code', code);
    if (!S.sheets) return;
    try {
      const r = routeFrom(S.sheets, code);
      $('startError').hidden = true;
      openRoute(code, r.stops, r.info, false);
      const pk = r.stops.reduce((a, x) => a + x.packages.length, 0);
      toast((code || 'Rota') + ': ' + pk + ' pacotes em ' + r.stops.length + ' endereços');
    } catch (e) {
      $('startError').textContent = e.message; $('startError').hidden = false;
    }
  }

  // Avisa na hora se a rota digitada não existe na planilha
  function validateCode() {
    if (!S.sheets) return;
    const codeN = C.normRouteCode($('routeCode').value);
    const routes = S.sheets.flatMap(sh => sh.meta.routes);
    const box = $('routeHint');
    if (!codeN || !routes.length) { box.classList.remove('ok', 'bad'); return; }
    const hit = routes.find(r => C.normRouteCode(r.code) === codeN);
    box.classList.toggle('ok', !!hit); box.classList.toggle('bad', !hit);
    box.textContent = hit ? hit.code + ': ' + hit.n + ' pacotes' : 'Essa rota não está na planilha.';
  }

  function renderRecent() {
    const last = store.get(K.last, null);
    const box = $('recentBox');
    box.querySelectorAll('button').forEach(b => b.remove());
    if (!last || !last.stops || !last.stops.length) { box.hidden = true; return; }
    const b = document.createElement('button');
    const d = new Date(last.t);
    const when = d.toDateString() === new Date().toDateString() ? 'hoje ' + d.toTimeString().slice(0, 5) : d.toLocaleDateString('pt-BR');
    b.innerHTML = '<b>' + esc(last.code || 'Rota') + '</b><small class="num">' + last.stops.length + ' paradas · ' + esc(when) + '</small>';
    b.addEventListener('click', () => {
      last.stops.forEach(s => { s.sheetLat = Number.isFinite(s.lat) ? s.lat : s.sheetLat; });
      openRoute(last.code, last.stops, last.info, !!last.example, true);
    });
    box.appendChild(b); box.hidden = false;
  }

  function saveLast() {
    if (S.example) return;
    const slim = S.stops.map(s => ({
      id: s.id, key: s.key, order: s.order, seq: s.seq, street: s.street, streetCore: s.streetCore, number: s.number,
      cep: s.cep, bairro: s.bairro, city: s.city, original: s.original, packages: s.packages, recipients: s.recipients,
      complements: s.complements, seqs: s.seqs, sheetLat: s.sheetLat, sheetLng: s.sheetLng, lat: s.lat, lng: s.lng, conf: s.conf, src: s.src
    }));
    store.set(K.last, { code: S.code, t: Date.now(), stops: slim, info: S.info });
  }

  // ---------- Abrir rota ----------
  function openRoute(code, stops, info, example, fromSaved) {
    S.code = code; S.stops = stops; S.info = info || {}; S.example = example; S.selected = null; S.filter = 'all';
    S.routeKey = (code || 'rota') + '-' + new Date().toISOString().slice(0, 10);
    S.done = new Set(store.get(K.done + S.routeKey, []));
    $('start').hidden = true; $('mapScreen').hidden = false;
    $('exampleBanner').hidden = !example;
    $('chipCode').textContent = code || 'Rota';
    initMap();
    setSheet('half');
    keepAwake();
    if (fromSaved) {
      S.stops.forEach(s => { if (Number.isFinite(s.lat) && !s.conf) s.conf = 'alta'; s.risk = Number.isFinite(s.lat) && S.zones.some(z => C.pointInCircle(s, z)); });
      renderAll(); fitAll(false); updateProgress(0, '0,0');
      // reaproveita o que já tinha e só busca o que faltou
      if (S.stops.some(s => !Number.isFinite(s.lat))) locateAll();
    } else {
      locateAll();
    }
  }

  function backToStart() {
    $('mapScreen').hidden = true; $('start').hidden = false;
    closePanels(); setRiskMode(false); renderRecent();
  }

  // ---------- Mapa ----------
  function initMap() {
    if (!S.map) {
      S.map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView([-22.9, -43.1], 12);
      const dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
      L.tileLayer(dark ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 20, subdomains: 'abcd',
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>'
      }).addTo(S.map);
      S.map.on('click', onMapClick);
      // quando o motorista mexe no mapa, a busca para de reenquadrar a visão sozinha
      S.map.on('dragstart', () => { S.userMoved = true; });
    }
    S.userMoved = false;
    S.markers.forEach(m => m.remove()); S.markers.clear();
    drawZones();
    setTimeout(() => S.map.invalidateSize(), 50);
  }

  function pinClass(s) {
    return [s.conf || 'wait', s.risk ? 'risco' : '', S.done.has(s.key) ? 'done' : '', S.selected === s.id ? 'sel' : ''].join(' ');
  }
  // Paradas no mesmo ponto (mesma rua sem número no mapa) abrem em leque para dar para tocar em cada uma
  const samePoint = s => S.stops.filter(o => Number.isFinite(o.lat) && Math.abs(o.lat - s.lat) < 2e-5 && Math.abs(o.lng - s.lng) < 2e-5)
    .sort((a, b) => a.order - b.order);
  function displayPos(s) {
    const same = samePoint(s);
    if (same.length < 2) return [s.lat, s.lng];
    const i = same.indexOf(s), n = same.length;
    const r = 0.00009 + 0.00002 * Math.floor(i / 8), ang = (2 * Math.PI * (i % 8)) / Math.min(n, 8);
    return [s.lat + r * Math.cos(ang), s.lng + r * Math.sin(ang) / Math.cos(s.lat * Math.PI / 180)];
  }
  function upsertMarker(s, noSpread) {
    let m = S.markers.get(s.id);
    if (!Number.isFinite(s.lat)) { if (m) { m.remove(); S.markers.delete(s.id); } return; }
    if (!noSpread) samePoint(s).forEach(o => { if (o !== s) upsertMarker(o, true); });
    const pos = displayPos(s);
    const icon = L.divIcon({ className: '', html: '<div class="pin ' + pinClass(s) + '"><span>' + s.order + '</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] });
    if (!m) {
      m = L.marker(pos, { icon, keyboard: false }).addTo(S.map);
      m.on('click', () => select(s.id, true));
      S.markers.set(s.id, m);
    } else { m.setLatLng(pos); m.setIcon(icon); }
    m.setZIndexOffset(S.selected === s.id ? 1000 : 0);
  }

  function fitAll(soft) {
    const pts = S.stops.filter(s => Number.isFinite(s.lat) && s.conf !== 'fora').map(s => [s.lat, s.lng]);
    if (!pts.length || !S.map) return;
    if (soft && S.userMoved) return;
    S.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 90], paddingBottomRight: [70, S.sheetPx + 20], maxZoom: 16, animate: !soft });
  }

  // ---------- Lista ----------
  const CONF_LABEL = { alta: 'Exato', planilha: 'Planilha', media: 'Rua', baixa: 'Conferir', fora: 'Fora da área', manual: 'Ajustado', wait: 'Localizando' };
  function navLinks(s) {
    if (Number.isFinite(s.lat)) {
      return { waze: 'https://waze.com/ul?ll=' + s.lat + ',' + s.lng + '&navigate=yes',
        gmaps: 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + s.lat + ',' + s.lng };
    }
    const q = encodeURIComponent([s.original, s.bairro, s.city].filter(Boolean).join(', '));
    return { waze: 'https://waze.com/ul?q=' + q + '&navigate=yes', gmaps: 'https://www.google.com/maps/search/?api=1&query=' + q };
  }
  const ICON = {
    waze: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-8-8 18-2-8z"/></svg>',
    map: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
    check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
  };

  function rowHTML(s) {
    const L2 = navLinks(s);
    const done = S.done.has(s.key);
    const addr = s.original || [s.street, s.number].filter(Boolean).join(', ') || 'Endereço sem rua';
    const ref = (s.complements || []).join(' · ');
    const seqs = (s.seqs || []).slice().sort((a, b) => a - b);
    const seqTxt = seqs.length ? 'seq ' + (seqs.length > 4 ? seqs.slice(0, 4).join(', ') + '…' : seqs.join(', ')) : '';
    const conf = s.conf || 'wait';
    const tags = [];
    if (s.risk) tags.push('<span class="tag risco">Risco</span>');
    if (['media', 'baixa', 'fora', 'manual'].includes(conf)) tags.push('<span class="tag conf ' + conf + '">' + CONF_LABEL[conf] + '</span>');
    if (conf === 'wait') tags.push('<span>localizando…</span>');
    const pk = s.packages.length;
    let html = '<div class="badge ' + conf + '">' + s.order + '</div>' +
      '<div style="min-width:0"><div class="addr">' + esc(addr) + '</div>' +
      (ref ? '<div class="ref">' + esc(ref) + '</div>' : '') +
      '<div class="meta">' +
      (s.bairro ? '<span>' + esc(s.bairro) + '</span>' : '') +
      '<span class="num">' + pk + (pk > 1 ? ' pacotes' : ' pacote') + (seqTxt ? ' · ' + seqTxt : '') + '</span>' + tags.join('') + '</div></div>' +
      '<div class="acts">' +
      '<a class="act" href="' + L2.waze + '" target="_blank" rel="noopener" aria-label="Abrir no Waze" data-stop>' + ICON.waze + '</a>' +
      '<button class="act check' + (done ? ' on' : '') + '" data-done aria-label="Marcar entregue" aria-pressed="' + done + '">' + ICON.check + '</button>' +
      '</div>';
    if (S.selected === s.id) {
      html += '<div class="detail">' +
        '<dl>' +
        (s.recipients.length ? '<dt>Para</dt><dd>' + esc(s.recipients.join(', ')) + '</dd>' : '') +
        (s.city ? '<dt>Cidade</dt><dd>' + esc(s.city) + '</dd>' : '') +
        (s.cep ? '<dt>CEP</dt><dd class="num">' + s.cep.slice(0, 5) + '-' + s.cep.slice(5) + '</dd>' : '') +
        '<dt>Pacotes</dt><dd class="num">' + esc(s.packages.join(', ')) + '</dd>' +
        '<dt>Local</dt><dd>' + esc(CONF_LABEL[conf]) + (s.src === 'cep' ? ' (pelo CEP)' : s.src === 'bairro' ? ' (centro do bairro, ajuste o pino)' : '') + '</dd>' +
        '</dl><div class="row">' +
        '<a class="btn btn-small" href="' + L2.gmaps + '" target="_blank" rel="noopener">' + ICON.map + ' Google Maps</a>' +
        '<button class="btn btn-small" data-fix>' + (Number.isFinite(s.lat) ? 'Ajustar pino' : 'Marcar no mapa') + '</button>' +
        '</div></div>';
    }
    return html;
  }

  function visible(s) {
    switch (S.filter) {
      case 'check': return ['baixa', 'fora', 'wait'].includes(s.conf) || !Number.isFinite(s.lat);
      case 'risk': return s.risk;
      case 'todo': return !S.done.has(s.key);
      default: return true;
    }
  }

  function renderList() {
    const list = $('list');
    list.innerHTML = ''; S.rows.clear();
    const items = S.stops.slice().sort((a, b) => a.order - b.order).filter(visible);
    if (!items.length) { list.innerHTML = '<p class="empty">Nenhuma parada neste filtro.</p>'; return; }
    const frag = document.createDocumentFragment();
    for (const s of items) {
      const el = document.createElement('div');
      el.className = 'stop' + (S.done.has(s.key) ? ' done' : '') + (S.selected === s.id ? ' sel' : '');
      el.setAttribute('role', 'listitem'); el.dataset.id = s.id;
      el.innerHTML = rowHTML(s);
      S.rows.set(s.id, el); frag.appendChild(el);
    }
    list.appendChild(frag);
  }

  function updateStop(s) {
    upsertMarker(s);
    const el = S.rows.get(s.id);
    if (el) {
      el.className = 'stop' + (S.done.has(s.key) ? ' done' : '') + (S.selected === s.id ? ' sel' : '');
      el.innerHTML = rowHTML(s);
    }
    scheduleSummary();
  }
  let sumTimer;
  function scheduleSummary() { clearTimeout(sumTimer); sumTimer = setTimeout(renderSummary, 120); }

  function renderSummary() {
    const n = S.stops.length;
    const pk = S.stops.reduce((a, s) => a + s.packages.length, 0);
    const check = S.stops.filter(s => visibleFor('check', s)).length;
    const risk = S.stops.filter(s => s.risk).length;
    const todo = S.stops.filter(s => !S.done.has(s.key)).length;
    const pills = [
      ['all', 'Todas ' + n, 'var(--accent)'],
      ['check', 'Conferir ' + check, 'var(--warn)'],
      ['risk', 'Risco ' + risk, 'var(--risk)'],
      ['todo', 'Faltam ' + todo, 'var(--muted)']
    ];
    $('summary').innerHTML = pills.map(([k, label, color]) =>
      '<button class="pill num' + (S.filter === k ? ' f-on' : '') + '" data-filter="' + k + '"><i style="background:' + color + '"></i>' + label + '</button>').join('') +
      '<span class="pill num" style="background:transparent;border-color:transparent">' + pk + ' pacotes</span>';
  }
  function visibleFor(f, s) { const keep = S.filter; S.filter = f; const v = visible(s); S.filter = keep; return v; }

  function renderAll() {
    S.stops.forEach(upsertMarker);
    renderList(); renderSummary();
  }

  function updateProgress(left, secs, verb, extra) {
    const n = S.stops.length;
    const info = $('chipInfo'), bar = $('progressBar');
    const pk = S.stops.reduce((a, s) => a + s.packages.length, 0);
    if (left > 0) {
      const total = Math.max(n, 1);
      info.textContent = (verb || 'Localizando') + '… faltam ' + left + ' de ' + n;
      bar.style.width = Math.round(100 * (total - left) / total) + '%';
    } else {
      info.textContent = n + ' paradas · ' + pk + ' pacotes' + (secs ? ' · pronto em ' + secs + ' s' : '') + (extra ? ' · ' + extra : '');
      bar.style.width = '100%';
    }
  }

  function select(id, fromMap) {
    S.selected = S.selected === id && !fromMap ? null : id;
    if (S.filter !== 'all' && fromMap) { const s = S.stops.find(x => x.id === id); if (s && !visible(s)) { S.filter = 'all'; renderSummary(); } }
    renderList();
    S.stops.forEach(upsertMarker);
    const s = S.stops.find(x => x.id === id);
    if (S.selected && s) {
      if (fromMap && S.sheetState === 'peek') setSheet('half');
      if (Number.isFinite(s.lat)) panVisible(s);
      const el = S.rows.get(id);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // centraliza o ponto na parte do mapa que a gaveta não cobre
  function panVisible(s) {
    const z = Math.max(S.map.getZoom(), 15);
    const pt = S.map.project([s.lat, s.lng], z).add([0, (S.sheetPx - 70) / 2]);
    S.map.setView(S.map.unproject(pt, z), z, { animate: true });
  }

  function toggleDone(s) {
    if (S.done.has(s.key)) S.done.delete(s.key); else S.done.add(s.key);
    store.set(K.done + S.routeKey, Array.from(S.done));
    if (S.filter === 'todo') renderList(); else updateStop(s);
    upsertMarker(s); renderSummary();
  }

  // ---------- Gaveta arrastável ----------
  function sheetHeights() {
    const h = window.innerHeight;
    return { peek: 128, half: Math.round(h * 0.46), full: Math.round(h * 0.86) };
  }
  function setSheet(state, px) {
    const H = sheetHeights();
    S.sheetState = state;
    S.sheetPx = px != null ? px : H[state];
    document.documentElement.style.setProperty('--sheet-h', S.sheetPx + 'px');
  }
  function initSheet() {
    const handle = $('handle'), sheet = $('sheet');
    let startY = 0, startH = 0, dragging = false, moved = false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-filter]')) return;
      dragging = true; moved = false; startY = e.clientY; startH = S.sheetPx;
      sheet.classList.add('dragging'); handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 4) moved = true;
      const H = sheetHeights();
      setSheet(S.sheetState, Math.max(H.peek, Math.min(H.full, startH + dy)));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; sheet.classList.remove('dragging');
      const H = sheetHeights();
      if (!moved) { setSheet(S.sheetState === 'peek' ? 'half' : S.sheetState === 'half' ? 'full' : 'peek'); return; }
      const near = Object.entries(H).sort((a, b) => Math.abs(a[1] - S.sheetPx) - Math.abs(b[1] - S.sheetPx))[0][0];
      setSheet(near);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => setSheet(S.sheetState || 'half'));
  }

  // ---------- Áreas de risco ----------
  function drawZones() {
    S.zoneLayers.forEach(l => l.remove()); S.zoneLayers = [];
    if (!S.map) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--risk').trim() || '#b0195b';
    S.zones.forEach(z => {
      const c = L.circle([z.lat, z.lng], { radius: z.radius, color, weight: 2, fillColor: color, fillOpacity: 0.16, dashArray: '6 6', interactive: false }).addTo(S.map);
      if (z.name) c.bindTooltip(z.name, { permanent: false });
      S.zoneLayers.push(c);
    });
  }
  function recomputeRisk() {
    S.stops.forEach(s => { s.risk = Number.isFinite(s.lat) && S.zones.some(z => C.pointInCircle(s, z)); });
    renderAll();
  }
  function setRiskMode(on) {
    S.riskMode = on;
    $('riskBtn').classList.toggle('on', on);
    $('riskBanner').hidden = !on;
    if (on) $('exampleBanner').hidden = true;
  }
  function onMapClick(e) {
    if (!S.riskMode) return;
    setRiskMode(false);
    S.pendingZone = { lat: e.latlng.lat, lng: e.latlng.lng, radius: +$('zoneRadius').value, name: '' };
    const color = getComputedStyle(document.documentElement).getPropertyValue('--risk').trim();
    S.pendingLayer = L.circle(e.latlng, { radius: S.pendingZone.radius, color, weight: 3, fillOpacity: 0.25 }).addTo(S.map);
    $('zoneName').value = '';
    closePanels(); $('zonePanel').hidden = false;
  }
  function saveZone() {
    const z = S.pendingZone; if (!z) return;
    z.name = $('zoneName').value.trim() || 'Área de risco';
    z.id = 'z' + Date.now();
    S.zones.push(z); store.set(K.zones, S.zones);
    cancelZone(); drawZones(); recomputeRisk();
    const n = S.stops.filter(s => s.risk).length;
    toast('Área salva. ' + n + (n === 1 ? ' parada' : ' paradas') + ' em área de risco.');
  }
  function cancelZone() {
    if (S.pendingLayer) S.pendingLayer.remove();
    S.pendingLayer = null; S.pendingZone = null; $('zonePanel').hidden = true;
  }
  function openZones() {
    closePanels();
    const list = $('zonesList');
    list.innerHTML = S.zones.length ? '' : '<p class="empty">Nenhuma área marcada ainda. Use o botão de alerta e toque no mapa.</p>';
    S.zones.forEach(z => {
      const row = document.createElement('div'); row.className = 'zone-item';
      row.innerHTML = '<div><b>' + esc(z.name) + '</b><div class="hint num">raio ' + z.radius + ' m</div></div>';
      const go = document.createElement('button'); go.className = 'btn btn-small'; go.textContent = 'Ver';
      go.onclick = () => { closePanels(); S.map.setView([z.lat, z.lng], 15); };
      const del = document.createElement('button'); del.className = 'btn btn-small'; del.textContent = 'Apagar';
      del.onclick = () => {
        if (del.dataset.confirm) { S.zones = S.zones.filter(x => x.id !== z.id); store.set(K.zones, S.zones); drawZones(); recomputeRisk(); openZones(); }
        else { del.dataset.confirm = '1'; del.textContent = 'Confirmar'; }
      };
      const box = document.createElement('div'); box.style.display = 'flex'; box.style.gap = '6px';
      box.append(go, del); row.appendChild(box); list.appendChild(row);
    });
    $('zonesPanel').hidden = false;
  }
  function exportZones() {
    const blob = new Blob([JSON.stringify({ tipo: 'areas-de-risco', versao: 1, areas: S.zones }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'areas-de-risco.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importZones(file) {
    try {
      const j = JSON.parse(await file.text());
      const arr = (j.areas || j).filter(z => Number.isFinite(z.lat) && Number.isFinite(z.lng) && Number.isFinite(z.radius));
      const ids = new Set(S.zones.map(z => z.lat.toFixed(5) + z.lng.toFixed(5)));
      let added = 0;
      arr.forEach(z => { const k = z.lat.toFixed(5) + z.lng.toFixed(5); if (!ids.has(k)) { S.zones.push({ id: 'z' + Date.now() + added, lat: z.lat, lng: z.lng, radius: z.radius, name: String(z.name || 'Área de risco') }); added++; } });
      store.set(K.zones, S.zones); drawZones(); recomputeRisk(); openZones();
      toast(added + ' áreas importadas.');
    } catch (e) { toast('Esse arquivo não é uma lista de áreas de risco.'); }
  }

  // ---------- Ajuste manual do pino ----------
  function startFix(s) {
    closePanels();
    S.fixStop = s;
    const start = Number.isFinite(s.lat) ? [s.lat, s.lng] : S.map.getCenter();
    S.fixMarker = L.marker(start, { draggable: true, zIndexOffset: 2000,
      icon: L.divIcon({ className: '', html: '<div class="pin manual sel"><span>' + s.order + '</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(S.map);
    const m = S.markers.get(s.id); if (m) m.setOpacity(0.3);
    S.map.setView(start, Math.max(S.map.getZoom(), 17));
    $('fixText').textContent = 'Arraste o pino até a porta de ' + title([s.street, s.number].filter(Boolean).join(', ')) + '. O ajuste fica salvo para as próximas rotas com esse endereço.';
    setSheet('peek');
    $('fixPanel').hidden = false;
  }
  function endFix(save) {
    const s = S.fixStop;
    if (s && save && S.fixMarker) {
      const p = S.fixMarker.getLatLng();
      setLoc(s, p.lat, p.lng, 'manual', 'ajuste');
      S.fix[s.key] = { lat: p.lat, lng: p.lng, t: Date.now() };
      store.set(K.fix, S.fix);
      toast('Local salvo. Da próxima vez esse endereço já aparece certo.');
      saveLast();
    }
    if (S.fixMarker) S.fixMarker.remove();
    const m = s && S.markers.get(s.id); if (m) m.setOpacity(1);
    S.fixMarker = null; S.fixStop = null; $('fixPanel').hidden = true;
    if (s) updateStop(s);
    setSheet('half');
  }

  // ---------- Ordem e navegação ----------
  function optimize() {
    const located = S.stops.filter(s => Number.isFinite(s.lat) && s.conf !== 'fora' && !S.done.has(s.key));
    if (located.length < 3) { toast('Preciso de pelo menos 3 paradas localizadas.'); return; }
    const sorted = located.slice().sort((a, b) => a.order - b.order);
    const before = C.routeLengthKm(sorted.map((_, i) => i), sorted, S.me);
    const ord = C.optimizeOrder(sorted, S.me);
    const after = C.routeLengthKm(ord, sorted, S.me);
    const doneStops = S.stops.filter(s => S.done.has(s.key)).sort((a, b) => a.order - b.order);
    const rest = S.stops.filter(s => !located.includes(s) && !S.done.has(s.key)).sort((a, b) => a.order - b.order);
    let n = 1;
    doneStops.forEach(s => { s.order = n++; });
    ord.forEach(i => { sorted[i].order = n++; });
    rest.forEach(s => { s.order = n++; });
    renderAll();
    const f = x => x.toFixed(1).replace('.', ',');
    toast('Ordem otimizada' + (S.me ? ' a partir de onde você está' : '') + ': ~' + f(after) + ' km em linha reta (antes ~' + f(before) + ' km).', 5000);
    saveLast();
  }

  function openGmaps() {
    const pts = S.stops.filter(s => Number.isFinite(s.lat) && !S.done.has(s.key) && s.conf !== 'fora').sort((a, b) => a.order - b.order);
    if (!pts.length) { toast('Nenhuma parada pendente localizada.'); return; }
    const chunks = [];
    for (let i = 0; i < pts.length; i += 10) chunks.push(pts.slice(i, i + 10));
    const url = ch => {
      const dest = ch[ch.length - 1];
      const wps = ch.slice(0, -1).map(s => s.lat.toFixed(6) + ',' + s.lng.toFixed(6)).join('|');
      return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest.lat.toFixed(6) + ',' + dest.lng.toFixed(6) + (wps ? '&waypoints=' + encodeURIComponent(wps) : '');
    };
    if (chunks.length === 1) { window.open(url(chunks[0]), '_blank', 'noopener'); return; }
    closePanels();
    let p = $('chunksPanel');
    if (!p) { p = document.createElement('div'); p.className = 'panel'; p.id = 'chunksPanel'; $('mapScreen').appendChild(p); }
    p.innerHTML = '<h2>Rota em trechos</h2><p class="hint">O Google Maps aceita até 10 paradas por vez. Abra um trecho, e quando terminar, volte e abra o próximo.</p>' +
      chunks.map((ch, i) => '<a class="btn" target="_blank" rel="noopener" href="' + url(ch) + '">Trecho ' + (i + 1) + ': paradas ' + ch[0].order + ' a ' + ch[ch.length - 1].order + '</a>').join('') +
      '<button class="btn btn-ghost" id="chunksClose">Fechar</button>';
    p.hidden = false;
    $('chunksClose').onclick = () => { p.hidden = true; };
  }

  function locateMe(silent) {
    if (!navigator.geolocation) { if (!silent) toast('Este navegador não informa a localização.'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      S.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
      if (S.meMarker) S.meMarker.setLatLng([S.me.lat, S.me.lng]); else S.meMarker = L.marker([S.me.lat, S.me.lng], { icon, interactive: false }).addTo(S.map);
      if (!silent) S.map.setView([S.me.lat, S.me.lng], 16);
    }, () => { if (!silent) toast('Não consegui sua localização. Libere o GPS para este site.'); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* opcional */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('mapScreen').hidden) keepAwake(); });

  function closePanels() {
    ['zonePanel', 'zonesPanel', 'chunksPanel'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
    if (S.pendingLayer) cancelZone();
  }

  // ---------- Exemplo ----------
  function openExample() {
    const H = ['Corridor Cage', 'Sequence', 'Destination Address', 'City', 'Neighborhood', 'Latitude', 'Longitude'];
    const R = [
      ['H-19', 1, 'Rua Gavião Peixoto, 182, Portão azul', 'Niterói', 'Icaraí', '-22.9047', '-43.1102'],
      ['H-19', 2, 'Rua Moreira César, 229, Apto 801', 'Niterói', 'Icaraí', '-22.9052', '-43.1069'],
      ['H-19', 3, 'Rua Moreira César, 229, Apto 1203', 'Niterói', 'Icaraí', '-22.9052', '-43.1069'],
      ['H-19', 4, 'Rua Otávio Carneiro, 100, Portaria', 'Niterói', 'Icaraí', '-22.9058', '-43.1037'],
      ['H-19', 5, 'Rua Lopes Trovão, 52, Casa 2 fundos', 'Niterói', 'Icaraí', '-22.9083', '-43.1079'],
      ['H-19', 6, 'Avenida Roberto Silveira, 120, Loja 3', 'Niterói', 'Icaraí', '-22.9031', '-43.1054'],
      ['H-19', 7, 'Rua Mariz e Barros, 300, Ao lado da farmácia', 'Niterói', 'Icaraí', '-22.9012', '-43.1066'],
      ['H-19', 8, 'Rua Presidente Backer, 58', 'Niterói', 'Icaraí', '-22.9001', '-43.1088'],
      ['H-19', 9, 'Rua Santa Rosa, 400, Bloco 2', 'Niterói', 'Santa Rosa', '-22.8987', '-43.1006'],
      ['H-19', 10, 'Rua Doutor Paulo César, 150', 'Niterói', 'Santa Rosa', '-22.8979', '-43.1049'],
      ['H-19', 11, 'Rua Tavares de Macedo, 95, Sobrado amarelo', 'Niterói', 'Icaraí', '-22.9017', '-43.1113'],
      ['H-19', 12, 'Rua Miguel de Frias, 77', 'Niterói', 'Icaraí', '-22.9036', '-43.1151'],
      ['H-19', 13, 'Rua da Conceição, 105, Sala 12', 'Niterói', 'Centro', '', ''],
      ['H-19', 14, 'Rua Coronel Moreira César, 40', 'Niterói', 'Icaraí', '', ''],
      ['H-20', 1, 'Rua Visconde de Uruguai, 300', 'Niterói', 'Centro', '-22.8930', '-43.1230']
    ];
    const r = C.buildRoute([['Romaneio de exemplo'], H].concat(R), 'H-19');
    openRoute('H-19', r.stops, r.info, true);
  }

  // ---------- Eventos ----------
  function initMapScreen() {
    $('backBtn').onclick = backToStart;
    $('exampleBanner').onclick = () => { $('exampleBanner').hidden = true; };
    $('fitBtn').onclick = () => { S.userMoved = false; fitAll(false); };
    $('meBtn').onclick = () => locateMe(false);
    $('riskBtn').onclick = () => { closePanels(); setRiskMode(!S.riskMode); };
    $('zonesBtn').onclick = openZones;
    $('zonesClose').onclick = closePanels;
    $('zonesExport').onclick = exportZones;
    $('zonesImport').onchange = e => { if (e.target.files[0]) importZones(e.target.files[0]); e.target.value = ''; };
    $('zoneSave').onclick = saveZone;
    $('zoneCancel').onclick = cancelZone;
    $('zoneRadius').oninput = e => {
      const r = +e.target.value; $('zoneRadiusLabel').textContent = r + ' m';
      if (S.pendingLayer) { S.pendingLayer.setRadius(r); S.pendingZone.radius = r; }
    };
    $('fixSave').onclick = () => endFix(true);
    $('fixCancel').onclick = () => endFix(false);
    $('optBtn').onclick = optimize;
    $('gmapsBtn').onclick = openGmaps;
    $('retryBtn').onclick = async () => {
      if (S.busy) { toast('Ainda estou localizando, espere terminar.'); return; }
      const weak = S.stops.filter(s => ['baixa', 'media', 'fora', 'wait'].includes(s.conf) || !Number.isFinite(s.lat)).slice(0, 40);
      if (!weak.length) { toast('Todas as paradas já estão com local exato ou ajustado.'); return; }
      S.busy = true;
      toast('Conferindo ' + weak.length + ' endereços com uma segunda fonte (cerca de 1 por segundo).', 4000);
      await pool(weak.map(s => s.cep).filter(c => c && !S.cepCache[c]), 6, lookupCep);
      await refine(weak);
      saveCaches(); saveLast(); S.busy = false; updateProgress(0); renderSummary();
    };
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

  // ---------- Início ----------
  initStart();
  initMapScreen();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
