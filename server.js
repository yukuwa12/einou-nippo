/**
 * 営農日報アプリ サーバー（紙のハガキ様式準拠）
 * - 1件の日報 = 紙1枚: 日付・氏名・作業(複数行: 作業区分・具体的内容・時間・場所)・特記事項・確認欄
 * - 作業者: 名前を入力して日報を登録・自分の日報を編集/削除（確認済みは変更不可）
 * - オペレーター: パスワードでログインし、全日報の閲覧/編集/削除/確認・集計・CSV出力・マスタ管理
 *
 * 金額 = 時間 × 作業区分の単価（1分単位で計算し、円未満は四捨五入）
 * 単価は各作業行の登録・更新時点のものを記録するため、後からマスタの単価を
 * 変更しても過去の日報の金額は変わらない。
 *
 * データは data/db.json（ローカル運用）または PostgreSQL（DATABASE_URL 設定時）に保存される
 */
const express = require("express");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
// オペレーターのパスワード。未設定なら起動のたびに推測できない値を作り、コンソールにだけ表示する
// （固定の初期パスワードをコードに書かない）
const ADMIN_PASSWORD_FROM_ENV = !!process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
// クラウドの永続ディスクを使う場合は DATA_DIR 環境変数で保存先を指定できる
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const app = express();
app.set("trust proxy", 1); // Render/Railway/トンネル等の逆プロキシ配下で接続元IPを正しく見る
// 通常のやり取りは小さく制限し、バックアップ復元のときだけ大きなファイルを許可する
app.use("/api/backups/restore-upload", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- 保存先の切り替え ----------
 * DATABASE_URL があれば PostgreSQL（Neon等）に保存（クラウド運用向け）。
 * なければ従来どおり data/db.json ファイルに保存（自宅PC運用向け）。 */
const usePg = !!process.env.DATABASE_URL;
let pool = null;
if (usePg) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3
  });
}

/* ---------- 合言葉ゲート ----------
 * SITE_CODE 環境変数を設定すると、正しい合言葉を知らない人はAPIを一切使えなくなる。
 * インターネット公開時の部外者対策（未設定ならゲートなし＝ローカル運用はそのまま）。 */
const SITE_CODE = process.env.SITE_CODE || "";
const gateAttempts = new Map(); // ip -> { count, lockedUntil }

app.get("/api/gate", (req, res) => res.json({ gated: !!SITE_CODE }));

app.post("/api/gate/check", (req, res) => {
  if (!SITE_CODE) return res.json({ ok: true });
  const ip = req.ip || "unknown";
  const a = gateAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (Date.now() < a.lockedUntil) {
    return res.status(429).json({ error: "失敗が続いたため一時的にロックしています。10分ほどしてからやり直してください" });
  }
  if (String((req.body || {}).code || "") !== SITE_CODE) {
    a.count += 1;
    if (a.count >= 5) {
      a.lockedUntil = Date.now() + 10 * 60 * 1000;
      a.count = 0;
    }
    gateAttempts.set(ip, a);
    return res.status(401).json({ error: "合言葉が違います" });
  }
  gateAttempts.delete(ip);
  res.json({ ok: true });
});

// 上の2つ以外のすべての /api/* は合言葉がないと使えない
app.use("/api", (req, res, next) => {
  if (!SITE_CODE) return next();
  const code = req.get("x-site-code") || req.query.code;
  if (code === SITE_CODE) return next();
  res.status(401).json({ error: "合言葉を入力してください", needCode: true });
});

/* ---------- データ読み書き ---------- */

// 作業区分・具体的内容の選択肢は紙の日報様式の並びを再現したもの。
// 単価と選択肢はサンプル値（実運用の値とは異なる）。管理画面の「マスタ管理」で変更できる。
const DEFAULT_DB = {
  reports: [],
  trash: [],   // 削除された日報（ごみ箱）
  history: [], // 変更履歴（追記のみ。書き換え・削除するAPIは存在しない）
  masters: {
    workTypes: [
      { name: "一般作業（軽作業）", rate: 1000,
        details: ["出荷調整", "箱洗い等", "袋詰め", "収穫手伝い"] },
      { name: "一般作業（重作業）", rate: 1200,
        details: ["水路掃除", "田植え手伝い", "稲刈り手伝い", "機械メンテナンス"] },
      { name: "草刈作業（モア含む）", rate: 1400, details: [] },
      { name: "オペレーター", rate: 1300,
        details: ["コンバイン", "トラクタ", "ハロー", "ロータリー", "田植機", "防除機"] },
      { name: "車両運搬作業", rate: 1200,
        details: ["苗運搬", "肥料運搬", "もみ・米運搬", "資材運搬"] },
      { name: "水管理", rate: 0, details: [] },
      { name: "その他", rate: 0, details: [] }
    ],
    places: [],
    // 日報提出の締め日（経理が管理画面で設定。最初は使わない）
    deadline: { enabled: false, monthOffset: 1, day: 5, overrides: {} }
  }
};

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

// 氏名の表記ゆれ防止: スペース（全角含む）を取り除いて統一する
function normalizeName(s) {
  return String(s ?? "").replace(/\s+/g, "");
}

/* 日時はすべて日本時間で扱う（サーバーは海外にあり、そのままでは9時間ずれる） */
const JST = "Asia/Tokyo";
function jstParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { y: g("year"), m: g("month"), d: g("day"), hh: g("hour"), mm: g("minute"), ss: g("second") };
}
function tsStamp(d = new Date()) {
  const p = jstParts(d);
  return p.y + p.m + p.d + "-" + p.hh + p.mm + p.ss;
}

function loadDbFile() {
  let raw;
  try {
    raw = fs.readFileSync(DB_PATH, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      // ファイルがまだ無い（初回起動）→ 初期データで開始
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    // ファイルはあるのに読めない（OneDriveの同期ロック等）
    // → 空データで上書きすると日報が全部消えるため、絶対に起動しない
    console.error("エラー: data/db.json が読み込めません:", e.message);
    console.error("データ保護のため起動を中止します。OneDriveの同期が終わるのを待って、もう一度起動してください。");
    process.exit(1);
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    // 中身が壊れている → 退避コピーを残してから初期データで開始（元データは消さない）
    const broken = path.join(path.dirname(DB_PATH), `db-broken-${tsStamp()}.json`);
    fs.copyFileSync(DB_PATH, broken);
    console.error(`警告: data/db.json が壊れていたため ${broken} に退避し、新しいデータで開始します`);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  try {
    if (!db.reports) db.reports = [];
    if (!db.trash) db.trash = [];
    if (!db.history) db.history = [];
    if (!db.masters) db.masters = JSON.parse(JSON.stringify(DEFAULT_DB.masters));
    // 旧形式マスタの移行（文字列配列 → オブジェクト、details欠落の補完）
    if (Array.isArray(db.masters.workTypes) && typeof db.masters.workTypes[0] === "string") {
      db.masters.workTypes = JSON.parse(JSON.stringify(DEFAULT_DB.masters.workTypes));
    }
    for (const w of db.masters.workTypes || []) {
      if (!Array.isArray(w.details)) {
        const def = DEFAULT_DB.masters.workTypes.find((d) => d.name === w.name);
        w.details = def ? [...def.details] : [];
      }
    }
    if (!db.masters.places) db.masters.places = db.masters.fields || [];
    delete db.masters.fields;
    delete db.masters.crops;
    // 旧形式日報（1件=1作業のフラット形式）→ ハガキ形式（1件=1日1枚、複数作業）へ移行
    if (db.reports.length > 0 && db.reports[0].workType !== undefined && db.reports[0].entries === undefined) {
      const sheets = new Map();
      for (const r of db.reports) {
        const key = r.date + "|" + r.worker;
        if (!sheets.has(key)) {
          sheets.set(key, {
            id: newId(), date: r.date, worker: r.worker, note: "", confirmed: false,
            entries: [], createdAt: r.createdAt, updatedAt: r.updatedAt
          });
        }
        const s = sheets.get(key);
        s.entries.push({
          id: newId(), workType: r.workType, detail: r.detail || "", place: r.place || "",
          startTime: r.startTime || "", endTime: r.endTime || "",
          hours: r.hours || 0, rate: r.rate || 0
        });
      }
      db.reports = [...sheets.values()];
    }
    // 既存データの氏名からもスペースを取り除いて統一
    for (const r of db.reports) r.worker = normalizeName(r.worker);
    for (const r of db.trash) r.worker = normalizeName(r.worker);
    return db;
  } catch (e) {
    // 形式変換に失敗 → 空データで上書きしないよう起動を中止
    console.error("エラー: data/db.json の形式変換に失敗しました:", e.message);
    console.error("データ保護のため起動を中止します。");
    process.exit(1);
  }
}

/* 毎日の自動バックアップ:
 * その日最初の保存の直前に、前日までの状態を data/backup/db-YYYYMMDD.json として残す。
 * 万一データが消えても直近のバックアップから戻せる。保持: 直近14日は毎日＋それ以前は各月1日分（1年分）。 */
const BACKUP_DIR = path.join(DATA_DIR, "backup");

function dailyBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const dest = path.join(BACKUP_DIR, `db-${ymd}.json`);
    if (fs.existsSync(dest)) return; // 今日の分は取得済み
    fs.copyFileSync(DB_PATH, dest);
    // 直近14日は毎日、それ以前は各月1日分のみ残す
    const keepDaily2 = ymdStr(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
    const keepMonthly2 = ymdStr(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const mm = f.match(/^db-([0-9]{8}).json$/);
      if (!mm) continue;
      const isMonthStart = mm[1].slice(6, 8) === "01";
      if (mm[1] < keepMonthly2 || (mm[1] < keepDaily2 && !isMonthStart)) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
    }
  } catch (e) {
    console.error("バックアップに失敗しました（保存処理は続行します）:", e.message);
  }
}

function saveDbFile(json) {
  dailyBackup();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, DB_PATH);
}

