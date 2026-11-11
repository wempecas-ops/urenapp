// ============================================================================
// /api/kvk  —  bedrijfsgegevens ophalen bij de KVK (Handelsregister)
// ============================================================================
// Gebruikt in Klanten -> Nieuwe klant / Wijzig: vul een KvK-nummer (of een stuk
// van de bedrijfsnaam) in en druk op "Ophalen bij KvK". Naam, adres, postcode en
// plaats worden dan automatisch ingevuld.
//
// Bron: de officiële KVK API's (developers.kvk.nl).
//   - Zoeken       (gratis per vraag)  -> naam, adres, plaats
//   - Basisprofiel (€ 0,02 per vraag)  -> alleen als Zoeken geen volledig adres geeft
// Daarvoor is een KVK API-abonnement nodig; de sleutel zet je op Vercel als
//   KVK_API_KEY   (Project -> Settings -> Environment Variables)
// Zonder sleutel geeft deze functie een nette melding terug.
//
// Alleen ingelogde beheerders mogen deze functie aanroepen.

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const KVK_KEY = process.env.KVK_API_KEY || '';
const KVK = (process.env.KVK_API_URL || 'https://api.kvk.nl/api').replace(/\/+$/, '');

async function magAanroepen(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !URL_SB || !ANON || !SERVICE) return false;
  try {
    const u = await fetch(URL_SB + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!u.ok) return false;
    const g = await u.json();
    const r = await fetch(URL_SB + '/rest/v1/profiles?id=eq.' + encodeURIComponent(g.id) + '&select=rol,actief', { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE } });
    const p = await r.json();
    return !!(p && p[0] && p[0].rol === 'beheer' && p[0].actief !== false);
  } catch (e) { return false }
}

async function kvk(pad) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(KVK + pad, { headers: { apikey: KVK_KEY, Accept: 'application/json' }, signal: ctl.signal });
    const tekst = await r.text();
    let data = null; try { data = tekst ? JSON.parse(tekst) : null } catch (e) {}
    if (r.status === 404) return null;
    if (!r.ok) {
      const msg = (data && (data.fout && data.fout[0] && data.fout[0].omschrijving)) || ('KVK gaf foutcode ' + r.status);
      const f = new Error(msg); f.status = r.status; throw f;
    }
    return data;
  } finally { clearTimeout(t) }
}

const huisnr = a => [a.huisnummer, a.huisletter, a.huisnummerToevoeging].filter(x => x !== undefined && x !== null && String(x).trim() !== '').join('');
const postcode = p => { const s = String(p || '').toUpperCase().replace(/\s+/g, ''); return /^\d{4}[A-Z]{2}$/.test(s) ? s : String(p || '') };

// Eén resultaat uit Zoeken omzetten naar wat de klantkaart nodig heeft
function uitZoeken(r) {
  const a = (r.adres && (r.adres.binnenlandsAdres || r.adres.buitenlandsAdres)) || {};
  return {
    kvk: r.kvkNummer || '',
    naam: r.naam || '',
    adres: [a.straatnaam, huisnr(a)].filter(Boolean).join(' ') || '',
    postcode: postcode(a.postcode),
    plaats: a.plaats || '',
    type: r.type || ''
  };
}

// Adres van de hoofdvestiging uit het Basisprofiel
async function uitBasisprofiel(nummer) {
  const b = await kvk('/v1/basisprofielen/' + nummer + '?geoData=false');
  if (!b) return null;
  const hv = (b._embedded && b._embedded.hoofdvestiging) || {};
  const adressen = hv.adressen || [];
  const a = adressen.find(x => x.type === 'bezoekadres') || adressen[0] || {};
  return {
    kvk: b.kvkNummer || nummer,
    naam: (hv.eersteHandelsnaam) || b.naam || ((b.handelsnamen || [])[0] || {}).naam || '',
    adres: [a.straatnaam, huisnr(a)].filter(Boolean).join(' ') || a.volledigAdres || '',
    postcode: postcode(a.postcode),
    plaats: a.plaats || '',
    type: 'hoofdvestiging'
  };
}

module.exports = async (req, res) => {
  const stuur = (c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) };
  if (!await magAanroepen(req)) return stuur(401, { fout: 'Niet toegestaan' });
  if (!KVK_KEY) return stuur(500, { fout: 'Er staat nog geen KVK-sleutel op Vercel (KVK_API_KEY). Vraag een API-abonnement aan op developers.kvk.nl en zet de sleutel bij Environment Variables.' });

  const url = new URL(req.url, 'http://x');
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) return stuur(400, { fout: 'Vul een KvK-nummer of bedrijfsnaam in' });

  try {
    const nummer = q.replace(/\D/g, '');
    if (/^\d{8}$/.test(nummer) && nummer.length === q.replace(/[\s.]/g, '').length) {
      // Op KvK-nummer: eerst Zoeken (gratis), alleen bij een onvolledig adres het Basisprofiel
      const z = await kvk('/v2/zoeken?kvkNummer=' + nummer + '&resultatenPerPagina=10');
      const lijst = ((z && z.resultaten) || []).map(uitZoeken);
      let best = lijst.find(r => r.type === 'hoofdvestiging') || lijst[0] || null;
      if (!best || !best.adres || !best.postcode) {
        const b = await uitBasisprofiel(nummer);
        if (b) best = Object.assign({}, best || {}, Object.fromEntries(Object.entries(b).filter(([, v]) => v)));
      }
      if (!best) return stuur(404, { fout: 'Geen bedrijf gevonden met KvK-nummer ' + nummer });
      return stuur(200, { resultaten: [best] });
    }
    // Op naam: lijst met hoofdvestigingen om uit te kiezen
    const z = await kvk('/v2/zoeken?naam=' + encodeURIComponent(q) + '&type=hoofdvestiging&resultatenPerPagina=10');
    const lijst = ((z && z.resultaten) || []).map(uitZoeken);
    if (!lijst.length) return stuur(404, { fout: 'Niets gevonden bij de KvK voor "' + q + '"' });
    return stuur(200, { resultaten: lijst });
  } catch (e) {
    return stuur(e.status === 401 || e.status === 403 ? 500 : 502, { fout: e.status === 401 || e.status === 403 ? 'De KVK-sleutel wordt niet geaccepteerd. Controleer KVK_API_KEY op Vercel.' : 'KvK niet bereikbaar: ' + e.message });
  }
};
