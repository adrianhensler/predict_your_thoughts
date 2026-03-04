import { Router } from "express";
import { getAdminStats } from "../db/index.js";
import { config } from "../config.js";
import { adminBasicAuth } from "../lib/basicAuth.js";

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="30" />
  <title>Predict Your Thoughts - Admin Cost</title>
  <style>
    :root { --bg:#f5f7f2; --card:#fff; --ink:#1b262c; --muted:#63717a; --accent:#1f7a8c; --warn:#b36b00; --danger:#b32339; }
    * { box-sizing: border-box; }
    body { margin:0; padding:1.2rem; background:var(--bg); color:var(--ink); font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
    h1,h2 { margin:0 0 0.6rem; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
    .card { background:var(--card); border:1px solid #d5dde0; border-radius:12px; padding:0.95rem; }
    .bar { height:14px; border-radius:99px; background:#e5ecef; overflow:hidden; }
    .fill { height:100%; background:var(--accent); }
    .fill.warn { background:var(--warn); }
    .fill.danger { background:var(--danger); }
    table { width:100%; border-collapse: collapse; font-size:0.92rem; }
    th,td { padding:0.4rem; border-bottom:1px solid #e6ecef; text-align:left; }
    .muted { color:var(--muted); }
    .mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
    .bars { display:grid; grid-template-columns:repeat(24,1fr); gap:3px; align-items:end; height:120px; }
    .bars span { background:#8db4bf; border-radius:3px 3px 0 0; display:block; }
    @media (max-width: 900px){ .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <h1>Admin Cost Dashboard</h1>
  <p class="muted">Auto-refreshes every 30 seconds. Endpoint: <span class="mono">/api/admin/stats</span></p>
  <div id="app" class="grid"></div>
  <script>
    function asMoney(value) { return '$' + Number(value || 0).toFixed(4); }
    function renderRows(rows, kind) {
      if (!Array.isArray(rows)) return '';
      return rows.map(function (row) {
        if (kind === 'provider') {
          return '<tr><td>' + row.provider + '</td><td>' + row.calls + '</td><td>' + asMoney(row.spend) + '</td></tr>';
        }
        return '<tr><td>' + row.provider + '</td><td>' + row.model + '</td><td>' + row.calls + '</td><td>' + asMoney(row.spend) + '</td></tr>';
      }).join('');
    }

    function renderBars(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return '';
      var max = rows.reduce(function(acc, item){ return Math.max(acc, item.count || 0); }, 1);
      return rows.map(function (item) {
        var h = Math.max(4, ((item.count || 0) / max) * 100);
        return '<span title="' + item.hour + ': ' + item.count + '" style="height:' + h + '%"></span>';
      }).join('');
    }

    async function load() {
      var response = await fetch('/api/admin/stats');
      if (!response.ok) {
        document.getElementById('app').innerHTML = '<div class="card">Failed to load stats</div>';
        return;
      }
      var payload = await response.json();
      var data = payload.data;
      var ratio = Math.min(100, (data.spend.today / data.budget.dailyCapUsd) * 100 || 0);
      var fillClass = ratio >= 95 ? 'danger' : (ratio >= data.budget.warningPercent ? 'warn' : '');
      var html = '';
      html += '<section class="card"><h2>Budget</h2>';
      html += '<p class="muted">Today ' + asMoney(data.spend.today) + ' / $' + Number(data.budget.dailyCapUsd).toFixed(2) + '</p>';
      html += '<div class="bar"><div class="fill ' + fillClass + '" style="width:' + ratio + '%"></div></div>';
      html += '<p class="muted">Remaining: ' + asMoney(data.budget.remainingUsd) + ' | Warning threshold: ' + data.budget.warningPercent + '%</p>';
      html += '<p class="muted">Fallback used today: ' + data.fallbackToday + '</p></section>';

      html += '<section class="card"><h2>Spend Snapshot</h2>';
      html += '<p>Today: <strong>' + asMoney(data.spend.today) + '</strong></p>';
      html += '<p>Yesterday: <strong>' + asMoney(data.spend.yesterday) + '</strong></p>';
      html += '<p>Last 7d: <strong>' + asMoney(data.spend.sevenDay) + '</strong></p>';
      html += '<p>All-time: <strong>' + asMoney(data.spend.allTime) + '</strong></p>';
      html += '<p class="muted">Errors: ' + data.errorCount + '</p></section>';

      html += '<section class="card"><h2>24h Call Volume</h2><div class="bars">' + renderBars(data.hourlyVolume) + '</div></section>';

      html += '<section class="card"><h2>Provider Breakdown</h2>';
      html += '<table><thead><tr><th>Provider</th><th>Calls</th><th>Spend</th></tr></thead><tbody>' + renderRows(data.providerRows, 'provider') + '</tbody></table></section>';

      html += '<section class="card" style="grid-column:1/-1"><h2>Model Breakdown</h2>';
      html += '<table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Spend</th></tr></thead><tbody>' + renderRows(data.modelRows, 'model') + '</tbody></table></section>';

      document.getElementById('app').innerHTML = html;
    }

    load();
  </script>
</body>
</html>`;
}

export const adminRouter = Router();

adminRouter.use(adminBasicAuth);

adminRouter.get("/cost", (_req, res) => {
  res.status(200).send(renderAdminPage());
});

adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const data = await getAdminStats();
    const remainingUsd = Math.max(0, Number((config.DAILY_BUDGET_USD - data.spend.today).toFixed(4)));
    res.json({
      success: true,
      data: {
        ...data,
        budget: {
          dailyCapUsd: config.DAILY_BUDGET_USD,
          warningPercent: config.WARNING_BUDGET_PERCENT,
          remainingUsd
        }
      }
    });
  } catch (error) {
    next(error);
  }
});
