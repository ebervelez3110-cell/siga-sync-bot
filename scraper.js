
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function decodificarJwtExp(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.searchParams.get('p');
    if (!p) return null;
    const parts = p.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json.exp ? new Date(json.exp * 1000) : null;
  } catch (e) {
    return null;
  }
}

function parseHoraFecha(rawText, fallbackFechaIso) {
  const txt = String(rawText || '').replace(/\s+/g, ' ').trim();
  const mTime = txt.match(/(\d{2}:\d{2})/);
  if (!mTime) return null;
  const hora = mTime[1];
  const mDate = txt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  let fecha = fallbackFechaIso;
  if (mDate) {
    fecha = mDate[3] + '-' + mDate[2] + '-' + mDate[1];
  }
  const horaTs = fecha + 'T' + hora + ':00-05:00';
  return { hora: hora, fecha: fecha, horaTs: horaTs };
}

function fechaHoyLima() {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600 * 1000);
  return lima.toISOString().slice(0, 10);
}

async function actualizarEstadoConfig(patch) {
  const payload = Object.assign({ id: 'LIM', updated_at: new Date().toISOString() }, patch);
  await sb.from('siga_config').upsert(payload, { onConflict: 'id' });
}

async function esperarTablaVuelos(page) {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await page.waitForFunction(function () {
        const txt = document.body ? document.body.innerText : '';
        return /\b[A-Z]{2}\d{3,4}\b/.test(txt);
      }, null, { timeout: 45000 });
      return true;
    } catch (e) {
      const preview = await page.evaluate(function () {
        return (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 280);
      }).catch(function () { return ''; });
      console.log('Intento ' + intento + ' sin vuelos aun. Texto visible: ' + preview);
      if (/expir|vencid|inval|unauthor|acceso|token/i.test(preview)) {
        throw new Error('Link SIGA expirado o rechazado por servidor: ' + preview);
      }
      if (intento === 1) {
        console.log('Reintentando carga de pizarra...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      } else {
        throw new Error('Timeout esperando vuelos en SIGA. Texto en pantalla: ' + (preview || '(pantalla en blanco)'));
      }
    }
  }
  return false;
}

