import fs from 'fs';
import * as cheerio from 'cheerio';

/**
 * showTargets.html → cuadros de "Targets", "LUNs" y "Blocks".
 * Lee SIEMPRE desde el texto de celdas (<td>), no de atributos.
 */
export async function parseTargets(filePath) {
  const html = await fs.promises.readFile(filePath, 'utf-8');
  const $ = cheerio.load(html);

  function tableToObj(sel) {
    const obj = {};
    $(sel).find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const k = $(tds[0]).text().trim();
        const v = Number($(tds[1]).text().trim().replace(/[^\d.-]/g, '')) || 0;
        obj[k] = v;
      }
    });
    return obj;
  }

  const targetsSummary = tableToObj('h1:contains("Targets")+table');
  const lunsSummary    = tableToObj('h1:contains("LUNs")+table');
  const blocksSummary  = tableToObj('h1:contains("Blocks")+table');

  const details = [];
  const rows = $('table').first().find('tr').slice(1);
  rows.each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length >= 13) {
      details.push({
        target: $(tds[0]).text().trim(),
        bitrate: Number($(tds[5]).text().trim().replace(/[^\d.-]/g,''))||0,
        total: Number($(tds[6]).text().trim().replace(/[^\d.-]/g,''))||0,
        available: Number($(tds[7]).text().trim().replace(/[^\d.-]/g,''))||0,
        empty: Number($(tds[8]).text().trim().replace(/[^\d.-]/g,''))||0,
        protected: Number($(tds[9]).text().trim().replace(/[^\d.-]/g,''))||0
      });
    }
  });

  return { targetsSummary, lunsSummary, blocksSummary, details };
}