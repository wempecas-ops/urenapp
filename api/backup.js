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
const TABELLEN = ['werknemers', 'klanten', 'diensten', 'diensten_tarief', 'materieel', 'dagstaten', 'profiles',
  'orders', 'planningen', 'vervaldata', 'klus_notities', 'producten', 'facturen', 'facturen_mts', 'vrachten', 'instellingen', 'factuur_teller'];
const MAG_ONTBREKEN = new Set(['materieel', 'orders', 'planningen', 'vervaldata', 'klus_notities', 'producten', 'facturen', 'facturen_mts', 'vrachten', 'instellingen', 'factuur_teller']);
const BEWAAR = 30;

const kop = extra => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE }, extra || {});
const pad = p => p.split('/').map(encodeURIComponent).join('/');

// Alle bestanden in een bucket (mappen worden doorlopen). Geeft [{naam, grootte}]
async function lijstAlles(bucket, prefix) {
  const uit = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${URL_SB}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: kop({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix: prefix || '', limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    if (!r.ok) throw new Error('Lijst ' + bucket + ': ' + r.status);
    const items = await r.json();
    for (const it of items) {
      const vol = (prefix ? prefix + '/' : '') + it.name;
      if (it.id === null || it.id === undefined) uit.push(...await lijstAlles(bucket, vol));   // map
      else uit.push({ naam: vol, grootte: (it.metadata && it.metadata.size) || 0 });
    }
    if (items.length < 1000) break;
  }
  return uit;
}

// Bijlagen (foto's van klussen, bijlagen en pdf's van facturen) kopiëren naar de backup-bucket,
// onder backups/bijlagen/... Alleen nieuwe bestanden; wat eenmaal gekopieerd is blijft bewaard,
// ook als het origineel later wordt verwijderd. Per nacht maximaal ~45 seconden werk; de rest volgt de nacht erna.
async function spiegelBijlagen(start) {
  const bron = await lijstAlles('bijlagen', '');
  let al = new Set();
  try { al = new Set((await lijstAlles('backups', 'bijlagen')).map(x => x.naam.replace(/^bijlagen\//, ''))) } catch (e) {}
  const nieuw = bron.filter(x => !al.has(x.naam));
  let gekopieerd = 0, mislukt = 0;
  for (const x of nieuw) {
    if (Date.now() - start > 45000) break;
    try {
      const d = await fetch(`${URL_SB}/storage/v1/object/bijlagen/${pad(x.naam)}`, { headers: kop() });
      if (!d.ok) throw new Error('ophalen ' + d.status);
      const buf = Buffer.from(await d.arrayBuffer());
      const u = await fetch(`${URL_SB}/storage/v1/object/backups/bijlagen/${pad(x.naam)}`, { method: 'POST', headers: kop({ 'Content-Type': d.headers.get('content-type') || 'application/octet-stream', 'x-upsert': 'true' }), body: buf });
      if (!u.ok) throw new Error('opslaan ' + u.status);
      gekopieerd++;
    } catch (e) { mislukt++ }
  }
  return { totaal: bron.length, alInBackup: bron.length - nieuw.length, gekopieerd, mislukt, nogTeGaan: Math.max(0, nieuw.length - gekopieerd - mislukt) };
}

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

    const start = Date.now();
    const data = { gemaakt: new Date().toISOString() };
    for (const t of TABELLEN) {
      try { data[t] = await haalTabel(t) }
      catch (e) { if (MAG_ONTBREKEN.has(t)) data[t] = []; else throw e }   // nieuwere tabellen mogen ontbreken tot ze bestaan
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
    let bijlagen = null;
    try { bijlagen = await spiegelBijlagen(start) } catch (e) { bijlagen = { fout: String(e.message || e) } }
    res.status(200).json({ ok: true, bestand: naam, rijen: TABELLEN.reduce((s, t) => s + (data[t] || []).length, 0), bijlagen });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
