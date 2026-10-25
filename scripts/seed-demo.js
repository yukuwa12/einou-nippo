/* =========================================================
   デモ用の架空データを入れるスクリプト
   - 氏名・場所・作業内容はすべて架空です
   - アプリのAPIを通して登録するので、入力チェック・単価の記録・変更履歴は本番と同じ流れになります

   使い方（サーバーを起動したまま、別のターミナルで）:
     PowerShell:  $env:ADMIN_PASSWORD = "<起動時に表示されたパスワード>"; npm run seed-demo
     bash:        ADMIN_PASSWORD=<起動時に表示されたパスワード> npm run seed-demo
   空のデータに対して1回だけ実行してください（実行するたびに日報が追加されます）。
   ========================================================= */
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) {
  console.error("環境変数 ADMIN_PASSWORD に、サーバー起動時に表示されたオペレーターのパスワードを設定してください");
  process.exit(1);
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error || ""}`);
  return data;
}

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// 作業1行（時間は画面と同じく開始・終了時刻から分で計算して送る）
const work = (workType, detail, place, startTime, endTime) =>
  ({ workType, detail, place, startTime, endTime, minutes: toMin(endTime) - toMin(startTime) });

// 日本時間の今日から n 日前の日付（YYYY-MM-DD）と曜日（0=日曜）
function jstDay(n) {
  const d = new Date(Date.now() + 9 * 3600e3 - n * 86400e3);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}

const RAIN_DAY = 5; // この日は午後が雨で中止になった想定

// 作業者ごとの出勤曜日と、1日の作業（i で日替わり）
const PLAN = [
  {
    worker: "山田太郎", days: [1, 2, 3, 4, 5, 6],
    day: (i) => i % 2 === 0
      ? [work("オペレーター", "コンバイン", "第2圃場", "08:00", "12:00"),
         work("車両運搬作業", "もみ・米運搬", "第2圃場→乾燥場", "13:00", "15:30")]
      : [work("オペレーター", "トラクタ、ロータリー", "第1圃場", "08:00", "11:30"),
         work("一般作業（重作業）", "機械メンテナンス", "機械庫", "13:00", "14:30")]
  },
  {
    worker: "佐藤花子", days: [1, 3, 5, 6],
    day: () => [work("一般作業（軽作業）", "出荷調整、袋詰め", "作業場", "09:00", "12:00"),
                work("一般作業（軽作業）", "箱洗い等", "作業場", "13:00", "15:00")]
  },
  {
    worker: "鈴木一郎", days: [2, 4, 6],
    day: () => [work("草刈作業（モア含む）", "", "東の農道", "08:30", "11:30"),
                work("一般作業（重作業）", "水路掃除", "第3圃場の用水路", "13:00", "15:00")]
  },
  {
    worker: "高橋健", days: [1, 2, 3, 4, 5],
    day: (i) => [work("一般作業（重作業）", "稲刈り手伝い", i % 2 ? "第1圃場" : "第2圃場", "08:00", "12:00"),
                 work("車両運搬作業", "もみ・米運搬", "乾燥場", "13:00", "16:00")]
  }
];

const NOTES = {
  "山田太郎:2": "コンバインの刈刃を1枚交換（予備品を使用）",
  "高橋健:8": "乾燥機の投入口が詰まったため30分ほど清掃"
};

async function main() {
  const token = (await api("POST", "/api/login", { password: PASSWORD })).token;

  await api("PUT", "/api/masters", {
    places: ["第1圃場", "第2圃場", "第3圃場", "作業場", "機械庫", "乾燥場", "東の農道"]
  }, token);

  // 13日前から今日まで、各作業者が自分で提出した想定で登録する
  let count = 0;
  for (let n = 13; n >= 0; n--) {
    const { date, dow } = jstDay(n);
    for (const p of PLAN) {
      if (!p.days.includes(dow)) continue;
      let entries = p.day(n);
      let note = NOTES[`${p.worker}:${n}`] || "";
      if (n === RAIN_DAY) {
        entries = entries.slice(0, 1);
        note = "午後は雨のため作業中止";
      }
      await api("POST", "/api/reports", { date, worker: p.worker, entries, note });
      count++;
    }
  }

  // 3日より前の日報はオペレーターが確認済みにする（紙の確認印にあたる）
  const all = await api("GET", "/api/reports", null, token);
  const cutoff = jstDay(3).date;
  for (const s of all.filter((r) => r.date < cutoff)) {
    await api("POST", `/api/reports/${s.id}/confirm`, { confirmed: true }, token);
  }

  // オペレーターによる修正の例: 佐藤花子さんの直近の日報で、午後の終了時刻を 15:00 → 14:30 に直す
  const sato = all.filter((r) => r.worker === "佐藤花子" && r.date >= cutoff)[0];
  if (sato) {
    const entries = sato.entries.map((e, i) =>
      i === 1 ? { ...e, endTime: "14:30", minutes: toMin("14:30") - toMin(e.startTime) } : e);
    await api("PUT", `/api/reports/${sato.id}`, { ...sato, entries }, token);
  }

  // 作業者が二重に提出して自分で削除した例（ごみ箱に残る）
  const { date } = jstDay(1);
  const dup = await api("POST", "/api/reports", {
    date, worker: "鈴木一郎", note: "",
    entries: [work("草刈作業（モア含む）", "", "東の農道", "08:30", "11:30")]
  });
  await api("DELETE", `/api/reports/${dup.id}?worker=${encodeURIComponent("鈴木一郎")}`);

  console.log(`デモデータを登録しました: 日報 ${count} 枚（うち ${all.filter((r) => r.date < cutoff).length} 枚を確認済み）`);
}

main().catch((e) => {
  console.error("登録に失敗しました:", e.message);
  process.exit(1);
});