/* ---------- PostgreSQL 保存（DATABASE_URL 設定時） ----------
 * app_state: 全データを1行のJSONBとして保存（このアプリの規模では十分）
 * app_backups: 1日1回、その日最初の保存前の状態を残す（直近14日＋各月1日を1年分） */

function ymdStr(d = new Date()) {
  const p = jstParts(d);
  return p.y + p.m + p.d;
}

async function loadDbPg() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_backups (ymd TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())");
  const r = await pool.query("SELECT data FROM app_state WHERE id = 1");
  return r.rows[0] ? r.rows[0].data : null;
}

async function saveDbPg(json) {
  const today = ymdStr(new Date());
  // 直近14日は毎日、それ以前は各月1日分のみ残す（容量を抑えつつ長期も追える）
  const keepDaily = ymdStr(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
  const keepMonthly = ymdStr(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  // 今日最初の保存なら、保存前の状態をバックアップに残す
  await pool.query(
    "INSERT INTO app_backups (ymd, data) SELECT $1, data FROM app_state WHERE id = 1 ON CONFLICT (ymd) DO NOTHING",
    [today]);
  const DAILY_ONLY = "ymd ~ '^[0-9]{8}$'";
  await pool.query(
    "DELETE FROM app_backups WHERE " + DAILY_ONLY + " AND ymd < $1 AND substring(ymd from 7 for 2) <> '01'",
    [keepDaily]);
  await pool.query(
    "DELETE FROM app_backups WHERE " + DAILY_ONLY + " AND ymd < $1", [keepMonthly]);
  await pool.query(
    "INSERT INTO app_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
    [json]);
}

/* ---------- 保存の一本化 ----------
 * 書き込みは1本のチェーンで直列化し、順序の入れ替わりを防ぐ */
let saveChain = Promise.resolve();

function persist() {
  const json = usePg ? JSON.stringify(db) : JSON.stringify(db, null, 2);
  const p = saveChain.then(() => (usePg ? saveDbPg(json) : saveDbFile(json)));
  saveChain = p.catch(() => {}); // 1回の失敗で以降の保存が止まらないように
  return p;
}

// 非同期ハンドラのエラーを500応答にする（Express 4は自動で拾わないため）
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error("保存エラー:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "保存に失敗しました。もう一度お試しください" });
  });
}

let db = null;

// データの形を整える（欠けた項目の補完・氏名の統一・旧形式hours→分の変換）
function ensureDbShape(d) {
  if (!d.reports) d.reports = [];
  if (!d.trash) d.trash = [];
  if (!d.history) d.history = [];
  if (!d.masters) d.masters = JSON.parse(JSON.stringify(DEFAULT_DB.masters));
  d.masters.deadline = normalizeDeadline(d.masters.deadline);
  for (const r of [...d.reports, ...d.trash]) {
    r.worker = normalizeName(r.worker);
    for (const e of r.entries || []) {
      e.minutes = entryMinutes(e);
      delete e.hours;
    }
  }
}

async function initDb() {
  if (usePg) {
    db = await loadDbPg();
    if (!db) db = JSON.parse(JSON.stringify(DEFAULT_DB));
  } else {
    db = loadDbFile();
  }
  ensureDbShape(db);
  await persist();
}

/* ---------- 変更履歴（監査ログ） ----------
 * 紙の日報は書いた内容を後から誰かが勝手に書き換えられないのと同じように、
 * すべての操作（提出・修正・削除・復元・確認）を変更前後の内容つきで記録する。
 * 履歴を書き換え・削除するAPIは意図的に用意していない。
 */

function snapshot(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}

// 操作者名: オペレーターなら「オペレーター」、作業者なら本人の氏名
function actorOf(req) {
  if (isOperator(req)) return "オペレーター";
  const name = normalizeName(req.body?.worker ?? req.query.worker ?? "");
  return name || "不明";
}

function logHistory(action, sheetId, actor, before, after) {
  db.history.push({
    id: newId(),
    ts: new Date().toISOString(),
    action,          // create / update / delete / restore / confirm / unconfirm / masters
    sheetId,
    actor,
    before: snapshot(before),
    after: snapshot(after)
  });
}

/* ---------- オペレーター認証 ---------- */

const tokens = new Set();

function isOperator(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  return token && tokens.has(token);
}

function requireOperator(req, res, next) {
  if (!isOperator(req)) {
    return res.status(401).json({ error: "オペレーター認証が必要です" });
  }
  next();
}

// ログイン試行制限: 同一IPから5回失敗すると10分ロック（パスワード総当たり対策）
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

app.post("/api/login", (req, res) => {
  const ip = req.ip || "unknown";
  const a = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (Date.now() < a.lockedUntil) {
    return res.status(429).json({ error: "失敗が続いたため一時的にロックしています。10分ほどしてからやり直してください" });
  }
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    a.count += 1;
    if (a.count >= 5) {
      a.lockedUntil = Date.now() + 10 * 60 * 1000;
      a.count = 0;
    }
    loginAttempts.set(ip, a);
    return res.status(401).json({ error: "パスワードが違います" });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});

/* ---------- マスタ ---------- */

app.get("/api/masters", (req, res) => {
  res.json(db.masters);
});

app.put("/api/masters", requireOperator, asyncRoute(async (req, res) => {
  const before = snapshot(db.masters);
  const { workTypes, places } = req.body || {};
  if (Array.isArray(workTypes)) {
    const seen = new Set();
    const cleaned = [];
    for (const w of workTypes) {
      const name = String(w?.name ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      cleaned.push({
        name,
        rate: Math.max(0, Number(w.rate) || 0),
        details: Array.isArray(w.details)
          ? [...new Set(w.details.map((s) => String(s).trim()).filter(Boolean))]
          : []
      });
    }
    if (cleaned.length === 0) {
      return res.status(400).json({ error: "作業区分を1つ以上登録してください" });
    }
    db.masters.workTypes = cleaned;
  }
  if (Array.isArray(places)) {
    db.masters.places = [...new Set(places.map((s) => String(s).trim()).filter(Boolean))];
  }
  logHistory("masters", null, "オペレーター", before, db.masters);
  await persist();
  res.json(db.masters);
}));

/* ---------- 日報提出の締め日 ----------
 * 経理が管理画面で自由に設定する。締め日を過ぎても作業者は提出できるが、
 * 提出時に「理事へ直接連絡を」と案内し、日報には締め日後だった印を残す。
 * 設定: 基本ルール（対象月の monthOffset か月後の day 日まで）＋ 月ごとの個別設定 */
function normalizeDeadline(src) {
  const x = src && typeof src === "object" ? src : {};
  const overrides = {};
  if (x.overrides && typeof x.overrides === "object") {
    for (const [ym, date] of Object.entries(x.overrides)) {
      if (/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(ym) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(date))) {
        overrides[ym] = String(date);
      }
    }
  }
  const day = Math.round(Number(x.day));
  return {
    enabled: !!x.enabled,
    monthOffset: Number(x.monthOffset) === 0 ? 0 : 1,
    day: day >= 1 && day <= 31 ? day : 5,
    overrides
  };
}

