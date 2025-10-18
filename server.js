import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const GRAFANA_URL = process.env.GRAFANA_URL || "https://betanalytics.net";
const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;
const DATASOURCE_NAME = process.env.DATASOURCE_NAME || "VAMOSETH";

if (!GRAFANA_API_KEY) {
  console.error("Missing GRAFANA_API_KEY");
  process.exit(1);
}

let dsInfo = null;
let leaderboardCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getDatasourceInfo() {
  if (dsInfo) return dsInfo;
  const r = await fetch(`${GRAFANA_URL}/api/datasources/name/${encodeURIComponent(DATASOURCE_NAME)}`, {
    headers: { Authorization: `Bearer ${GRAFANA_API_KEY}` }
  });
  if (!r.ok) throw new Error("Datasource not found: " + (await r.text()));
  const j = await r.json();
  dsInfo = { uid: j.uid, type: j.type };
  return dsInfo;
}

// top 100 by multiplier
function buildSQL() {
  return `
SELECT
  player_id,
  Package_id,
  bet_amount,
  paid_amount,
  total_odds,
  total_rows,
  (paid_amount / NULLIF(bet_amount, 0)) AS multiplier
FROM sportsbook.bm_bets
WHERE bet_amount > 0 AND paid_amount IS NOT NULL
ORDER BY multiplier DESC
LIMIT 100
  `.trim();
}

async function fetchLeaderboard() {
  const { uid, type } = await getDatasourceInfo();
  const payload = {
    queries: [{
      refId: "A",
      datasource: { uid, type },
      format: "table",
      rawSql: buildSQL()
    }]
  };

  const r = await fetch(`${GRAFANA_URL}/api/ds/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GRAFANA_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());

  const j = await r.json();
  const result = j?.results?.A;
  const frames = result?.frames || [];
  const rows = [];

  frames.forEach(f => {
    const cols = f?.schema?.fields?.map(x => x.name) || [];
    const values = f?.data?.values || [];
    const rowCount = values[0]?.length || 0;
    for (let i = 0; i < rowCount; i++) {
      const row = {};
      cols.forEach((c, idx) => (row[c] = values[idx][i]));
      rows.push(row);
    }
  });

  // obfuscate player IDs: keep first 2, last 1
  const obfuscated = rows.map(r => {
    const id = String(r.player_id ?? "");
    let safe = id;
    if (id.length > 3) {
      safe = id.slice(0, 2) + "*".repeat(id.length - 3) + id.slice(-1);
    }
    return {
      player_id: safe,
      package_id: r.Package_id,
      bet_amount: r.bet_amount,
      paid_amount: r.paid_amount,
      multiplier: r.multiplier
    };
  });

  leaderboardCache = { data: obfuscated, timestamp: Date.now() };
  console.log("Cache refreshed:", new Date().toLocaleTimeString());
  return obfuscated;
}

app.get("/api/leaderboard", async (req, res) => {
  try {
    const now = Date.now();
    if (leaderboardCache.data && now - leaderboardCache.timestamp < CACHE_TTL_MS) {
      return res.json({
        data: leaderboardCache.data,
        next_refresh: leaderboardCache.timestamp + CACHE_TTL_MS
      });
    }
    const data = await fetchLeaderboard();
    res.json({ data, next_refresh: leaderboardCache.timestamp + CACHE_TTL_MS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// background auto-refresh every 5 minutes
setInterval(async () => {
  try {
    await fetchLeaderboard();
  } catch (e) {
    console.error("Auto-refresh failed:", e.message);
  }
}, CACHE_TTL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Leaderboard API running on :${PORT}`));
