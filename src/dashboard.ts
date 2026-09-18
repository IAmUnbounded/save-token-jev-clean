import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallDecision, CompactStats } from './types.js';

export interface DashboardRecord {
  version: 1;
  createdAt: string;
  sessionId: string;
  trigger: string;
  stats: CompactStats;
  decisions: CallDecision[];
}

export interface DashboardOptions {
  dataDir?: string;
  host?: string;
  port?: number;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLUGIN_DATA || env.SAVE_TOKEN_JEV_DATA_DIR || join(tmpdir(), 'save-token-jev');
}

export function historyPath(options: Pick<DashboardOptions, 'dataDir'> = {}): string {
  return join(options.dataDir ?? defaultDataDir(), 'codex', 'history.jsonl');
}

export async function loadDashboardHistory(path: string): Promise<DashboardRecord[]> {
  try {
    const text = await readFile(path, 'utf8');
    const records: DashboardRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<DashboardRecord>;
        if (value.version === 1 && typeof value.createdAt === 'string' && typeof value.sessionId === 'string' && value.stats && Array.isArray(value.decisions)) {
          records.push(value as DashboardRecord);
        }
      } catch {
        // Ignore a partial final append; the next refresh will read the completed record.
      }
    }
    return records;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function html(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>save-token-jev · Context savings</title><style>
:root{color-scheme:dark;--bg:#080b14;--panel:rgba(20,27,43,.84);--panel2:#172139;--line:#263452;--text:#f4f7ff;--muted:#94a2c1;--mint:#63e6b0;--blue:#7da7ff;--amber:#f2c76e;--rose:#ff8296;--shadow:0 22px 70px rgba(0,0,0,.35)}
*{box-sizing:border-box}body{margin:0;color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(800px 420px at 10% -10%,#183b47 0%,transparent 63%),radial-gradient(700px 420px at 100% 0%,#202d59 0%,transparent 65%),var(--bg);min-height:100vh}main{max-width:1240px;margin:auto;padding:42px 24px 70px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:30px}.brand{display:flex;align-items:center;gap:12px}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--mint),var(--blue));box-shadow:0 8px 30px rgba(99,230,176,.22);position:relative}.logo:after{content:"";position:absolute;inset:9px;border:2px solid #07121a;border-radius:7px;opacity:.8}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:var(--mint);font-size:10px;font-weight:700}.title{font-size:27px;font-weight:760;letter-spacing:-.04em;margin:2px 0}.subtitle{color:var(--muted);margin:4px 0 0}.live{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:8px 12px;background:rgba(17,24,40,.7)}.live i{width:7px;height:7px;background:var(--mint);border-radius:50%;box-shadow:0 0 12px var(--mint)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:linear-gradient(145deg,rgba(24,34,55,.9),rgba(13,18,31,.8));border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow)}.label{color:var(--muted);font-size:12px}.value{font-size:28px;font-weight:760;letter-spacing:-.04em;margin-top:7px}.hint{color:#71809e;font-size:11px;margin-top:5px}.section{margin-top:32px}.section-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:12px}.section-title{font-size:16px;font-weight:700;letter-spacing:-.01em}.section-note{color:var(--muted);font-size:12px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:13px 16px;border-bottom:1px solid rgba(38,52,82,.72)}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:650;background:rgba(11,16,28,.42)}tr:last-child td{border-bottom:0}td.num{text-align:right;font-variant-numeric:tabular-nums}.tool-name{font-weight:650}.tool-meta{color:var(--muted);font-size:11px;margin-top:2px}.meter{height:6px;background:#202b43;border-radius:99px;overflow:hidden;margin-top:7px;min-width:130px}.meter span{display:block;height:100%;background:linear-gradient(90deg,var(--mint),var(--blue));border-radius:inherit}.tag{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:650;white-space:nowrap}.tag:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.drop{background:rgba(255,130,150,.12);color:var(--rose)}.truncate{background:rgba(242,199,110,.13);color:var(--amber)}.keep{background:rgba(99,230,176,.12);color:var(--mint)}.meaning{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.meaning-card{padding:15px 16px;border:1px solid var(--line);border-radius:14px;background:rgba(18,25,41,.76)}.meaning-card .tag{margin-bottom:9px}.meaning-card p{margin:0;color:var(--muted);font-size:12px}.empty{color:var(--muted);padding:25px 16px;text-align:center}.foot{color:#71809e;font-size:11px;margin-top:18px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:800px){main{padding:28px 14px 50px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.meaning{grid-template-columns:1fr}.top{display:block}.live{display:inline-flex;margin-top:16px}th:nth-child(5),td:nth-child(5),th:nth-child(6),td:nth-child(6){display:none}}@media(max-width:480px){.grid{grid-template-columns:1fr 1fr}.value{font-size:22px}th,td{padding:11px 10px}.meter{min-width:70px}}
</style></head><body><main><header class="top"><div class="brand"><div class="logo"></div><div><div class="eyebrow">local observability</div><div class="title">Context savings</div><div class="subtitle">Jev-guided compaction for Codex</div></div></div><div class="live"><i></i>Live · refreshes every 5 seconds</div></header><section class="grid" id="cards"></section><section class="section"><div class="section-head"><div><div class="section-title">What happened to each tool call?</div><div class="section-note">Decisions are made per call/result pair, never by rewriting your messages.</div></div></div><div class="meaning"><div class="meaning-card"><span class="tag drop">Removed pair</span><p>The tool call and its result were both judged unnecessary for the remaining task.</p></div><div class="meaning-card"><span class="tag truncate">Shortened result</span><p>The call still matters, but its full output does not. A bounded prefix and recovery note remain.</p></div><div class="meaning-card"><span class="tag keep">Kept verbatim</span><p>The call and complete result remain available exactly as recorded.</p></div></div></section><section class="section"><div class="section-head"><div><div class="section-title">Savings by tool</div><div class="section-note">Estimated token equivalent is saved characters ÷ 4.</div></div></div><div class="panel"><table><thead><tr><th>Tool</th><th>Decision</th><th>Calls</th><th>Saved characters</th><th>Estimated tokens</th><th>Last seen</th></tr></thead><tbody id="tools"></tbody></table></div></section><section class="section"><div class="section-head"><div><div class="section-title">Compaction history</div><div class="section-note">Each row is one Codex compaction event.</div></div></div><div class="panel"><table><thead><tr><th>When</th><th>Session</th><th>Reduction</th><th>Tool calls</th><th>Saved chars</th><th>Jev requests</th></tr></thead><tbody id="runs"></tbody></table></div></section><div class="foot">Everything stays on localhost. Counts are conservative estimates; provider billing tokenization may differ.</div></main><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString();
const meta={drop_call:{label:'Removed pair',cls:'drop'},truncate_result:{label:'Shortened result',cls:'truncate'},keep:{label:'Kept verbatim',cls:'keep'}};
const callSection=document.createElement('section');callSection.className='section';callSection.innerHTML='<div class="section-head"><div><div class="section-title">Recent call decisions</div><div class="section-note">The exact tool call and a redacted input preview are shown below.</div></div></div><div class="panel"><table><thead><tr><th>Call</th><th>What it did</th><th>Decision</th><th>Saved</th></tr></thead><tbody id="decisions"></tbody></table></div>';const sectionList=document.querySelectorAll('.section');document.querySelector('main').insertBefore(callSection,sectionList[1]||null);
async function refreshDecisions(){const records=await fetch('/api/history').then(r=>r.json());const decisions=records.flatMap(r=>r.decisions.map(d=>({...d,createdAt:r.createdAt,sessionId:r.sessionId})));document.querySelector('#decisions').innerHTML=decisions.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(d=>{const m=meta[d.action]||meta.keep;const preview=d.inputPreview||'Input not recorded in this older run';return '<tr><td><div class="tool-name">'+esc(d.id)+' · '+esc(d.name)+'</div><div class="tool-meta">'+esc(d.callId)+'</div></td><td><div style="color:var(--muted);font-size:12px;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(preview)+'">'+esc(preview)+'</div></td><td><span class="tag '+m.cls+'">'+m.label+'</span><div class="tool-meta">call '+Number(d.keepCall||0).toFixed(2)+' · result '+Number(d.keepResult||0).toFixed(2)+'</div></td><td class="num">'+fmt(d.savedChars||0)+'</td></tr>'}).join('')||'<tr><td colspan="4" class="empty">No call decisions recorded yet.</td></tr>'}refreshDecisions().catch(console.error);setInterval(()=>refreshDecisions().catch(console.error),5000);
async function refresh(){const records=await fetch('/api/history').then(r=>r.json());const decisions=records.flatMap(r=>r.decisions.map(d=>({...d,createdAt:r.createdAt,sessionId:r.sessionId})));const saved=decisions.reduce((n,d)=>n+(d.savedChars||0),0);const before=records.reduce((n,r)=>n+(r.stats.charsBefore||0),0);const after=records.reduce((n,r)=>n+(r.stats.charsAfter||0),0);const reduction=before?Math.round((before-after)/before*100):0;document.querySelector('#cards').innerHTML=[['Compactions',records.length,'Codex events'],['Characters saved',fmt(saved),'retained transcript data'],['Estimated tokens saved','~'+fmt(Math.round(saved/4)),'chars ÷ 4'],['Overall reduction',reduction+'%','across recorded runs']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="hint">'+x[2]+'</div></div>').join('');const groups=new Map();for(const d of decisions){const key=d.name+'|'+d.action;const g=groups.get(key)||{name:d.name,action:d.action,calls:0,saved:0,last:d.createdAt};g.calls++;g.saved+=d.savedChars||0;if(d.createdAt>g.last)g.last=d.createdAt;groups.set(key,g)}const toolRows=[...groups.values()].sort((a,b)=>b.saved-a.saved);const maxSaved=Math.max(1,...toolRows.map(g=>g.saved));document.querySelector('#tools').innerHTML=toolRows.map(g=>{const m=meta[g.action]||meta.keep;return '<tr><td><div class="tool-name">'+esc(g.name)+'</div><div class="meter"><span style="width:'+Math.max(3,Math.round(g.saved/maxSaved*100))+'%"></span></div></td><td><span class="tag '+m.cls+'">'+m.label+'</span></td><td class="num">'+fmt(g.calls)+'</td><td class="num">'+fmt(g.saved)+'</td><td class="num">~'+fmt(Math.round(g.saved/4))+'</td><td>'+esc(new Date(g.last).toLocaleString())+'</td></tr>'}).join('')||'<tr><td colspan="6" class="empty">No compactions recorded yet.</td></tr>';document.querySelector('#runs').innerHTML=records.slice().reverse().map(r=>'<tr><td>'+esc(new Date(r.createdAt).toLocaleString())+'</td><td class="mono">'+esc(r.sessionId.slice(0,12))+'</td><td>'+((r.stats.charsBefore?Math.round((r.stats.charsBefore-r.stats.charsAfter)/r.stats.charsBefore*100):0))+'%</td><td class="num">'+fmt(r.stats.calls)+'</td><td class="num">'+fmt(Math.max(0,(r.stats.charsBefore||0)-(r.stats.charsAfter||0)))+'</td><td class="num">'+fmt(r.stats.requests)+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No compactions recorded yet.</td></tr>'}refresh().catch(console.error);setInterval(()=>refresh().catch(console.error),5000);
</script></body></html>`;
}

function htmlLegacy(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>save-token-jev</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2d;--muted:#8b98b7;--text:#edf2ff;--accent:#71e0b5;--line:#273451}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 18px 56px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px}.subtitle{color:var(--muted);margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px}.value{font-size:25px;font-weight:700;color:var(--accent);margin-top:5px}.label{color:var(--muted);font-size:12px}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;font-weight:500}td.num{text-align:right;font-variant-numeric:tabular-nums}.tag{border-radius:999px;padding:3px 8px;font-size:12px}.drop{background:#5c2634;color:#ffb8c5}.truncate{background:#59491e;color:#ffe39a}.keep{background:#1c4c42;color:#a9ffdc}.empty{color:var(--muted);padding:20px 0}.foot{color:var(--muted);font-size:12px;margin-top:16px}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}th:nth-child(5),td:nth-child(5),th:nth-child(6),td:nth-child(6){display:none}}
</style></head><body><main><h1>save-token-jev</h1><div class="subtitle">Local compaction savings for Codex · refreshes every 5 seconds</div><section class="grid" id="cards"></section><h2>Tool-call savings</h2><table><thead><tr><th>Tool</th><th>Action</th><th>Calls</th><th>Saved chars</th><th>Estimated tokens</th><th>Last seen</th></tr></thead><tbody id="tools"></tbody></table><h2>Compactions</h2><table><thead><tr><th>When</th><th>Session</th><th>Reduction</th><th>Calls</th><th>Saved chars</th><th>Jev requests</th></tr></thead><tbody id="runs"></tbody></table><div class="foot">Tool savings are measured from retained transcript data. Estimated tokens use a conservative chars/4 display approximation; provider billing may differ.</div></main><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString();
async function refresh(){const records=await fetch('/api/history').then(r=>r.json());const decisions=records.flatMap(r=>r.decisions.map(d=>({...d,createdAt:r.createdAt,sessionId:r.sessionId})));const saved=decisions.reduce((n,d)=>n+(d.savedChars||0),0);const before=records.reduce((n,r)=>n+(r.stats.charsBefore||0),0);const after=records.reduce((n,r)=>n+(r.stats.charsAfter||0),0);document.querySelector('#cards').innerHTML=[['Compactions',records.length],['Chars saved',fmt(saved)],['Estimated tokens saved',fmt(Math.round(saved/4))],['Overall reduction',before?Math.round((before-after)/before*100)+'%':'0%']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div></div>').join('');const groups=new Map();for(const d of decisions){const key=d.name+'|'+d.action;const g=groups.get(key)||{name:d.name,action:d.action,calls:0,saved:0,last:d.createdAt};g.calls++;g.saved+=d.savedChars||0;if(d.createdAt>g.last)g.last=d.createdAt;groups.set(key,g)}document.querySelector('#tools').innerHTML=[...groups.values()].sort((a,b)=>b.saved-a.saved).map(g=>'<tr><td>'+esc(g.name)+'</td><td><span class="tag '+(g.action==='drop_call'?'drop':g.action==='truncate_result'?'truncate':'keep')+'">'+esc(g.action)+'</span></td><td class="num">'+fmt(g.calls)+'</td><td class="num">'+fmt(g.saved)+'</td><td class="num">~'+fmt(Math.round(g.saved/4))+'</td><td>'+esc(new Date(g.last).toLocaleString())+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No compactions recorded yet.</td></tr>';document.querySelector('#runs').innerHTML=records.slice().reverse().map(r=>'<tr><td>'+esc(new Date(r.createdAt).toLocaleString())+'</td><td>'+esc(r.sessionId.slice(0,12))+'</td><td>'+((r.stats.charsBefore?Math.round((r.stats.charsBefore-r.stats.charsAfter)/r.stats.charsBefore*100):0))+'%</td><td class="num">'+fmt(r.stats.calls)+'</td><td class="num">'+fmt(Math.max(0,(r.stats.charsBefore||0)-(r.stats.charsAfter||0)))+'</td><td class="num">'+fmt(r.stats.requests)+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No compactions recorded yet.</td></tr>'}refresh().catch(console.error);setInterval(()=>refresh().catch(console.error),5000);
</script></body></html>`;
}

export async function startDashboard(options: DashboardOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const path = historyPath(options);
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/api/history') return json(response, await loadDashboardHistory(path));
      if (url.pathname === '/api/health') return json(response, { ok: true });
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(html());
      }
      return json(response, { error: 'not found' }, 404);
    } catch (error) {
      return json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('dashboard server did not bind to a TCP port');
  return { server, url: `http://${host}:${address.port}/` };
}