// 日報の日付 → その月分の締め日（YYYY-MM-DD。この日までは期限内）。使わない設定なら null
function deadlineFor(dateStr, cfg = db.masters.deadline) {
  if (!cfg || !cfg.enabled || !/^[0-9]{4}-[0-9]{2}/.test(String(dateStr || ""))) return null;
  const ym = dateStr.slice(0, 7);
  if (cfg.overrides && cfg.overrides[ym]) return cfg.overrides[ym];
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + cfg.monthOffset;
  if (m > 12) { m -= 12; y++; }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(cfg.day, lastDay); // 31日指定は月末に合わせる
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function todayJst() {
  const p = jstParts();
  return p.y + "-" + p.m + "-" + p.d;
}

// 締め日を過ぎていれば { date, deadline } を返す
function pastDeadline(dateStr) {
  const deadline = deadlineFor(dateStr);
  return deadline && todayJst() > deadline ? { date: dateStr, deadline } : null;
}

// 賃金に関わる内容（日付・作業区分・時間）だけを比べるための要約
function wageKey(sheet) {
  return String(sheet.date) + "|" + (sheet.entries || [])
    .map((e) => e.workType + ":" + entryMinutes(e)).sort().join(",");
}

app.put("/api/deadline", requireOperator, asyncRoute(async (req, res) => {
  const before = snapshot(db.masters.deadline);
  db.masters.deadline = normalizeDeadline(req.body || {});
  logHistory("deadline", null, "オペレーター", before, db.masters.deadline);
  await persist();
  res.json(db.masters.deadline);
}));

function rateFor(workType) {
  const w = db.masters.workTypes.find((x) => x.name === workType);
  return w ? w.rate : 0;
}

/* ---------- 日報（1件 = 紙1枚） ---------- */

const MARU = "①②③④⑤⑥⑦⑧⑨⑩";

// 作業時間は「分」を正とする（旧データの hours（小数の時間）からも変換できる）
function entryMinutes(e) {
  if (e && Number.isFinite(Number(e.minutes)) && e.minutes !== "" && e.minutes !== null) {
    return Math.max(0, Math.round(Number(e.minutes)));
  }
  return Math.max(0, Math.round((Number(e && e.hours) || 0) * 60));
}

function pickEntry(e) {
  return {
    id: typeof e.id === "string" ? e.id : undefined,
    workType: String(e.workType ?? ""),
    detail: String(e.detail ?? "").trim(),
    place: String(e.place ?? "").trim(),
    startTime: String(e.startTime ?? ""),
    endTime: String(e.endTime ?? ""),
    minutes: entryMinutes(e)
  };
}

function pickSheet(body) {
  const s = {};
  if (body.date !== undefined) s.date = String(body.date);
  if (body.worker !== undefined) s.worker = normalizeName(body.worker);
  if (body.note !== undefined) s.note = String(body.note).trim();
  if (Array.isArray(body.entries)) s.entries = body.entries.map(pickEntry);
  return s;
}

/* 入力の上限。打ち間違い（例: 600分のつもりで6000分）や
 * 誤った大量登録でデータが膨らむのを防ぐ */
const LIMITS = {
  worker: 30, note: 1000, detail: 200, place: 100,
  entries: 20, minutesPerEntry: 24 * 60, minutesPerSheet: 24 * 60
};

function validateSheet(s) {
  if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return "日付を入力してください";
  if (!s.worker) return "氏名を入力してください";
  if (s.worker.length > LIMITS.worker) return "氏名が長すぎます";
  if (s.date < "2020-01-01" || s.date > "2100-12-31") return "日付が正しくありません";
  if (String(s.note || "").length > LIMITS.note) return "特記事項が長すぎます（1000文字まで）";
  if (!Array.isArray(s.entries) || s.entries.length === 0) return "作業を1つ以上記入してください";
  if (s.entries.length > LIMITS.entries) return "1日に登録できる作業は" + LIMITS.entries + "件までです";
  for (let i = 0; i < s.entries.length; i++) {
    const label = "作業" + (MARU[i] || i + 1);
    if (!s.entries[i].workType) return `${label}の作業区分に○をつけてください`;
    const min = entryMinutes(s.entries[i]);
    if (!(min > 0)) return `${label}の時間を入力してください（開始・終了時刻を入れると自動計算されます）`;
    if (min > LIMITS.minutesPerEntry) return `${label}の時間が24時間を超えています。入力を確認してください`;
    if (String(s.entries[i].detail || "").length > LIMITS.detail) return `${label}の具体的内容が長すぎます`;
    if (String(s.entries[i].place || "").length > LIMITS.place) return `${label}の場所が長すぎます`;
  }
  const totalMin = s.entries.reduce((n, e) => n + entryMinutes(e), 0);
  if (totalMin > LIMITS.minutesPerSheet) {
    return `1日の合計時間が24時間を超えています（現在 ${Math.round(totalMin / 60 * 10) / 10} 時間）。入力を確認してください`;
  }
  return null;
}

// 金額 = 単価 × 分 ÷ 60 を1分単位で計算し、円未満は四捨五入
// （単価0円の作業区分は金額算出の対象外 → null）
function withAmounts(sheet) {
  const entries = sheet.entries.map((e) => {
    const minutes = entryMinutes(e);
    const rate = Number(e.rate) || 0;
    const amount = rate > 0 ? Math.round((rate * minutes) / 60) : null;
    // hours は表示・Excel集計用の参考値（小数第2位まで）
    return { ...e, minutes, hours: Math.round((minutes / 60) * 100) / 100, amount };
  });
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  const totalAmount = entries.reduce((s, e) => s + (e.amount || 0), 0);
  return {
    ...sheet, entries, totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    totalAmount
  };
}

// 一覧取得: worker指定 → その作業者の分のみ(認証不要)、指定なし → オペレーターのみ全件
// workType / place を指定した場合は、該当する作業行だけに絞って返す（集計が絞り込みと一致するように）
app.get("/api/reports", (req, res) => {
  const { worker, from, to, place, workType } = req.query;
  if (!worker && !isOperator(req)) {
    return res.status(401).json({ error: "オペレーター認証が必要です" });
  }
  let list = db.reports;
  if (worker) list = list.filter((r) => r.worker === normalizeName(worker));
  if (from) list = list.filter((r) => r.date >= from);
  if (to) list = list.filter((r) => r.date <= to);
  // オペレーターによる修正の有無（作業者に見える化するためのフラグ）
  const opEditedIds = new Set(
    db.history.filter((h) => h.actor === "オペレーター" && (h.action === "update" || h.action === "restore"))
      .map((h) => h.sheetId)
  );
  let sheets = list.map((s) => ({ ...withAmounts(s), operatorEdited: opEditedIds.has(s.id) }));
  if (workType || place) {
    sheets = sheets
      .map((s) => ({
        ...s,
        entries: s.entries.filter((e) =>
          (!workType || e.workType === workType) &&
          (!place || (e.place || "").includes(place)))
      }))
      .filter((s) => s.entries.length > 0)
      .map((s) => withAmounts(s)); // 絞り込み後の合計を計算し直す
  }
  sheets.sort((a, b) =>
    b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || "")
  );
  res.json(sheets);
});

// 1枚取得（編集用・絞り込みなしの全作業行）
app.get("/api/reports/:id", (req, res) => {
  const sheet = db.reports.find((r) => r.id === req.params.id);
  if (!sheet) return res.status(404).json({ error: "日報が見つかりません" });
  if (!isOperator(req) && normalizeName(req.query.worker) !== sheet.worker) {
    return res.status(403).json({ error: "この日報を見る権限がありません" });
  }
  res.json(withAmounts(sheet));
});

app.post("/api/reports", asyncRoute(async (req, res) => {
  const s = pickSheet(req.body || {});
  const err = validateSheet(s);
  if (err) return res.status(400).json({ error: err });
  s.entries = s.entries.map((e) => ({ ...e, id: newId(), rate: rateFor(e.workType) }));
  s.id = newId();
  s.confirmed = false;
  s.createdAt = new Date().toISOString();
  s.updatedAt = s.createdAt;
  // 作業者が締め日を過ぎて提出した場合（経理が代わりに入力した分は対象外）
  const late = isOperator(req) ? null : pastDeadline(s.date);
  if (late) s.lateSubmit = { at: s.createdAt, deadline: late.deadline };
  db.reports.push(s);
  logHistory("create", s.id, actorOf(req), null, s);
  await persist();
  res.status(201).json({ ...withAmounts(s), lateNotice: late ? lateNoticeBody(late) : null });
}));

