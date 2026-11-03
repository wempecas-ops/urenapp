// ============================================================================
// /api/factuur-mail  —  verstuurt een definitieve factuur per mail (Vercel)
// ============================================================================
// De browser zet de factuur-pdf en eventuele bijlagen eerst in de besloten
// opslag (bucket "bijlagen", map facturen/<factuur-id>/). Deze functie haalt
// ze daar op en verstuurt de mail via Gmail (of een andere SMTP-server).
// Zo blijft het app-wachtwoord van de mailbox op de server en komt het nooit
// in de browser.
//
// Omgevingsvariabelen op Vercel (Settings -> Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (staan er al)
//   GMAIL_USER            bijv. facturencaswempe@gmail.com
//   GMAIL_APP_PASSWORD    app-wachtwoord van Google (16 letters, zonder spaties)
//   Optioneel, voor een andere mailbox dan Gmail (bijv. later @caswempe.nl):
//   SMTP_HOST, SMTP_PORT (465 of 587), SMTP_USER, SMTP_PASS
const nodemailer = require('nodemailer');

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAIL_USER = process.env.SMTP_USER || process.env.GMAIL_USER || '';
const MAIL_PASS = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const MAX_BYTES = 18 * 1024 * 1024;   // ~18 MB aan bestanden = ~24,7 MB mail (Gmail-grens is 25 MB)
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

async function sb(pad, opties) {
  opties = opties || {};
  const sleutel = opties.service ? SERVICE : ANON;
  const headers = Object.assign({ apikey: sleutel, Authorization: 'Bearer ' + (opties.token || sleutel) }, opties.headers || {});
  if (opties.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opties.prefer) headers.Prefer = opties.prefer;
  const r = await fetch(URL_SB + pad, { method: opties.method || 'GET', headers, body: opties.body !== undefined ? JSON.stringify(opties.body) : undefined });
  if (opties.binair) {
    if (!r.ok) throw new Error('Bestand niet gevonden (' + r.status + ')');
    return Buffer.from(await r.arrayBuffer());
  }
  const tekst = await r.text();
  let data = null;
  try { data = tekst ? JSON.parse(tekst) : null } catch (e) { data = null }
  if (!r.ok) throw new Error((data && (data.message || data.msg || data.error_description || data.error)) || ('Supabase-fout ' + r.status));
  return data;
}

function maakTransport() {
  if (process.env.SMTP_HOST) {
    const poort = Number(process.env.SMTP_PORT || 465);
    return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: poort, secure: poort === 465, auth: { user: MAIL_USER, pass: MAIL_PASS } });
  }
  return nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: MAIL_USER, pass: MAIL_PASS } });
}

