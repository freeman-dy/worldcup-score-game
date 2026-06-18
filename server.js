require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const GROUP_ID = process.env.GROUP_ID || "main";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL 또는 SUPABASE_KEY가 없습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const matches = [
  { id: 1, round: "1차전", date: "2026.06.12", time: "11:00", home: "체코", away: "대한민국" },
  { id: 2, round: "2차전", date: "2026.06.19", time: "10:00", home: "대한민국", away: "멕시코" },
  { id: 3, round: "3차전", date: "2026.06.25", time: "10:00", home: "대한민국", away: "남아공" }
];

function requireAdmin(req, res, next) {
  const password = req.body.adminPassword || req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: "관리자 비밀번호가 맞지 않습니다." });
  }
  next();
}

async function setDefaultSetting(key, value) {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("group_id", GROUP_ID)
    .eq("key", key)
    .maybeSingle();

  if (!data) {
    await supabase.from("settings").insert({
      group_id: GROUP_ID,
      key,
      value
    });
  }
}

async function initDefaults() {
  await setDefaultSetting("adminName", "000");
  await setDefaultSetting("bankAccount", "000-000-000-000");
  await setDefaultSetting("entryFee", "10000");
}

async function getSettings() {
  await initDefaults();

  const { data, error } = await supabase
    .from("settings")
    .select("key,value")
    .eq("group_id", GROUP_ID);

  if (error) throw error;

  const obj = {};
  data.forEach(r => obj[r.key] = r.value);

  return {
    adminName: obj.adminName || "000",
    bankAccount: obj.bankAccount || "000-000-000-000",
    entryFee: Number(obj.entryFee || 10000)
  };
}

async function getPredictions(matchId) {
  const { data, error } = await supabase
    .from("predictions")
    .select("id, match_id, name, home_score, away_score, paid, created_at, updated_at")
    .eq("group_id", GROUP_ID)
    .eq("match_id", matchId)
    .order("id", { ascending: true });

  if (error) throw error;

  return data.map(p => ({
    id: p.id,
    matchId: p.match_id,
    name: p.name,
    homeScore: p.home_score,
    awayScore: p.away_score,
    paid: p.paid,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  }));
}

