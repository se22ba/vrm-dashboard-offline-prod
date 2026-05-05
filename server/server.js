import express from 'express';
import path from 'path';
import fs from 'fs';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import Busboy from 'busboy';

import { parseIndexMhtml } from './parsers/indexParser.js';
import { parseCamerasAndDevices } from './parsers/camerasParser.js';
import { parseTargets } from './parsers/targetsParser.js';
import { saveVrmPages } from './scrapers/vrmScraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------- App base -------------------------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

// Servir estáticos del front
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (/\.(?:html|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Fallback a index.html para la raíz
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ------------------------- Helpers -------------------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function safeName(s) {
  return String(s || '').replace(/[^a-z0-9._-]+/gi, '_');
}
function emptyTotals() {
  return { totalChannels: 0, offlineChannels: 0, activeRecordings: 0, idle: 0, signalLoss: 0 };
}
function emptyTargetsSummary() {
  return { targetsSummary: {}, lunsSummary: {}, blocksSummary: {}, details: [] };
}

function cloneTargetsSummary(src = {}) {
  return {
    targetsSummary: { ...(src.targetsSummary || {}) },
    lunsSummary: { ...(src.lunsSummary || {}) },
    blocksSummary: { ...(src.blocksSummary || {}) },
    details: Array.isArray(src.details) ? src.details.slice() : []
  };
}

function buildVrmLabel({ bvms, vrm, ip }) {
  const parts = [];
  if (bvms) parts.push(bvms);
  if (vrm) parts.push(vrm);
  if (parts.length) return parts.join(' · ');
  if (ip) return ip;
  return 'VRM';
}

function buildTargetsPayload(raw, meta = {}, { includeCard = true } = {}) {
  const base = raw ? cloneTargetsSummary(raw) : emptyTargetsSummary();
  const label = meta.label;
  const byVrm = {};
  if (label && includeCard) {
    byVrm[label] = { ...cloneTargetsSummary(raw || {}), meta };
  }
  return { totals: base, byVrm };
}


// Normaliza cualquier cosa "parecida a lista" a un array
function asArray(maybeList) {
  if (Array.isArray(maybeList)) return maybeList;
  if (maybeList && typeof maybeList === 'object') {
    if (Array.isArray(maybeList.cameras)) return maybeList.cameras;
    if (Array.isArray(maybeList.merged)) return maybeList.merged;
    if (Array.isArray(maybeList.rows)) return maybeList.rows;
    if (Array.isArray(maybeList.list)) return maybeList.list;
    if (Array.isArray(maybeList.items)) return maybeList.items;
  }
  return [];
}

// Respaldo para contadores por VRM si no usamos los del parser
function derivePerVrmCounters(camerasMaybe) {
  const cameras = asArray(camerasMaybe);
  const map = {};
  for (const c of cameras) {
    const key = c?.primaryTarget || c?.vrm || c?.vrmName || c?.address || 'unknown';
    const m = (map[key] ||= { bvmsIssues: 0, offline: 0, total: 0 });
    m.total++;

    const rec = String(c?.recordingState || c?.state || '').toLowerCase();

    // Offline (no BVMS)
    if (/\boffline\b/.test(rec)) m.offline++;

    // BVMS issues: Recording disabled, Pending (no blocks / connecting to storage), Error (storage)
    const isDisabled = /recording\s*disabled/i.test(rec);
    const isPending  = /pending/i.test(rec) && /(no\s*blocks?|connecting\s*to\s*storage)/i.test(rec);
    const isStorageError = /error\s*\(storage\)/i.test(rec);
    if (isDisabled || isPending || isStorageError) m.bvmsIssues++;
  }
  return map;
}

// ------------------------- Parseo por uploads (conservado) -------------------------
app.post('/api/parse-uploads', (req, res) => {
  const bb = Busboy({ headers: req.headers, limits: { files: 8, fileSize: 60 * 1024 * 1024 } });
  const tmpDir = ensureDir(path.join(__dirname, '..', 'uploads', String(Date.now())));
  const files = {};

  bb.on('file', (name, file, info) => {
    const fname = safeName(info.filename || name);
    const out = path.join(tmpDir, fname);
    files[name] = out;
    const ws = fs.createWriteStream(out);
    file.pipe(ws);
  });

  bb.on('finish', async () => {
    try {
      const indexPath = files['index_mhtml'] || files['index'] || null;
      const camsPath  = files['showCameras'] || files['cams'] || null;
      const devsPath  = files['showDevices'] || files['devs'] || null;
      const tgsPath   = files['showTargets'] || files['targets'] || null;

      const overview = indexPath ? await parseIndexMhtml(indexPath) : { totals: emptyTotals(), perVrm: {} };

      let camerasParsed = [];
      let camsStats = null; // totales / perVrm desde parser .htm

      if (camsPath && devsPath) {
        const raw = await parseCamerasAndDevices(camsPath, devsPath);
        // raw trae: { merged, perVrmCounters, derivedOverview }
        camerasParsed = Array.isArray(raw?.merged) ? raw.merged : asArray(raw);
        camsStats = raw && typeof raw === 'object' ? raw : null;
      }

      const hasTargetsFile = Boolean(tgsPath);
      const targetsRaw = hasTargetsFile
        ? await parseTargets(tgsPath)
          : emptyTargetsSummary();

      const overviewVrms = Object.keys(overview?.perVrm || {});
      const vrmFromOverview = overviewVrms.length === 1 ? overviewVrms[0] : (overviewVrms[0] || null);
      const uploadLabel = buildVrmLabel({ bvms: null, vrm: vrmFromOverview, ip: null });
      const targets = buildTargetsPayload(targetsRaw, {
        label: uploadLabel,
        vrm: vrmFromOverview || null
      }, { includeCard: hasTargetsFile });

      // --- Totales base desde index.mhtml (Total de cámaras de index) ---
      let totals = overview?.totals || emptyTotals();

      // --- Override solicitado: "Cámaras operativas" desde showCameras (Recording) ---
      if (camsStats?.derivedOverview?.totals) {
        totals.activeRecordings = Number(camsStats.derivedOverview.totals.activeRecordings || 0);
      }

      // --- perVrmCounters: priorizamos los del parser .htm ---
      let perVrmCounters = camsStats?.perVrmCounters || derivePerVrmCounters(camerasParsed);

      return res.json({
        overview: { perVrm: overview?.perVrm || {} },
        overviewFinal: { totals, perVrm: overview?.perVrm || {} },
        perVrmCounters,
        targets,
        cameras: camerasParsed,
        debugPaths: { indexPath, camsPath, devsPath, tgsPath },
        debugCams: camerasParsed.slice(0, 5)
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  req.pipe(bb);
});

// ------------------------- Scrapeo por IP -------------------------
app.post('/api/scrape', async (req, res) => {
  try {
    const { bvms = '', vrm = '', ip = '', user = '', pass = '' } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'Falta IP' });

    // carpeta de salida: ./data/<BVMS>/<VRM o IP>/
    const baseDir = ensureDir(path.join(__dirname, '..', 'data', safeName(bvms || 'BVMS'), safeName(vrm || ip)));

    const creds = (user || pass) ? { user, pass } : {};

    const savedPaths = await saveVrmPages({ ip, credentials: creds, outDir: baseDir });

    const indexPath = path.join(baseDir, 'index.mhtml');
    const camsPath  = path.join(baseDir, 'showCameras.html');
    const devsPath  = path.join(baseDir, 'showDevices.html');
    const tgsPath   = path.join(baseDir, 'showTargets.html');

    const overview = fs.existsSync(indexPath) ? await parseIndexMhtml(indexPath) : { totals: emptyTotals(), perVrm: {} };

    let camerasParsed = [];
    let camsStats = null;

    if (fs.existsSync(camsPath) && fs.existsSync(devsPath)) {
      const raw = await parseCamerasAndDevices(camsPath, devsPath);
      camerasParsed = Array.isArray(raw?.merged) ? raw.merged : asArray(raw);
      camsStats = raw && typeof raw === 'object' ? raw : null;
    }

    const hasTargetsFile = fs.existsSync(tgsPath);
    const targetsRaw = hasTargetsFile
      ? await parseTargets(tgsPath)
      : emptyTargetsSummary();

    const label = buildVrmLabel({ bvms, vrm, ip });
    const targets = buildTargetsPayload(targetsRaw, {
      label,
      bvms: bvms || null,
      vrm: vrm || null,
      ip: ip || null
    }, { includeCard: hasTargetsFile });

    // --- Totales base desde index.mhtml (Total de cámaras de index) ---
    let totals = overview?.totals || emptyTotals();

    // --- Override solicitado: "Cámaras operativas" desde showCameras (Recording) ---
    if (camsStats?.derivedOverview?.totals) {
      totals.activeRecordings = Number(camsStats.derivedOverview.totals.activeRecordings || 0);
    }

    // --- perVrmCounters: preferimos los calculados por el parser de .htm ---
    let perVrmCounters = camsStats?.perVrmCounters || derivePerVrmCounters(camerasParsed);

    return res.json({
      overview: { perVrm: overview?.perVrm || {} },
      overviewFinal: { totals, perVrm: overview?.perVrm || {} },
      perVrmCounters,
      targets,
      cameras: camerasParsed,
      debugPaths: { baseDir, savedPaths, indexPath, camsPath, devsPath, tgsPath },
      debugCams: camerasParsed.slice(0, 5)
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

// ------------------------- Start -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VRM Dashboard on http://localhost:${PORT}`));