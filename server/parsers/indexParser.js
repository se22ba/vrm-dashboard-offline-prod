import fs from 'fs';
import * as cheerio from 'cheerio';

/**
 * FIX de mojibake: UTF-8 interpretado como Latin-1 (Ej.: "lÃ­nea" → "línea").
 * Aplicamos esto al HTML decodificado antes de cualquier parseo.
 */
function fixMojibake(s) {
  if (!s) return s;
  return String(s)
    // minúsculas
    .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã±/g, 'ñ')
    .replace(/Ã¼/g, 'ü')
    // mayúsculas
    .replace(/Ã/g, 'Á').replace(/Ã‰/g, 'É').replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó').replace(/Ãš/g, 'Ú').replace(/Ã‘/g, 'Ñ')
    .replace(/Ãœ/g, 'Ü')
    // guiones y misceláneos que suelen colarse
    .replace(/Â¿/g, '¿').replace(/Â¡/g, '¡').replace(/Â/g, '');
}

/**
 * Parseador robusto del index (MHTML):
 * 1) Busca la tabla de "Devices/Dispositivos".
 * 2) Busca filas label/value en TODO el DOM (versión precisa).
 * 3) Busca sección “Devices/Dispositivos”.
 * 4) Fallback a texto plano.
 * También intenta per-VRM si existiera algo en el index.
 */
