// ============================================================================
// /api/apk  —  APK- en tachograafdata ophalen bij de RDW (open data)
// ============================================================================
// Voor elk actief voertuig in "materieel" met een kenteken vraagt deze functie de
// vervaldatum van de APK (en, als de RDW die kent, van de tachograaf) op bij
// opendata.rdw.nl (dezelfde bron die kentekencheck gebruikt). De datum komt in
// "vervaldata" (tabblad Keuringen), zodat de waarschuwingen op het dashboard kloppen.
//
// Wordt elke nacht aangeroepen door Vercel Cron (zie vercel.json) en kan ook met de
// knop "Ophalen bij RDW" in Keuringen (alleen beheer).
// Omgevingsvariabelen: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (staan er al),
// optioneel CRON_SECRET en RDW_APP_TOKEN (niet nodig bij een paar voertuigen).

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RDW = 'https://opendata.rdw.nl/resource/m9d7-ebf2.json';

const kop = extra => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE }, extra || {});
async function sb(pad, opties) {
  opties = opties || {};
  const r = await fetch(URL_SB + pad, { method: opties.method || 'GET', headers: kop(Object.assign(opties.body !== undefined ? { 'Content-Type': 'application/json' } : {}, opties.prefer ? { Prefer: opties.prefer } : {})), body: opties.body !== undefined ? JSON.stringify(opties.body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// "20270315" of "2027-03-15T00:00:00.000" -> "2027-03-15"
function datum(v) {
  const s = String(v || '').trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}
const schoon = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function rdw(kenteken) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const h = process.env.RDW_APP_TOKEN ? { 'X-App-Token': process.env.RDW_APP_TOKEN } : {};
    const r = await fetch(RDW + '?kenteken=' + encodeURIComponent(kenteken), { headers: h, signal: ctl.signal });
    if (!r.ok) throw new Error('RDW ' + r.status);
    const rij = (await r.json())[0];
    if (!rij) return null;
    return {
      apk: datum(rij.vervaldatum_apk_dt || rij.vervaldatum_apk),
      tacho: datum(rij.vervaldatum_tachograaf_dt || rij.vervaldatum_tachograaf),
      merk: [rij.merk, rij.handelsbenaming].filter(Boolean).join(' ')
    };
  } finally { clearTimeout(t) }
}

async function magAanroepen(req) {
  const auth = String(req.headers.authorization || '');
  if (process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) return true;
  if (!process.env.CRON_SECRET && /vercel-cron/i.test(String(req.headers['user-agent'] || ''))) return true;
  // Anders: een ingelogde beheerder
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !ANON) return false;
  try {
    const u = await fetch(URL_SB + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!u.ok) return false;
    const gebruiker = await u.json();
    const p = await sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(gebruiker.id) + '&select=rol,actief');
    return !!(p && p[0] && p[0].rol === 'beheer' && p[0].actief !== false);
  } catch (e) { return false }
}

module.exports = async (req, res) => {
  const stuur = (c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) };
  if (!URL_SB || !SERVICE) return stuur(500, { fout: 'De Supabase-instellingen ontbreken op Vercel.' });
  if (!await magAanroepen(req)) return stuur(401, { fout: 'Niet toegestaan' });

  const uit = { gecontroleerd: 0, bijgewerkt: [], nieuw: [], ongewijzigd: 0, nietGevonden: [], fouten: [] };
  try {
    const mat = (await sb('/rest/v1/materieel?select=id,kenteken,omschrijving,actief') || []).filter(m => m.actief !== false && schoon(m.kenteken).length >= 4);
    const bestaand = await sb('/rest/v1/vervaldata?type=eq.voertuig&select=id,ref_id,soort,vervaldatum,opmerking') || [];
    for (const m of mat) {
      const k = schoon(m.kenteken);
      let info;
      try { info = await rdw(k) } catch (e) { uit.fouten.push(m.kenteken + ': ' + e.message); continue }
      uit.gecontroleerd++;
      if (!info) { uit.nietGevonden.push(m.kenteken); continue }
      for (const [soort, dat] of [['APK', info.apk], ['Tachograaf-keuring', info.tacho]]) {
        if (!dat) continue;
        const rij = bestaand.find(v => v.ref_id === m.id && v.soort === soort);
        if (rij) {
          if (rij.vervaldatum === dat) { uit.ongewijzigd++; continue }
          await sb('/rest/v1/vervaldata?id=eq.' + encodeURIComponent(rij.id), { method: 'PATCH', prefer: 'return=minimal', body: { vervaldatum: dat, opmerking: 'Automatisch bijgewerkt via RDW' } });
          uit.bijgewerkt.push(m.kenteken + ' ' + soort + ': ' + (rij.vervaldatum || '—') + ' → ' + dat);
        } else {
          await sb('/rest/v1/vervaldata', { method: 'POST', prefer: 'return=minimal', body: { id: 'rdw-' + soort.toLowerCase().replace(/[^a-z]/g, '') + '-' + m.id, type: 'voertuig', ref_id: m.id, soort, vervaldatum: dat, opmerking: 'Automatisch bijgewerkt via RDW' } });
          uit.nieuw.push(m.kenteken + ' ' + soort + ': ' + dat);
        }
      }
    }
  } catch (e) { return stuur(500, Object.assign(uit, { fout: e.message })) }
  return stuur(200, Object.assign({ ok: true }, uit));
};