// 締め日を過ぎたときに作業者の画面へ返す案内
function lateNoticeBody(late) {
  return { date: late.date, deadline: late.deadline };
}

// 編集・削除: オペレーター、または本人（worker名が一致）のみ。
// 確認済み（印またはサイン相当）の日報は作業者からは変更できない。
function canModify(req, sheet) {
  if (isOperator(req)) return { ok: true };
  const claimed = normalizeName(req.body?.worker ?? req.query.worker);
  if (!claimed || claimed !== sheet.worker) {
    return { ok: false, status: 403, error: "この日報を変更する権限がありません" };
  }
  if (sheet.confirmed) {
    return { ok: false, status: 403, error: "確認済みの日報のため変更できません。オペレーターに連絡してください" };
  }
  return { ok: true };
}

app.put("/api/reports/:id", asyncRoute(async (req, res) => {
  const sheet = db.reports.find((r) => r.id === req.params.id);
  if (!sheet) return res.status(404).json({ error: "日報が見つかりません" });
  const perm = canModify(req, sheet);
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
  const patch = pickSheet(req.body || {});
  const merged = { ...sheet, ...patch };
  const err = validateSheet(merged);
  if (err) return res.status(400).json({ error: err });
  if (patch.entries) {
    // 既存の作業行は登録時の単価を保持（作業区分が変わった行・新しい行はその時点の単価）
    patch.entries = patch.entries.map((e) => {
      const old = e.id && sheet.entries.find((x) => x.id === e.id);
      const rate = old && old.workType === e.workType ? old.rate : rateFor(e.workType);
      return { ...e, id: e.id || newId(), rate };
    });
  }
  const before = snapshot(sheet);
  const updatedAt = new Date().toISOString();
  let late = null;
  if (!isOperator(req) && wageKey(before) !== wageKey(merged)) {
    // 変更後の日付、または変更前の日付の月が締め日を過ぎていれば対象
    late = pastDeadline(merged.date) || pastDeadline(before.date);
  }
  Object.assign(sheet, patch, { updatedAt });
  if (late) sheet.lateEdit = { at: updatedAt, deadline: late.deadline };
  logHistory("update", sheet.id, actorOf(req), before, sheet);
  await persist();
  res.json({ ...withAmounts(sheet), lateNotice: late ? lateNoticeBody(late) : null });
}));

// 削除 = ごみ箱へ移動（完全には消えない。ごみ箱から見直し・復元ができる）
app.delete("/api/reports/:id", asyncRoute(async (req, res) => {
  const idx = db.reports.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "日報が見つかりません" });
  const perm = canModify(req, db.reports[idx]);
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });
  const [sheet] = db.reports.splice(idx, 1);
  sheet.deletedAt = new Date().toISOString();
  sheet.deletedBy = actorOf(req);
  db.trash.push(sheet);
  logHistory("delete", sheet.id, sheet.deletedBy, sheet, null);
  await persist();
  res.json({ ok: true });
}));

/* ---------- ごみ箱（削除済み日報の見直し・復元） ---------- */

// 一覧: worker指定 → その作業者の分のみ、指定なし → オペレーターのみ全件
app.get("/api/trash", (req, res) => {
  const { worker } = req.query;
  if (!worker && !isOperator(req)) {
    return res.status(401).json({ error: "オペレーター認証が必要です" });
  }
  let list = db.trash;
  if (worker) list = list.filter((r) => r.worker === normalizeName(worker));
  list = [...list].sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
  res.json(list.map(withAmounts));
});

// 復元: オペレーター、または本人
app.post("/api/trash/:id/restore", asyncRoute(async (req, res) => {
  const idx = db.trash.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "ごみ箱に見つかりません" });
  const sheet = db.trash[idx];
  const claimed = normalizeName(req.body?.worker ?? req.query.worker);
  if (!isOperator(req) && claimed !== sheet.worker) {
    return res.status(403).json({ error: "この日報を復元する権限がありません" });
  }
  db.trash.splice(idx, 1);
  delete sheet.deletedAt;
  delete sheet.deletedBy;
  sheet.updatedAt = new Date().toISOString();
  db.reports.push(sheet);
  logHistory("restore", sheet.id, actorOf(req), null, sheet);
  await persist();
  res.json(withAmounts(sheet));
}));

/* ---------- 変更履歴の閲覧 ---------- */

// sheetId指定: その日報の履歴（オペレーター、または本人）
// 指定なし: 全体の履歴（オペレーターのみ、新しい順に最大200件）
app.get("/api/history", (req, res) => {
  const { sheetId } = req.query;
  if (sheetId) {
    const events = db.history.filter((h) => h.sheetId === sheetId);
    if (!isOperator(req)) {
      const claimed = normalizeName(req.query.worker);
      const owns = events.some((h) =>
        (h.before && h.before.worker === claimed) || (h.after && h.after.worker === claimed));
      if (!claimed || !owns) {
        return res.status(403).json({ error: "この日報の履歴を見る権限がありません" });
      }
    }
    return res.json([...events].reverse());
  }
  if (!isOperator(req)) {
    return res.status(401).json({ error: "オペレーター認証が必要です" });
  }
  res.json([...db.history].reverse().slice(0, 200));
});

// 確認欄（紙の「印またはサイン」に相当）: オペレーターのみ
app.post("/api/reports/:id/confirm", requireOperator, asyncRoute(async (req, res) => {
  const sheet = db.reports.find((r) => r.id === req.params.id);
  if (!sheet) return res.status(404).json({ error: "日報が見つかりません" });
  sheet.confirmed = !!(req.body || {}).confirmed;
  sheet.updatedAt = new Date().toISOString();
  logHistory(sheet.confirmed ? "confirm" : "unconfirm", sheet.id, "オペレーター", null, sheet);
  await persist();
  res.json(withAmounts(sheet));
}));

/* ---------- CSV出力（オペレーターのみ） ----------
 * 形式は紙の「月別出役明細書」に準拠:
 *   作業者ごとに1枚、日付1〜31が行、単価のある作業区分が列。
 *   各日は上段=時間(h)、下段=金額(円)の2段。末尾に合計。
 *   これをそのまま賃金計算に使える。
 * detail=1 を付けると、従来の明細形式（1作業=1行）で出力する。 */

const csvEsc = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* 月別明細の列 = 現在のマスタ（単価あり）＋ データに実際に登場する区分。
 * マスタで名称変更・削除された区分の過去分が明細から消えないようにする。 */
function monthlyColumns(sheets) {
  const cols = [];
  const seen = new Set();
  for (const w of db.masters.workTypes) {
    if (Number(w.rate) > 0) { cols.push({ name: w.name, rate: Number(w.rate) }); seen.add(w.name); }
  }
  for (const s of sheets) {
    for (const e of s.entries) {
      if (!seen.has(e.workType) && Number(e.rate) > 0) {
        cols.push({ name: e.workType, rate: Number(e.rate), retired: true });
        seen.add(e.workType);
      }
    }
  }
  return cols;
}

/* 作業者 → 年月 → { days: 日ごとの集計, rates: その月に実際に使われた単価 } */
function aggregateMonthly(sheets, cols) {
  const colNames = new Set(cols.map((c) => c.name));
  const byWorker = new Map();
  for (const s of sheets) {
    const ym = s.date.slice(0, 7);
    const day = Number(s.date.slice(8, 10));
    if (!byWorker.has(s.worker)) byWorker.set(s.worker, new Map());
    const months = byWorker.get(s.worker);
    if (!months.has(ym)) months.set(ym, { days: new Map(), rates: new Map() });
    const mo = months.get(ym);
    if (!mo.days.has(day)) mo.days.set(day, new Map());
    const cells = mo.days.get(day);
    for (const e of s.entries) {
      if (!colNames.has(e.workType)) continue;
      const cur = cells.get(e.workType) || { minutes: 0, amount: 0 };
      cur.minutes += Number(e.minutes) || 0;
      cur.amount += Number(e.amount) || 0;
      cells.set(e.workType, cur);
      if (Number(e.rate) > 0) {
        if (!mo.rates.has(e.workType)) mo.rates.set(e.workType, new Set());
        mo.rates.get(e.workType).add(Number(e.rate));
      }
    }
  }
  return byWorker;
}

