// Local admin/debug tool for Ugin's Vault. READ access to every user's backend
// entries (collection, prices, queue state) + manual actions (run ingest,
// re-queue a card, prune queue). Runs ONLY on 127.0.0.1 and reads the
// service-role key from .env — it must never be deployed or exposed.
//
//   npm run admin   ->   http://localhost:8787

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'admin', '.run.log');

// ── load .env into process.env (so spawned ingest children inherit) ──────────
for (const line of existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n') : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

const rest = async (path) => (await fetch(`${URL}/rest/v1/${path}`, { headers: H })).json();
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

// ── per-user debug snapshot ──────────────────────────────────────────────────
async function userDetail(uid) {
  const [stacks, items] = await Promise.all([
    rest(`stacks?user_id=eq.${uid}&select=id,name,kind,sort_order&order=sort_order`),
    rest(`collection_items?user_id=eq.${uid}&select=id,card_id,stack_id,quantity,finish,condition,language`)
  ]);
  const cardIds = [...new Set(items.map((i) => String(i.card_id).toLowerCase()))];
  let recent = [], queue = [];
  if (cardIds.length) {
    const inList = `(${cardIds.join(',')})`;
    [recent, queue] = await Promise.all([
      rest(`prices?card_id=in.${inList}&date=gte.${daysAgo(7)}&select=card_id,source,date`),
      rest(`price_backfill_queue?card_id=in.${inList}&select=card_id,last_attempt_at`)
    ]);
  }
  const recentBy = new Map();
  for (const r of recent) {
    const c = String(r.card_id).toLowerCase();
    if (!recentBy.has(c)) recentBy.set(c, { sources: new Set(), latest: '' });
    const e = recentBy.get(c); e.sources.add(r.source); if (r.date > e.latest) e.latest = r.date;
  }
  const queueBy = new Map(queue.map((q) => [String(q.card_id).toLowerCase(), q.last_attempt_at]));
  const cards = cardIds.map((c) => {
    const r = recentBy.get(c);
    const inQ = queueBy.has(c);
    let state = 'unknown';
    if (r) state = 'priced';
    else if (inQ && queueBy.get(c)) state = 'noData';
    else if (inQ) state = 'pending';
    else state = 'stale'; // no recent price, not queued
    return { cardId: c, state, latest: r?.latest ?? null, sources: r ? [...r.sources] : [], queue: inQ ? (queueBy.get(c) ? 'noData' : 'pending') : null };
  });
  const counts = cards.reduce((a, c) => ((a[c.state] = (a[c.state] || 0) + 1), a), {});
  return { stacks, itemCount: items.length, cardCount: cardIds.length, counts, cards, items };
}

// ── manual actions ───────────────────────────────────────────────────────────
function runIngest(job) {
  appendFileSync(LOG, `\n=== ${new Date().toISOString()} run ingest:${job} ===\n`);
  const child = spawn('npm', ['run', `ingest:${job}`], { cwd: ROOT, env: process.env });
  child.stdout.on('data', (d) => appendFileSync(LOG, d));
  child.stderr.on('data', (d) => appendFileSync(LOG, d));
  child.on('close', (code) => appendFileSync(LOG, `=== exit ${code} ===\n`));
}
async function requeue(cardIds) {
  // upsert with last_attempt_at=null -> claimable again (forces a re-fetch)
  const rows = cardIds.map((c) => ({ card_id: c, last_attempt_at: null }));
  const r = await fetch(`${URL}/rest/v1/price_backfill_queue?on_conflict=card_id`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  return r.ok;
}
const prune = async () => (await fetch(`${URL}/rest/v1/rpc/prune_priced_queue`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' })).json();

const server = createServer(async (req, res) => {
  const u = new globalThis.URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (u.pathname === '/api/users') {
      const d = await (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H })).json();
      return json(res, 200, (d.users || []).map((x) => ({ id: x.id, email: x.email, created_at: x.created_at, last_sign_in_at: x.last_sign_in_at })));
    }
    if (u.pathname === '/api/user') return json(res, 200, await userDetail(u.searchParams.get('id')));
    if (u.pathname === '/api/runlog') return json(res, 200, { log: existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').slice(-120).join('\n') : '(no runs yet)' });
    if (req.method === 'POST' && u.pathname === '/api/run') { const b = await readBody(req); if (!['daily', 'on-demand', 'backfill'].includes(b.job)) return json(res, 400, { error: 'bad job' }); runIngest(b.job); return json(res, 200, { started: b.job }); }
    if (req.method === 'POST' && u.pathname === '/api/requeue') { const b = await readBody(req); return json(res, 200, { ok: await requeue(b.cardIds || []) }); }
    if (req.method === 'POST' && u.pathname === '/api/prune') return json(res, 200, { deleted: await prune() });
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e) }); }
});
server.listen(8787, '127.0.0.1', () => console.log('admin -> http://localhost:8787  (127.0.0.1 only; reads service-role key from .env)'));

