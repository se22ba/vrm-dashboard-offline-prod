import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

// ---- Mitigación entorno offline/proxy ----
try {
  process.env.HTTP_PROXY = '';
  process.env.HTTPS_PROXY = '';
  process.env.http_proxy = '';
  process.env.https_proxy = '';
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';
} catch { /* ignore */ }

/**
 * saveVrmPages({ ip, credentials = {}, outDir })
 *
 * Endpoints reales:
 *  - HTTPS cockpit → https://<ip>/vrmcockpit/index.html   → index.mhtml (CDP snapshot, tras render real)
 *  - HTTP tablas   → http://<ip>/showCameras.htm         → showCameras.html
 *                    http://<ip>/showDevices.htm         → showDevices.html
 *                    http://<ip>/showTargets.htm         → showTargets.html
 *
 * Estrategia de login:
 *  - Cockpit (HTTPS) intenta en este orden:
 *      1) Basic Auth proactivo (page.authenticate + header Authorization)
 *      2) URL con user:pass@host
 *      3) Form login (#username, #password, hidden #ref, #submit/#submitButton)
 *  - Tablas (HTTP): Basic Auth proactivo + URL con user:pass@host + form si aparece.
 *
 * Extra:
 *  - Fuerza "sin proxy" y guarda dumps HTML cuando el login falla para depurar in situ.
 */
