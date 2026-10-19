// ============================================================================
// /api/backup  —  dagelijkse automatische back-up (Vercel Cron, zie vercel.json)
// ============================================================================
// Leest alle tabellen met de service_role-sleutel en bewaart ze als 1 JSON-bestand
// in de besloten Supabase Storage-bucket "backups" (backup-JJJJ-MM-DD.json).
// De laatste 30 back-ups blijven bewaard, oudere worden opgeruimd.
// Omgevingsvariabelen: SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY (staan er al),
// optioneel CRON_SECRET (dan moet de aanroep dat geheim meesturen; Vercel doet dat zelf).

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABELLEN = ['werknemers', 'klanten', 'diensten', 'diensten_tarief', 'materieel', 'dagstaten', 'profiles'];
const BEWAAR = 30;

const kop = extra => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE }, extra || {});

async function haalTabel(t) {
  let alles = [], van = 0;
  for (;;) {
    const r = await fetch(`${URL_SB}/rest/v1/${t}?select=*&order=${t === 'diensten_tarief' ? 'dienst_id' : 'id'}.asc&limit=1000&offset=${van}`, { headers: kop() });
    if (!r.ok) throw new Error(`${t}: ${r.status} ${await r.text()}`);
    const rijen = await r.json();
    alles = alles.concat(rijen);
    if (rijen.length < 1000) break;
    van += 1000;
  }
  return alles;
}

module.exports = async (req, res) => {
  try {
    if (!URL_SB || !SERVICE) return res.status(500).json({ error: 'Omgevingsvariabelen ontbreken' });
    if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401).json({ error: 'Niet toegestaan' });

    const data = { gemaakt: new Date().toISOString() };
    for (const t of TABELLEN) {
      try { data[t] = await haalTabel(t) }
      catch (e) { if (t === 'materieel') data[t] = []; else throw e }   // materieel mag ontbreken tot de tabel bestaat
    }

    const naam = 'backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const up = await fetch(`${URL_SB}/storage/v1/object/backups/${naam}`, {
      method: 'POST', headers: kop({ 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: JSON.stringify(data)
    });
    if (!up.ok) throw new Error('Uploaden mislukt: ' + up.status + ' ' + await up.text());

    // opruimen: alleen de laatste BEWAAR bestanden houden
    const lijst = await fetch(`${URL_SB}/storage/v1/object/list/backups`, {
      method: 'POST', headers: kop({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'name', order: 'desc' } })
    });
    if (lijst.ok) {
      const namen = (await lijst.json()).map(f => f.name).filter(n => /^backup-.*\.json$/.test(n)).sort().reverse();
      const weg = namen.slice(BEWAAR);
      if (weg.length) await fetch(`${URL_SB}/storage/v1/object/backups`, { method: 'DELETE', headers: kop({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: weg }) });
    }
    res.status(200).json({ ok: true, bestand: naam, rijen: TABELLEN.reduce((s, t) => s + data[t].length, 0) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
