/* Mapa do Romaneio — núcleo do algoritmo (funções puras, sem rede nem DOM).
 * Usado pelo app no navegador e pelos testes em Node. */
(function (root) {
  'use strict';

  // ---------- Texto ----------
  function stripAccents(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function norm(s) {
    return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function normRouteCode(s) {
    return stripAccents(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // ---------- Detecção de colunas ----------
  // Cada campo tem padrões testados contra o cabeçalho normalizado (ordem importa).
  const FIELD_PATTERNS = {
    lat: [/^lat$/, /^latitude/, /\blatitude\b/],
    lng: [/^(lng|lon|long)$/, /^longitude/, /\blongitude\b/],
    address: [/destination address/, /^endereco( de entrega| completo| destino)?$/, /^endereco/, /^logradouro/, /^address/, /^rua$/],
    number: [/^(numero|num|n|no|nro|n o)$/, /^numero/],
    complement: [/^complemento/, /^compl/],
    bairro: [/^bairro/, /neighbo/, /^district/],
    city: [/^cidade/, /^city/, /^municipio/],
    cep: [/^cep/, /zip ?code/, /postal/],
    seq: [/^sequence$/, /^sequencia/, /^seq$/, /^ordem/, /^parada$/, /^stop$/, /^#$/],
    pkg: [/spx tn/, /tracking/, /^rastreio/, /^codigo do pacote/, /^pacote/, /^pedido/, /^tn$/, /^id do pacote/],
    route: [/^rota$/, /^route$/, /corridor cage/, /^gaiola/, /^cluster/, /^corredor/, /cage/, /^codigo da rota/, /^rota /],
    recipient: [/^destinatario/, /^recipient/, /^nome do cliente/, /^cliente$/, /^nome$/]
  };

  function detectColumns(headerRow) {
    const map = {};
    const used = new Set();
    const headers = headerRow.map(norm);
    for (const field of Object.keys(FIELD_PATTERNS)) {
      for (const re of FIELD_PATTERNS[field]) {
        const idx = headers.findIndex((h, i) => h && !used.has(i) && re.test(h));
        if (idx >= 0) { map[field] = idx; used.add(idx); break; }
      }
    }
    return map;
  }

  // Procura nas primeiras linhas a que mais parece um cabeçalho.
  function findHeaderRow(rows) {
    let best = { index: -1, score: 0, map: {} };
    const limit = Math.min(rows.length, 20);
    for (let i = 0; i < limit; i++) {
      const row = rows[i] || [];
      const map = detectColumns(row);
      let score = Object.keys(map).length;
      if (map.address != null) score += 2;
      if (map.lat != null && map.lng != null) score += 2;
      if (score > best.score) best = { index: i, score, map };
    }
    return best.score >= 2 ? best : null;
  }

  // ---------- Números ----------
  function parseNum(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    let s = String(v).trim();
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }
  // Algumas planilhas trazem coordenada sem ponto (ex.: -22905123). Corrige pela faixa do Brasil.
  function fixCoord(n, isLat) {
    if (!Number.isFinite(n) || n === 0) return NaN;
    const max = isLat ? 90 : 180;
    let guard = 0;
    while (Math.abs(n) > max && guard++ < 12) n = n / 10;
    return n;
  }
  function inBrazil(lat, lng) {
    return lat > -34.5 && lat < 6 && lng > -74.5 && lng < -28.5;
  }

  // ---------- Endereço ----------
  const ABBREV = [
    [/\br\.?(?=\s)/g, 'rua'], [/\bav\.?(?=\s)/g, 'avenida'], [/\bavn?\b/g, 'avenida'],
    [/\b(trav|tv)\.?(?=\s)/g, 'travessa'], [/\bestr\.?(?=\s)/g, 'estrada'], [/\best\.?(?=\s)/g, 'estrada'],
    [/\brodv?\.?(?=\s)/g, 'rodovia'], [/\bal\.?(?=\s)/g, 'alameda'], [/\bp(c|ca|ç|ça)\.?(?=\s)/g, 'praca'],
    [/\blgo\.?(?=\s)/g, 'largo'], [/\bvl\.?(?=\s)/g, 'vila'], [/\bjd\.?(?=\s)/g, 'jardim'],
    [/\bdr\.?(?=\s)/g, 'doutor'], [/\bdra\.?(?=\s)/g, 'doutora'], [/\bprof\.?(?=\s)/g, 'professor'],
    [/\bprofa\.?(?=\s)/g, 'professora'], [/\bsen\.?(?=\s)/g, 'senador'], [/\bgen\.?(?=\s)/g, 'general'],
    [/\bcel\.?(?=\s)/g, 'coronel'], [/\bcap\.?(?=\s)/g, 'capitao'], [/\bmal\.?(?=\s)/g, 'marechal'],
    [/\bmaj\.?(?=\s)/g, 'major'], [/\beng\.?(?=\s)/g, 'engenheiro'], [/\bsta\.?(?=\s)/g, 'santa'],
    [/\bsto\.?(?=\s)/g, 'santo'], [/\bpres\.?(?=\s)/g, 'presidente'], [/\bgov\.?(?=\s)/g, 'governador'],
    [/\bdes\.?(?=\s)/g, 'desembargador'], [/\bver\.?(?=\s)/g, 'vereador'], [/\bmin\.?(?=\s)/g, 'ministro'],
    [/\bn\.?\s?s(ra)?\.?(?=\s)/g, 'nossa senhora'], [/\bsao\b/g, 'sao']
  ];
  const STREET_TYPES = ['rua', 'avenida', 'travessa', 'estrada', 'rodovia', 'alameda', 'praca', 'largo',
    'vila', 'beco', 'ladeira', 'via', 'viela', 'servidao', 'caminho', 'passagem', 'parque', 'jardim', 'quadra'];
  // Complementos que atrapalham a busca e são descartados.
  // Só corta quando a palavra vem com código (apto 101, bloco B, casa 2) ou é inequívoca (fundos).
  const COMPLEMENT_RE = /\b((apto?|apt|ap|apartamento|bloco|bl|casa|cs|lote|lt|qd|quadra|sala|sl|loja|lj|andar|torre|box|kitnet|kit)(\s*[a-z]?\d+[a-z]?|\s+[a-z])\b|fundos|terreo|cobertura|sobrado)\b/g;

  function expandAbbrev(s) {
    let out = ' ' + stripAccents(s).toLowerCase() + ' ';
    out = out.replace(/º|°|ª|⁰/g, ' ');
    for (const [re, rep] of ABBREV) out = out.replace(re, rep);
    return out.replace(/\s+/g, ' ').trim();
  }

  const SN_RE = /^(s\s*\/?\s*n[o]?|sem\s*n(umero|o)?|sn)\.?$/;
  const NUM_PART_RE = /^(?:n(?:umero|o|r)?\.?\s*)?(\d{1,5})[a-z]?\b/;

  function finishStreet(street) {
    street = street.replace(COMPLEMENT_RE, ' ')
      .replace(/\(.*?\)/g, ' ')          // "(Dois)"
      .split('/')[0]                     // "Travessa X/ PAC Preventorio/ ..."
      .split(/\s+-\s+/)[0]               // "Rua Dezessete - interfone"
      .replace(/\b(paralela|proximo|perto|esquina|em frente|ao lado|atras|antiga|entrada|acesso)\b.*$/, '')
      .replace(/[,;.]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (SN_RE.test(street)) street = '';
    street = street.replace(/^(\w+) \1\b/, '$1'); // "R Rua X" virou "rua rua x"
    street = street.replace(/(\s+[a-z])+$/, '').trim(); // sobra de "LT 20 E"
    const words = street.split(' ');
    const type = STREET_TYPES.includes(words[0]) ? words[0] : '';
    return { street, streetType: type, streetCore: type ? words.slice(1).join(' ') : street };
  }

  // Formato do romaneio Shopee: "Rua X, 123, referência" (às vezes ", Bairro, Cidade, Estado, CEP").
  // Também aceita "Rua X 123, Ap 510", "Rua X - N.370, ...", "Rua X, S/N, ..." e textos sem vírgula.
  function parseAddress(raw, numberCol, ctx) {
    const original = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    ctx = ctx || {};
    const ignore = new Set([norm(ctx.bairro), norm(ctx.city), 'rio de janeiro', 'rj', 'brasil', 'sao paulo', 'sp', 'minas gerais', 'mg'].filter(Boolean));
    let number = numberCol != null && String(numberCol).trim() !== '' ? String(numberCol).replace(/\D+/g, '') : '';
    let cepInText = '';
    const origParts = original.split(',').map(x => x.trim());
    const parts = origParts.map(x => expandAbbrev(x));

    // tira partes que são só CEP, cidade, estado ou bairro repetido
    const keep = [];
    parts.forEach((p, i) => {
      const c = p.match(/^(\d{5})-?(\d{3})$/);
      if (c) { cepInText = c[1] + c[2]; return; }
      if (i > 0 && ignore.has(norm(p))) return;
      keep.push(i);
    });

    let street = '', numIdx = -1, sn = false;
    if (keep.length) {
      let first = parts[keep[0]].replace(COMPLEMENT_RE, ' ').replace(/\s+/g, ' ').trim();
      // número grudado na rua: "rua marechal deodoro 295" ou "avenida x - n 370"
      const tail = first.match(/^(.*?[a-z].*?)(?:\s*-\s*|\s+)(?:n(?:umero|o)?\.?\s*)?(\d{1,5})$/);
      if (tail && tail[1].trim().split(' ').length >= 2 && !/\bde$/.test(tail[1].trim())) {
        first = tail[1]; if (!number) number = tail[2]; numIdx = 0;
      }
      street = first;
      // procura o número nas próximas partes (pula um bairro no meio: "Rua X, Centro, 86, Apto")
      if (numIdx < 0) {
        for (let k = 1; k < Math.min(keep.length, 3); k++) {
          const p = parts[keep[k]].trim();
          if (SN_RE.test(p)) { sn = true; numIdx = k; break; }
          const m = p.match(NUM_PART_RE);
          if (m) { if (!number) number = m[1]; numIdx = k; break; }
        }
      }
    }

    // Sem vírgula útil: usa a heurística antiga sobre o texto inteiro
    if (keep.length <= 1 && numIdx < 0 && !sn) {
      let s = expandAbbrev(original);
      const cm = s.match(/\b(\d{5})-?(\d{3})\b/);
      if (cm) { cepInText = cm[1] + cm[2]; s = s.replace(cm[0], ' '); }
      s = s.replace(COMPLEMENT_RE, ' ').replace(/\s+/g, ' ').trim();
      const re = /\b(\d{1,5})\b(?!\s+de\b)/g;
      let m, last = null;
      while ((m = re.exec(s))) {
        const before = s.slice(0, m.index).trim();
        if (before && /[a-z]/.test(before) && before.split(' ').length >= 2) last = m;
      }
      if (last) { if (!number) number = last[1]; street = s.slice(0, last.index); }
      else street = s;
    }

    const st = finishStreet(street);
    // referência para o motorista: o que vem depois do número, com a grafia original
    const refFrom = numIdx >= 0 ? numIdx + 1 : 1;
    const ref = keep.slice(refFrom).map(i => origParts[i]).filter(Boolean).join(', ');
    const display = keep.length ? keep.slice(0, Math.max(refFrom, 1)).map(i => origParts[i]).join(', ') : original;

    return Object.assign(st, { original, display, ref, number, sn, bairroHint: '', cepInText });
  }

  const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
    onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
    vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50 };
  // "rua vinte e nove" → "rua 29" (no mapa muitas ruas de loteamento estão com o número)
  function wordsToDigits(s) {
    return norm(s).replace(/\b(vinte|trinta|quarenta|cinquenta)( e (um|dois|tres|quatro|cinco|seis|sete|oito|nove))?\b|\b(um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove)\b/g,
      m => String(m.split(' e ').reduce((a, w) => a + NUM_WORDS[w], 0)));
  }
  function digitsToWords(s) {
    const inv = {}; Object.entries(NUM_WORDS).forEach(([w, n]) => { if (!inv[n]) inv[n] = w; });
    return norm(s).replace(/\b(\d{1,2})\b/g, m => {
      const n = +m; if (inv[n]) return inv[n];
      const t = Math.floor(n / 10) * 10, u = n % 10;
      return inv[t] && inv[u] ? inv[t] + ' e ' + inv[u] : m;
    });
  }

  function cleanCep(v) {
    const d = String(v == null ? '' : v).replace(/\D+/g, '');
    if (d.length === 8) return d;
    if (d.length === 7) return '0' + d; // planilha comeu o zero à esquerda
    return '';
  }

  // Chave estável para cache e para agrupar pacotes do mesmo endereço.
  // "Ponta D Areia", "Ponta DAreia", "Ponta Dareia" e "Ponta da Areia" viram a mesma chave
  function bairroKey(b) {
    return norm(b).replace(/\b(d|da|de|do|das|dos|e)\b/g, ' ').replace(/\s+/g, '').replace(/^(.*)d(?=areia|agua|ouro)/, '$1');
  }

  function addressKey(p) {
    return [norm(p.street), p.number || 's/n', p.cep || bairroKey(p.bairro), norm(p.city)].join('|');
  }

  // ---------- Similaridade ----------
  function jaroWinkler(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
    let m = 0;
    for (let i = 0; i < a.length; i++) {
      const lo = Math.max(0, i - md), hi = Math.min(i + md + 1, b.length);
      for (let j = lo; j < hi; j++) {
        if (bm[j] || a[i] !== b[j]) continue;
        am[i] = bm[j] = true; m++; break;
      }
    }
    if (!m) return 0;
    let t = 0, k = 0;
    for (let i = 0; i < a.length; i++) {
      if (!am[i]) continue;
      while (!bm[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
    const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
    let p = 0;
    while (p < 4 && a[p] === b[p]) p++;
    return jaro + p * 0.1 * (1 - jaro);
  }
  // Compara só o "miolo" do nome da rua (sem Rua/Avenida), e também por palavras.
  function streetSimilarity(a, b) {
    const strip = s => { const w = norm(expandAbbrev(s)).split(' '); return (STREET_TYPES.includes(w[0]) ? w.slice(1) : w).join(' '); };
    const A = strip(a), B = strip(b);
    if (!A || !B) return 0;
    const whole = jaroWinkler(A, B);
    const wa = A.split(' ').filter(w => w.length > 2), wb = new Set(B.split(' ').filter(w => w.length > 2));
    const overlap = wa.length ? wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size) : 0;
    return Math.max(whole, overlap);
  }

  // ---------- Geografia ----------
  function haversineKm(a, b) {
    const R = 6371, toRad = x => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function median(arr) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function centroid(points) {
    return { lat: median(points.map(p => p.lat)), lng: median(points.map(p => p.lng)) };
  }

  // ---------- Pontuação de candidatos do geocodificador ----------
  // query: {streetCore, street, number, cep, bairro, city, anchor:{lat,lng}|null}
  // cand: {lat, lng, street, housenumber, postcode, district, city, type}
  function scoreCandidate(query, cand) {
    const sStreet = streetSimilarity(query.street || query.streetCore, cand.street || cand.name || '');
    let score = 0.62 * sStreet;
    const reasons = [];
    if (query.number && cand.housenumber) {
      const cn = String(cand.housenumber).replace(/\D+/g, '');
      if (cn === query.number) { score += 0.16; reasons.push('número'); }
    }
    const pc = String(cand.postcode || '').replace(/\D+/g, '');
    if (query.cep && pc) {
      if (pc === query.cep) { score += 0.14; reasons.push('CEP'); }
      else if (pc.slice(0, 5) === query.cep.slice(0, 5)) { score += 0.08; reasons.push('CEP parcial'); }
    }
    if (query.bairro && cand.district && jaroWinkler(query.bairro, cand.district) >= 0.88) { score += 0.08; reasons.push('bairro'); }
    if (query.city && cand.city && !/regiao|metropolitana|mesorregiao|microrregiao/.test(norm(cand.city))) {
      if (jaroWinkler(query.city, cand.city) >= 0.88) score += 0.04;
      else score -= 0.25;
    }
    if (query.anchor && Number.isFinite(cand.lat)) {
      const d = haversineKm(query.anchor, cand);
      if (query.tight) { // âncora é o centro do bairro: rua com o mesmo nome em outro bairro perde pontos
        // bairros grandes (Piratininga, Itaipu, Engenho do Mato) passam de 5 km de ponta a ponta
        if (d > 9) score -= 0.3; else if (d > 4.5) score -= 0.06; else score += 0.04;
      } else if (d > 25) score -= 0.35; else if (d > 10) score -= 0.12;
    }
    if (cand.type === 'house' && reasons.includes('número')) score += 0.04;
    return { score: Math.max(0, Math.min(1, score)), sStreet, reasons };
  }
  function confidenceFromScore(s) {
    if (s >= 0.8) return 'alta';
    if (s >= 0.6) return 'media';
    return 'baixa';
  }

  // ---------- Pontos fora da área ----------
  // Marca quem está longe demais da mediana da rota (distância > max(minKm, 4 × desvio mediano)).
  function findOutliers(points, minKm) {
    minKm = minKm || 12;
    const good = points.filter(p => Number.isFinite(p.lat));
    if (good.length < 4) return new Set();
    const c = centroid(good);
    const dists = good.map(p => haversineKm(c, p));
    const mad = median(dists);
    const limit = Math.max(minKm, 4 * mad);
    const out = new Set();
    good.forEach((p, i) => { if (dists[i] > limit) out.add(p.id); });
    return out;
  }

  // ---------- Ordem das paradas ----------
  function routeLengthKm(order, pts, start) {
    let total = 0, prev = start || null;
    for (const i of order) { if (prev) total += haversineKm(prev, pts[i]); prev = pts[i]; }
    return total;
  }
  // Vizinho mais próximo + melhoria 2-opt. Rápido para até ~300 paradas no celular.
  function optimizeOrder(pts, start) {
    const n = pts.length;
    if (n < 3) return pts.map((_, i) => i);
    const left = new Set(pts.map((_, i) => i));
    const order = [];
    let cur = start;
    if (!cur) { order.push(0); left.delete(0); cur = pts[0]; }
    while (left.size) {
      let best = -1, bd = Infinity;
      for (const i of left) { const d = haversineKm(cur, pts[i]); if (d < bd) { bd = d; best = i; } }
      order.push(best); left.delete(best); cur = pts[best];
    }
    const D = (a, b) => haversineKm(a, b);
    const P = i => (i < 0 ? start : pts[order[i]]);
    let improved = true, rounds = 0;
    const deadline = Date.now() + 600;
    while (improved && rounds++ < 40 && Date.now() < deadline) {
      improved = false;
      for (let i = start ? 0 : 1; i < n - 1; i++) {
        const a = P(i - 1); if (!a) continue;
        const b = P(i);
        for (let k = i + 1; k < n; k++) {
          const c = P(k), d = k + 1 < n ? P(k + 1) : null;
          const before = D(a, b) + (d ? D(c, d) : 0);
          const after = D(a, c) + (d ? D(b, d) : 0);
          if (after + 1e-9 < before) {
            const seg = order.slice(i, k + 1).reverse();
            order.splice(i, seg.length, ...seg);
            improved = true;
            break;
          }
        }
      }
    }
    return order;
  }

  // ---------- Montagem da rota a partir da planilha ----------
  function cell(row, idx) { return idx == null ? '' : (row[idx] == null ? '' : row[idx]); }

  // "Neves (Neves)" → "Neves"
  function cleanBairro(b) {
    const t = String(b || '').trim();
    const m = t.match(/^(.*?)\s*\((.*?)\)\s*$/);
    return m ? (m[1] || m[2]).trim() : t;
  }

  function routeCounts(data, idx) {
    const m = new Map();
    data.forEach(r => { const c = String(cell(r, idx)).trim(); if (c) m.set(c, (m.get(c) || 0) + 1); });
    const nat = c => { const x = c.match(/^([A-Za-z]*)\W*(\d*)/); return [x[1].toUpperCase(), +x[2] || 0]; };
    return Array.from(m, ([code, n]) => ({ code, n })).sort((a, b) => {
      const A = nat(a.code), B = nat(b.code);
      return A[0] < B[0] ? -1 : A[0] > B[0] ? 1 : A[1] - B[1];
    });
  }

  // Lê só o cabeçalho e as rotas existentes (para sugerir na tela inicial).
  function listRoutes(rows) {
    const header = findHeaderRow(rows);
    if (!header) return null;
    const data = rows.slice(header.index + 1);
    return { header, routes: header.map.route != null ? routeCounts(data, header.map.route) : [], total: data.filter(r => r && r.some(c => String(c == null ? '' : c).trim() !== '')).length };
  }

  // rows: matriz de células (todas as abas já concatenadas ou a aba escolhida)
  // Retorna {stops, info} com paradas agrupadas por endereço.
  function buildRoute(rows, routeCode) {
    const header = findHeaderRow(rows);
    if (!header) return { error: 'Não encontrei o cabeçalho da planilha (colunas como Endereço, Bairro, CEP).' };
    const map = header.map;
    let data = rows.slice(header.index + 1).filter(r => r && r.some(c => String(c == null ? '' : c).trim() !== ''));
    const code = normRouteCode(routeCode);
    let routeNote = '';

    if (code) {
      if (map.route != null) {
        const filtered = data.filter(r => normRouteCode(cell(r, map.route)) === code);
        if (!filtered.length) {
          const codes = routeCounts(data, map.route).map(x => x.code);
          const near = codes.filter(c => c[0] === String(routeCode).trim().toUpperCase()[0]).slice(0, 6);
          return { error: 'A rota ' + routeCode + ' não está nesta planilha.' + (near.length ? ' Parecidas: ' + near.join(', ') + '.' : ''), routes: codes };
        }
        data = filtered; routeNote = 'Rota ' + routeCode;
      } else {
        // procura a rota em qualquer célula da linha
        const filtered = data.filter(r => r.some(c => normRouteCode(c) === code));
        if (filtered.length && filtered.length < data.length) { data = filtered; routeNote = 'Filtrado pelas linhas que citam ' + routeCode; }
        else routeNote = 'Planilha tratada como a rota ' + routeCode;
      }
    } else if (map.route != null) {
      const codes = routeCounts(data, map.route);
      if (codes.length > 1) return { error: 'Esta planilha tem ' + codes.length + ' rotas. Digite a sua (ex.: ' + codes[0].code + ').', routes: codes.map(x => x.code) };
    }

    const groups = new Map();
    data.forEach((r, i) => {
      const addrRaw = cell(r, map.address);
      if (!String(addrRaw).trim() && map.lat == null) return;
      const bairroRaw = String(cell(r, map.bairro)).trim();
      const city = String(cell(r, map.city)).trim();
      const parsed = parseAddress(addrRaw, cell(r, map.number), { bairro: bairroRaw, city });
      const cep = cleanCep(cell(r, map.cep)) || parsed.cepInText;
      const bairro = cleanBairro(bairroRaw);
      let lat = fixCoord(parseNum(cell(r, map.lat)), true);
      let lng = fixCoord(parseNum(cell(r, map.lng)), false);
      if (!(Number.isFinite(lat) && Number.isFinite(lng) && inBrazil(lat, lng))) { lat = NaN; lng = NaN; }
      const seqRaw = parseNum(cell(r, map.seq));
      const stop = {
        street: parsed.street, streetCore: parsed.streetCore, streetType: parsed.streetType,
        number: parsed.number, cep, bairro, city, original: parsed.display || parsed.original
      };
      const key = addressKey(stop);
      const pkg = String(cell(r, map.pkg)).trim();
      const recipient = String(cell(r, map.recipient)).trim();
      const complement = [String(cell(r, map.complement)).trim(), parsed.ref].filter(Boolean).join(' · ');
      if (!groups.has(key)) {
        groups.set(key, Object.assign(stop, {
          id: 's' + groups.size, key, row: i, seq: Number.isFinite(seqRaw) ? seqRaw : null,
          sheetLat: lat, sheetLng: lng, packages: [], seqs: [], recipients: [], complements: []
        }));
      }
      const g = groups.get(key);
      g.packages.push(pkg || (Number.isFinite(seqRaw) ? 'seq ' + seqRaw : '#' + (i + 1)));
      if (Number.isFinite(seqRaw)) g.seqs.push(seqRaw);
      if (recipient && !g.recipients.includes(recipient)) g.recipients.push(recipient);
      if (complement && !g.complements.includes(complement)) g.complements.push(complement);
      if (Number.isFinite(seqRaw) && (g.seq == null || seqRaw < g.seq)) g.seq = seqRaw;
      if (!Number.isFinite(g.sheetLat) && Number.isFinite(lat)) { g.sheetLat = lat; g.sheetLng = lng; }
    });

    let stops = Array.from(groups.values());
    if (stops.some(s => s.seq != null)) stops.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || a.row - b.row);
    stops.forEach((s, i) => { s.order = i + 1; });
    return {
      stops,
      info: {
        columns: map, headerRow: header.index, rows: data.length, routeNote,
        hasCoords: stops.some(s => Number.isFinite(s.sheetLat))
      }
    };
  }

  // ---------- Malha de ruas (OpenStreetMap) e numeração ----------
  // No Brasil o número da casa costuma ser a distância em metros desde o início da rua.
  // Então, com a geometria da rua, dá para colocar o 469 a ~469 m do começo dela.
  const keyPt = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);
  function segKm(a, b) { return haversineKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }); }

  function makeChain(name, pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + segKm(pts[i - 1], pts[i]) * 1000);
    return { name, pts, cum, len: cum[cum.length - 1] };
  }

  // ways: [{id, n: nome, g: [[lat,lng],...]}] → trechos contínuos por nome
  function buildChains(ways, gapKm) {
    const byName = new Map();
    for (const w of ways) {
      if (!w.n || !w.g || w.g.length < 2) continue;
      const k = norm(expandAbbrev(w.n));
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(w);
    }
    const chains = [];
    for (const list of byName.values()) {
      const name = list[0].n;
      const adj = new Map();
      list.forEach((w, i) => {
        for (const end of [0, 1]) {
          const k = keyPt(end ? w.g[w.g.length - 1] : w.g[0]);
          if (!adj.has(k)) adj.set(k, []);
          adj.get(k).push(i);
        }
      });
      const used = new Set();
      const pieces = []; // {pts, subs}
      while (used.size < list.length) {
        // começa por uma ponta (nó com um trecho só) ainda livre
        let startNode = null;
        for (const [k, ids] of adj) { const free = ids.filter(i => !used.has(i)); if (free.length === 1) { startNode = k; break; } }
        if (!startNode) { const i = list.findIndex((_, j) => !used.has(j)); startNode = keyPt(list[i].g[0]); }
        let node = startNode, pts = null;
        const subs = new Set();
        for (;;) {
          const next = (adj.get(node) || []).find(i => !used.has(i));
          if (next == null) break;
          used.add(next);
          if (list[next].sub) subs.add(list[next].sub);
          const g = list[next].g;
          const forward = keyPt(g[0]) === node;
          const seg = forward ? g : g.slice().reverse();
          pts = pts ? pts.concat(seg.slice(1)) : seg.slice();
          node = keyPt(seg[seg.length - 1]);
        }
        if (pts && pts.length > 1) pieces.push({ pts, subs });
      }
      // junta pedaços do mesmo nome com buraco de até 250 m (praça, canteiro, trecho que o mapa não trouxe),
      // sempre pelo par de pontas mais próximo
      for (;;) {
        let best = null;
        for (let i = 0; i < pieces.length; i++) {
          for (let j = i + 1; j < pieces.length; j++) {
            const a = pieces[i].pts, b = pieces[j].pts;
            const opts = [[a[a.length - 1], b[0], () => a.concat(b)], [a[a.length - 1], b[b.length - 1], () => a.concat(b.slice().reverse())],
              [a[0], b[b.length - 1], () => b.concat(a)], [a[0], b[0], () => b.slice().reverse().concat(a)]];
            for (const [p, q, join] of opts) {
              const d = segKm(p, q);
              if (d < (gapKm || 0.25) && (!best || d < best.d)) best = { d, i, j, join };
            }
          }
        }
        if (!best) break;
        const subs = new Set([...pieces[best.i].subs, ...pieces[best.j].subs]);
        pieces[best.i] = { pts: best.join(), subs };
        pieces.splice(best.j, 1);
      }
      pieces.forEach(pc => { const c = makeChain(name, pc.pts); c.subs = Array.from(pc.subs); chains.push(c); });
    }
    return chains;
  }

  // Ponto a "m" metros do início (ou do fim), afastado 7 m para o lado do número (ímpar/par)
  function positionOnChain(chain, meters, fromEnd, number) {
    let m = Math.max(0, Math.min(chain.len, fromEnd ? chain.len - meters : meters));
    const { pts, cum } = chain;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < m) i++;
    const a = pts[i - 1], b = pts[i];
    const segLen = cum[i] - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (m - cum[i - 1]) / segLen));
    let lat = a[0] + (b[0] - a[0]) * f, lng = a[1] + (b[1] - a[1]) * f;
    if (number) {
      const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
      let dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky;
      if (fromEnd) { dx = -dx; dy = -dy; }
      const L = Math.hypot(dx, dy) || 1;
      const side = (+number % 2 === 1) ? 1 : -1; // ímpar à esquerda de quem anda no sentido da numeração
      const off = 7 * side;
      lat += (dx / L) * off / ky;
      lng += (-dy / L) * off / kx;
    }
    return { lat, lng };
  }

  function nearestOnChainKm(chain, p) {
    let best = Infinity;
    for (const q of chain.pts) { const d = haversineKm(p, { lat: q[0], lng: q[1] }); if (d < best) best = d; }
    return best;
  }

  // Candidatos de local para uma parada a partir da malha de ruas da região.
  // ctx: {bairroCenter, downtown}
  function streetCandidates(stop, chains, ctx) {
    const out = [];
    if (!stop.street) return out;
    const sType = STREET_TYPES.includes(norm(stop.street).split(' ')[0]) ? norm(stop.street).split(' ')[0] : '';
    for (const c of chains) {
      const sim = streetSimilarity(stop.street, c.name);
      if (sim < 0.88) continue;
      const cn = norm(expandAbbrev(c.name)).split(' ');
      const cType = STREET_TYPES.includes(cn[0]) ? cn[0] : '';
      const typePenalty = sType && cType && sType !== cType ? 0.2 : 0;
      const num = stop.number ? +stop.number : null;
      // sentido da numeração: começa na ponta mais perto do centro da cidade (com dúvida, testa os dois)
      const p0 = { lat: c.pts[0][0], lng: c.pts[0][1] }, p1 = { lat: c.pts[c.pts.length - 1][0], lng: c.pts[c.pts.length - 1][1] };
      const startIsFirst = ctx.downtown ? haversineKm(ctx.downtown, p0) <= haversineKm(ctx.downtown, p1) : true;
      const dirs = num ? [false, true] : [false];
      for (const fromEnd of dirs) {
        const pos = num ? positionOnChain(c, num, fromEnd, stop.number) : positionOnChain(c, c.len / 2, false, null);
        let score = sim - typePenalty;
        if (ctx.bairroCenter) {
          const d = Math.min(haversineKm(ctx.bairroCenter, pos), nearestOnChainKm(c, ctx.bairroCenter) + 0.5);
          // o bairro do romaneio é o sinal mais forte que temos sem CEP
          score += d <= 1.5 ? 0.06 : d <= 3 ? -0.1 : d <= 6 ? -0.4 : -0.7;
        }
        const inRange = num ? num <= c.len * 1.15 + 20 : false;
        if (num) score += inRange ? 0.03 : -0.15; else score -= 0.12;
        const natural = (fromEnd ? !startIsFirst : startIsFirst);
        if (num && !natural) score -= 0.06;
        score = Math.max(0.02, Math.min(1.15, score));
        out.push({ lat: pos.lat, lng: pos.lng, score, src: 'rua', inRange, street: c.name });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  // Candidatos para uma parada usando os trechos de rua devolvidos pelo Nominatim.
  // Cada trecho sabe em que bairro está, então "mesma rua em outro bairro" perde pontos direto.
  function nominatimCandidates(stop, chains, ctx) {
    const out = [];
    const bk = bairroKey(stop.bairro);
    const num = stop.number ? +stop.number : null;
    for (const c of chains) {
      const sim = Math.max(streetSimilarity(stop.street, c.name), streetSimilarity(wordsToDigits(stop.street), c.name));
      if (sim < 0.8) continue;
      let score = 0.55 + 0.4 * sim; // a rua já veio filtrada pela cidade
      const subs = (c.subs || []).map(bairroKey);
      if (bk && subs.length) score += subs.includes(bk) || subs.some(x => x && (x.includes(bk) || bk.includes(x))) ? 0.12 : -0.15;
      const p0 = { lat: c.pts[0][0], lng: c.pts[0][1] }, p1 = { lat: c.pts[c.pts.length - 1][0], lng: c.pts[c.pts.length - 1][1] };
      const startIsFirst = ctx && ctx.downtown ? haversineKm(ctx.downtown, p0) <= haversineKm(ctx.downtown, p1) : true;
      if (num) {
        const inRange = num <= c.len * 1.15 + 20;
        for (const fromEnd of [false, true]) {
          const pos = positionOnChain(c, num, fromEnd, stop.number);
          const natural = fromEnd ? !startIsFirst : startIsFirst;
          let sc = score + (inRange ? 0.03 : -0.15) - (natural ? 0 : 0.05);
          out.push({ lat: pos.lat, lng: pos.lng, score: Math.max(0.02, Math.min(1.15, sc)), src: 'rua', inRange, street: c.name });
        }
      } else {
        const pos = positionOnChain(c, c.len / 2, false, null);
        out.push({ lat: pos.lat, lng: pos.lng, score: Math.max(0.02, score - 0.15), src: 'rua', inRange: false, street: c.name });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  // Viterbi: escolhe, para cada parada, o candidato que equilibra "texto bate" com
  // "fica perto da parada anterior e da próxima" (a rota da Shopee anda em sequência).
  // cands[t] = [{lat, lng, score}] na ordem da rota. Devolve o índice escolhido em cada t.
  function viterbi(cands, lambda) {
    lambda = lambda == null ? 0.3 : lambda;
    const n = cands.length;
    if (!n) return [];
    const em = c => Math.log(Math.max(0.01, c.score));
    let prev = cands[0].map(em);
    const back = [];
    for (let t = 1; t < n; t++) {
      const cur = [], bp = [];
      for (const c of cands[t]) {
        let best = -Infinity, bi = 0;
        for (let j = 0; j < cands[t - 1].length; j++) {
          const v = prev[j] - lambda * Math.min(haversineKm(cands[t - 1][j], c), 4);
          if (v > best) { best = v; bi = j; }
        }
        cur.push(best + em(c)); bp.push(bi);
      }
      prev = cur; back.push(bp);
    }
    const pick = new Array(n);
    let bi = 0;
    prev.forEach((v, i) => { if (v > prev[bi]) bi = i; });
    pick[n - 1] = bi;
    for (let t = n - 1; t > 0; t--) { bi = back[t - 1][bi]; pick[t - 1] = bi; }
    return pick;
  }

  function pointInCircle(p, zone) {
    return haversineKm(p, zone) * 1000 <= zone.radius;
  }

  const api = {
    stripAccents, norm, normRouteCode, detectColumns, findHeaderRow, parseNum, fixCoord, inBrazil,
    expandAbbrev, parseAddress, cleanCep, addressKey, jaroWinkler, streetSimilarity, haversineKm,
    centroid, median, scoreCandidate, confidenceFromScore, findOutliers, optimizeOrder, routeLengthKm,
    buildRoute, pointInCircle, listRoutes, cleanBairro, buildChains, positionOnChain, streetCandidates, viterbi, bairroKey, nominatimCandidates, wordsToDigits, digitsToWords
  };
  root.RomCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