const PAGE = `<!doctype html><meta charset=utf8><title>UV admin</title>
<style>body{font:14px system-ui;margin:0;display:flex;height:100vh}#l{width:280px;border-right:1px solid #ddd;overflow:auto}#m{flex:1;overflow:auto;padding:16px}
.u{padding:8px 12px;border-bottom:1px solid #eee;cursor:pointer}.u:hover{background:#f5f5f5}h2{margin:4px 0}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #eee;padding:4px 6px;text-align:left}
.priced{color:#137333}.pending{color:#b06000}.noData{color:#999}.stale{color:#c5221f}
button{margin:2px;padding:6px 10px;cursor:pointer}#log{background:#111;color:#0f0;font:11px monospace;white-space:pre-wrap;padding:8px;max-height:240px;overflow:auto;margin-top:8px}
.bar{position:sticky;top:0;background:#fff;padding-bottom:8px;border-bottom:1px solid #eee}</style>
<div id=l></div><div id=m><p>pick a user →</p></div>
<script>
let cur=null;
async function users(){const us=await (await fetch('/api/users')).json();document.getElementById('l').innerHTML=us.map(u=>'<div class=u onclick="open_(\\''+u.id+'\\',\\''+(u.email||'')+'\\')">'+(u.email||u.id)+'<br><small>'+u.id.slice(0,8)+' · '+(u.created_at||'').slice(0,10)+'</small></div>').join('');}
async function open_(id,email){cur=id;const d=await (await fetch('/api/user?id='+id)).json();
 const c=d.counts||{};const rows=d.cards.map(x=>'<tr class='+x.state+'><td>'+x.cardId+'</td><td>'+x.state+'</td><td>'+(x.latest||'')+'</td><td>'+x.sources.join(',')+'</td><td>'+(x.queue||'')+'</td></tr>').join('');
 document.getElementById('m').innerHTML='<div class=bar><h2>'+email+'</h2><small>'+id+'</small><div>stacks '+d.stacks.length+' · items '+d.itemCount+' · cards '+d.cardCount+' &nbsp; <b>priced '+(c.priced||0)+' · pending '+(c.pending||0)+' · noData '+(c.noData||0)+' · stale '+(c.stale||0)+'</b></div>'
 +'<button onclick="run(\\'daily\\')">run daily</button><button onclick="run(\\'on-demand\\')">run on-demand</button><button onclick="run(\\'backfill\\')">run backfill</button>'
 +'<button onclick="requeueBad()">re-queue pending/stale</button><button onclick="prune()">prune priced</button><button onclick="poll()">refresh log</button></div>'
 +'<table><tr><th>card_id</th><th>state</th><th>latest</th><th>sources(7d)</th><th>queue</th></tr>'+rows+'</table><div id=log></div>';poll();}
async function run(job){await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job})});setTimeout(poll,800);}
async function requeueBad(){const d=await (await fetch('/api/user?id='+cur)).json();const ids=d.cards.filter(x=>x.state!=='priced').map(x=>x.cardId);await fetch('/api/requeue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cardIds:ids})});alert('re-queued '+ids.length+' (run on-demand/daily to fetch)');}
async function prune(){const r=await (await fetch('/api/prune',{method:'POST'})).json();alert('pruned '+JSON.stringify(r));open_(cur,'');}
async function poll(){const r=await (await fetch('/api/runlog')).json();const el=document.getElementById('log');if(el){el.textContent=r.log;el.scrollTop=el.scrollHeight;}}
users();
</script>`;
