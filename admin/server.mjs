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
    else state = 'stale';
    return { cardId: c, state, latest: r?.latest ?? null, sources: r ? [...r.sources] : [], queue: inQ ? (queueBy.get(c) ? 'noData' : 'pending') : null };
  });
  const order = { stale: 0, pending: 1, noData: 2, priced: 3 };
  cards.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.cardId.localeCompare(b.cardId));
  const counts = cards.reduce((a, c) => ((a[c.state] = (a[c.state] || 0) + 1), a), {});
  return { stacks, itemCount: items.length, cardCount: cardIds.length, counts, cards };
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

const PAGE = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>UV admin</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--border:#30363d;--text:#c9d1d9;--muted:#8b949e;--accent:#388bfd}
*{box-sizing:border-box}
body{margin:0;font:13px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden}
#l{width:264px;flex:none;background:var(--panel);border-right:1px solid var(--border);overflow:auto}
#l h1{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:16px 16px 8px;margin:0}
.u{padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;border-left:2px solid transparent}
.u:hover{background:var(--panel2)}
.u.active{background:#1f6feb1a;border-left-color:var(--accent)}
.u b{display:block;font-weight:600}
.u small{color:var(--muted);font:11px monospace}
#m{flex:1;overflow:auto;padding:22px 26px}
.email{font-size:21px;font-weight:700;margin:0}
.uid{color:var(--muted);font:11px monospace;margin:3px 0 14px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.chip{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:5px 13px;font-size:12px;color:var(--muted)}
.chip b{color:#fff;font-weight:700;margin-left:3px}
.bar{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:16px;position:sticky;top:0;background:var(--bg);padding:4px 0 10px;z-index:2}
button{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 13px;font-size:12px;font-weight:500;cursor:pointer;transition:.12s}
button:hover{background:var(--panel2);border-color:#484f58}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{filter:brightness(1.1)}
button.danger{border-color:#da363355;color:#f85149}
button.danger:hover{background:#da36331a}
label.filter{margin-left:auto;color:var(--muted);font-size:12px;display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none}
table{border-collapse:collapse;width:100%}
th{position:sticky;top:0;background:var(--panel);color:var(--muted);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:9px 11px;border-bottom:1px solid var(--border)}
td{padding:8px 11px;border-bottom:1px solid #21262d;vertical-align:middle}
tr:hover td{background:#161b2299}
.cid{font:12px ui-monospace,SFMono-Regular,monospace;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:lowercase}
.pill.priced{background:#2386361f;color:#3fb950}
.pill.pending{background:#9e6a031f;color:#d29922}
.pill.noData{background:#6e76814d;color:#adbac7}
.pill.stale{background:#da36331f;color:#f85149}
.pill.unknown{background:#6e76814d;color:#8b949e}
.src{color:var(--muted);font-size:12px}
#log{background:#010409;color:#3fb950;font:11px/1.55 ui-monospace,monospace;white-space:pre-wrap;padding:12px;border:1px solid var(--border);border-radius:8px;max-height:220px;overflow:auto;margin-top:16px}
.empty{color:var(--muted);padding:60px;text-align:center}
.placeholder{color:var(--muted);padding:60px;text-align:center}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#30363d;border-radius:6px}
</style></head>
<body><div id=l></div><div id=m><div class=placeholder>pick a user &larr;</div></div>
<script>
let cur=null,curData=null,problemsOnly=false,allUsers=[];
const emailOf=id=>(allUsers.find(u=>u.id===id)||{}).email||'(no email)';
const pill=s=>'<span class="pill '+s+'">'+s+'</span>';
async function users(){allUsers=await (await fetch('/api/users')).json();
 document.getElementById('l').innerHTML='<h1>users ('+allUsers.length+')</h1>'+allUsers.map(u=>'<div class="u" data-id="'+u.id+'" onclick="open_(\\''+u.id+'\\')"><b>'+(u.email||'(no email)')+'</b><small>'+u.id.slice(0,8)+' · '+(u.created_at||'').slice(0,10)+'</small></div>').join('');}
async function open_(id){cur=id;[...document.querySelectorAll('.u')].forEach(e=>e.classList.toggle('active',e.dataset.id===id));curData=await (await fetch('/api/user?id='+id)).json();render();poll();}
function render(){if(!curData)return;const d=curData,c=d.counts||{};
 const rows=d.cards.filter(x=>!problemsOnly||x.state!=='priced').map(x=>'<tr><td class="cid" title="'+x.cardId+'">'+x.cardId+'</td><td>'+pill(x.state)+'</td><td>'+(x.latest||'—')+'</td><td class="src">'+(x.sources.join(', ')||'—')+'</td><td>'+(x.queue?pill(x.queue):'')+'</td></tr>').join('');
 document.getElementById('m').innerHTML='<div class="email">'+emailOf(cur)+'</div><div class="uid">'+cur+'</div>'
 +'<div class="chips"><span class="chip">stacks<b>'+d.stacks.length+'</b></span><span class="chip">items<b>'+d.itemCount+'</b></span><span class="chip">cards<b>'+d.cardCount+'</b></span><span class="chip" style="color:#3fb950">priced<b>'+(c.priced||0)+'</b></span><span class="chip" style="color:#d29922">pending<b>'+(c.pending||0)+'</b></span><span class="chip" style="color:#adbac7">noData<b>'+(c.noData||0)+'</b></span><span class="chip" style="color:#f85149">stale<b>'+(c.stale||0)+'</b></span></div>'
 +'<div class="bar"><button class="primary" onclick="run(\\'on-demand\\')">run on-demand</button><button onclick="run(\\'daily\\')">run daily</button><button onclick="run(\\'backfill\\')">run backfill</button><button onclick="requeueBad()">re-queue pending/stale</button><button class="danger" onclick="prune()">prune priced</button><button onclick="poll()">refresh log</button><label class="filter"><input type="checkbox" '+(problemsOnly?'checked':'')+' onchange="problemsOnly=this.checked;render()"> problems only</label></div>'
 +'<table><thead><tr><th>card_id</th><th>state</th><th>latest</th><th>sources (7d)</th><th>queue</th></tr></thead><tbody>'+(rows||'<tr><td colspan=5 class=empty>no rows</td></tr>')+'</tbody></table><div id="log"></div>';}
async function reload(){curData=await (await fetch('/api/user?id='+cur)).json();render();poll();}
async function run(job){await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job})});setTimeout(poll,800);}
async function requeueBad(){const ids=curData.cards.filter(x=>x.state!=='priced'&&x.state!=='noData').map(x=>x.cardId);await fetch('/api/requeue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cardIds:ids})});alert('re-queued '+ids.length+' card(s) — now run on-demand/daily to fetch');}
async function prune(){const r=await (await fetch('/api/prune',{method:'POST'})).json();alert('pruned '+JSON.stringify(r));reload();}
async function poll(){const r=await (await fetch('/api/runlog')).json();const el=document.getElementById('log');if(el){el.textContent=r.log;el.scrollTop=el.scrollHeight;}}
users();
</script></body></html>`;
