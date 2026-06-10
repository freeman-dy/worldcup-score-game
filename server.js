require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const DB_PATH = process.env.DB_PATH || "worldcup_score_game.db";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(match_id, name)
);

CREATE TABLE IF NOT EXISTS results (
  match_id INTEGER PRIMARY KEY,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function setDefaultSetting(key, value) {
  const exists = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!exists) db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)").run(key, value);
}

setDefaultSetting("adminName", "000");
setDefaultSetting("bankAccount", "000-000-000-000");
setDefaultSetting("entryFee", "10000");

const matches = [
  { id: 1, round: "1차전", date: "2026.06.12", time: "11:00", home: "체코", away: "대한민국" },
  { id: 2, round: "2차전", date: "2026.06.19", time: "10:00", home: "대한민국", away: "멕시코" },
  { id: 3, round: "3차전", date: "2026.06.25", time: "10:00", home: "대한민국", away: "남아공" }
];

function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  return {
    adminName: obj.adminName || "000",
    bankAccount: obj.bankAccount || "000-000-000-000",
    entryFee: Number(obj.entryFee || 10000)
  };
}

function getPredictions(matchId) {
  return db.prepare(`
    SELECT id, match_id AS matchId, name, home_score AS homeScore, away_score AS awayScore, paid, created_at AS createdAt, updated_at AS updatedAt
    FROM predictions
    WHERE match_id = ?
    ORDER BY id ASC
  `).all(matchId);
}

function getAllPredictions() {
  return db.prepare(`
    SELECT id, match_id AS matchId, name, home_score AS homeScore, away_score AS awayScore, paid, created_at AS createdAt, updated_at AS updatedAt
    FROM predictions
    ORDER BY match_id ASC, id ASC
  `).all();
}

function getResults() {
  const rows = db.prepare(`
    SELECT match_id AS matchId, home_score AS homeScore, away_score AS awayScore, confirmed_at AS confirmedAt
    FROM results
  `).all();
  const obj = {};
  rows.forEach(r => obj[r.matchId] = r);
  return obj;
}

function getWinners(matchId, results) {
  const result = results[matchId];
  if (!result) return [];
  return getPredictions(matchId).filter(p =>
    Number(p.homeScore) === Number(result.homeScore) &&
    Number(p.awayScore) === Number(result.awayScore)
  );
}

function getCarryOverBefore(matchId, entryFee, results) {
  let carry = 0;
  for (const match of matches) {
    if (match.id >= matchId) break;
    const preds = getPredictions(match.id);
    const total = preds.length * entryFee + carry;
    const result = results[match.id];
    if (!result) {
      carry = 0;
      continue;
    }
    const winners = getWinners(match.id, results);
    if (winners.length === 0) carry = total;
    else carry = total % winners.length;
  }
  return carry;
}

function calculateSettlement(matchId) {
  const settings = getSettings();
  const entryFee = settings.entryFee;
  const results = getResults();
  const preds = getPredictions(matchId);
  const basePrize = preds.length * entryFee;
  const carryIn = getCarryOverBefore(matchId, entryFee, results);
  const totalPrize = basePrize + carryIn;
  const result = results[matchId];
  const winners = getWinners(matchId, results);

  if (!result) {
    return {
      status: "not_finished",
      participants: preds.length,
      basePrize,
      carryIn,
      totalPrize,
      winners: [],
      prizePerPerson: 0,
      carryOut: 0
    };
  }

  if (winners.length === 0) {
    return {
      status: "carry",
      participants: preds.length,
      basePrize,
      carryIn,
      totalPrize,
      winners: [],
      prizePerPerson: 0,
      carryOut: totalPrize
    };
  }

  return {
    status: "paid",
    participants: preds.length,
    basePrize,
    carryIn,
    totalPrize,
    winners,
    prizePerPerson: Math.floor(totalPrize / winners.length),
    carryOut: totalPrize % winners.length
  };
}

function buildState() {
  const settings = getSettings();
  const results = getResults();
  return {
    ok: true,
    settings,
    matches,
    predictions: getAllPredictions(),
    results,
    settlements: matches.map(m => ({
      matchId: m.id,
      ...calculateSettlement(m.id)
    }))
  };
}

function requireAdmin(req, res, next) {
  const password = req.body.adminPassword || req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "관리자 비밀번호가 맞지 않습니다." });
  }
  next();
}

app.get("/api/state", (req, res) => {
  res.json(buildState());
});

app.post("/api/predictions", (req, res) => {
  const { matchId, name, homeScore, awayScore } = req.body;

  const match = matches.find(m => m.id === Number(matchId));
  if (!match) return res.status(400).json({ ok: false, message: "경기 정보가 올바르지 않습니다." });

  const cleanName = String(name || "").trim().replace(/\s+/g, "");
  if (!cleanName) return res.status(400).json({ ok: false, message: "참가자 이름을 입력하세요." });

  const h = Number(homeScore);
  const a = Number(awayScore);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 20 || a > 20) {
    return res.status(400).json({ ok: false, message: "점수는 0~20 사이 정수로 입력하세요." });
  }
const resultExists = db.prepare(
  "SELECT match_id FROM results WHERE match_id = ?"
).get(Number(matchId));

if (resultExists) {
  return res.status(400).json({
    ok: false,
    message: "이미 결과가 확정된 경기입니다. 예상 스코어를 입력하거나 수정할 수 없습니다."
  });
}
  db.prepare(`
    INSERT INTO predictions(match_id, name, home_score, away_score, paid, created_at, updated_at)
    VALUES(?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(match_id, name)
    DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score, updated_at = CURRENT_TIMESTAMP
  `).run(Number(matchId), cleanName, h, a);

  res.json(buildState());
});

app.delete("/api/predictions/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM predictions WHERE id = ?").run(Number(req.params.id));
  res.json(buildState());
});

app.post("/api/results", requireAdmin, (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  const match = matches.find(m => m.id === Number(matchId));
  if (!match) return res.status(400).json({ ok: false, message: "경기 정보가 올바르지 않습니다." });

  const h = Number(homeScore);
  const a = Number(awayScore);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 20 || a > 20) {
    return res.status(400).json({ ok: false, message: "점수는 0~20 사이 정수로 입력하세요." });
  }

  db.prepare(`
    INSERT INTO results(match_id, home_score, away_score, confirmed_at)
    VALUES(?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(match_id)
    DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score, confirmed_at = CURRENT_TIMESTAMP
  `).run(Number(matchId), h, a);

  res.json(buildState());
});

app.delete("/api/results/:matchId", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM results WHERE match_id = ?").run(Number(req.params.matchId));
  res.json(buildState());
});

app.post("/api/settings", requireAdmin, (req, res) => {
  const adminName = String(req.body.adminName || "000").trim();
  const bankAccount = String(req.body.bankAccount || "000-000-000-000").trim();
  const entryFee = Number(req.body.entryFee || 10000);

  db.prepare("INSERT INTO settings(key, value) VALUES('adminName', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(adminName);
  db.prepare("INSERT INTO settings(key, value) VALUES('bankAccount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(bankAccount);
  db.prepare("INSERT INTO settings(key, value) VALUES('entryFee', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(entryFee));

  res.json(buildState());
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "월드컵 스코어 맞추기 서버형 v2" });
});

app.listen(PORT, () => {
  console.log(`월드컵 스코어 맞추기 실행: http://localhost:${PORT}`);
});
