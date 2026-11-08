// ============================================================================
// Back-up terugzetten  —  node scripts/herstel.js <backup.json(.gz)> [--echt] [--alleen tabel1,tabel2]
// ============================================================================
// Nodig: SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY als omgevingsvariabelen
// (van het project waar je naartoe wilt terugzetten).
// Zonder --echt kijkt het script alleen wat er in de back-up staat en verandert niets.
// Met --echt worden de regels teruggezet (bestaande regels met hetzelfde id worden overschreven,
// andere regels blijven staan). Inlogaccounts (profiles) worden overgeslagen: die maak je
// opnieuw aan via Accounts in de app.
const fs = require('fs');
const zlib = require('zlib');

const VOLGORDE = ['werknemers', 'klanten', 'diensten', 'diensten_tarief', 'materieel', 'producten', 'dagstaten',
  'orders', 'planningen', 'vervaldata', 'klus_notities', 'facturen', 'facturen_mts', 'vrachten', 'tolposten',
  'percelen', 'scans', 'instellingen', 'factuur_teller'];
const SLEUTEL = { diensten_tarief: 'dienst_id' };

async function main() {
  const args = process.argv.slice(2);
  const bestand = args.find(a => !a.startsWith('--'));
  const echt = args.includes('--echt');
  const i = args.indexOf('--alleen');
  const alleen = i >= 0 ? new Set(String(args[i + 1] || '').split(',')) : null;
  if (!bestand) { console.log('Gebruik: node scripts/herstel.js backup-JJJJ-MM-DD.json.gz [--echt] [--alleen dagstaten,klanten]'); process.exit(1) }
  let buf = fs.readFileSync(bestand);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const data = JSON.parse(buf.toString('utf8'));
  console.log('Back-up van', data.gemaakt || '(onbekend)');
  const URL_SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (echt && (!URL_SB || !KEY)) { console.error('Zet eerst SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
  for (const t of VOLGORDE) {
    if (alleen && !alleen.has(t)) continue;
    const rijen = data[t] || [];
    if (!echt) { console.log(String(rijen.length).padStart(6), t); continue }
    for (let n = 0; n < rijen.length; n += 500) {
      const deel = rijen.slice(n, n + 500);
      const r = await fetch(`${URL_SB}/rest/v1/${t}?on_conflict=${SLEUTEL[t] || 'id'}`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(deel)
      });
      if (!r.ok) { console.error(`${t}: fout ${r.status} ${await r.text()}`); process.exit(1) }
    }
    console.log('teruggezet', String(rijen.length).padStart(6), t);
  }
  if (!echt) console.log('\nDit was een proefrun. Voeg --echt toe om echt terug te zetten.');
}
main().catch(e => { console.error(e); process.exit(1) });
