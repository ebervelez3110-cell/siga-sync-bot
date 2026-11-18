const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  await sb.from('siga_config').upsert({ id: 'LIM', updated_at: new Date().toISOString(), ...patch }, { onConflict: 'id' });
}

async function main() {
  console.log('🚀 Iniciando sincronización SIGA...');
  const { data: cfg, error: cfgErr } = await sb
    .from('siga_config')
    .select('*')
    .eq('id', 'LIM')
    .maybeSingle();

  if (cfgErr) throw cfgErr;
  if (!cfg || !cfg.url_siga || !cfg.url_siga.trim().startsWith('http')) {
    console.log('ℹ️ No hay link SIGA configurado en siga_config. Saliendo sin error.');
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
      viewport: { width: 1920, height: 1080 },
      locale: 'es-PE',
      timezoneId: 'America/Lima'
    });
    const page = await context.newPage();

    console.log('🌐 Abriendo pizarra...');
    await page.goto(urlSiga, { waitUntil: 'networkidle', timeout: 60000 });

    // Esperar a que carguen las filas reales de vuelos en la tabla
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('table tbody tr, [role="row"]');
      return rows.length >= 3;
    }, { timeout: 45000 });

    // Pequeña pausa extra para asegurar render completo de todas las celdas
    await page.waitForTimeout(2500);

    const extracted = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

      // 1. Localizar la tabla principal de vuelos (la que tiene más filas)
      const tables = Array.from(document.querySelectorAll('table'));
      let mainTable = tables[0];
      let maxRows = 0;
      for (const t of tables) {
        const count = t.querySelectorAll('tbody tr').length;
        if (count > maxRows) {
          maxRows = count;
          mainTable = t;
        }
      }
      if (!mainTable) return { headers: [], rows: [] };

      // 2. Tomar la última fila de thead como cabeceras reales de columnas
      const theadRows = Array.from(mainTable.querySelectorAll('thead tr'));
      const headerRow = theadRows[theadRows.length - 1];
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll('th, td')).map((el) => clean(el.innerText).toUpperCase())
        : [];

      // 3. Extraer todas las filas del tbody
      const bodyRows = Array.from(mainTable.querySelectorAll('tbody tr'));
      const rows = bodyRows.map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => clean(td.innerText))
      );

      return { headers, rows };
    });

    const { headers, rows } = extracted;
    console.log(`📊 Cabeceras detectadas (${headers.length}):`, headers.join(' | '));
    console.log(`📋 Filas detectadas: ${rows.length}`);

    if (!rows.length) {
      await actualizarEstadoConfig({
        estado: 'ERROR',
        ultimo_error: 'La página abrió pero no se encontraron filas de vuelos.'
      });
      return;
    }

    // Ubicar índices dinámicamente usando la columna PREFIX como eje central
    const idxPrefix = headers.findIndex((h) => h.includes('PREFIX') || h.includes('MATR'));
    const findBefore = (pred, limit) => {
      for (let i = 0; i < (limit >= 0 ? limit : headers.length); i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    };
    const findAfter = (pred, start) => {
      for (let i = Math.max(0, start + 1); i < headers.length; i++) {
        if (pred(headers[i])) return i;
      }
      return -1;
    };

    // Columnas de LLEGADAS (antes de PREFIX)
    const idxArrVuelo = findBefore((h) => h === 'VUELO' || h.includes('VUELO') || h === 'VOO', idxPrefix);
    const idxArrOrigen = findBefore((h) => h.includes('ORIGEN') || h.includes('ORIG'), idxPrefix);
    const idxArrPea = findBefore((h) => h.includes('P.POS') || h.includes('POS'), idxPrefix);
    const idxArrEta = findBefore((h) => h === 'ETA' || h.startsWith('ETA'), idxPrefix);
    const idxArrSta = findBefore((h) => h === 'STA' || h.startsWith('STA'), idxPrefix);

    // Columnas de SALIDAS (después de PREFIX)
    const idxDepVuelo = findAfter((h) => h === 'VUELO' || h.includes('VUELO') || h === 'VOO', idxPrefix);
    const idxDepDest = findAfter((h) => h.includes('DEST'), idxPrefix);
    const idxDepPea = findAfter((h) => h.includes('P.POS') || h.includes('POS'), idxPrefix);
    const idxDepEtd = findAfter((h) => h === 'ETD' || h.startsWith('ETD'), idxPrefix);
    const idxDepStd = findAfter((h) => h === 'STD' || h.startsWith('STD'), idxPrefix);

    const hoyLima = fechaHoyLima();
    const registrosMap = new Map();
    const cleanVuelo = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
    const cleanPea = (p) => String(p || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, '');
    const cleanMat = (m) => String(m || '').replace(/\s+/g, '').toUpperCase().replace(/^-$/, '');

    for (const cells of rows) {
      if (!cells || cells.length < 4) continue;
      const matricula = idxPrefix >= 0 ? cleanMat(cells[idxPrefix]) : '';

      // --- PROCESAR LLEGADA (ACOPLE) ---
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
              ruta: idxArrOrigen >= 0 ? cleanMat(cells[idxArrOrigen]) : '',
              pea: idxArrPea >= 0 ? cleanPea(cells[idxArrPea]) : '',
              hora_estimada: parsed.hora,
              hora_ts: parsed.horaTs,
              matricula
            });
          }
        }
      }

      // --- PROCESAR SALIDA (DESACOPLE) ---
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
              ruta: idxDepDest >= 0 ? cleanMat(cells[idxDepDest]) : '',
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

    if (registros.length > 0) {
      // Upsert en lotes de 100 (el trigger SQL detecta cambios de PEA/hora sin duplicar)
      for (let i = 0; i < registros.length; i += 100) {
        const chunk = registros.slice(i, i + 100);
        const { error: upErr } = await sb
          .from('siga_vuelos')
          .upsert(chunk, { onConflict: 'id' });
        if (upErr) throw upErr;
      }

      // Limpiar vuelos antiguos (> 36 horas atrás) para mantener la tabla ligera
      const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
      await sb.from('siga_vuelos').delete().lt('hora_ts', cutoff);
    }

    await actualizarEstadoConfig({
      estado: 'ACTIVO',
      token_exp: expDate ? expDate.toISOString() : null,
      ultima_sync: new Date().toISOString(),
      total_vuelos: registros.length,
      ultimo_error: null
    });

    console.log('✅ Sincronización completada con éxito.');
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
