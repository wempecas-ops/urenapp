// ============================================================================
// /api/admin-users  —  Vercel serverless function
// ============================================================================
// Waarom deze functie nodig is:
// Een account met wachtwoord aanmaken kan NIET vanuit de browser. Daarvoor is
// de service_role-sleutel van Supabase nodig, en die mag nooit in de browser
// staan (wie hem heeft, heeft volledige toegang tot je database). Daarom loopt
// het via deze functie: de sleutel staat als omgevingsvariabele op Vercel.
//
// Instellen op Vercel (Project -> Settings -> Environment Variables):
//   SUPABASE_URL                https://xxxx.supabase.co
//   SUPABASE_ANON_KEY           je anon public key
//   SUPABASE_SERVICE_ROLE_KEY   je service_role key  (GEHEIM, alleen hier)
//   URENAPP_EMAIL_DOMEIN        optioneel, standaard urenapp.local
//
// De functie controleert eerst of de aanroeper een ingelogde beheerder is.

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DOMEIN = process.env.URENAPP_EMAIL_DOMEIN || 'urenapp.local';

const naarEmail = g => {
  g = String(g || '').trim().toLowerCase();
  return g.includes('@') ? g : g + '@' + DOMEIN;
};

async function sb(pad, opties) {
  opties = opties || {};
  const sleutel = opties.service ? SERVICE : ANON;
  const headers = {
    'apikey': sleutel,
    'Authorization': 'Bearer ' + (opties.token || sleutel),
    'Content-Type': 'application/json'
  };
  if (opties.prefer) headers['Prefer'] = opties.prefer;
  const r = await fetch(URL_SB + pad, {
    method: opties.method || 'GET',
    headers,
    body: opties.body ? JSON.stringify(opties.body) : undefined
  });
  const tekst = await r.text();
  let data = null;
  try { data = tekst ? JSON.parse(tekst) : null } catch (e) { data = null }
  if (!r.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || ('Supabase-fout ' + r.status);
    const fout = new Error(msg);
    fout.status = r.status;
    throw fout;
  }
  return data;
}

module.exports = async (req, res) => {
  const stuur = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) };

  if (req.method !== 'POST') return stuur(405, { fout: 'Gebruik POST' });
  if (!URL_SB || !ANON || !SERVICE) {
    return stuur(500, { fout: 'De omgevingsvariabelen SUPABASE_URL, SUPABASE_ANON_KEY en SUPABASE_SERVICE_ROLE_KEY zijn nog niet ingesteld op Vercel.' });
  }

  // ---- 1. wie roept dit aan? ----
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return stuur(401, { fout: 'Niet ingelogd' });

  let beller = null;
  try { beller = await sb('/auth/v1/user', { token }) } catch (e) { return stuur(401, { fout: 'Sessie ongeldig of verlopen' }) }
  if (!beller || !beller.id) return stuur(401, { fout: 'Sessie ongeldig' });

  // ---- 2. is de aanroeper beheerder? ----
  let profielen = [];
  try { profielen = await sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(beller.id) + '&select=rol,actief', { service: true }) } catch (e) { return stuur(500, { fout: e.message }) }
  const eigen = Array.isArray(profielen) ? profielen[0] : null;
  if (!eigen || eigen.rol !== 'beheer' || eigen.actief === false) {
    return stuur(403, { fout: 'Alleen een beheerder mag accounts beheren' });
  }

  // ---- 3. de actie uitvoeren ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = null } }
  if (!body || !body.actie) return stuur(400, { fout: 'Geen actie opgegeven' });

  try {
    if (body.actie === 'list') {
      const prof = await sb('/rest/v1/profiles?select=*&order=gebruikersnaam.asc', { service: true });
      return stuur(200, { accounts: (prof || []).map(p => ({
        id: p.id, gebruikersnaam: p.gebruikersnaam, naam: p.naam,
        rol: p.rol, werknemer_id: p.werknemer_id, actief: p.actief !== false
      })) });
    }

    if (body.actie === 'create') {
      const gebruikersnaam = String(body.gebruikersnaam || '').trim().toLowerCase();
      const naam = String(body.naam || '').trim();
      const wachtwoord = String(body.wachtwoord || '');
      const rol = body.rol === 'beheer' ? 'beheer' : 'medewerker';
      const werknemerId = body.werknemer_id || null;
      if (!gebruikersnaam || !wachtwoord) return stuur(400, { fout: 'Gebruikersnaam en wachtwoord zijn verplicht' });
      if (wachtwoord.length < 6) return stuur(400, { fout: 'Kies een wachtwoord van minstens 6 tekens' });
      if (rol === 'medewerker' && !werknemerId) return stuur(400, { fout: 'Kies aan welke werknemer dit account gekoppeld is' });

      const bestaat = await sb('/rest/v1/profiles?gebruikersnaam=eq.' + encodeURIComponent(gebruikersnaam) + '&select=id', { service: true });
      if (Array.isArray(bestaat) && bestaat.length) return stuur(409, { fout: 'Die gebruikersnaam bestaat al' });

      let nieuw = null;
      try {
        nieuw = await sb('/auth/v1/admin/users', {
          service: true, method: 'POST',
          body: { email: naarEmail(gebruikersnaam), password: wachtwoord, email_confirm: true, user_metadata: { naam } }
        });
      } catch (e) {
        if (/already|exists|registered/i.test(e.message)) return stuur(409, { fout: 'Dat e-mailadres is al in gebruik in Supabase Auth' });
        throw e;
      }
      const uid = nieuw && (nieuw.id || (nieuw.user && nieuw.user.id));
      if (!uid) return stuur(500, { fout: 'Gebruiker aangemaakt maar geen id teruggekregen' });

      await sb('/rest/v1/profiles', {
        service: true, method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
        body: { id: uid, gebruikersnaam, naam, rol, werknemer_id: werknemerId, actief: true }
      });
      return stuur(200, { ok: true, id: uid });
    }

    if (body.actie === 'reset') {
      const id = body.id, wachtwoord = String(body.wachtwoord || '');
      if (!id || wachtwoord.length < 6) return stuur(400, { fout: 'Kies een wachtwoord van minstens 6 tekens' });
      await sb('/auth/v1/admin/users/' + encodeURIComponent(id), { service: true, method: 'PUT', body: { password: wachtwoord } });
      return stuur(200, { ok: true });
    }

    if (body.actie === 'toggle') {
      const id = body.id;
      if (!id) return stuur(400, { fout: 'Geen account opgegeven' });
      const actief = body.actief !== false;
      await sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(id), { service: true, method: 'PATCH', body: { actief } });
      return stuur(200, { ok: true, actief });
    }

    return stuur(400, { fout: 'Onbekende actie: ' + body.actie });
  } catch (e) {
    return stuur(e.status && e.status >= 400 && e.status < 500 ? e.status : 500, { fout: e.message });
  }
};