export async function saveVrmPages({ ip, credentials = {}, outDir }) {
  if (!ip) throw new Error('IP requerida');

  fs.mkdirSync(outDir, { recursive: true });

  const httpBase  = `http://${ip}`;
  const httpsBase = `https://${ip}`;

  const URLS = {
    index: `${httpsBase}/vrmcockpit/index.html`,
    indexWithCreds: (credentials.user || credentials.pass)
      ? `https://${encodeURIComponent(credentials.user || '')}:${encodeURIComponent(credentials.pass || '')}@${ip}/vrmcockpit/index.html`
      : `${httpsBase}/vrmcockpit/index.html`,
    showCameras: `${httpBase}/showCameras.htm`,
    showDevices: `${httpBase}/showDevices.htm`,
    showTargets: `${httpBase}/showTargets.htm`,
  };

  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
      '--disable-web-security',
      '--proxy-server=direct://',
      '--proxy-bypass-list=*'
    ]
  });

  const saved = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Helpers ----------
  function basicAuthHeader() {
    if (!(credentials.user || credentials.pass)) return null;
    const token = Buffer.from(`${credentials.user || ''}:${credentials.pass || ''}`).toString('base64');
    return `Basic ${token}`;
  }

  async function newPageBase() {
    const page = await browser.newPage();
    try { await page.setViewport({ width: 1366, height: 900 }); } catch {}
    try { page.setDefaultNavigationTimeout(60000); } catch {}
    try { page.setDefaultTimeout(60000); } catch {}
    return page;
  }

  async function newPageWithAuthHttp() {
    const page = await newPageBase();
    if (credentials.user || credentials.pass) {
      try { await page.authenticate({ username: credentials.user || '', password: credentials.pass || '' }); } catch {}
    }
    const auth = basicAuthHeader();
    if (auth) { try { await page.setExtraHTTPHeaders({ Authorization: auth }); } catch {} }
    return page;
  }

  async function newPageWithAuthHttps() {
    const page = await newPageBase();
    // Basic Auth proactivo también en HTTPS
    if (credentials.user || credentials.pass) {
      try { await page.authenticate({ username: credentials.user || '', password: credentials.pass || '' }); } catch {}
      const auth = basicAuthHeader();
      if (auth) { try { await page.setExtraHTTPHeaders({ Authorization: auth }); } catch {} }
    }
    return page;
  }

  async function isLoginPage(page) {
    try {
      const hasLoginContent = await page.$('#loginContent');
      const hasUser         = await page.$('#username');
      const hasPwd          = (await page.$('#password')) || (await page.$('input[type="password"]'));
      if (hasLoginContent || (hasUser && hasPwd)) return true;
      const text = await page.evaluate(() => document.body && document.body.innerText || '');
      if (/\bInicio de sesión\b|\bLogin\b/i.test(text) && /\bVRM\b/i.test(text)) return true;
    } catch {}
    return false;
  }

  // Dump HTML al disco para depurar
  async function dump(page, filename) {
    try {
      const html = await page.content();
      await fs.promises.writeFile(path.join(outDir, filename), html, 'utf-8');
    } catch {}
  }

  // Espera robusta a que desaparezca el login y aparezca contenido de app (SPA)
  async function waitLoggedIn(page) {
    try {
      await page.waitForFunction(
        () => !document.querySelector('#loginContent') && !document.querySelector('#password'),
        { timeout: 60000 }
      );
    } catch {}
    try {
      await page.waitForSelector('#menu, #header, #Head', { timeout: 8000 });
    } catch {}
    // también considerar cambio de URL típico del forward
    try {
      await page.waitForFunction(
        () => /forwardToPage\.html|\/vrmcockpit\/index\.html/i.test(location.href),
        { timeout: 8000 }
      );
    } catch {}
  }

  // Esperar a que el cockpit pinte contenido real en #content
  async function waitForCockpitRendered(page) {
    try {
      await page.waitForFunction(
        () => {
          const sp = document.querySelector('#spinner');
          return !sp || getComputedStyle(sp).display === 'none' || sp.hidden === true;
        },
        { timeout: 30000 }
      );
    } catch {}
    try {
      await page.waitForFunction(
        () => {
          const c = document.querySelector('#content');
          if (!c) return false;
          if (c.childElementCount > 0) return true;
          const txt = c.innerText?.trim();
          return !!txt && txt.length > 5;
        },
        { timeout: 30000 }
      );
    } catch {}
    const candidates = [
      '#content .dashboard',
      '#content .tab-wrapper',
      '#content .tiles',
      '#content .kpi',
      '#content .chart',
      '[data-role="cockpit"], [class*="cockpit"]'
    ];
    for (const sel of candidates) {
      try { await page.waitForSelector(sel, { timeout: 4000 }); return; } catch {}
    }
    await sleep(1000);
  }

  // Login de formulario ULTRA-ROBUSTO
  async function doFormLogin(page, desiredPath) {
    // Asegurar #ref
    try {
      const hasRef = await page.$('#ref');
      if (hasRef && desiredPath) {
        await page.$eval('#ref', (el, value) => { el.value = value; }, desiredPath);
      }
    } catch {}

    // Set value + eventos
    async function setValueWithEvents(selector, value) {
      try {
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, selector, value);
      } catch {}
    }

    const uSel = '#username, input[name="username"], input[name="user"], input[id*="user" i], input[type="text"]';
    const pSel = '#password, input[name="password"], input[id*="pass" i], input[type="password"]';

    await setValueWithEvents(uSel, credentials.user || '');
    await setValueWithEvents(pSel, credentials.pass || '');

    // 4 estrategias de submit
    async function tryClick(selector) {
      try {
        const h = await page.$(selector);
        if (!h) return false;
        await Promise.race([
          page.click(selector).then(() => page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })),
          (async () => { await page.click(selector); await waitLoggedIn(page); })()
        ]).catch(() => {});
        return true;
      } catch { return false; }
    }

    let submitted =
      (await tryClick('#submit')) ||
      (await tryClick('#submitButton button')) ||
      (await tryClick('#submitButton input[type="submit"]')) ||
      (await (async () => {
        try { await page.evaluate(() => { const f = document.querySelector('#form1'); if (f) f.submit(); }); await waitLoggedIn(page); return true; } catch { return false; }
      })()) ||
      (await (async () => {
        try { await page.focus(pSel); await page.keyboard.press('Enter'); await waitLoggedIn(page); return true; } catch { return false; }
      })());

    if (!submitted) throw new Error('No se pudo accionar el submit del formulario de login.');

    if (await isLoginPage(page)) {
      throw new Error('Login falló: el formulario sigue presente tras el submit.');
    }
  }

  async function openAndLoginCockpitHttps(page) {
    // 1) Intento con Basic Auth proactivo + URL normal
    try { await page.goto(URLS.index, { waitUntil: 'load', timeout: 60000 }); } catch {}

    if (await isLoginPage(page)) {
      // 2) Intento con URL user:pass@host (puede destrabar instalaciones con auth intermedia)
      try { await page.goto(URLS.indexWithCreds, { waitUntil: 'load', timeout: 60000 }); } catch {}
    }

    // 3) Si todavía es login, probamos el formulario
    if (await isLoginPage(page)) {
      if (!(credentials.user || credentials.pass)) {
        throw new Error('Se requiere login pero no se recibieron credenciales.');
      }
      await doFormLogin(page, '/vrmcockpit/index.html');
    }

    // Validar
    if (await isLoginPage(page)) {
      await dump(page, 'debug-cockpit-login.html');
      throw new Error('No fue posible autenticarse en el cockpit HTTPS.');
    }
  }

  async function saveHtmlFromCurrentPage(page, outFile) {
    const html = await page.content();
    await fs.promises.writeFile(outFile, html, 'utf-8');
    saved.push(outFile);
  }

  async function openHttpAuthAndPossiblyForm(page, absUrl, desiredRefPath) {
    try { await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 60000 }); } catch {}

    if (await isLoginPage(page)) {
      if (credentials.user || credentials.pass) {
        try {
          const url = new URL(absUrl);
          const user = encodeURIComponent(credentials.user || '');
          const pass = encodeURIComponent(credentials.pass || '');
          const urlWithCreds = `${url.protocol}//${user}:${pass}@${url.host}${url.pathname}${url.search}`;
          await page.goto(urlWithCreds, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        } catch {}
      }
    }

    if (await isLoginPage(page)) {
      try { await doFormLogin(page, desiredRefPath); }
      catch (e) { await dump(page, 'debug-http-login.html'); throw e; }
    }

    if (await isLoginPage(page)) {
      await dump(page, 'debug-http-login.html');
      throw new Error(`No se pudo acceder a ${absUrl}: la página insiste con login.`);
    }
  }

  try {
    // 1) Cockpit en HTTPS (Basic/URL + form) → esperar render → snapshot MHTML
    {
      const page = await newPageWithAuthHttps();
      await openAndLoginCockpitHttps(page);
      await waitForCockpitRendered(page);

      const client = await page.target().createCDPSession();
      await client.send('Page.enable');
      const { data: mhtml } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
      const indexPath = path.join(outDir, 'index.mhtml');
      await fs.promises.writeFile(indexPath, mhtml, 'utf-8');
      saved.push(indexPath);

      await page.close().catch(() => {});
    }

    // 2) .HTM por HTTP con Basic Auth proactivo + form si aparece
    const pageHttp = await newPageWithAuthHttp();

    await openHttpAuthAndPossiblyForm(pageHttp, URLS.showDevices, '/showDevices.htm');
    await saveHtmlFromCurrentPage(pageHttp, path.join(outDir, 'showDevices.html'));

    await openHttpAuthAndPossiblyForm(pageHttp, URLS.showCameras, '/showCameras.htm');
    await saveHtmlFromCurrentPage(pageHttp, path.join(outDir, 'showCameras.html'));

    await openHttpAuthAndPossiblyForm(pageHttp, URLS.showTargets, '/showTargets.htm');
    await saveHtmlFromCurrentPage(pageHttp, path.join(outDir, 'showTargets.html'));

    await pageHttp.close().catch(() => {});

    return saved;
  } finally {
    try { await browser.close(); } catch {}
  }
}