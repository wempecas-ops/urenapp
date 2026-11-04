// ============================================================================
// /api/evdm  —  gereden vrachten ophalen uit eVDM (app.evdm.nl)
// ============================================================================
// Logt in met het eigen eVDM-account, leest het overzicht "Overzicht aanvragen (r)eVDM"
// (alle pagina's, ook al verwerkte eVDM's) en zet de vrachten in de tabel "vrachten".
// Elke nacht via Vercel Cron (vercel.json) en met de knop "Nu ophalen" in het tabblad Vrachten.
//
// Omgevingsvariabelen op Vercel (zelf instellen, het wachtwoord komt nooit in de app):
//   EVDM_USER       e-mailadres of mobiel nummer waarmee je inlogt
//   EVDM_PASSWORD   wachtwoord
//   (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY staan er al; CRON_SECRET optioneel)
//
// De uitkomst van elke ronde staat in instellingen (id "evdm_status"), zodat je in de app ziet
// of het gelukt is. Lukt het niet, dan staat daar ook een stukje van de pagina om te zien waarom.

const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BASIS = 'https://app.evdm.nl';
const MAX_PAGINAS = 60;
// Vrachten vanaf deze laaddatum (de dag dat de eerste uren in Wempe op Pad stonden); oudere worden overgeslagen
const VANAF = process.env.EVDM_VANAF || '2026-10-19';

