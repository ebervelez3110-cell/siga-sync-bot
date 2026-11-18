```javascript
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
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
  } catch {
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
    fecha = `${mDate[3]}-${mDate[2]}-${mDate[1]}`;
  }
  const horaTs = `${fecha}T${hora}:00-05:00`;
  return { hora, fecha, horaTs };
}

function fechaHoyLima() {
  const now = new Date();
  const lima = new Date(now.getTime() - 5 * 3600 * 1000);
  return lima.toISOString().slice(0, 10);
}

async function actualizarEstadoConfig(patch) {
  await sb.from('siga_config').upsert(
    { id: 'LIM', updated_at: new Date().toISOString(), ...patch },
    { onConflict: 'id' }
  );
}

async function main() {
  console.log('🚀 Iniciando sincronización SIGA v2...');
  const { data: cfg, error: cfgErr } = await sb
    .from('siga_config')
    .select('*')
    .eq('id', 'LIM')
    .maybeSingle();

  if (cfgErr) throw cfgErr;
  if (!cfg || !cfg.url_siga || !cfg.url_siga.trim().startsWith('http')) {
    console.log('ℹ️ No hay link SIGA configurado en siga_config.');
    await actualizarEstadoConfig({ estado: 'SIN_LINK', ultimo_error: 'Pega un link vigente en CCO.' });
    return;
  }

  const urlSiga = cfg.url_siga.trim();
  const expDate = decodificarJwtExp(urlSiga);
  if (expDate && expDate.getTime() < Date.now()) {
    console.log(`⚠️ Link SIGA vencido desde ${expDate.toISOString()}`);
    await actualizarEstadoConfig({
      estado: 'VENCIDO',
      token_exp: expDate.toISOString(),
      ultimo_error: 'El enlace de 48h venció. Pega uno nuevo en CCO.'
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

    console.log('🌐 Abriendo pizarra...');
    await page.goto(urlSiga, { waitUntil: 'networkidle', timeout: 60000 });

    // Esperar a que aparezcan filas con códigos de vuelo (ej. LA2357)
    await page.waitForFunction(() => {
      const txt = document.body ? document.body.innerText : '';
      return /\b[A-Z]{2}\d{3,4}\b/.test(txt);
    }, { timeout: 45000 });

    await page.waitForTimeout(3000);

    const extracted = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const tables = Array.from(document.querySelectorAll('table'));

      // 1. Encontrar las filas de datos (soporta tabla única o tablas divididas thead/tbody)
      let mainTable = null;
      let maxRows = 0;
      for (const t of tables) {
        const count = t.querySelectorAll('tbody tr').length;
        if (count > maxRows) {
          maxRows = count;
          mainTable = t;
        }
      }

      let rows = [];
      let headers = [];

      if (mainTable && maxRows > 0) {
        rows = Array.from(mainTable.querySelectorAll('tbody tr'))
          .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => clean(td.innerText)))
          .filter((r) => r.length >= 4);

        // Buscar cabeceras primero dentro de mainTable y si no hay, en TODAS las tablas del documento
        const candidateHeaderRows = [
          ...Array.from(mainTable.querySelectorAll('thead tr')),
          ...Array.from(document.querySelectorAll('table thead tr'))
        ];

        const colCount = rows[0] ? rows[0].length : 0;
        let bestH = [];
        let bestScore = -1;
        for (const hr of candidateHeaderRows) {
          const hs = Array.from(hr.querySelectorAll('th, td')).map((el) => clean(el.innerText).toUpperCase());
          if (!hs.length) continue;
          let score = 0;
          if (hs.some((h) => h.includes('VUELO') || h === 'VOO')) score += 5;
          if (hs.some((h) => h.includes('ETA'))) score += 3;
          if (hs.some((h) => h.includes('ETD'))) score += 3;
          if (hs.some((h) => h.includes('PREFIX') || h.includes('MATR'))) score += 4;
          if (colCount && hs.length === colCount) score += 6;
          score += hs.length * 0.05;
          if (score > bestScore) {
            bestScore = score;
            bestH = hs;
          }
        }
        headers = bestH;
      }

      // 2. Fallback si la pizarra usa grid ARIA en vez de <table>
      if (!rows.length) {
        const ariaHeaders = Array.from(document.querySelectorAll('[role="columnheader"]'))
          .map((el) => clean(el.innerText).toUpperCase());
        const ariaRows = Array.from(document.querySelectorAll('[role="row"]'))
          .map((r) => Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"]')).map((c) => clean(c.innerText)))
          .filter((r) => r.length >= 4);
        if (ariaRows.length) {
          headers = ariaHeaders;
          rows = ariaRows;
        }
      }

      return { tableCount: tables.length, headers, rows };
    });

    const { tableCount, headers, rows } = extracted;
    console.log(`🔎 Tablas en DOM: ${tableCount} | Cabeceras (${headers.length}):`, headers.join(' | '));
    console.log(`📋 Filas detectadas: ${rows.length}`);
    if (rows[0]) console.log('🧪 Ejemplo fila 0:', JSON.stringify(rows[0]));

    if (!rows.length) {
      await actualizarEstadoConfig({
        estado: 'ERROR',
        ultimo_error: 'La página cargó pero no se encontraron filas en la tabla.'
      });
      return;
    }

    // Detectar índice de PREFIX por cabecera o por patrón de matrícula (CC-XXX, PR-XXX, etc.)
    let idxPrefix = headers.findIndex((h) => h.includes('PREFIX') || h.includes('MATR'));
    if (idxPrefix < 0) {
      const counts = {};
      for (const r of rows.slice(0, 30)) {
        r.forEach((val, idx) => {
          if (/^[A-Z]{2}-[A-Z0-9]{3,5}$/.test(val.trim())) {
            counts[idx] = (counts[idx] || 0) + 1;
          }
        });
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (best) idxPrefix = parseInt(best[0], 10);
    }

    const findBefore = (pred, limit) => {
      const end = limit >= 0 ? limit : headers.length;
      for (let i = 0; i < end; i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    };
    const findAfter = (pred, start) => {
      if (start < 0) return -1;
      for (let i = start + 1; i < headers.length; i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    };

    const idxArrVuelo = findBefore((h) => h === 'VUELO' || h.includes('VUELO') || h === 'VOO', idxPrefix);
    const idxArrOrigen = findBefore((h) => h.includes('ORIGEN') || h.includes('ORIG'), idxPrefix);
    const idxArrPea = findBefore((h) => h.includes('P.POS') || h.includes('POS'), idxPrefix);
    const idxArrEta = findBefore((h) => h === 'ETA' || h.startsWith('ETA'), idxPrefix);
    const idxArrSta = findBefore((h) => h === 'STA' || h.startsWith('STA'), idxPrefix);

    const idxDepVuelo = findAfter((h) => h === 'VUELO' || h.includes('VUELO') || h === 'VOO', idxPrefix);
    const idxDepDest = findAfter((h) => h.includes('DEST'), idxPrefix);
    const idxDepPea = findAfter((h) => h.includes('P.POS') || h.includes('POS'), idxPrefix);
    const idxDepEtd = findAfter((h) => h === 'ETD' || h.startsWith('ETD'), idxPrefix);
    const idxDepStd = findAfter((h) => h === 'STD' || h.startsWith('STD'), idxPrefix);

    console.log('🧭 Índices detectados:', JSON.stringify({
      idxPrefix, idxArrVuelo, idxArrOrigen, idxArrPea, idxArrEta, idxArrSta,
      idxDepVuelo, idxDepDest, idxDepPea, idxDepEtd, idxDepStd
    }));

    const hoyLima = fechaHoyLima();
    const registrosMap = new Map();
    const cleanVuelo = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
    const cleanPea = (p) => String(p || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, '');
    const cleanTxt = (m) => String(m || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, '');

    for (const cells of rows) {
      if (!cells || cells.length < 4) continue;
      const matricula = idxPrefix >= 0 ? cleanTxt(cells[idxPrefix]) : '';

      // LLEGADA (ACOPLE)
      if (idxArrVuelo >= 0) {
        const vuelo = cleanVuelo(cells[idxArrVuelo]);
        if (vuelo && vuelo !== '-' && /[A-Z0-9]{3,}/.test(vuelo)) {
          const rawHora = (idxArrEta >= 0 && cells[idxArrEta] && cells[idxArrEta] !== '-')
            ? cells[idxArrEta]
            : (idxArrSta >= 0 ? cells[idxArrSta] : '');
          const parsed = parseHoraFecha(rawHora, hoyLima);
          if (parsed) {
            const id = `${parsed.fecha}_${vuelo}_ACOPLE`;
            registrosMap.set(id, {
              id,
              fecha: parsed.fecha,
              tipo: 'ACOPLE',
              vuelo,
              ruta: idxArrOrigen >= 0 ? cleanTxt(cells[idxArrOrigen]) : '',
              pea: idxArrPea >= 0 ? cleanPea(cells[idxArrPea]) : '',
              hora_estimada: parsed.hora,
              hora_ts: parsed.horaTs,
              matricula
            });
          }
        }
      }

      // SALIDA (DESACOPLE)
      if (idxDepVuelo >= 0) {
        const vuelo = cleanVuelo(cells[idxDepVuelo]);
        if (vuelo && vuelo !== '-' && /[A-Z0-9]{3,}/.test(vuelo)) {
          const rawHora = (idxDepEtd >= 0 && cells[idxDepEtd] && cells[idxDepEtd] !== '-')
            ? cells[idxDepEtd]
            : (idxDepStd >= 0 ? cells[idxDepStd] : '');
          const parsed = parseHoraFecha(rawHora, hoyLima);
          if (parsed) {
            const id = `${parsed.fecha}_${vuelo}_DESACOPLE`;
            registrosMap.set(id, {
              id,
              fecha: parsed.fecha,
              tipo: 'DESACOPLE',
              vuelo,
              ruta: idxDepDest >= 0 ? cleanTxt(cells[idxDepDest]) : '',
              pea: idxDepPea >= 0 ? cleanPea(cells[idxDepPea]) : '',
              hora_estimada: parsed.hora,
              hora_ts: parsed.horaTs,
              matricula
            });
          }
        }
      }
    }

    const registros = Array.from(registrosMap.values());
    console.log(`✈️ Eventos normalizados (Llegadas + Salidas sin duplicados): ${registros.length}`);
    if (registros[0]) console.log('🧪 Muestra registro 0:', JSON.stringify(registros[0]));

    if (registros.length > 0) {
      for (let i = 0; i < registros.length; i += 100) {
        const chunk = registros.slice(i, i + 100);
        const { error: upErr } = await sb
          .from('siga_vuelos')
          .upsert(chunk, { onConflict: 'id' });
        if (upErr) throw upErr;
      }

      const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
      await sb.from('siga_vuelos').delete().lt('hora_ts', cutoff);
    }

    await actualizarEstadoConfig({
      estado: registros.length > 0 ? 'ACTIVO' : 'ERROR',
      token_exp: expDate ? expDate.toISOString() : null,
      ultima_sync: new Date().toISOString(),
      total_vuelos: registros.length,
      ultimo_error: registros.length > 0 ? null : 'Se leyeron filas pero 0 vuelos normalizados (revisar cabeceras en Actions).'
    });

    console.log('✅ Sincronización completada.');
  } finally {
    await browser.close();
  }
}

main().catch(async (err) => {
  console.error('❌ Error en sincronización:', err);
  try {
    await actualizarEstadoConfig({
      estado: 'ERROR',
      ultimo_error: String(err.message || err).slice(0, 300)
    });
  } catch {}
  process.exit(1);
});
```