async function main() {
  console.log('Iniciando sincronizacion SIGA v3...');
  const resCfg = await sb.from('siga_config').select('*').eq('id', 'LIM').maybeSingle();
  if (resCfg.error) throw resCfg.error;
  const cfg = resCfg.data;

  if (!cfg || !cfg.url_siga || !cfg.url_siga.trim().startsWith('http')) {
    console.log('No hay link SIGA configurado en siga_config.');
    await actualizarEstadoConfig({ estado: 'SIN_LINK', ultimo_error: 'Pega un link vigente en CCO.' });
    return;
  }

  const urlSiga = cfg.url_siga.trim();
  const expDate = decodificarJwtExp(urlSiga);
  if (expDate && expDate.getTime() < Date.now()) {
    console.log('Link SIGA vencido desde ' + expDate.toISOString());
    await actualizarEstadoConfig({
      estado: 'VENCIDO',
      token_exp: expDate.toISOString(),
      ultimo_error: 'El enlace de 48h vencio. Pega uno nuevo en CCO.'
    });
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 2560, height: 1440 },
      locale: 'es-PE',
      timezoneId: 'America/Lima'
    });
    const page = await context.newPage();

    console.log('Abriendo pizarra...');
    await page.goto(urlSiga, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await esperarTablaVuelos(page);
    await page.waitForTimeout(3000);

    const extracted = await page.evaluate(function () {
      function clean(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
      }
      const tables = Array.from(document.querySelectorAll('table'));
      let mainTable = null;
      let maxRows = 0;
      for (let i = 0; i < tables.length; i++) {
        const count = tables[i].querySelectorAll('tbody tr').length;
        if (count > maxRows) {
          maxRows = count;
          mainTable = tables[i];
        }
      }

      let rows = [];
      let headers = [];

      if (mainTable && maxRows > 0) {
        rows = Array.from(mainTable.querySelectorAll('tbody tr'))
          .map(function (tr) {
            return Array.from(tr.querySelectorAll('td')).map(function (td) { return clean(td.innerText); });
          })
          .filter(function (r) { return r.length >= 4; });

        const candidateHeaderRows = Array.from(mainTable.querySelectorAll('thead tr'))
          .concat(Array.from(document.querySelectorAll('table thead tr')));

        const colCount = rows[0] ? rows[0].length : 0;
        let bestH = [];
        let bestScore = -1;
        for (let j = 0; j < candidateHeaderRows.length; j++) {
          const hs = Array.from(candidateHeaderRows[j].querySelectorAll('th, td'))
            .map(function (el) { return clean(el.innerText).toUpperCase(); });
          if (!hs.length) continue;
          let score = 0;
          if (hs.some(function (h) { return h.indexOf('VUELO') >= 0 || h === 'VOO'; })) score += 5;
          if (hs.some(function (h) { return h.indexOf('ETA') >= 0; })) score += 3;
          if (hs.some(function (h) { return h.indexOf('ETD') >= 0; })) score += 3;
          if (hs.some(function (h) { return h.indexOf('PREFIX') >= 0 || h.indexOf('MATR') >= 0; })) score += 4;
          if (colCount && hs.length === colCount) score += 6;
          score += hs.length * 0.05;
          if (score > bestScore) {
            bestScore = score;
            bestH = hs;
          }
        }
        headers = bestH;
      }

      if (!rows.length) {
        const ariaHeaders = Array.from(document.querySelectorAll('[role="columnheader"]'))
          .map(function (el) { return clean(el.innerText).toUpperCase(); });
        const ariaRows = Array.from(document.querySelectorAll('[role="row"]'))
          .map(function (r) {
            return Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"]'))
              .map(function (c) { return clean(c.innerText); });
          })
          .filter(function (r) { return r.length >= 4; });
        if (ariaRows.length) {
          headers = ariaHeaders;
          rows = ariaRows;
        }
      }

      return { tableCount: tables.length, headers: headers, rows: rows };
    });

    const tableCount = extracted.tableCount;
    const headers = extracted.headers;
    const rows = extracted.rows;

    console.log('Tablas en DOM: ' + tableCount + ' | Cabeceras (' + headers.length + '): ' + headers.join(' | '));
    console.log('Filas detectadas: ' + rows.length);
    if (rows[0]) console.log('Ejemplo fila 0: ' + JSON.stringify(rows[0]));

    if (!rows.length) {
      await actualizarEstadoConfig({
        estado: 'ERROR',
        ultimo_error: 'La pagina cargo pero no se encontraron filas en la tabla.'
      });
      return;
    }

    let idxPrefix = headers.findIndex(function (h) {
      return h.indexOf('PREFIX') >= 0 || h.indexOf('MATR') >= 0;
    });
    if (idxPrefix < 0) {
      const counts = {};
      rows.slice(0, 30).forEach(function (r) {
        r.forEach(function (val, idx) {
          if (/^[A-Z]{2}-[A-Z0-9]{3,5}$/.test(val.trim())) {
            counts[idx] = (counts[idx] || 0) + 1;
          }
        });
      });
      const sorted = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });
      if (sorted[0]) idxPrefix = parseInt(sorted[0][0], 10);
    }

    function findBefore(pred, limit) {
      const end = limit >= 0 ? limit : headers.length;
      for (let i = 0; i < end; i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    }
    function findAfter(pred, start) {
      if (start < 0) return -1;
      for (let i = start + 1; i < headers.length; i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    }

    const idxArrVuelo = findBefore(function (h) { return h === 'VUELO' || h.indexOf('VUELO') >= 0 || h === 'VOO'; }, idxPrefix);
    const idxArrOrigen = findBefore(function (h) { return h.indexOf('ORIGEN') >= 0 || h.indexOf('ORIG') >= 0; }, idxPrefix);
    const idxArrPea = findBefore(function (h) { return h.indexOf('P.POS') >= 0 || h.indexOf('POS') >= 0; }, idxPrefix);
    const idxArrEta = findBefore(function (h) { return h === 'ETA' || h.indexOf('ETA') === 0; }, idxPrefix);
    const idxArrSta = findBefore(function (h) { return h === 'STA' || h.indexOf('STA') === 0; }, idxPrefix);

    const idxDepVuelo = findAfter(function (h) { return h === 'VUELO' || h.indexOf('VUELO') >= 0 || h === 'VOO'; }, idxPrefix);
    const idxDepDest = findAfter(function (h) { return h.indexOf('DEST') >= 0; }, idxPrefix);
    const idxDepPea = findAfter(function (h) { return h.indexOf('P.POS') >= 0 || h.indexOf('POS') >= 0; }, idxPrefix);
    const idxDepEtd = findAfter(function (h) { return h === 'ETD' || h.indexOf('ETD') === 0; }, idxPrefix);
    const idxDepStd = findAfter(function (h) { return h === 'STD' || h.indexOf('STD') === 0; }, idxPrefix);

    const hoyLima = fechaHoyLima();
    const registrosMap = new Map();
    function cleanVuelo(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }
    function cleanPea(p) { return String(p || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, ''); }
    function cleanTxt(m) { return String(m || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, ''); }

    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || cells.length < 4) continue;
      const matricula = idxPrefix >= 0 ? cleanTxt(cells[idxPrefix]) : '';

      if (idxArrVuelo >= 0) {
        const vuelo = cleanVuelo(cells[idxArrVuelo]);
        if (vuelo && vuelo !== '-' && /[A-Z0-9]{3,}/.test(vuelo)) {
          const rawHora = (idxArrEta >= 0 && cells[idxArrEta] && cells[idxArrEta] !== '-')
            ? cells[idxArrEta]
            : (idxArrSta >= 0 ? cells[idxArrSta] : '');
          const parsed = parseHoraFecha(rawHora, hoyLima);
          if (parsed) {
            const id = parsed.fecha + '_' + vuelo + '_ACOPLE';
            registrosMap.set(id, {
              id: id,
              fecha: parsed.fecha,
              tipo: 'ACOPLE',
              vuelo: vuelo,
              ruta: idxArrOrigen >= 0 ? cleanTxt(cells[idxArrOrigen]) : '',
              pea: idxArrPea >= 0 ? cleanPea(cells[idxArrPea]) : '',
              hora_estimada: parsed.hora,
              hora_ts: parsed.horaTs,
              matricula: matricula
            });
          }
        }
      }

      if (idxDepVuelo >= 0) {
        const vuelo = cleanVuelo(cells[idxDepVuelo]);
        if (vuelo && vuelo !== '-' && /[A-Z0-9]{3,}/.test(vuelo)) {
          const rawHora = (idxDepEtd >= 0 && cells[idxDepEtd] && cells[idxDepEtd] !== '-')
            ? cells[idxDepEtd]
            : (idxDepStd >= 0 ? cells[idxDepStd] : '');
          const parsed = parseHoraFecha(rawHora, hoyLima);
          if (parsed) {
            const id = parsed.fecha + '_' + vuelo + '_DESACOPLE';
            registrosMap.set(id, {
              id: id,
              fecha: parsed.fecha,
              tipo: 'DESACOPLE',
              vuelo: vuelo,
              ruta: idxDepDest >= 0 ? cleanTxt(cells[idxDepDest]) : '',
              pea: idxDepPea >= 0 ? cleanPea(cells[idxDepPea]) : '',
              hora_estimada: parsed.hora,
              hora_ts: parsed.horaTs,
              matricula: matricula
            });
          }
        }
      }
    }

    const registros = Array.from(registrosMap.values());
    console.log('Eventos normalizados (Llegadas + Salidas): ' + registros.length);

    if (registros.length > 0) {
      for (let i = 0; i < registros.length; i += 100) {
        const chunk = registros.slice(i, i + 100);
        const up = await sb.from('siga_vuelos').upsert(chunk, { onConflict: 'id' });
        if (up.error) throw up.error;
      }

      const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
      await sb.from('siga_vuelos').delete().lt('hora_ts', cutoff);
    }

    await actualizarEstadoConfig({
      estado: registros.length > 0 ? 'ACTIVO' : 'ERROR',
      token_exp: expDate ? expDate.toISOString() : null,
      ultima_sync: new Date().toISOString(),
      total_vuelos: registros.length,
      ultimo_error: registros.length > 0 ? null : 'Se leyeron filas pero 0 vuelos normalizados.'
    });

    console.log('Sincronizacion completada.');
  } finally {
    await browser.close();
  }
}

main().catch(async function (err) {
  console.error('Error en sincronizacion:', err);
  try {
    await actualizarEstadoConfig({
      estado: 'ERROR',
      ultimo_error: String(err && err.message ? err.message : err).slice(0, 300)
    });
  } catch (e) {}
  process.exit(1);
});
