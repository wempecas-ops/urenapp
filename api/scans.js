// ============================================================================
// /api/scans  —  gescande bonnen ophalen uit Gmail (scan-naar-e-mail van de printer)
// ============================================================================
// De printer mailt naar  <GMAIL_USER zonder @>+scans@gmail.com  (bijv. facturencaswempe+scans@gmail.com).
// Deze functie logt via IMAP in op dezelfde Gmail (GMAIL_USER + GMAIL_APP_PASSWORD, staan al op Vercel),
// pakt alleen berichten aan "+scans", haalt de bijlagen (pdf/jpg/png) eruit, zet ze in de opslag
// (bucket "bijlagen", map scans/) en maakt per bijlage een regel in de tabel "scans".
// De mails zelf blijven ongemoeid in Gmail. Welke al verwerkt zijn staat in instellingen "scans_imap".
//
// Aanroep: elke nacht via Vercel Cron, en vanuit de app (tabblad Scans) door een beheerder.
const tls = require('tls');

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const IMAP_HOST = process.env.SCANS_IMAP_HOST || 'imap.gmail.com';
const USER = process.env.SCANS_USER || process.env.GMAIL_USER || '';
const PASS = (process.env.SCANS_PASSWORD || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const LABEL = process.env.SCANS_ADRES_DEEL || '+scans';      // stukje van het aan-adres
const MAX_BERICHTEN = 25, MAX_BYTES = 26 * 1024 * 1024;   // Gmail laat max. 25 MB per mail door

// ---------- Supabase ----------
const kop = extra => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE }, extra || {});
async function sb(pad, o) {
  o = o || {};
  const r = await fetch(URL_SB + pad, { method: o.method || 'GET', headers: kop(Object.assign(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}, o.prefer ? { Prefer: o.prefer } : {}, o.headers || {})), body: o.json !== undefined ? JSON.stringify(o.json) : o.body });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0, 200));
  try { return t ? JSON.parse(t) : null } catch (e) { return t }
}