/* 単価欄に出す値: その月に実際に使われた単価（改定をまたぐ月は併記）。
 * 実績がない列は現在のマスタ単価。表内で「時間×単価=金額」が食い違わないようにする。 */
function rateCellValue(mo, col) {
  const used = mo.rates.get(col.name);
  if (!used || used.size === 0) return { value: col.rate, numeric: true };
  const arr = [...used].sort((a, b) => a - b);
  if (arr.length === 1) return { value: arr[0], numeric: true };
  return { value: arr.map((n) => n.toLocaleString("ja-JP")).join(" / "), numeric: false };
}

function exportDetailCsv(list) {
  const headers = ["日付", "氏名", "作業区分", "具体的内容", "場所", "開始", "終了", "時間(分)", "時間(h)", "単価(円/時)", "金額(円)", "特記事項", "確認"];
  const rows = [];
  for (const sheet of list.map(withAmounts)) {
    for (const e of sheet.entries) {
      rows.push([
        sheet.date, sheet.worker, e.workType, e.detail, e.place,
        e.startTime, e.endTime, e.minutes, e.hours,
        e.rate > 0 ? e.rate : "", e.amount ?? "",
        sheet.note, sheet.confirmed ? "済" : ""
      ].map(csvEsc).join(","));
    }
  }
  return [headers.join(","), ...rows].join("\r\n");
}

// 月別出役明細書（紙様式準拠）
function exportMonthlyCsv(list) {
  const sheets = list.map(withAmounts);
  const cols = monthlyColumns(sheets);
  const byWorker = aggregateMonthly(sheets, cols);

  const lines = [];
  const workers = [...byWorker.keys()].sort((a, b) => a.localeCompare(b, "ja"));
  for (const worker of workers) {
    const months = byWorker.get(worker);
    for (const ym of [...months.keys()].sort()) {
      const mo = months.get(ym);
      const days = mo.days;
      const [y, m] = ym.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();

      if (lines.length > 0) lines.push(""); // 明細書ごとに1行あける

      lines.push(["月別出役明細書", `${y}年${m}月`, `氏名:${worker}`, "上段:時間(h) / 下段:金額(円)"].map(csvEsc).join(","));
      lines.push(["日", ...cols.map((c) => c.name)].map(csvEsc).join(","));
      lines.push(["単価", ...cols.map((c) => rateCellValue(mo, c).value)].map(csvEsc).join(","));

      const totals = cols.map(() => ({ minutes: 0, amount: 0 }));
      for (let d = 1; d <= lastDay; d++) {
        const cells = days.get(d);
        const hourRow = [d];
        const yenRow = [""];
        cols.forEach((c, i) => {
          const v = cells && cells.get(c.name);
          if (v) {
            totals[i].minutes += v.minutes;
            totals[i].amount += v.amount;
            hourRow.push((v.minutes / 60).toFixed(2));
            yenRow.push(v.amount);
          } else {
            hourRow.push("");
            yenRow.push("");
          }
        });
        lines.push(hourRow.map(csvEsc).join(","));
        lines.push(yenRow.map(csvEsc).join(","));
      }

      lines.push(["合計", ...totals.map((t) => (t.minutes / 60).toFixed(2))].map(csvEsc).join(","));
      lines.push(["", ...totals.map((t) => t.amount)].map(csvEsc).join(","));
      lines.push(["総合計(円)", totals.reduce((s, t) => s + t.amount, 0)].map(csvEsc).join(","));
    }
  }
  return lines.join("\r\n");
}