const lijst = v => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean);
const veiligeNaam = n => String(n || 'bijlage').replace(/[\r\n"\\/:*?<>|]/g, '').slice(0, 120) || 'bijlage';

module.exports = async (req, res) => {
  const stuur = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) };
  if (req.method !== 'POST') return stuur(405, { fout: 'Gebruik POST' });
  if (!URL_SB || !ANON || !SERVICE) return stuur(500, { fout: 'De Supabase-instellingen ontbreken op Vercel.' });
  if (!MAIL_USER || !MAIL_PASS) return stuur(500, { fout: 'De mailinstellingen ontbreken op Vercel (GMAIL_USER en GMAIL_APP_PASSWORD).' });

  // ---- 1. alleen een ingelogde beheerder ----
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return stuur(401, { fout: 'Niet ingelogd' });
  let beller;
  try { beller = await sb('/auth/v1/user', { token }) } catch (e) { return stuur(401, { fout: 'Sessie ongeldig of verlopen' }) }
  let prof = [];
  try { prof = await sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(beller.id) + '&select=rol,actief,naam', { service: true }) } catch (e) { return stuur(500, { fout: e.message }) }
  const eigen = Array.isArray(prof) ? prof[0] : null;
  if (!eigen || eigen.rol !== 'beheer' || eigen.actief === false) return stuur(403, { fout: 'Alleen een beheerder mag facturen versturen' });

  // ---- 2. aanvraag controleren ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = null } }
  if (!body || !body.factuurId) return stuur(400, { fout: 'Geen factuur opgegeven' });
  const id = String(body.factuurId);
  const herinnering = body.soort === 'herinnering';
  const aan = lijst(body.aan), cc = lijst(body.cc), yuki = herinnering ? [] : lijst(body.yuki);   // een herinnering gaat nooit naar Yuki
  if (!aan.length) return stuur(400, { fout: 'Vul minstens één ontvanger in' });
  const fout = [...aan, ...cc, ...yuki].find(a => !EMAIL_RE.test(a));
  if (fout) return stuur(400, { fout: 'Dit mailadres klopt niet: ' + fout });
  if (aan.length + cc.length > 10) return stuur(400, { fout: 'Te veel ontvangers' });

  let f;
  try { f = (await sb('/rest/v1/facturen?id=eq.' + encodeURIComponent(id) + '&select=*', { service: true }) || [])[0] } catch (e) { return stuur(500, { fout: e.message }) }
  if (!f) return stuur(404, { fout: 'Factuur niet gevonden' });
  if (f.status === 'concept' || !f.nummer) return stuur(400, { fout: 'Maak de factuur eerst definitief' });

  const map = 'facturen/' + id + '/';
  const bestanden = [{ pad: body.factuurPad, naam: body.factuurNaam }, ...(Array.isArray(body.bijlagen) ? body.bijlagen : [])].filter(b => b && b.pad);
  if (!bestanden.length || bestanden[0].pad !== body.factuurPad) return stuur(400, { fout: 'De factuur-pdf ontbreekt' });
  if (bestanden.some(b => !String(b.pad).startsWith(map) || String(b.pad).includes('..'))) return stuur(400, { fout: 'Ongeldige bijlage' });
  if (bestanden.length > 20) return stuur(400, { fout: 'Te veel bijlagen (maximaal 20)' });

  // ---- 3. bestanden ophalen ----
  const bijlagen = [];
  let totaal = 0;
  try {
    for (const b of bestanden) {
      const buf = await sb('/storage/v1/object/bijlagen/' + String(b.pad).split('/').map(encodeURIComponent).join('/'), { service: true, binair: true });
      totaal += buf.length;
      if (totaal > MAX_BYTES) return stuur(413, { fout: 'De bijlagen zijn samen te groot voor een mail (maximaal ongeveer 18 MB aan bestanden).' });
      bijlagen.push({ filename: veiligeNaam(b.naam), content: buf });
    }
  } catch (e) { return stuur(500, { fout: 'Bijlage ophalen mislukt: ' + e.message }) }

  // ---- 4. versturen ----
  const bedrijf = String(body.afzenderNaam || 'Cas Wempe').replace(/[\r\n"]/g, '').slice(0, 80);
  const van = { name: bedrijf, address: MAIL_USER };
  const transport = maakTransport();
  const onderwerp = String(body.onderwerp || ('Factuur ' + f.nummer)).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const tekst = String(body.tekst || '').slice(0, 20000);
  try {
    await transport.sendMail({ from: van, to: aan, cc: cc.length ? cc : undefined, replyTo: MAIL_USER, subject: onderwerp, text: tekst, attachments: bijlagen });
  } catch (e) {
    const m = /Invalid login|Username and Password not accepted|535/i.test(e.message) ? 'Gmail weigert het inloggen: controleer GMAIL_USER en GMAIL_APP_PASSWORD op Vercel.' : e.message;
    return stuur(502, { fout: 'Versturen mislukt: ' + m });
  }
  const nu = new Date().toISOString();
  const verzending = { op: nu, soort: herinnering ? 'herinnering' : 'factuur', aan, cc, bijlagen: bijlagen.slice(1).map(b => b.filename), door: eigen.naam || '' };

  // Kopie voor de boekhouding (Yuki): alleen de factuur-pdf, als aparte mail.
  let yukiOk = null;
  if (yuki.length) {
    try {
      await transport.sendMail({ from: van, to: yuki, subject: 'Factuur ' + f.nummer + ' - ' + ((f.klant && f.klant.naam) || ''), text: 'Factuur ' + f.nummer + ' in de bijlage.', attachments: [bijlagen[0]] });
      yukiOk = true; verzending.yuki = yuki;
    } catch (e) { yukiOk = false; verzending.yukiFout = e.message }
  }

  // ---- 5. vastleggen bij de factuur ----
  try {
    const oud = Array.isArray(f.verzendingen) ? f.verzendingen : [];
    await sb('/rest/v1/facturen?id=eq.' + encodeURIComponent(id), { service: true, method: 'PATCH', prefer: 'return=minimal', body: Object.assign(herinnering ? {} : { verstuurd_op: nu, pdf_pad: body.factuurPad }, { verzendingen: [...oud, verzending] }) });
  } catch (e) { /* de mail is wel verstuurd; alleen het vastleggen ging mis */ }

  return stuur(200, { ok: true, verstuurdOp: nu, verzending, yuki: yukiOk });
};