// ---------- minimale IMAP-client ----------
function imapVerbinding(host) {
  return new Promise((ok, fout) => {
    const sock = tls.connect({ host, port: Number(process.env.SCANS_IMAP_PORT || 993), servername: host });
    let buf = Buffer.alloc(0), wachter = null, tagNr = 0;
    const lees = () => {
      if (!wachter) return;
      // complete antwoorden zoeken: regels, met {n}-literals
      let pos = 0; const regels = [], literals = [];
      while (true) {
        const eind = buf.indexOf('\r\n', pos);
        if (eind < 0) return;                    // nog niet alles binnen
        const regel = buf.slice(pos, eind).toString('latin1');
        const lit = /\{(\d+)\}$/.exec(regel);
        if (lit) {
          const n = +lit[1], start = eind + 2;
          if (buf.length < start + n) return;    // literal nog niet compleet
          regels.push(regel); literals.push(buf.slice(start, start + n));
          pos = start + n; continue;
        }
        regels.push(regel); pos = eind + 2;
        if (wachter.tag === null ? /^\* (OK|NO|BAD|BYE)/.test(regel) : regel.startsWith(wachter.tag + ' ')) {
          const w = wachter; wachter = null; buf = buf.slice(pos);
          const status = w.tag === null ? 'OK' : regel.slice(w.tag.length + 1).split(' ')[0];
          if (status !== 'OK') w.fout(new Error('IMAP: ' + regel.replace(/LOGIN .*/i, 'LOGIN …')));
          else w.ok({ regels, literals });
          return;
        }
      }
    };
    sock.on('data', d => { buf = Buffer.concat([buf, d]); lees() });
    sock.on('error', e => { if (wachter) { const w = wachter; wachter = null; w.fout(e) } else fout(e) });
    sock.setTimeout(20000, () => sock.destroy(new Error('IMAP time-out')));
    const api = {
      cmd(tekst) { return new Promise((ok2, fout2) => { const tag = 'A' + (++tagNr); wachter = { tag, ok: ok2, fout: fout2 }; sock.write(tag + ' ' + tekst + '\r\n') }) },
      sluit() { try { sock.write('Z LOGOUT\r\n'); sock.end() } catch (e) {} }
    };
    wachter = { tag: null, ok: () => ok(api), fout };
    sock.once('secureConnect', () => {});
  });
}
const imapQ = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// ---------- MIME ----------
function koppen(tekst) {
  const h = {}; tekst.replace(/\r\n[ \t]+/g, ' ').split(/\r\n/).forEach(r => { const i = r.indexOf(':'); if (i > 0) { const k = r.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = r.slice(i + 1).trim() } });
  return h;
}
function param(waarde, naam) {
  const s = String(waarde || '');
  let m = new RegExp(naam + '\\*=([^;]+)', 'i').exec(s);                 // RFC 2231: utf-8''naam
  if (m) { const v = m[1].trim().replace(/^"|"$/g, ''); const d = /^[^']*'[^']*'(.*)$/.exec(v); try { return decodeURIComponent(d ? d[1] : v) } catch (e) { return d ? d[1] : v } }
  m = new RegExp('(?:^|;)\\s*' + naam + '\\s*=\\s*("([^"]*)"|[^;]+)', 'i').exec(s);
  return m ? (m[2] !== undefined ? m[2] : m[1].trim()) : '';
}
function woorden(s) {                                                     // RFC 2047 =?utf-8?B?..?=
  return String(s || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, t) => {
    try { const b = enc.toLowerCase() === 'b' ? Buffer.from(t, 'base64') : Buffer.from(t.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'); return b.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1') } catch (e) { return t }
  }).replace(/\?=\s+=\?/g, '');
}
function decodeer(body, enc) {
  enc = String(enc || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return Buffer.from(body.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return body;
}
function bijlagenUit(raw, uit) {
  uit = uit || [];
  const scheid = raw.indexOf('\r\n\r\n');
  const h = koppen(raw.slice(0, scheid < 0 ? raw.length : scheid).toString('latin1'));
  const body = scheid < 0 ? Buffer.alloc(0) : raw.slice(scheid + 4);
  const ct = h['content-type'] || 'text/plain';
  if (/^multipart\//i.test(ct)) {
    const grens = param(ct, 'boundary'); if (!grens) return uit;
    const g = Buffer.from('--' + grens);
    let i = body.indexOf(g);
    while (i >= 0) {
      const start = body.indexOf('\r\n', i) + 2;
      const volgende = body.indexOf(g, start);
      if (volgende < 0 || start < 2) break;
      bijlagenUit(body.slice(start, volgende - 2), uit);
      if (body.slice(volgende + g.length, volgende + g.length + 2).toString() === '--') break;
      i = volgende;
    }
    return uit;
  }
  if (/^message\/rfc822/i.test(ct)) return bijlagenUit(body, uit);
  const naam = woorden(param(h['content-disposition'], 'filename') || param(ct, 'name'));
  const type = ct.split(';')[0].trim().toLowerCase();
  if (/^(application\/pdf|image\/(jpeg|jpg|png|tiff|heic))$/.test(type) || /\.(pdf|jpe?g|png|tiff?)$/i.test(naam)) {
    const data = decodeer(body, h['content-transfer-encoding']);
    if (data.length > 15000 || /pdf/.test(type)) uit.push({ naam: naam || ('scan.' + (type.split('/')[1] || 'bin')), type: /\.pdf$/i.test(naam) ? 'application/pdf' : type, data });
  }
  return uit;
}

async function magAanroepen(req) {
  const auth = String(req.headers.authorization || '');
  if (process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) return true;
  if (!process.env.CRON_SECRET && /vercel-cron/i.test(String(req.headers['user-agent'] || ''))) return true;
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !ANON) return false;
  try {
    const u = await fetch(URL_SB + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!u.ok) return false;
    const g = await u.json();
    const p = await sb('/rest/v1/profiles?id=eq.' + encodeURIComponent(g.id) + '&select=rol,actief');
    return !!(p && p[0] && p[0].rol === 'beheer' && p[0].actief !== false);
  } catch (e) { return false }
}

module.exports = async (req, res) => {
  const stuur = (c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) };
  if (!URL_SB || !SERVICE) return stuur(500, { fout: 'De Supabase-instellingen ontbreken op Vercel.' });
  if (!await magAanroepen(req)) return stuur(401, { fout: 'Niet toegestaan' });
  if (!USER || !PASS) return stuur(500, { fout: 'GMAIL_USER en GMAIL_APP_PASSWORD staan nog niet op Vercel.' });
  const start = Date.now();
  const uit = { ok: false, berichten: 0, bestanden: 0, adres: USER.replace('@', LABEL + '@') };
  let imap = null;
  try {
    const st = ((await sb('/rest/v1/instellingen?id=eq.scans_imap&select=waarde')) || [])[0];
    const stand = (st && st.waarde) || {};
    imap = await imapVerbinding(IMAP_HOST);
    try { await imap.cmd('LOGIN ' + imapQ(USER) + ' ' + imapQ(PASS)) }
    catch (e) { throw new Error('Inloggen bij Gmail mislukt: controleer GMAIL_USER en GMAIL_APP_PASSWORD (en of IMAP aan staat).') }
    const sel = await imap.cmd('SELECT INBOX');
    const uv = (sel.regels.join('\n').match(/UIDVALIDITY (\d+)/i) || [])[1] || '';
    let vanaf = stand.uidvalidity === uv && stand.laatste ? Number(stand.laatste) + 1 : 1;
    // eerste keer: alleen de laatste 30 dagen
    const d = new Date(Date.now() - 30 * 86400000), mnd = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const sinds = d.getUTCDate() + '-' + mnd[d.getUTCMonth()] + '-' + d.getUTCFullYear();
    const zoek = await imap.cmd('UID SEARCH UID ' + vanaf + ':* SINCE ' + sinds + ' TO ' + imapQ(LABEL));
    const uids = ((zoek.regels.find(r => /^\* SEARCH/i.test(r)) || '').replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number).filter(n => n >= vanaf)).sort((a, b) => a - b);
    let laatste = vanaf - 1;
    for (const uid of uids.slice(0, MAX_BERICHTEN)) {
      if (Date.now() - start > 45000) break;
      const f = await imap.cmd('UID FETCH ' + uid + ' BODY.PEEK[]');
      const raw = f.literals.sort((a, b) => b.length - a.length)[0];
      if (raw && raw.length <= MAX_BYTES) {
        const scheid = raw.indexOf('\r\n\r\n');
        const h = koppen(raw.slice(0, scheid).toString('latin1'));
        const msgId = (h['message-id'] || ('uid-' + uv + '-' + uid)).replace(/[<>]/g, '');
        const ontvangen = h.date ? new Date(h.date) : new Date();
        const bijlagen = bijlagenUit(raw);
        for (let i = 0; i < bijlagen.length; i++) {
          const b = bijlagen[i];
          const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const veilig = b.naam.replace(/[^\w.\-]+/g, '_').slice(-80);
          const pad = 'scans/' + ontvangen.toISOString().slice(0, 7) + '/' + id + '-' + veilig;
          const bestaat = await sb('/rest/v1/scans?select=id&message_id=eq.' + encodeURIComponent(msgId) + '&bestandsnaam=eq.' + encodeURIComponent(b.naam));
          if (bestaat && bestaat.length) continue;
          // eerst de regel claimen (bij twee rondes tegelijk wint er één), dan pas het bestand opslaan
          const rij = await sb('/rest/v1/scans?on_conflict=message_id,bestandsnaam', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', json: { id, message_id: msgId, ontvangen_op: isNaN(ontvangen) ? new Date().toISOString() : ontvangen.toISOString(), afzender: woorden(h.from || '').slice(0, 200), onderwerp: woorden(h.subject || '').slice(0, 300), bestandsnaam: b.naam, pad, type: b.type, grootte: b.data.length, status: 'nieuw' } });
          if (!Array.isArray(rij) || !rij.length) continue;            // stond er al
          try { await sb('/storage/v1/object/bijlagen/' + pad.split('/').map(encodeURIComponent).join('/'), { method: 'POST', body: b.data, headers: { 'Content-Type': b.type, 'x-upsert': 'true' } }) }
          catch (e) { await sb('/rest/v1/scans?id=eq.' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {}); throw e }
          uit.bestanden++;
        }
        uit.berichten++;
      }
      laatste = uid;
    }
    if (laatste >= vanaf || stand.uidvalidity !== uv) {
      await sb('/rest/v1/instellingen', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', json: { id: 'scans_imap', waarde: { uidvalidity: uv, laatste: Math.max(laatste, vanaf - 1), op: new Date().toISOString() } } });
    }
    uit.ok = true; uit.meer = uids.length > uit.berichten;
    return stuur(200, uit);
  } catch (e) {
    uit.fout = e.message;
    return stuur(500, uit);
  } finally { if (imap) imap.sluit() }
};