app.get("/api/export", requireOperator, (req, res) => {
  const { from, to, detail } = req.query;
  let list = db.reports;
  if (from) list = list.filter((r) => r.date >= from);
  if (to) list = list.filter((r) => r.date <= to);
  list = [...list].sort((a, b) =>
    a.date.localeCompare(b.date) || a.worker.localeCompare(b.worker, "ja")
  );

  const wantDetail = detail === "1" || detail === "true";
  const csv = "﻿" + (wantDetail ? exportDetailCsv(list) : exportMonthlyCsv(list));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="${wantDetail ? "nippo-meisai" : "nippo-getsubetsu"}.csv"`);
  res.send(csv);
});

/* ---------- 月別出役明細書（Excel: 紙様式を罫線・列幅つきで再現） ----------
 * 作業者×年月ごとに1シート。日付1〜月末が行、単価のある作業区分が列。
 * 各日は上段=時間(h)／下段=金額(円)。確認印（組合長・理事）と経理欄つき。 */

const XL_THIN = { style: "thin", color: { argb: "FF7F7F7F" } };
const XL_MED = { style: "medium", color: { argb: "FF000000" } };

function xlBox(cell, { top = XL_THIN, left = XL_THIN, bottom = XL_THIN, right = XL_THIN } = {}) {
  cell.border = { top, left, bottom, right };
}

function buildMonthlyWorkbook(list) {
  const sheets = list.map(withAmounts);
  const cols = monthlyColumns(sheets);
  const byWorker = aggregateMonthly(sheets, cols);

  const wb = new ExcelJS.Workbook();
  wb.creator = "営農日報";
  const lastCol = 1 + cols.length;               // A=日, B..=作業区分
  const stampCol1 = lastCol + 2, stampCol2 = lastCol + 3; // 確認印（組合長・理事）

  const workers = [...byWorker.keys()].sort((a, b) => a.localeCompare(b, "ja"));
  for (const worker of workers) {
    const months = byWorker.get(worker);
    for (const ym of [...months.keys()].sort()) {
      const mo = months.get(ym);
      const days = mo.days;
      const [y, m] = ym.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const ws = wb.addWorksheet(`${worker}_${y}年${m}月`.slice(0, 31).replace(/[\\/*?:\[\]]/g, "_"));

      ws.getColumn(1).width = 6;
      // 作業区分名がヘッダーに収まる幅（全角は2文字ぶんで数える）
      for (let i = 0; i < cols.length; i++) {
        const name = cols[i].name;
        const visual = [...name].reduce((n, ch) => n + (/[\x20-\x7E]/.test(ch) ? 1 : 2), 0);
        ws.getColumn(2 + i).width = Math.min(24, Math.max(14, visual + 2));
      }
      ws.getColumn(lastCol + 1).width = 2;
      ws.getColumn(stampCol1).width = 11;
      ws.getColumn(stampCol2).width = 11;

      // 1行目: 表題／単位の説明／確認印の見出し
      ws.mergeCells(1, 1, 1, 3);
      const title = ws.getCell(1, 1);
      title.value = "月別出役明細書";
      title.font = { size: 14, bold: true };
      const unit = ws.getCell(1, Math.max(4, lastCol - 1));
      unit.value = "（上段：時間 / 下段：金額）";
      unit.alignment = { horizontal: "right" };
      ws.mergeCells(1, stampCol1, 1, stampCol2);
      const stampHead = ws.getCell(1, stampCol1);
      stampHead.value = "確認印";
      stampHead.alignment = { horizontal: "center" };
      stampHead.font = { bold: true };

      // 2行目: 氏名・年月／確認印の役職名
      ws.getCell(2, 1).value = "氏名";
      ws.mergeCells(2, 2, 2, 3);
      const nameCell = ws.getCell(2, 2);
      nameCell.value = worker;
      nameCell.font = { size: 12, bold: true };
      const ymCell = ws.getCell(2, Math.max(4, lastCol - 1));
      ymCell.value = `${y}年${m}月`;
      ymCell.alignment = { horizontal: "right" };
      for (const [c, label] of [[stampCol1, "組合長"], [stampCol2, "理事"]]) {
        const cell = ws.getCell(2, c);
        cell.value = label;
        cell.alignment = { horizontal: "center" };
        xlBox(cell);
      }
      // 3行目: 押印スペース（背を高く）
      ws.getRow(3).height = 46;
      for (const c of [stampCol1, stampCol2]) xlBox(ws.getCell(3, c));

      // 表のヘッダー（作業区分と単価）
      const headRow = 4, rateRow = 5;
      const dayHead = ws.getCell(headRow, 1);
      dayHead.value = "日";
      dayHead.alignment = { horizontal: "center", vertical: "middle" };
      dayHead.font = { bold: true };
      dayHead.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1E6" } };
      xlBox(dayHead, { top: XL_MED, left: XL_MED });
      ws.getCell(rateRow, 1).value = "単価";
      ws.getCell(rateRow, 1).alignment = { horizontal: "center" };
      xlBox(ws.getCell(rateRow, 1), { left: XL_MED, bottom: XL_MED });

      cols.forEach((c, i) => {
        const col = 2 + i;
        const h = ws.getCell(headRow, col);
        // 現在のマスタにない区分（名称変更・削除された旧区分）は※印で区別
        h.value = c.retired ? c.name + "※" : c.name;
        h.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        h.font = { bold: true };
        h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1E6" } };
        xlBox(h, { top: XL_MED, right: i === cols.length - 1 ? XL_MED : XL_THIN });
        const r = ws.getCell(rateRow, col);
        const rv = rateCellValue(mo, c);
        r.value = rv.value;
        if (rv.numeric) r.numFmt = '#,##0"円"';
        else r.font = { size: 9 }; // 月内で単価改定があった場合は併記
        r.alignment = { horizontal: "center" };
        xlBox(r, { bottom: XL_MED, right: i === cols.length - 1 ? XL_MED : XL_THIN });
      });
      ws.getRow(headRow).height = 30;

      // 日ごとの2段（上段=時間 / 下段=金額）
      const totals = cols.map(() => ({ minutes: 0, amount: 0 }));
      let row = rateRow + 1;
      for (let d = 1; d <= lastDay; d++) {
        const hourRow = row, yenRow = row + 1;
        ws.mergeCells(hourRow, 1, yenRow, 1);
        const dayCell = ws.getCell(hourRow, 1);
        dayCell.value = d;
        dayCell.alignment = { horizontal: "center", vertical: "middle" };
        xlBox(dayCell, { left: XL_MED, bottom: XL_THIN });

        const cells = days.get(d);
        cols.forEach((c, i) => {
          const col = 2 + i;
          const v = cells && cells.get(c.name);
          const hc = ws.getCell(hourRow, col);
          const yc = ws.getCell(yenRow, col);
          if (v) {
            totals[i].minutes += v.minutes;
            totals[i].amount += v.amount;
            hc.value = Math.round((v.minutes / 60) * 100) / 100;
            yc.value = v.amount;
          }
          hc.numFmt = "0.00";
          yc.numFmt = "#,##0";
          hc.alignment = { horizontal: "right" };
          yc.alignment = { horizontal: "right" };
          const rightBorder = i === cols.length - 1 ? XL_MED : XL_THIN;
          // 上段と下段の境目は点線風に細く、日の区切りは実線
          hc.border = { top: XL_THIN, left: XL_THIN, right: rightBorder,
            bottom: { style: "hair", color: { argb: "FFAAAAAA" } } };
          yc.border = { top: { style: "hair", color: { argb: "FFAAAAAA" } },
            left: XL_THIN, right: rightBorder, bottom: XL_THIN };
        });
        // 行の高さを揃える（A4 1ページに収まる比率）
        ws.getRow(hourRow).height = 13;
        ws.getRow(yenRow).height = 13;
        row += 2;
      }

      // 合計（2段）
      const totalHourRow = row, totalYenRow = row + 1;
      ws.mergeCells(totalHourRow, 1, totalYenRow, 1);
      const totalLabel = ws.getCell(totalHourRow, 1);
      totalLabel.value = "合計";
      totalLabel.alignment = { horizontal: "center", vertical: "middle" };
      totalLabel.font = { bold: true };
      totalLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
      xlBox(totalLabel, { top: XL_MED, left: XL_MED, bottom: XL_MED });
      cols.forEach((t, i) => {
        const col = 2 + i;
        const hc = ws.getCell(totalHourRow, col);
        const yc = ws.getCell(totalYenRow, col);
        hc.value = Math.round((totals[i].minutes / 60) * 100) / 100;
        yc.value = totals[i].amount;
        hc.numFmt = "0.00";
        yc.numFmt = "#,##0";
        hc.font = { bold: true };
        yc.font = { bold: true };
        hc.alignment = { horizontal: "right" };
        yc.alignment = { horizontal: "right" };
        for (const cell of [hc, yc]) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
        }
        const rightBorder = i === cols.length - 1 ? XL_MED : XL_THIN;
        hc.border = { top: XL_MED, left: XL_THIN, right: rightBorder };
        yc.border = { left: XL_THIN, right: rightBorder, bottom: XL_MED };
      });

      // 全作業の合計金額（賃金計算へ使用）
      const grandRow = totalYenRow + 2;
      ws.mergeCells(grandRow, 1, grandRow, Math.max(2, cols.length - 1));
      const gLabel = ws.getCell(grandRow, 1);
      gLabel.value = "全作業 合計金額（賃金計算へ使用）";
      gLabel.font = { bold: true, size: 12 };
      gLabel.alignment = { horizontal: "right", vertical: "middle" };
      const gValueCol = Math.max(3, cols.length);
      ws.mergeCells(grandRow, gValueCol, grandRow, lastCol);
      const gValue = ws.getCell(grandRow, gValueCol);
      gValue.value = totals.reduce((s, t) => s + t.amount, 0);
      gValue.numFmt = '#,##0"円"';
      gValue.font = { bold: true, size: 14 };
      gValue.alignment = { horizontal: "right", vertical: "middle" };
      gValue.border = { top: XL_MED, left: XL_MED, bottom: XL_MED, right: XL_MED };
      ws.getRow(grandRow).height = 26;

      // 経理欄（表の下端に合わせて右側に配置。押印できる大きさを確保）
      const keiriRow = totalHourRow - 5;
      const keiriLabel = ws.getCell(keiriRow, stampCol1);
      keiriLabel.value = "経理";
      keiriLabel.alignment = { horizontal: "center" };
      xlBox(keiriLabel);
      ws.mergeCells(keiriRow + 1, stampCol1, keiriRow + 4, stampCol1);
      xlBox(ws.getCell(keiriRow + 1, stampCol1));

      // 印刷設定（A4縦・全体を1ページに収め、左右中央に配置）
      const lastRow = grandRow;
      ws.pageSetup = {
        paperSize: 9, orientation: "portrait", fitToPage: true,
        fitToWidth: 1, fitToHeight: 1,
        horizontalCentered: true,
        printArea: `A1:${ws.getColumn(stampCol2).letter}${lastRow}`,
        margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 }
      };
      ws.views = [{ state: "frozen", ySplit: rateRow }];
    }
  }

  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet("データなし");
    ws.getCell(1, 1).value = "該当する日報がありません";
  }
  return wb;
}

/* ---------- 年間集計表（月別・具体的内容ごとの時間と金額） ----------
 * 紙様式「作業区分 × 具体的内容 を行、月を列」に準拠。
 * 期間の指定がなければ今の年度（4月〜翌3月）を対象にする。 */

function fiscalYearRange(base = new Date()) {
  const y = base.getMonth() + 1 >= 4 ? base.getFullYear() : base.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ey, em] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
    if (out.length > 120) break; // 念のための上限（10年分）
  }
  return out;
}

// 具体的内容の行を決める。複数選択や自由記入は最初に一致した項目へ計上し、
// どれにも当てはまらないものは「その他（自由記入）」へ（時間の二重計上を防ぐ）
function detailBucket(entryDetail, masterDetails) {
  const d = String(entryDetail || "");
  for (const md of masterDetails) if (d.includes(md)) return md;
  return OTHER_DETAIL;
}
const OTHER_DETAIL = "その他（自由記入）";

function aggregateYearly(sheets, months) {
  const monthSet = new Set(months);
  const groups = new Map(); // workType -> { rate, details: Map<label, Map<ym, minutes>>, min: Map, yen: Map, rates: Set }
  const masterOf = (name) => db.masters.workTypes.find((w) => w.name === name);

  const ensure = (name) => {
    if (!groups.has(name)) {
      const m = masterOf(name);
      groups.set(name, {
        rate: m ? Number(m.rate) || 0 : 0,
        masterDetails: m ? [...m.details] : [],
        retired: !m,
        details: new Map(), min: new Map(), yen: new Map(), rates: new Set()
      });
    }
    return groups.get(name);
  };
  // マスタにある区分は実績が無くても行として出す（紙の様式と同じ並び）
  for (const w of db.masters.workTypes) ensure(w.name);

  for (const s of sheets) {
    const ym = s.date.slice(0, 7);
    if (!monthSet.has(ym)) continue;
    for (const e of s.entries) {
      const g = ensure(e.workType);
      const label = detailBucket(e.detail, g.masterDetails);
      if (!g.details.has(label)) g.details.set(label, new Map());
      const row = g.details.get(label);
      row.set(ym, (row.get(ym) || 0) + (Number(e.minutes) || 0));
      g.min.set(ym, (g.min.get(ym) || 0) + (Number(e.minutes) || 0));
      g.yen.set(ym, (g.yen.get(ym) || 0) + (Number(e.amount) || 0));
      if (Number(e.rate) > 0) g.rates.add(Number(e.rate));
    }
  }
  return groups;
}

function buildYearlyWorkbook(list, months, { worker } = {}) {
  const sheets = list.map(withAmounts);
  const wb = new ExcelJS.Workbook();
  wb.creator = "営農日報";

  // 出力単位: 作業者ごと（1人分に絞られていればその1枚のみ）
  const workers = worker
    ? [normalizeName(worker)]
    : [...new Set(sheets.map((s) => s.worker))].sort((a, b) => a.localeCompare(b, "ja"));
  const targets = workers.length > 1
    ? [{ name: "全員合計", rows: sheets }, ...workers.map((w) => ({ name: w, rows: sheets.filter((s) => s.worker === w) }))]
    : workers.map((w) => ({ name: w, rows: sheets.filter((s) => s.worker === w) }));

  const COL_TYPE = 1, COL_DETAIL = 2, COL_M0 = 3;
  const colTotal = COL_M0 + months.length;

  for (const t of targets) {
    const groups = aggregateYearly(t.rows, months);
    const ws = wb.addWorksheet(`${t.name}_年間`.slice(0, 31).replace(/[\\/*?:\[\]]/g, "_"));
    ws.getColumn(COL_TYPE).width = 18;
    ws.getColumn(COL_DETAIL).width = 24;
    for (let i = 0; i < months.length; i++) ws.getColumn(COL_M0 + i).width = 10;
    ws.getColumn(colTotal).width = 12;

    // 表題
    ws.mergeCells(1, COL_TYPE, 1, COL_DETAIL + 1);
    const title = ws.getCell(1, COL_TYPE);
    title.value = `年間集計表　${t.name}`;
    title.font = { size: 14, bold: true };
    const period = ws.getCell(1, colTotal);
    period.value = `${months[0].replace("-", "年")}月 〜 ${months[months.length - 1].replace("-", "年")}月`;
    period.alignment = { horizontal: "right" };

    // ヘッダー
    const headRow = 3;
    for (const [c, label] of [[COL_TYPE, "作業区分"], [COL_DETAIL, "具体的内容"]]) {
      const cell = ws.getCell(headRow, c);
      cell.value = label;
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1E6" } };
      xlBox(cell, { top: XL_MED, bottom: XL_MED, left: c === COL_TYPE ? XL_MED : XL_THIN });
    }
    months.forEach((ym, i) => {
      const cell = ws.getCell(headRow, COL_M0 + i);
      cell.value = `${Number(ym.slice(5, 7))}月`;
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1E6" } };
      xlBox(cell, { top: XL_MED, bottom: XL_MED });
    });
    const totalHead = ws.getCell(headRow, colTotal);
    totalHead.value = "合計";
    totalHead.font = { bold: true };
    totalHead.alignment = { horizontal: "center" };
    totalHead.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE8D6" } };
    xlBox(totalHead, { top: XL_MED, bottom: XL_MED, right: XL_MED });
    ws.getRow(headRow).height = 22;

    let row = headRow + 1;
    const amountRows = []; // 総合計の計算に使う「金額 計」行

    const putLabel = (r, text, { bold = false, fill = null } = {}) => {
      const cell = ws.getCell(r, COL_DETAIL);
      cell.value = text;
      if (bold) cell.font = { bold: true };
      if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      xlBox(cell);
      return cell;
    };

    for (const [name, g] of groups) {
      const startRow = row;
      // 具体的内容ごとの時間
      const labels = [...g.masterDetails];
      for (const extra of g.details.keys()) if (!labels.includes(extra)) labels.push(extra);
      if (!labels.includes(OTHER_DETAIL)) labels.push(OTHER_DETAIL);

      for (const label of labels) {
        putLabel(row, label);
        const per = g.details.get(label);
        months.forEach((ym, i) => {
          const cell = ws.getCell(row, COL_M0 + i);
          const min = per && per.get(ym);
          if (min) cell.value = Math.round((min / 60) * 100) / 100;
          cell.numFmt = "0.00";
          xlBox(cell);
        });
        const tc = ws.getCell(row, colTotal);
        tc.value = { formula: `SUM(${ws.getColumn(COL_M0).letter}${row}:${ws.getColumn(colTotal - 1).letter}${row})` };
        tc.numFmt = "0.00";
        xlBox(tc, { right: XL_MED });
        row++;
      }

      // 時間 計
      putLabel(row, "時間 計", { bold: true, fill: "FFF3F6F1" });
      months.forEach((ym, i) => {
        const cell = ws.getCell(row, COL_M0 + i);
        const min = g.min.get(ym) || 0;
        cell.value = Math.round((min / 60) * 100) / 100;
        cell.numFmt = "0.00";
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6F1" } };
        xlBox(cell);
      });
      const htc = ws.getCell(row, colTotal);
      htc.value = { formula: `SUM(${ws.getColumn(COL_M0).letter}${row}:${ws.getColumn(colTotal - 1).letter}${row})` };
      htc.numFmt = "0.00";
      htc.font = { bold: true };
      htc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6F1" } };
      xlBox(htc, { right: XL_MED });
      row++;

      // 金額 計（単価は実績のものを表示。単価なしの区分は金額行を出さない）
      const rates = [...g.rates].sort((a, b) => a - b);
      if (g.rate > 0 || rates.length > 0) {
        const rateLabel = rates.length === 0
          ? `（×${g.rate.toLocaleString("ja-JP")}円）`
          : `（×${rates.map((n) => n.toLocaleString("ja-JP")).join(" / ")}円）`;
        putLabel(row, `金額 計 ${rateLabel}`, { bold: true, fill: "FFFFF6DA" });
        months.forEach((ym, i) => {
          const cell = ws.getCell(row, COL_M0 + i);
          cell.value = g.yen.get(ym) || 0;
          cell.numFmt = "#,##0";
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF6DA" } };
          xlBox(cell);
        });
        const ytc = ws.getCell(row, colTotal);
        ytc.value = { formula: `SUM(${ws.getColumn(COL_M0).letter}${row}:${ws.getColumn(colTotal - 1).letter}${row})` };
        ytc.numFmt = "#,##0";
        ytc.font = { bold: true };
        ytc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF6DA" } };
        xlBox(ytc, { right: XL_MED });
        amountRows.push(row);
        row++;
      }

      // 作業区分名（左端に縦結合）
      ws.mergeCells(startRow, COL_TYPE, row - 1, COL_TYPE);
      const nameCell = ws.getCell(startRow, COL_TYPE);
      nameCell.value = g.retired ? name + "※" : name;
      nameCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      nameCell.font = { bold: true };
      xlBox(nameCell, { left: XL_MED, top: XL_MED, bottom: XL_MED });
    }

    // 手当（アプリでは扱わないため手入力欄。総合計には自動で反映される）
    const teateStart = row;
    for (const label of ["連絡員手当", "管理者手当"]) {
      putLabel(row, label);
      months.forEach((ym, i) => {
        const cell = ws.getCell(row, COL_M0 + i);
        cell.numFmt = "#,##0";
        xlBox(cell);
      });
      const tc = ws.getCell(row, colTotal);
      tc.value = { formula: `SUM(${ws.getColumn(COL_M0).letter}${row}:${ws.getColumn(colTotal - 1).letter}${row})` };
      tc.numFmt = "#,##0";
      xlBox(tc, { right: XL_MED });
      amountRows.push(row);
      row++;
    }
    ws.mergeCells(teateStart, COL_TYPE, row - 1, COL_TYPE);
    const teateCell = ws.getCell(teateStart, COL_TYPE);
    teateCell.value = "手当";
    teateCell.alignment = { horizontal: "center", vertical: "middle" };
    teateCell.font = { bold: true };
    xlBox(teateCell, { left: XL_MED, top: XL_MED, bottom: XL_MED });

    // 総合計（各「金額 計」＋手当の合計。手当を手入力すれば自動で加算される）
    row++;
    ws.mergeCells(row, COL_TYPE, row, COL_DETAIL);
    const gLabel = ws.getCell(row, COL_TYPE);
    gLabel.value = "総合計（賃金計算へ使用）";
    gLabel.font = { bold: true, size: 12 };
    gLabel.alignment = { horizontal: "right", vertical: "middle" };
    xlBox(gLabel, { top: XL_MED, left: XL_MED, bottom: XL_MED });
    const sumRefs = (colLetter) => amountRows.map((r) => `${colLetter}${r}`).join("+");
    months.forEach((ym, i) => {
      const letter = ws.getColumn(COL_M0 + i).letter;
      const cell = ws.getCell(row, COL_M0 + i);
      cell.value = { formula: sumRefs(letter) };
      cell.numFmt = "#,##0";
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6E2CF" } };
      xlBox(cell, { top: XL_MED, bottom: XL_MED });
    });
    const gTotal = ws.getCell(row, colTotal);
    gTotal.value = { formula: sumRefs(ws.getColumn(colTotal).letter) };
    gTotal.numFmt = '#,##0"円"';
    gTotal.font = { bold: true, size: 12 };
    gTotal.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6E2CF" } };
    xlBox(gTotal, { top: XL_MED, bottom: XL_MED, right: XL_MED });
    ws.getRow(row).height = 24;

    ws.pageSetup = {
      paperSize: 9, orientation: "landscape", fitToPage: true,
      fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
    };
    ws.views = [{ state: "frozen", xSplit: COL_DETAIL, ySplit: headRow }];
  }

  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet("データなし");
    ws.getCell(1, 1).value = "該当する日報がありません";
  }
  return wb;
}

app.get("/api/export-year-xlsx", requireOperator, asyncRoute(async (req, res) => {
  let { from, to, worker } = req.query;
  if (!from || !to) {
    const fy = fiscalYearRange();
    from = from || fy.from;
    to = to || fy.to;
  }
  const months = monthsBetween(from, to);
  let list = db.reports;
  if (worker) list = list.filter((r) => r.worker === normalizeName(worker));
  list = list.filter((r) => r.date >= from && r.date <= to);

  const wb = buildYearlyWorkbook(list, months, { worker });
  const base = worker ? `年間集計表_${normalizeName(worker)}` : "年間集計表_全員";
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="nenkan.xlsx"; filename*=UTF-8''${encodeURIComponent(base + ".xlsx")}`);
  await wb.xlsx.write(res);
  res.end();
}));

