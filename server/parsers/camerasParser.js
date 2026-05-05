import fs from 'fs';
import * as cheerio from 'cheerio';

/**
 * Une ShowCameras + ShowDevices en una grilla única de cámaras.
 * - Cuenta issues BVMS: Recording disabled, Pending (no blocks/connecting), Error (storage)
 * - Cuenta issues no BVMS: Offline
 * - Trae fwVersion desde ShowDevices (por IP base)
 */
export async function parseCamerasAndDevices(showCamerasPath, showDevicesPath) {
  const camsHtml = await fs.promises.readFile(showCamerasPath, 'utf-8');
  const devsHtml = await fs.promises.readFile(showDevicesPath, 'utf-8');

  const cams = parseCameras(camsHtml);   // cameraName, address, baseAddress, recordingState, ...
  const devs = parseDevices(devsHtml);   // baseAddress(ip), fwVersion, connectionTime, maxBitrate

  // Mapear devices por IP base (antes del "\")
  const devMap = new Map(devs.map(d => [d.baseAddress, d]));

  // Merge final para la tabla
  const merged = cams.map(c => {
    const d = devMap.get(c.baseAddress) || {};
    return {
      cameraName: c.cameraName,
      address: c.address,
      baseAddress: c.baseAddress,
      fwVersion: d.fwVersion || '',
      recordingState: c.recordingState,
      maxBitrate: d.maxBitrate || c.maxBitrate || '',
      connectionTime: c.connectionTime || d.connectionTime || '',
      primaryTarget: c.primaryTarget || '',
      currentBlockClass: c.currentBlockClass || ''
    };
  });

  // Contadores por VRM/Target
  const perVrmCounters = {};
  for (const c of cams) {
    const k = c.primaryTarget || 'unknown';
    if (!perVrmCounters[k]) perVrmCounters[k] = { bvmsIssues: 0, offline: 0, total: 0 };
    perVrmCounters[k].total++;

    const rs = String(c.recordingState || '').toLowerCase();

    // ----- Problemas BVMS -----
    const isDisabled      = /recording\s*disabled/i.test(rs);
    const isPending       = /pending/i.test(rs) && /(no\s*blocks?|connecting\s*to\s*storage)/i.test(rs);
    const isStorageError  = /error\s*\(storage\)/i.test(rs);      // <-- agregado
    if (isDisabled || isPending || isStorageError) perVrmCounters[k].bvmsIssues++;

    // ----- Problemas (no BVMS) = offline -----
    if (/\boffline\b/i.test(rs)) perVrmCounters[k].offline++;
  }

  // Derivados para fallback/otros gráficos
  const totalChannels = cams.length;
  const activeRecordings = cams.filter(c =>
    /^(?:\s*)recording\b/i.test(c.recordingState || '') && !/disabled/i.test(c.recordingState || '')
  ).length;
  const offlineChannels = cams.filter(c => /\boffline\b/i.test(c.recordingState || '')).length;

  const perVrmDerived = {};
  for (const c of cams) {
    const k = c.primaryTarget || 'unknown';
    if (!perVrmDerived[k]) perVrmDerived[k] = { total: 0, active: 0, offline: 0 };
    perVrmDerived[k].total++;
    if (/^(?:\s*)recording\b/i.test(c.recordingState || '') && !/disabled/i.test(c.recordingState || '')) perVrmDerived[k].active++;
    if (/\boffline\b/i.test(c.recordingState || '')) perVrmDerived[k].offline++;
  }

  return {
    merged,
    perVrmCounters,
    derivedOverview: {
      totals: { totalChannels, activeRecordings, offlineChannels },
      perVrmDerived
    }
  };
}

/* ------------------------ Parsers robustos por encabezado ------------------------ */

function norm(s) {
  return String(s||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function parseCameras(html) {
  const $ = cheerio.load(html);
  const out = [];

  const $rows = $('table tr');
  if (!$rows.length) return out;

  // Mapear encabezados -> índice
  const headers = [];
  $rows.first().find('th').each((i,th)=> headers[i] = norm($(th).text()));
  const idx = (nameLike) => headers.findIndex(h => h.includes(nameLike));

  const iName   = idx('camera name');
  const iAddr   = idx('address');
  const iState  = idx('recording state');
  const iConn   = idx('connection time');
  const iTarget = idx('primary target');
  const iClass  = idx('current block class');
  const iMaxBr  = idx('max bitrate');

  $rows.slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;

    const name = iName>=0 ? $(tds[iName]).text().trim() : '';
    // Address: puede venir como <a> o texto
    let addr = iAddr>=0 ? ($(tds[iAddr]).find('a').text().trim() || $(tds[iAddr]).text().trim()) : '';
    const baseAddress = (addr.split('\\')[0] || '').trim();

    const recordingState   = iState>=0  ? $(tds[iState]).text().trim()  : '';
    const connectionTime   = iConn>=0   ? $(tds[iConn]).text().trim()   : '';
    const primaryTarget    = iTarget>=0 ? $(tds[iTarget]).text().trim() : '';
    const currentBlockClass= iClass>=0  ? ($(tds[iClass]).text().trim() || /class=['"]([^'"]+)['"]/i.exec($(tds[iClass]).html()||'')?.[1] || '') : '';
    const maxBitrate       = iMaxBr>=0  ? $(tds[iMaxBr]).text().trim()  : '';

    out.push({
      cameraName: name,
      address: addr,
      baseAddress,
      recordingState,
      maxBitrate,
      connectionTime,
      primaryTarget,
      currentBlockClass
    });
  });

  return out;
}

function parseDevices(html) {
  const $ = cheerio.load(html);
  const out = [];

  const $rows = $('table tr');
  if (!$rows.length) return out;

  // Mapear encabezados -> índice
  const headers = [];
  $rows.first().find('th').each((i,th)=> headers[i] = norm($(th).text()));
  const idx = (nameLike) => headers.findIndex(h => h.includes(nameLike));

  const iDevice   = idx('device');                 // ejemplo: "172.25.0.24\1"
  const iFw       = headers.findIndex(h => h.includes('fw') && h.includes('version')); // "FW version"
  const iConnTime = idx('connection time') >= 0 ? idx('connection time') : headers.findIndex(h => h.includes('remap time'));
  const iMaxBr    = idx('max bitrate');

  $rows.slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;

    const device = iDevice>=0 ? $(tds[iDevice]).text().trim() : '';
    const baseAddress = (device.split('\\')[0] || '').trim();

    const fwVersion     = iFw>=0 ? $(tds[iFw]).text().trim() : '';
    const connectionTime= iConnTime>=0 ? $(tds[iConnTime]).text().trim() : '';
    const maxBitrate    = iMaxBr>=0 ? $(tds[iMaxBr]).text().trim() : '';

    out.push({ baseAddress, fwVersion, connectionTime, maxBitrate });
  });

  return out;
}