export async function parseIndexMhtml(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf-8');

  const boundary = getBoundary(raw) || guessBoundary(raw);
  if (!boundary) {
    return { totals: emptyTotals(), perVrm: {}, debug: { reason: 'no-boundary' } };
  }

  const parts = splitParts(raw, boundary);
  const htmlParts = parts
    .filter(p => /content-type:\s*text\/html/i.test(p.headers))
    .map(p => decodeBody(p.body, getCTE(p.headers), getCharset(p.headers)));

  // Usamos el mayor HTML y aplicamos FIX de mojibake ANTES de parsear
  let html = fixMojibake(
    (htmlParts.sort((a, b) => b.length - a.length)[0] || '')
      .replace(/&#92;|%5C/gi, '\\')
      .replace(/\u00A0/g, ' ')
  );

  try {
    await fs.promises.writeFile(
      filePath.replace(/\.mhtml?$/i, '.decoded.html'),
      html,
      'utf-8'
    );
  } catch {}

  // 1) tabla Devices/Dispositivos
  const gTable = readGlobalsFromDevicesTable(html);
  if (someValue(gTable)) {
    return { totals: gTable, perVrm: tryPerVrm(html), debug: { source: 'devices-table', globalsFound: gTable } };
  }

  // 2) búsqueda ANYWHERE en TODO el DOM (precisa: sólo hermanos inmediatos)
  const gAny = readGlobalsAnywhere(html);
  if (someValue(gAny)) {
    return { totals: gAny, perVrm: tryPerVrm(html), debug: { source: 'anywhere', globalsFound: gAny } };
  }

  // 3) sección alrededor de “Devices/Dispositivos”
  const gSection = readGlobalsFromSection(sliceAround(html, /(>|\b)(Devices|Dispositivos)\b/i, 4000, 20000));
  if (someValue(gSection)) {
    return { totals: gSection, perVrm: tryPerVrm(html), debug: { source: 'devices-section', globalsFound: gSection } };
  }

  // 4) texto plano (aplicamos fix también al plano)
  const gPlain = readGlobalsFromPlain(stripTags(html));
  return { totals: gPlain, perVrm: tryPerVrm(html), debug: { source: 'plain-fallback', globalsFound: gPlain } };
}

/* ────────── 1) TABLA DEVICES ────────── */
function readGlobalsFromDevicesTable(html) {
  const $ = cheerio.load(html);

  const normalize = (s) => fixMojibake(s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  // Mapeo multi-idioma + tolerante a mojibake (ya corregido por fix)
  const labelsMap = {
    // total
    'total channels': 'totalChannels',
    'total de canales': 'totalChannels',
    'canales totales': 'totalChannels',
    'canais totais': 'totalChannels',
    // offline
    'offline channels': 'offlineChannels',
    'canales offline': 'offlineChannels',
    'canales fuera de linea': 'offlineChannels',  // "línea" ya normaliza a "linea"
    'canais offline': 'offlineChannels',
    // active
    'active recordings': 'activeRecordings',
    'grabaciones activas': 'activeRecordings',
    'gravacoes ativas': 'activeRecordings',
    'gravações ativas': 'activeRecordings',
    // idle
    'idle': 'idle',
    'inactivo': 'idle',
    'inactivos': 'idle',
    // signal loss
    'signal loss': 'signalLoss',
    'perdida de senal': 'signalLoss', // "señal" → "senal" tras NFD
    'perda de sinal': 'signalLoss'
  };

  let best = { score: 0, values: {} };

  $('table').each((_, tbl) => {
    const values = {};
    let score = 0;

    $(tbl).find('tr').each((__, tr) => {
      const tds = $(tr).find('td,th');
      if (tds.length < 2) return;

      const leftText = normalize($(tds[0]).text());
      const rightText = fixMojibake($(tds[tds.length - 1]).text());
      const num = toInt(rightText);

      for (const k of Object.keys(labelsMap)) {
        if (leftText.includes(k)) {
          const field = labelsMap[k];
          values[field] = num;
          score++;
          break;
        }
      }
    });

    if (score > best.score) best = { score, values };
  });

  if (best.score >= 3) {
    return {
      totalChannels: valuesOrZero(best.values, 'totalChannels'),
      offlineChannels: valuesOrZero(best.values, 'offlineChannels'),
      activeRecordings: valuesOrZero(best.values, 'activeRecordings'),
      idle: valuesOrZero(best.values, 'idle'),
      signalLoss: valuesOrZero(best.values, 'signalLoss')
    };
  }
  return emptyTotals();
}

/* ────────── 2) ANYWHERE (preciso) ────────── */
function readGlobalsAnywhere(html) {
  const $ = cheerio.load(html);

  const norm = (s) => fixMojibake(s || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  const map = [
    // Total
    { re: /(total channels|total de canales|canales totales|canais totais)/i, key: 'totalChannels' },
    // Offline
    { re: /(offline channels|canales offline|canales fuera de linea|canais offline)/i, key: 'offlineChannels' },
    // Active
    { re: /(active recordings|grabaciones activas|grava(?:coes|ções) ativas)/i, key: 'activeRecordings' },
    // Idle
    { re: /\b(idle|inactivo(?:s)?)\b/i, key: 'idle' },
    // Signal loss
    { re: /(signal loss|perdida de senal|perda de sinal)/i, key: 'signalLoss' }
  ];

  const out = { totalChannels: 0, offlineChannels: 0, activeRecordings: 0, idle: 0, signalLoss: 0 };

  // 2.1) pares label/value como hermanos
  $('.label, .leftLabel, .rightLabel').each((_, lab) => {
    const txt = norm($(lab).text());
    const hit = map.find(m => m.re.test(txt));
    if (!hit) return;

    let node = $(lab).nextAll('.value').first();

    if (!node.length) {
      const td = $(lab).closest('td,th');
      if (td.length) {
        const row = td.closest('tr');
        const cells = row.children('td,th');
        let idx = -1; cells.each((i, c) => { if ($(c).is(td)) idx = i; });
        if (idx >= 0 && idx + 1 < cells.length) node = $(cells[idx + 1]);
      }
    }

    const n = toInt(node.find('strong,b').first().text()) || toInt(node.text());
    if (n) out[hit.key] = n;
  });

  // 2.2) por si quedó algo fuera
  if (!someValue(out)) {
    $('table').each((_, tbl) => {
      $(tbl).find('tr').each((__, tr) => {
        const tds = $(tr).find('td,th');
        if (tds.length < 2) return;
        const left = norm($(tds[0]).text());
        const m = map.find(mm => mm.re.test(left));
        if (!m) return;
        const n = toInt($(tds[1]).find('strong,b').first().text()) || toInt($(tds[1]).text());
        if (n) out[m.key] = n;
      });
    });
  }

  return out;
}

/* ────────── 3) SECCIÓN DEVICES ────────── */
function readGlobalsFromSection(sectionHtml) {
  if (!sectionHtml) return emptyTotals();

  const read = (labels) => {
    const rx1 = new RegExp(`${labels}[\\s\\S]{0,1000}?<span[^>]*class=["'][^"']*\\bvalue\\b[^"']*["'][^>]*>[\\s\\S]{0,200}?<strong[^>]*>([\\d.,]+)`, 'i');
    let r = rx1.exec(sectionHtml);
    if (r) return toInt(r[1]);

    const rx2 = new RegExp(`${labels}[\\s\\S]{0,400}?>\\s*([\\d.,]+)\\s*<`, 'i');
    r = rx2.exec(sectionHtml);
    if (r) return toInt(r[1]);

    const rx3 = new RegExp(`${labels}[\\s\\S]{0,200}?(\\d[\\d.,]*)`, 'i');
    r = rx3.exec(stripTags(sectionHtml));
    if (r) return toInt(r[1]);

    return 0;
  };

  const L = {
    total:   '(Total\\s*channels|Total\\s*de\\s*canales|Canales\\s*totales|Canais\\s*totais)',
    offline: '(Offline\\s*channels|Canales\\s*offline|Canales\\s*fuera\\s*de\\s*linea|Canais\\s*offline)',
    active:  '(Active\\s*recordings|Grabaciones\\s*activas|Grava(?:ções|coes)\\s*ativas)',
    idle:    '(\\bIdle\\b|Inactivo(?:s)?)',
    signal:  '(Signal\\s*loss|Perdida\\s*de\\s*senal|Perda\\s*de\\s*sinal)'
  };

  return {
    totalChannels:    read(L.total),
    offlineChannels:  read(L.offline),
    activeRecordings: read(L.active),
    idle:             read(L.idle),
    signalLoss:       read(L.signal)
  };
}

/* ────────── 4) TEXTO PLANO ────────── */
function readGlobalsFromPlain(text) {
  const t = fixMojibake(text);
  const read = (labels) => {
    const rx = new RegExp(`${labels}\\s*[:\\-]?\\s*(\\d[\\d.,]*)`, 'i');
    const m = rx.exec(t);
    return m ? toInt(m[1]) : 0;
  };

  const L = {
    total:   '(Total\\s*channels|Total\\s*de\\s*canales|Canales\\s*totales|Canais\\s*totais)',
    offline: '(Offline\\s*channels|Canales\\s*offline|Canales\\s*fuera\\s*de\\s*linea|Canais\\s*offline)',
    active:  '(Active\\s*recordings|Grabaciones\\s*activas|Grava(?:ções|coes)\\s*ativas)',
    idle:    '(\\bIdle\\b|Inactivo(?:s)?)',
    signal:  '(Signal\\s*loss|Perdida\\s*de\\s*senal|Perda\\s*de\\s*sinal)'
  };

  return {
    totalChannels:    read(L.total),
    offlineChannels:  read(L.offline),
    activeRecordings: read(L.active),
    idle:             read(L.idle),
    signalLoss:       read(L.signal)
  };
}

/* ────────── per-VRM helpers (suaves) ────────── */
function tryPerVrm(html) {
  let per = extractPerVrmByAnchors(html);
  if (!Object.keys(per).length) per = extractPerVrmByDom(html);
  return per;
}

function extractPerVrmByAnchors(html) {
  const fixed = fixMojibake(html);
  const perVrm = {};
  const ipBackslash = /(\b\d{1,3}(?:\.\d{1,3}){3})\\(\d+)\b/g;
  let m;
  while ((m = ipBackslash.exec(fixed)) !== null) {
    const key = `${m[1]}\\${m[2]}`;
    const slice = fixed.slice(Math.max(0, m.index), m.index + 20000);
    perVrm[key] = {
      totalChannels:    pickIntNear(slice, /(Total\s*channels|Total\s*de\s*canales|Canales\s*totales|Canais\s*totais)/i),
      offlineChannels:  pickIntNear(slice, /(Offline\s*channels|Canales\s*offline|Canales\s*fuera\s*de\s*linea|Canais\s*offline)/i),
      activeRecordings: pickIntNear(slice, /(Active\s*recordings|Grabaciones\s*activas|Grava(?:ções|coes)\s*ativas)/i),
      idle:             pickIntNear(slice, /\b(Idle|Inactivo(?:s)?)\b/i),
      signalLoss:       pickIntNear(slice, /(Signal\s*loss|Perdida\s*de\s*senal|Perda\s*de\s*sinal)/i),
    };
  }
  for (const k of Object.keys(perVrm)) {
    const v = perVrm[k];
    if (!(v.totalChannels || v.offlineChannels || v.activeRecordings || v.idle || v.signalLoss)) delete perVrm[k];
  }
  return perVrm;
}

function pickIntNear(scope, labelRe) {
  const idx = scope.search(labelRe);
  if (idx === -1) return 0;
  const window = scope.slice(idx, idx + 4000);
  const mStrong = /<strong[^>]*>(\d[\d.,]*)/i.exec(window);
  if (mStrong) return toInt(mStrong[1]);
  const mAny = /(\d[\d.,]*)/.exec(window);
  return mAny ? toInt(mAny[1]) : 0;
}

function extractPerVrmByDom(html) {
  const fixed = fixMojibake(html);
  const $ = cheerio.load(fixed);
  const perVrm = {};
  const RX = {
    vrmKey: /^(?:VRM\s+)?(\d{1,3}(?:\.\d{1,3}){3}\\\d)\b/i,
    total: /Total\s*channels|Total\s*de\s*canales|Canales\s*totales|Canais\s*totais/i,
    offline: /Offline\s*channels|Canales\s*offline|Canales\s*fuera\s*de\s*linea|Canais\s*offline/i,
    active: /Active\s*recordings|Grabaciones\s*activas|Grava(ções|coes)\s*ativas/i,
    idle: /\bIdle\b|Inactivo(s)?/i,
    signal: /Signal\s*loss|Perdida\s*de\s*senal|Perda\s*de\s*sinal/i,
  };
  let current = null;
  $('h1,h2,h3,h4,h5,th,td,span,div,p,li').each((_, el) => {
    const text = $(el).text().trim(); if (!text) return;
    const mk = text.match(RX.vrmKey);
    if (mk) { current = mk[1]; if (!perVrm[current]) perVrm[current] = freshMetrics(); return; }
    if (!current) return;
    const val = numberFromSiblings($, el);
    if (val == null) return;
    if (RX.total.test(text)) perVrm[current].totalChannels = val;
    else if (RX.offline.test(text)) perVrm[current].offlineChannels = val;
    else if (RX.active.test(text)) perVrm[current].activeRecordings = val;
    else if (RX.idle.test(text)) perVrm[current].idle = val;
    else if (RX.signal.test(text)) perVrm[current].signalLoss = val;
  });
  for (const k of Object.keys(perVrm)) {
    const v = perVrm[k];
    if (!(v.totalChannels || v.offlineChannels || v.activeRecordings || v.idle || v.signalLoss)) delete perVrm[k];
  }
  return perVrm;
}

function numberFromSiblings($, el) {
  const next = $(el).next();
  const n1 = asInt(next.find('strong,b').first().text()) ?? asInt(next.text());
  if (n1 != null) return n1;

  const cell = $(el).closest('td,th');
  const row  = $(el).closest('tr');
  if (row.length) {
    const cells = row.children('td,th');
    let idx = -1; cells.each((i,c)=>{ if ($(c).is(cell)) idx=i; });
    if (idx >= 0 && idx + 1 < cells.length) {
      const n2 = asInt($(cells[idx+1]).text());
      if (n2 != null) return n2;
    }
  }

  const within = $(el).parent().find('.value').first();
  const n3 = asInt(within.find('strong,b').first().text()) ?? asInt(within.text());
  if (n3 != null) return n3;

  const self = $(el).clone().children().remove().end().text();
  const m = /(\d[\d.,]*)/.exec(self);
  if (m) return toInt(m[1]);

  const child = $(el).children().filter((_, c) => /\d/.test($(c).text())).first();
  return asInt(child.text());
}

/* ────────── MIME & utils ────────── */
function valuesOrZero(obj, key) { return Number(obj?.[key] || 0); }
function someValue(g) { return !!(g.totalChannels || g.offlineChannels || g.activeRecordings || g.idle || g.signalLoss); }
function sliceAround(html, re, before = 4000, after = 20000) {
  const m = re.exec(html); if (!m) return '';
  const i = m.index; return html.slice(Math.max(0, i - before), Math.min(html.length, i + after));
}

function getBoundary(text) {
  const m = /content-type:\s*multipart\/[\w-]+;\s*boundary="?([^"\r\n;]+)"?/i.exec(text);
  return m ? m[1] : null;
}
function guessBoundary(text) {
  const m = /(\r?\n)--([-\w.=_]+)\r?\n/i.exec(text);
  return m ? m[2] : null;
}
function splitParts(text, boundary) {
  const sep = `--${boundary}`, end = `--${boundary}--`;
  const chunks = text.split(sep).slice(1);
  const parts = [];
  for (let chunk of chunks) {
    chunk = chunk.replace(new RegExp(`${end}\\s*$`), '');
    const splitIdx = findDoubleNewline(chunk);
    if (splitIdx === -1) continue;
    const headers = chunk.slice(0, splitIdx).trim();
    const body = chunk.slice(splitIdx).replace(/^\s+/, '');
    parts.push({ headers, body });
  }
  return parts;
}
function findDoubleNewline(s) { const a = s.indexOf('\r\n\r\n'); if (a !== -1) return a + 4; const b = s.indexOf('\n\n'); return b !== -1 ? b + 2 : -1; }
function getCTE(h) { const m = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(h); return m ? m[1].trim().toLowerCase() : '7bit'; }
function getCharset(h) { const m = /charset="?([^";\r\n]+)"?/i.exec(h); return (m ? m[1].trim() : 'utf-8').toLowerCase(); }
function decodeBody(body, cte, cs) {
  let buf;
  if (cte === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (cte === 'quoted-printable') buf = Buffer.from(decodeQuotedPrintable(body), 'utf-8');
  else buf = Buffer.from(body, 'utf-8');
  return buf.toString(normalizeCharset(cs));
}
function decodeQuotedPrintable(str) { str = str.replace(/=\r?\n/g, ''); return str.replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function normalizeCharset(cs) { if (/utf-8|utf8/i.test(cs)) return 'utf-8'; if (/iso-8859-1|latin1/i.test(cs)) return 'latin1'; return 'utf-8'; }

function emptyTotals() { return { totalChannels: 0, offlineChannels: 0, activeRecordings: 0, idle: 0, signalLoss: 0 }; }
function freshMetrics() { return { totalChannels: 0, offlineChannels: 0, activeRecordings: 0, idle: 0, signalLoss: 0 }; }
function asInt(s) { if (!s) return null; const m = String(s).match(/(\d[\d.,]*)/); return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null; }
function toInt(s) { return parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0; }
function stripTags(h) { return fixMojibake(String(h)).replace(/<[^>]+>/g, ' '); }