// ---------- Supabase ----------
const kop = extra => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE }, extra || {});
async function sb(pad, o) {
  o = o || {};
  const r = await fetch(URL_SB + pad, { method: o.method || 'GET', headers: kop(Object.assign(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}, o.prefer ? { Prefer: o.prefer } : {})), body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// ---------- eenvoudige browser met cookies ----------
function maakSessie() {
  const jar = {};
  const cookieKop = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  function bewaar(r) {
    let lijst = [];
    if (typeof r.headers.getSetCookie === 'function') lijst = r.headers.getSetCookie();
    else if (r.headers.get('set-cookie')) lijst = r.headers.get('set-cookie').split(/,(?=\s*[^;,=\s]+=)/);
    for (const c of lijst) { const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c); if (m) jar[m[1]] = m[2] }
  }
  async function haal(url, o) {
    o = o || {};
    let huidig = new URL(url, BASIS).toString(), methode = o.method || 'GET', body = o.body;
    for (let i = 0; i < 8; i++) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      let r;
      try {
        r = await fetch(huidig, { method: methode, redirect: 'manual', signal: ctl.signal, body,
          headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (WempeOpPad vrachtenoverzicht)', Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'nl-NL,nl;q=0.9', Cookie: cookieKop() }, o.headers || {}) });
      } finally { clearTimeout(t) }
      bewaar(r);
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        huidig = new URL(r.headers.get('location'), huidig).toString(); methode = 'GET'; body = undefined; o = {}; continue;
      }
      return { status: r.status, url: huidig, html: await r.text() };
    }
    throw new Error('Te veel doorverwijzingen');
  }
  return { haal };
}

// ---------- HTML-hulpjes ----------
const ent = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const tekst = h => ent(String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, naam) => { const m = new RegExp('\\b' + naam + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag); return m ? ent(m[2] ?? m[3] ?? m[4] ?? '') : null };

// Het inlogformulier invullen: alle verborgen velden (zoals authenticity_token) + login + wachtwoord
function inlogFormulier(html) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const form = forms.find(f => /type\s*=\s*["']?password/i.test(f));
  if (!form) return null;
  const actie = attr(form.match(/<form[^>]*>/i)[0], 'action') || '/session';
  const velden = new URLSearchParams();
  let loginNaam = null, wwNaam = null;
  for (const inp of form.match(/<input[^>]*>/gi) || []) {
    const type = (attr(inp, 'type') || 'text').toLowerCase(), naam = attr(inp, 'name');
    if (!naam) continue;
    if (type === 'password') wwNaam = wwNaam || naam;
    else if (['text', 'email', 'tel'].includes(type)) loginNaam = loginNaam || naam;
    else if (type === 'hidden') velden.append(naam, attr(inp, 'value') || '');
    else if (type === 'checkbox' && /remember|onthoud/i.test(naam)) velden.append(naam, attr(inp, 'value') || '1');
  }
  return { actie, velden, loginNaam, wwNaam };
}

// De tabel met vrachten: kolommen op naam van de kop, zodat een andere volgorde niet uitmaakt
function leesTabel(html) {
  const tabellen = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const tab = tabellen.find(t => /VDM-nummer/i.test(t) && /Kenteken/i.test(t));
  if (!tab) return null;
  const rijen = tab.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const kopRij = rijen.find(r => /<th/i.test(r)) || rijen[0];
  const koppen = (kopRij.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(c => tekst(c).toLowerCase());
  const idx = woord => koppen.findIndex(k => k.includes(woord));
  const k = { id: idx('id') >= 0 ? koppen.findIndex(x => x === 'id' || x.startsWith('id ')) : -1, vdm: idx('vdm'), gepland: idx('gepland'), kenteken: idx('kenteken'), laad: idx('laaddatum'), los: idx('losdatum'), lev: idx('leverancier'), afn: idx('afnemer'), gew: idx('gewicht') };
  const uit = [];
  for (const r of rijen) {
    if (r === kopRij || !/<td/i.test(r)) continue;
    const ruw = r.match(/<td[\s\S]*?<\/td>/gi) || [];
    const c = ruw.map(tekst);
    // link naar de detailpagina van deze bon (in de Id- of VDM-kolom)
    let href = null;
    for (const i of [k.id, k.vdm]) { if (i < 0 || !ruw[i]) continue; const a = ruw[i].match(/<a[^>]*>/i); const h = a && attr(a[0], 'href'); if (h && h !== '#' && !/^javascript/i.test(h)) { href = h; break } }
    const pak = i => (i >= 0 && i < c.length ? c[i] : '');
    const id = pak(k.id) || (pak(k.vdm) ? 'vdm-' + pak(k.vdm) : '');
    if (!id || !/\d/.test(id)) continue;
    uit.push({ id: id.replace(/\s+/g, ''), vdm: pak(k.vdm), gepland: pak(k.gepland), kenteken: pak(k.kenteken), laad: pak(k.laad), los: pak(k.los), lev: pak(k.lev), afn: pak(k.afn), gew: pak(k.gew), href });
  }
  return uit;
}
// "28-10-2026 / 12:15" -> { datum: "2026-10-28", op: "2026-10-28T12:15" }
function dt(s) {
  const m = /(\d{1,2})-(\d{1,2})-(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return { datum: null, op: null };
  const d = m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return { datum: d, op: m[4] ? d + 'T' + m[4].padStart(2, '0') + ':' + m[5] : d };
}
// Detailpagina van een bon: de tekst in losse stukjes, en daarin zoeken naar het label en de waarde erna
function stukjes(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').split(/<[^>]+>/).map(t => ent(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const LABELS = {
  oplegger: /^(kenteken\s*)?(oplegger|aanhanger|aanhangwagen)(\s*kenteken)?\s*:?$/i,
  mestcode: /^(mestcode|mestsoort(code)?|code\s*mest(soort)?)\s*:?$/i,
  opmerkingcode: /^opmerking(s)?\s*-?\s*code(s)?\s*:?$/i
};
const ALLE_LABELS = /:$|^(kenteken|oplegger|mestcode|mestsoort|opmerking|laaddatum|losdatum|leverancier|afnemer|gewicht|vervoerder|status|vdm)/i;
function leesDetails(html) {
  const t = stukjes(html), uit = {};
  for (const [veld, re] of Object.entries(LABELS)) {
    for (let i = 0; i < t.length; i++) {
      const m = /^([^:]{3,40}):\s*(.+)$/.exec(t[i]);          // "Mestcode: 14"
      if (m && re.test(m[1].trim())) { uit[veld] = m[2].trim(); break }
      if (re.test(t[i])) {
        const v = t[i + 1];
        if (v && !LABELS.oplegger.test(v) && !LABELS.mestcode.test(v) && !LABELS.opmerkingcode.test(v) && !(/:$/.test(v))) { uit[veld] = v; break }
        if (v && /:$/.test(v)) { uit[veld] = ''; break }
      }
    }
  }
  return { velden: uit, tekst: t };
}
const kg = s => { const n = parseFloat(String(s || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n };

// Link naar de volgende pagina (rel="next", of een link met "Volgende" / ›)
function volgende(html, huidig) {
  const links = html.match(/<a[^>]*>[\s\S]*?<\/a>/gi) || [];
  const l = links.find(a => /rel\s*=\s*["']?next/i.test(a)) || links.find(a => /^(volgende|next|›|»|&rsaquo;|&raquo;)/i.test(tekst(a)) && attr(a, 'href') && attr(a, 'href') !== '#');
  return l ? new URL(attr(l, 'href'), huidig).toString() : null;
}

// Filterformulier: zet "Onverwerkte eVDMs" om naar "Alle", zodat ook verwerkte vrachten meekomen
function filterUrl(html, huidig) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const form = forms.find(f => /<select/i.test(f) && /onverwerkt/i.test(f));
  if (!form) return null;
  const kopTag = form.match(/<form[^>]*>/i)[0];
  if ((attr(kopTag, 'method') || 'get').toLowerCase() !== 'get') return null;
  const q = new URLSearchParams();
  for (const inp of form.match(/<input[^>]*>/gi) || []) {
    const naam = attr(inp, 'name'), type = (attr(inp, 'type') || 'text').toLowerCase();
    if (naam && !['submit', 'button', 'checkbox'].includes(type)) q.append(naam, attr(inp, 'value') || '');
  }
  for (const sel of form.match(/<select[\s\S]*?<\/select>/gi) || []) {
    const naam = attr(sel.match(/<select[^>]*>/i)[0], 'name'); if (!naam) continue;
    const opties = (sel.match(/<option[\s\S]*?<\/option>/gi) || []).map(o => ({ v: attr(o.match(/<option[^>]*>/i)[0], 'value') ?? tekst(o), t: tekst(o), sel: /\bselected\b/i.test(o.match(/<option[^>]*>/i)[0]) }));
    let kies = opties.find(o => o.sel) || null;
    if (kies && /onverwerkt/i.test(kies.t)) kies = opties.find(o => /^alle/i.test(o.t)) || kies;
    if (kies) q.append(naam, kies.v);
  }
  return new URL((attr(kopTag, 'action') || huidig).split('?')[0] + '?' + q.toString(), huidig).toString();
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

async function zetStatus(w) {
  try { await sb('/rest/v1/instellingen', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: 'evdm_status', waarde: w } }) } catch (e) {}
}

module.exports = async (req, res) => {
  const stuur = (c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) };
  if (!URL_SB || !SERVICE) return stuur(500, { fout: 'De Supabase-instellingen ontbreken op Vercel.' });
  if (!await magAanroepen(req)) return stuur(401, { fout: 'Niet toegestaan' });
  const USER = process.env.EVDM_USER || '', PASS = process.env.EVDM_PASSWORD || '';
  const status = { op: new Date().toISOString(), ok: false };
  if (!USER || !PASS) { status.fout = 'EVDM_USER en EVDM_PASSWORD staan nog niet op Vercel.'; await zetStatus(status); return stuur(500, status) }

  const s = maakSessie();
  const start = Date.now();
  let stap = 'inlogpagina';
  try {
    // 1. inloggen
    const inlog = await s.haal('/session/new');
    const f = inlogFormulier(inlog.html);
    if (!f || !f.loginNaam || !f.wwNaam) throw Object.assign(new Error('Inlogformulier niet herkend'), { html: inlog.html });
    f.velden.set(f.loginNaam, USER); f.velden.set(f.wwNaam, PASS);
    stap = 'inloggen';
    const na = await s.haal(f.actie, { method: 'POST', body: f.velden.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (/type\s*=\s*["']?password/i.test(na.html) && /session/i.test(na.url)) throw Object.assign(new Error('Inloggen mislukt: controleer EVDM_USER en EVDM_PASSWORD'), { html: '' });

    // 2. overzicht (met filter "alle", ook verwerkte)
    stap = 'overzicht';
    let pagina = /VDM-nummer/i.test(na.html) ? na : await s.haal('/');
    const fu = filterUrl(pagina.html, pagina.url);
    if (fu) { const p2 = await s.haal(fu); if (leesTabel(p2.html)) pagina = p2 }
    const alle = new Map();
    for (let i = 0; i < MAX_PAGINAS && pagina; i++) {
      const rijen = leesTabel(pagina.html);
      if (!rijen) { if (i === 0) throw Object.assign(new Error('Tabel met vrachten niet gevonden'), { html: pagina.html }); break }
      let nieuw = 0, recent = 0;
      for (const r of rijen) { const d = dt(r.laad).datum; if (d && d < VANAF) continue; recent++; if (!alle.has(r.id)) { alle.set(r.id, r); nieuw++ } }
      const v = volgende(pagina.html, pagina.url);
      if (!v || (!nieuw && rijen.length) || (rijen.length && !recent)) break;   // pagina met alleen oudere vrachten: klaar
      pagina = await s.haal(v);
    }

    // 3. opslaan
    stap = 'opslaan';
    const rijen = [...alle.values()].map(r => { const l = dt(r.laad), o = dt(r.los); return { id: r.id, detail_url: r.href ? new URL(r.href, BASIS).toString() : null, vdm_nummer: r.vdm || null, gepland: r.gepland || null, kenteken: r.kenteken || null, laaddatum: l.datum, laad_op: l.op, losdatum: o.datum, los_op: o.op, leverancier: r.lev || null, afnemer: r.afn || null, gewicht_kg: kg(r.gew), opgehaald_op: new Date().toISOString() } });
    const bekend = new Set();
    if (rijen.length) {
      for (let i = 0; i < rijen.length; i += 200) {
        const ids = rijen.slice(i, i + 200).map(r => '"' + r.id.replace(/"/g, '') + '"').join(',');
        (await sb('/rest/v1/vrachten?select=id&id=in.(' + encodeURIComponent(ids) + ')') || []).forEach(x => bekend.add(x.id));
      }
      for (let i = 0; i < rijen.length; i += 500) await sb('/rest/v1/vrachten', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: rijen.slice(i, i + 500) });
    }
    // 4. details (oplegger, mestcode, opmerkingscode) van bonnen waar die nog ontbreken
    stap = 'details';
    let details = 0, debugGezet = false;
    const open = await sb('/rest/v1/vrachten?select=id,detail_url&details_op=is.null&detail_url=not.is.null&laaddatum=gte.' + VANAF + '&order=laaddatum.desc&limit=200') || [];
    for (const v of open) {
      if (Date.now() - start > 45000) break;
      try {
        const d = await s.haal(v.detail_url);
        const { velden, tekst: t } = leesDetails(d.html);
        // Ontbreekt er iets, bewaar dan de tekst van deze pagina apart (voor controle), los van de status
        if (!debugGezet && (!velden.oplegger || !velden.mestcode || !velden.opmerkingcode)) { debugGezet = true; try { await sb('/rest/v1/instellingen', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: 'evdm_debug', waarde: { op: new Date().toISOString(), url: v.detail_url, gevonden: velden, tekst: t.join(' | ').slice(0, 12000) } } }) } catch (e) {} }
        await sb('/rest/v1/vrachten?id=eq.' + encodeURIComponent(v.id), { method: 'PATCH', prefer: 'return=minimal', body: { oplegger: velden.oplegger || null, mestcode: velden.mestcode || null, opmerkingcode: velden.opmerkingcode || null, details_op: new Date().toISOString() } });
        details++;
      } catch (e) { status.detailFout = e.message }
    }
    Object.assign(status, { ok: true, gelezen: rijen.length, nieuw: rijen.filter(r => !bekend.has(r.id)).length, details, detailsOpen: Math.max(0, open.length - details) });
    await zetStatus(status);
    return stuur(200, status);
  } catch (e) {
    Object.assign(status, { fout: e.message, stap });
    if (e.html) status.voorbeeld = tekst(e.html).slice(0, 1500);
    await zetStatus(status);
    return stuur(500, status);
  }
};