async function getAllPredictions() {
  const { data, error } = await supabase
    .from("predictions")
    .select("id, match_id, name, home_score, away_score, paid, created_at, updated_at")
    .eq("group_id", GROUP_ID)
    .order("match_id", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;

  return data.map(p => ({
    id: p.id,
    matchId: p.match_id,
    name: p.name,
    homeScore: p.home_score,
    awayScore: p.away_score,
    paid: p.paid,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  }));
}

async function getResults() {
  const { data, error } = await supabase
    .from("results")
    .select("match_id, home_score, away_score, confirmed_at")
    .eq("group_id", GROUP_ID);

  if (error) throw error;

  const obj = {};
  data.forEach(r => {
    obj[r.match_id] = {
      matchId: r.match_id,
      homeScore: r.home_score,
      awayScore: r.away_score,
      confirmedAt: r.confirmed_at
    };
  });

  return obj;
}

async function getWinners(matchId, results) {
  const result = results[matchId];
  if (!result) return [];

  const preds = await getPredictions(matchId);

  return preds.filter(p =>
    Number(p.homeScore) === Number(result.homeScore) &&
    Number(p.awayScore) === Number(result.awayScore)
  );
}

async function getCarryOverBefore(matchId, entryFee, results) {
  let carry = 0;

  for (const match of matches) {
    if (match.id >= matchId) break;

    const preds = await getPredictions(match.id);
    const total = preds.length * entryFee + carry;
    const result = results[match.id];

    if (!result) {
      carry = 0;
      continue;
    }

    const winners = await getWinners(match.id, results);
    carry = winners.length === 0 ? total : total % winners.length;
  }

  return carry;
}

async function calculateSettlement(matchId) {
  const settings = await getSettings();
  const entryFee = settings.entryFee;
  const results = await getResults();
  const preds = await getPredictions(matchId);
  const basePrize = preds.length * entryFee;
  const carryIn = await getCarryOverBefore(matchId, entryFee, results);
  const totalPrize = basePrize + carryIn;
  const result = results[matchId];
  const winners = await getWinners(matchId, results);

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

async function buildState() {
  const settings = await getSettings();
  const results = await getResults();
  const predictions = await getAllPredictions();

  const settlements = [];
  for (const m of matches) {
    settlements.push({
      matchId: m.id,
      ...(await calculateSettlement(m.id))
    });
  }

  return {
    ok: true,
    groupId: GROUP_ID,
    settings,
    matches,
    predictions,
    results,
    settlements
  };
}

app.get("/api/state", async (req, res) => {
  try {
    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/api/predictions", async (req, res) => {
  try {
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

    const { data: resultExists } = await supabase
      .from("results")
      .select("match_id")
      .eq("group_id", GROUP_ID)
      .eq("match_id", Number(matchId))
      .maybeSingle();

    if (resultExists) {
      return res.status(400).json({
        ok: false,
        message: "이미 결과가 확정된 경기입니다. 예상 스코어를 입력하거나 수정할 수 없습니다."
      });
    }

    const { error } = await supabase
      .from("predictions")
      .upsert({
        group_id: GROUP_ID,
        match_id: Number(matchId),
        name: cleanName,
        home_score: h,
        away_score: a,
        paid: 1,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "group_id,match_id,name"
      });

    if (error) throw error;

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.delete("/api/predictions/match/:matchId", requireAdmin, async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);

    await supabase
      .from("predictions")
      .delete()
      .eq("group_id", GROUP_ID)
      .eq("match_id", matchId);

    await supabase
      .from("results")
      .delete()
      .eq("group_id", GROUP_ID)
      .eq("match_id", matchId);

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.delete("/api/predictions/:id", requireAdmin, async (req, res) => {
  try {
    await supabase
      .from("predictions")
      .delete()
      .eq("group_id", GROUP_ID)
      .eq("id", Number(req.params.id));

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/api/results", requireAdmin, async (req, res) => {
  try {
    const { matchId, homeScore, awayScore } = req.body;

    const h = Number(homeScore);
    const a = Number(awayScore);

    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 20 || a > 20) {
      return res.status(400).json({ ok: false, message: "점수는 0~20 사이 정수로 입력하세요." });
    }

    const { error } = await supabase
      .from("results")
      .upsert({
        group_id: GROUP_ID,
        match_id: Number(matchId),
        home_score: h,
        away_score: a,
        confirmed_at: new Date().toISOString()
      }, {
        onConflict: "group_id,match_id"
      });

    if (error) throw error;

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.delete("/api/results/:matchId", requireAdmin, async (req, res) => {
  try {
    await supabase
      .from("results")
      .delete()
      .eq("group_id", GROUP_ID)
      .eq("match_id", Number(req.params.matchId));

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/api/settings", requireAdmin, async (req, res) => {
  try {
    const adminName = String(req.body.adminName || "000").trim();
    const bankAccount = String(req.body.bankAccount || "000-000-000-000").trim();
    const entryFee = Number(req.body.entryFee || 10000);

    await supabase.from("settings").upsert([
      { group_id: GROUP_ID, key: "adminName", value: adminName },
      { group_id: GROUP_ID, key: "bankAccount", value: bankAccount },
      { group_id: GROUP_ID, key: "entryFee", value: String(entryFee) }
    ], {
      onConflict: "group_id,key"
    });

    res.json(await buildState());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "월드컵 스코어 맞추기 Supabase 버전",
    groupId: GROUP_ID
  });
});

app.listen(PORT, () => {
  console.log(`월드컵 스코어 맞추기 실행: http://localhost:${PORT}`);
});