app.get("/api/export-xlsx", requireOperator, asyncRoute(async (req, res) => {
  const { from, to, worker } = req.query;
  let list = db.reports;
  if (worker) list = list.filter((r) => r.worker === normalizeName(worker));
  if (from) list = list.filter((r) => r.date >= from);
  if (to) list = list.filter((r) => r.date <= to);
  list = [...list].sort((a, b) =>
    a.date.localeCompare(b.date) || a.worker.localeCompare(b.worker, "ja")
  );

  const wb = buildMonthlyWorkbook(list);
  const base = worker ? `出役明細_${normalizeName(worker)}` : "出役明細_全員";
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="meisai.xlsx"; filename*=UTF-8''${encodeURIComponent(base + ".xlsx")}`);
  await wb.xlsx.write(res);
  res.end();
}));

/* ---------- バックアップのダウンロード（オペレーターのみ） ----------
 * クラウドで運用する場合でも、全データ(db.json)を手元のPCに保存できる */
app.get("/api/backup", requireOperator, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="nippo-backup-${tsStamp()}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

/* ---------- バックアップからの復元（オペレーターのみ） ----------
 * 復元の直前に現在の状態を「safety-日時」の控えとして必ず残す（直近5件保持）。
 * 誤って復元しても、その控えからやり直せる。 */

async function safetyBackupCurrent() {
  const key = "safety-" + tsStamp();
  const json = JSON.stringify(db);
  if (usePg) {
    await pool.query(
      "INSERT INTO app_backups (ymd, data) VALUES ($1, $2::jsonb) ON CONFLICT (ymd) DO NOTHING",
      [key, json]);
    await pool.query(
      "DELETE FROM app_backups WHERE ymd LIKE 'safety-%' AND ymd NOT IN (SELECT ymd FROM app_backups WHERE ymd LIKE 'safety-%' ORDER BY ymd DESC LIMIT 5)");
  } else {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, key + ".json"), json, "utf8");
    const safeties = fs.readdirSync(BACKUP_DIR).filter((f) => /^safety-[\d-]+\.json$/.test(f)).sort();
    while (safeties.length > 5) fs.unlinkSync(path.join(BACKUP_DIR, safeties.shift()));
  }
}

async function restoreDbFrom(data, sourceLabel) {
  await safetyBackupCurrent();
  db = data;
  ensureDbShape(db);
  logHistory("restoredb", null, "オペレーター", null, { restoredFrom: sourceLabel });
  await persist();
}

function isValidBackup(data) {
  return data && typeof data === "object" && Array.isArray(data.reports) && data.masters;
}

// 控えの一覧（毎日の自動控え + 復元直前の控え）
app.get("/api/backups", requireOperator, asyncRoute(async (req, res) => {
  const items = [];
  if (usePg) {
    const r = await pool.query(
      "SELECT ymd, created_at, jsonb_array_length(data->'reports') AS reports FROM app_backups ORDER BY ymd DESC");
    for (const row of r.rows) {
      items.push({ key: row.ymd, createdAt: row.created_at, reports: Number(row.reports) || 0 });
    }
  } else if (fs.existsSync(BACKUP_DIR)) {
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const m = f.match(/^(?:db-(\d{8})|(safety-[\d-]+))\.json$/);
      if (!m) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), "utf8"));
        items.push({
          key: m[1] || m[2],
          createdAt: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
          reports: (d.reports || []).length
        });
      } catch { /* 壊れたファイルは一覧に出さない */ }
    }
    items.sort((a, b) => b.key.localeCompare(a.key));
  }
  res.json(items);
}));

// 指定した控えの内容に戻す
app.post("/api/backups/:key/restore", requireOperator, asyncRoute(async (req, res) => {
  const key = String(req.params.key || "");
  if (!/^\d{8}$/.test(key) && !/^safety-[\d-]{1,40}$/.test(key)) {
    return res.status(400).json({ error: "バックアップの指定が正しくありません" });
  }
  let data = null;
  if (usePg) {
    const r = await pool.query("SELECT data FROM app_backups WHERE ymd = $1", [key]);
    data = r.rows[0] ? r.rows[0].data : null;
  } else {
    const file = path.join(BACKUP_DIR, (/^\d{8}$/.test(key) ? "db-" + key : key) + ".json");
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!isValidBackup(data)) return res.status(404).json({ error: "バックアップが見つかりません" });
  await restoreDbFrom(data, key);
  res.json({ ok: true });
}));

// 手元のバックアップファイル（バックアップ保存でダウンロードしたもの）から戻す
app.post("/api/backups/restore-upload", requireOperator, asyncRoute(async (req, res) => {
  const data = (req.body || {}).data;
  if (!isValidBackup(data)) {
    return res.status(400).json({ error: "バックアップファイルの形式が正しくありません（「バックアップ保存」で保存したファイルを選んでください）" });
  }
  await restoreDbFrom(data, "アップロードされたファイル");
  res.json({ ok: true });
}));

/* ---------- 起動 ---------- */

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`営農日報アプリ起動: http://localhost:${PORT}`);
      console.log(`保存先: ${usePg ? "PostgreSQL (DATABASE_URL)" : "data/db.json"}／合言葉ゲート: ${SITE_CODE ? "有効" : "なし"}`);
      // 環境変数で渡されたパスワードはログに残さない（クラウドのログ画面に平文で出てしまうため）
      console.log(ADMIN_PASSWORD_FROM_ENV
        ? "オペレーターパスワード: 環境変数 ADMIN_PASSWORD の値"
        : `オペレーターパスワード（今回の起動だけ有効）: ${ADMIN_PASSWORD}　※固定するには環境変数 ADMIN_PASSWORD を設定`);
    });
  })
  .catch((e) => {
    console.error("初期化に失敗しました:", e.message);
    process.exit(1);
  });
