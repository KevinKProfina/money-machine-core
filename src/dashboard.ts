import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { collectStatus } from './status.js';
import { appendStudioDecision, resolvePreviewFile } from './studio.js';
import { clearKillSwitch, setKillSwitch } from './supervisor.js';

export type DashboardOptions = { host: string; port: number; adminToken?: string };

function tokenMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage, limit = 4_096): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return body;
}

const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Checks the admin token; answers 403/401 itself and returns false when the request must stop. */
function requireAdmin(req: http.IncomingMessage, res: http.ServerResponse, options: DashboardOptions): boolean {
  if (!options.adminToken) {
    sendJson(res, 403, { error: 'MM_ADMIN_TOKEN is not configured; use the CLI instead' });
    return false;
  }
  if (!tokenMatches(req.headers.authorization, options.adminToken)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

export function createDashboardServer(options: DashboardOptions): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, await collectStatus());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/studio-preview') {
        // Generated (LLM-written) HTML: served sandboxed so it runs in an opaque origin and can't
        // reach the dashboard API or the admin token kept in this origin's sessionStorage.
        const file = resolvePreviewFile(url.searchParams.get('path') ?? '');
        const type = file ? PREVIEW_TYPES[path.extname(file).toLowerCase()] : undefined;
        if (!file || !type) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        let body: Buffer;
        try {
          body = await fsp.readFile(file);
        } catch {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        res.writeHead(200, { 'content-type': type, 'content-security-policy': 'sandbox', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/studio/decision') {
        if (!requireAdmin(req, res, options)) return;
        let body: { ventureId?: unknown; decision?: unknown; note?: unknown };
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' });
          return;
        }
        if (typeof body.ventureId !== 'string' || (body.decision !== 'approved' && body.decision !== 'rejected')) {
          sendJson(res, 400, { error: 'expected { ventureId, decision: "approved" | "rejected", note? }' });
          return;
        }
        try {
          await appendStudioDecision({
            ventureId: body.ventureId,
            decision: body.decision,
            decidedBy: 'dashboard',
            note: typeof body.note === 'string' ? body.note : undefined,
          });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return;
        }
        sendJson(res, 200, { ok: true, note: 'recorded; the venture studio applies it on its next cycle' });
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/api/kill' || url.pathname === '/api/resume')) {
        if (!requireAdmin(req, res, options)) return;
        if (url.pathname === '/api/kill') {
          const raw = await readBody(req);
          let reason = 'dashboard';
          try {
            reason = String((JSON.parse(raw || '{}') as { reason?: string }).reason ?? reason).slice(0, 200);
          } catch {
            // keep default reason
          }
          await setKillSwitch(reason);
          sendJson(res, 200, { killSwitch: true, reason });
        } else {
          sendJson(res, 200, { killSwitch: false, cleared: await clearKillSwitch() });
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export function startDashboard(options: DashboardOptions): Promise<http.Server> {
  const server = createDashboardServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      console.log(`dashboard: http://${options.host}:${options.port}`);
      resolve(server);
    });
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Money Machine</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5f6b7a; --line:#e3e6ea; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --card:#171b21; --fg:#e6e9ee; --muted:#93a0b0; --line:#262c35; --ok:#3fb950; --bad:#f85149; --warn:#d29922; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); padding:16px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 8px; }
  .muted { color:var(--muted); } .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin:12px 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto; margin-bottom:12px; }
  .kpi .v { font-size:20px; font-variant-numeric: tabular-nums; }
  table { border-collapse:collapse; width:100%; font-variant-numeric: tabular-nums; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  .banner { padding:10px 12px; border-radius:8px; margin:8px 0; border:1px solid var(--bad); color:var(--bad); }
</style>
</head>
<body>
<h1>Money Machine</h1>
<div class="muted" id="meta">lade…</div>
<div id="banner"></div>
<div class="grid" id="kpis"></div>
<div class="card"><h2>Strategien</h2><table id="strategies"></table></div>
<div class="card"><h2>Venture Studio</h2><div class="muted" id="studioMeta">keine Daten</div>
  <div id="studioToken" style="margin:8px 0"><label class="muted">Admin-Token für Freigaben: <input id="tokenInput" type="password" autocomplete="off" style="max-width:220px"></label></div>
  <table id="approvals"></table><table id="ventures"></table></div>
<div class="card"><h2>Agenten-Arena</h2><div class="muted" id="arenaMeta">keine Daten</div><table id="arena"></table></div>
<div class="card"><h2>Umsatzströme</h2><table id="revenue"></table></div>
<div class="card"><h2>Letzter Zyklus</h2><table id="cycle"></table></div>
<div class="card"><h2>Ereignisse</h2><table id="events"></table></div>
<script>
const tokenKey = 'mm-admin-token';
function getToken() { try { return sessionStorage.getItem(tokenKey) || ''; } catch { return ''; } }
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('tokenInput');
  input.value = getToken();
  input.addEventListener('change', () => { try { sessionStorage.setItem(tokenKey, input.value); } catch {} });
});
async function decide(ventureId, decision) {
  const note = decision === 'rejected' ? (prompt('Grund (optional):') || '') : '';
  const res = await fetch('/api/studio/decision', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken() }, body: JSON.stringify({ ventureId, decision, note }) });
  const body = await res.json().catch(() => ({}));
  alert(res.ok ? (decision === 'approved' ? 'Freigegeben – wird im nächsten Zyklus veröffentlicht.' : 'Abgelehnt.') : 'Fehler: ' + (body.error || res.status));
  refresh();
}
const usd = (n) => n == null || !isFinite(n) ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'USD' });
const pct = (n) => n == null || !isFinite(n) ? '–' : (n * 100).toFixed(1) + ' %';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
function table(el, head, rows) {
  document.getElementById(el).innerHTML = '<tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    (rows.length ? rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') : '<tr><td class="muted" colspan="' + head.length + '">keine Daten</td></tr>');
}
async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    document.getElementById('meta').textContent = 'Stand ' + new Date(s.timestamp).toLocaleString('de-DE') + ' · ' + s.stateDir;
    const banners = [];
    if (s.killSwitch.active) banners.push('NOT-AUS AKTIV' + (s.killSwitch.reason ? ': ' + s.killSwitch.reason : ''));
    for (const w of s.warnings) banners.push(w);
    document.getElementById('banner').innerHTML = banners.map((b) => '<div class="banner">' + esc(b) + '</div>').join('');
    const p = s.portfolio || {};
    const kpis = [['Kapital', usd(p.totalCapitalUsd)], ['Allokiert', usd(p.allocatedUsd)], ['Reserve', usd(p.reserveUsd)], ['PnL', usd(p.totalPnlUsd)],
      ['Rendite', pct(p.portfolioReturn)], ['Max. Drawdown', pct(p.maxDrawdown)], ['Umsatz 30T', usd(s.revenue && s.revenue.last30dUsd)],
      ['Marktplatz-Jobs', s.marketplace ? s.marketplace.jobsCompleted : '–']];
    document.getElementById('kpis').innerHTML = kpis.map(([k, v]) => '<div class="card kpi"><div class="muted">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    const alloc = (s.allocations && s.allocations.allocations) || {};
    table('strategies', ['Name', 'Modus', 'Status', 'Budget', 'PnL', 'Rendite', 'Trefferquote', 'Drawdown', 'Trades', 'Aktualisiert'],
      s.strategies.map((x) => [esc(x.name), x.mode === 'live' ? '<b class="bad">live</b>' : esc(x.mode),
        '<span class="' + (x.status === 'active' ? 'ok' : 'warn') + '">' + esc(x.status) + '</span>', usd(alloc[x.name]),
        usd(x.realizedPnlUsd + x.unrealizedPnlUsd), pct(x.totalReturn), pct(x.winRate), pct(x.maxDrawdown), x.totalTrades,
        (x.stale ? '<span class="warn">veraltet</span> ' : '') + esc(new Date(x.lastUpdated).toLocaleTimeString('de-DE'))]));
    const st = s.studio;
    document.getElementById('studioMeta').textContent = st
      ? 'Kanal ' + (st.channel || '–') + ' · ' + Object.entries(st.counts || {}).map(([k, v]) => k + ' ' + v).join(', ')
        + ((st.blockers || []).length ? ' · Blocker: ' + st.blockers.join('; ') : '')
      : 'keine Daten';
    const preview = (p) => p ? '<a href="/studio-preview?path=' + encodeURIComponent(p) + '" target="_blank" rel="noopener">Vorschau</a>' : '–';
    table('approvals', ['Wartet auf Freigabe', 'Preis', 'Seit', 'Vorschau', ''],
      ((st && st.pendingApprovals) || []).map((p) => [esc(p.title), usd(p.price), esc(new Date(p.requestedAt).toLocaleString('de-DE')), preview(p.previewPath),
        '<button data-id="' + esc(p.ventureId) + '" data-d="approved">Freigeben</button> <button data-id="' + esc(p.ventureId) + '" data-d="rejected">Ablehnen</button>']));
    for (const b of document.querySelectorAll('#approvals button')) b.onclick = () => decide(b.dataset.id, b.dataset.d);
    table('ventures', ['Live-Produkt', 'Preis', 'Verkäufe', 'Umsatz', 'Tage live'],
      ((st && st.live) || []).map((v) => [v.url ? '<a href="' + esc(v.url) + '" target="_blank" rel="noopener">' + esc(v.title) + '</a>' : esc(v.title), usd(v.price), v.sales, usd(v.revenue), v.daysLive]));
    const a = s.arena;
    document.getElementById('arenaMeta').textContent = a
      ? 'Zyklus ' + a.cycle + ' · Population ' + a.population + ' · max. Generation ' + a.maxGeneration + ' · Kapital ' + usd(a.equityUsd) + ' · Treasury ' + usd(a.treasuryUsd)
        + (a.births ? ' · Geburten ' + a.births.total + ' / Tode ' + ((a.deaths && a.deaths.total) || 0) : '')
      : 'keine Daten';
    table('arena', ['Agent', 'Generation', 'Guthaben', 'Rendite', 'Alter (Zyklen)'],
      ((a && a.leaderboard) || []).slice(0, 10).map((x) => [esc(x.id), x.generation, usd(x.balanceUsd), pct(x.return), x.ageCycles]));
    const streams = s.revenue ? Object.entries(s.revenue.streams) : [];
    table('revenue', ['Strom', 'Art', 'Gesamt', '7 Tage', '30 Tage', 'Simuliert'],
      streams.map(([n, v]) => [esc(n), esc(v.kind), usd(v.totalUsd), usd(v.last7dUsd), usd(v.last30dUsd), v.simulated ? 'ja' : 'nein']));
    const steps = (s.supervisor && s.supervisor.lastCycle && s.supervisor.lastCycle.steps) || [];
    table('cycle', ['Komponente', 'Ergebnis', 'Dauer', 'Letzte Ausgabe'],
      steps.map((x) => [esc(x.name), x.ok ? '<span class="ok">ok</span>' : '<span class="bad">' + esc(x.skipped || (x.timedOut ? 'Timeout' : 'Exit ' + x.exitCode)) + '</span>',
        (x.durationMs / 1000).toFixed(1) + ' s', esc(x.tail[x.tail.length - 1] || '')]));
    table('events', ['Zeit', 'Quelle', 'Level', 'Nachricht'],
      s.events.slice(0, 30).map((e) => [esc(new Date(e.ts).toLocaleString('de-DE')), esc(e.source), '<span class="' + (e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'muted') + '">' + esc(e.level) + '</span>', esc(e.message)]));
  } catch (err) {
    document.getElementById('meta').textContent = 'Status nicht erreichbar: ' + err.message;
  }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
