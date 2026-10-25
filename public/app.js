/* 営農日報アプリ フロントエンド（紙のハガキ様式準拠: 1枚 = 1日分、作業①②…） */

const $ = (id) => document.getElementById(id);
const MARU = "①②③④⑤⑥⑦⑧⑨⑩";

const state = {
  role: null,          // "worker" | "operator"
  workerName: "",
  token: "",
  siteCode: localStorage.getItem("nippo-site-code") || "", // 合言葉（公開運用時のみ使用）
  masters: { workTypes: [], places: [] },
  editingSheetId: null, // 作業者フォームで編集中の日報(1枚)のID
  myReports: [],
  operatorSheets: [],
  modalSheetId: null,
  pendingSubmit: null   // 確認画面で「提出する」を待っている日報の内容
};

/* ---------- 共通ユーティリティ ---------- */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (state.siteCode) headers["X-Site-Code"] = state.siteCode;
  const res = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { /* JSON以外は無視 */ }
  if (!res.ok) {
    // 合言葉が未入力・変更された場合はゲート画面へ
    if (data && data.needCode) {
      state.siteCode = "";
      localStorage.removeItem("nippo-site-code");
      showView("gate");
    }
    throw new Error((data && data.error) || `エラー (${res.status})`);
  }
  return data;
}

// サーバーの保存値は世界標準時のため、表示は必ず日本時間に直す
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

/* ---------- 日報提出の締め日 ---------- */

// 日本時間の今日（YYYY-MM-DD）
function todayJst() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return g("year") + "-" + g("month") + "-" + g("day");
}

// 日報の日付 → その月分の締め日（サーバーと同じ計算）。使わない設定なら null
function deadlineFor(dateStr, cfg) {
  cfg = cfg || (state.masters && state.masters.deadline);
  if (!cfg || !cfg.enabled || !/^[0-9]{4}-[0-9]{2}/.test(String(dateStr || ""))) return null;
  const ym = dateStr.slice(0, 7);
  if (cfg.overrides && cfg.overrides[ym]) return cfg.overrides[ym];
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + (Number(cfg.monthOffset) === 0 ? 0 : 1);
  if (m > 12) { m -= 12; y++; }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Number(cfg.day) || 5, lastDay);
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// 締め日を過ぎていれば { date, deadline }
function pastDeadline(dateStr, cfg) {
  const deadline = deadlineFor(dateStr, cfg);
  return deadline && todayJst() > deadline ? { date: dateStr, deadline } : null;
}

// 「2026-09-05」→「9月5日」（今年でなければ年も付ける）
function fmtMd(ymd) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)), d = Number(ymd.slice(8, 10));
  return (y !== Number(todayJst().slice(0, 4)) ? y + "年" : "") + m + "月" + d + "日";
}

// 「2026-08-20」→「8月分」
function fmtMonthOf(dateStr) {
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  return (y !== Number(todayJst().slice(0, 4)) ? y + "年" : "") + m + "月分";
}

// 賃金に関わる内容（日付・作業区分・時間）の要約（サーバーと同じ）
function wageKey(sheet) {
  return String(sheet.date) + "|" + (sheet.entries || [])
    .map((e) => e.workType + ":" + entryMinutes(e)).sort().join(",");
}

// いま送ろうとしている日報が締め日の対象か（新規は日付で判定、編集は賃金に関わる変更があるときだけ）
function lateForSubmit(body) {
  const orig = state.editingSheetId && state.myReports.find((x) => x.id === state.editingSheetId);
  if (!orig) return pastDeadline(body.date);
  if (wageKey(orig) === wageKey(body)) return null;
  return pastDeadline(body.date) || pastDeadline(orig.date);
}

// 入力フォームの日付の下に出す案内
function updateDeadlineNote() {
  const el = $("deadline-note");
  if (!el) return;
  const date = $("f-date").value;
  const deadline = deadlineFor(date);
  if (!deadline) {
    el.className = "hidden";
    el.innerHTML = "";
    return;
  }
  if (todayJst() > deadline) {
    el.className = "deadline-warn";
    el.innerHTML = state.editingSheetId
      ? `⚠ <b>${fmtMonthOf(date)}の締め日（${fmtMd(deadline)}）を過ぎています。</b><br>作業時間などを変更した場合は、<b>理事へ直接ご連絡ください</b>。`
      : `⚠ <b>${fmtMonthOf(date)}の締め日（${fmtMd(deadline)}）を過ぎています。</b><br>提出はできますが、提出したあと<b>理事へ直接ご連絡ください</b>。`;
  } else {
    el.className = "deadline-info";
    el.textContent = `${fmtMonthOf(date)}の提出締め日：${fmtMd(deadline)}まで`;
  }
}

// 確認画面の先頭に出す警告
function deadlineAlertHtml(body) {
  const late = lateForSubmit(body);
  if (!late) return "";
  const verb = state.editingSheetId ? "変更" : "提出";
  return `
    <div class="deadline-alert">
      <div class="deadline-alert-title">⚠ 締め日を過ぎています</div>
      <p>${fmtMonthOf(late.date)}の日報の締め日は<b>${fmtMd(late.deadline)}</b>でした。このまま${verb}はできますが、賃金の計算に間に合わない場合があります。</p>
      <p class="deadline-alert-action">${verb}したあと、<b>必ず理事へ直接ご連絡ください。</b></p>
    </div>`;
}

// 提出・更新のあとに出す案内（「わかりました」を押すまで閉じない）
function showLateModal(notice, isEdit) {
  const verb = isEdit ? "更新" : "提出";
  $("late-title").textContent = verb + "しました";
  $("late-body").innerHTML = `
    <p class="late-lead">締め日を過ぎているため、<br><b>理事へ直接ご連絡ください。</b></p>
    <p>${fmtMonthOf(notice.date)}の日報の締め日は${fmtMd(notice.deadline)}でした。${verb}した内容は記録されていますが、賃金の計算に間に合わない場合があります。</p>`;
  $("late-modal").classList.remove("hidden");
  $("btn-late-ok").focus();
}

// 日報カード・一覧に付ける「締め日後」の印
function lateBadgeHtml(s) {
  if (s.lateSubmit) return '<span class="badge badge-late">締め日後の提出</span>';
  if (s.lateEdit) return '<span class="badge badge-late">締め日後に修正</span>';
  return "";
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function calcMinutes(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // 日をまたぐ場合
  return mins;
}

// 旧データ（hours: 小数の時間）にも対応して「分」を取り出す
function entryMinutes(e) {
  if (e && e.minutes !== undefined && e.minutes !== null && e.minutes !== "") {
    return Math.max(0, Math.round(Number(e.minutes)) || 0);
  }
  return Math.max(0, Math.round((Number(e && e.hours) || 0) * 60));
}

// 分 → 「2時間30分」「45分」の表示
function fmtDur(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0 && mm > 0) return `${h}時間${mm}分`;
  if (h > 0) return `${h}時間`;
  return `${mm}分`;
}

function yen(n) {
  return Number(n).toLocaleString("ja-JP");
}

function masterFor(workType) {
  return state.masters.workTypes.find((x) => x.name === workType) || null;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fillSelectStrings(sel, items, { emptyLabel = "選択" } = {}) {
  const current = sel.value;
  sel.innerHTML = "";
  const o = document.createElement("option");
  o.value = "";
  o.textContent = emptyLabel;
  sel.appendChild(o);
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((x) => x.value === current)) sel.value = current;
}

/* ---------- 長い一覧の折りたたみ ----------
 * 最初は initial 件だけ表示し、「続きを見る」で step 件ずつ広げる。
 * 広げたあとは「閉じる」で最初の件数まで畳み直せる */
function collapseList(container, initial = 3, step = 10, unit = "件") {
  const anchor = container.closest(".table-wrap") || container;
  // 前回のボタン行が残っていれば消す
  if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("more-actions")) {
    anchor.nextElementSibling.remove();
  }
  const items = [...container.children];
  if (items.length <= initial) return;

  let shown = initial;
  const bar = document.createElement("div");
  bar.className = "more-actions";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "btn btn-ghost";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-ghost";
  closeBtn.textContent = "閉じる";
  bar.append(moreBtn, closeBtn);

  const apply = () => {
    items.forEach((el, i) => el.classList.toggle("hidden", i >= shown));
    moreBtn.textContent = `続きを見る（あと${items.length - shown}${unit}）`;
    moreBtn.classList.toggle("hidden", shown >= items.length);
    closeBtn.classList.toggle("hidden", shown <= initial);
  };
  moreBtn.addEventListener("click", () => {
    shown = Math.min(shown + step, items.length);
    apply();
  });
  closeBtn.addEventListener("click", () => {
    shown = initial;
    apply();
    // 畳んだあと、一覧の先頭が見える位置まで戻る
    (container.closest(".card") || anchor).scrollIntoView({ behavior: "smooth", block: "start" });
  });
  apply();
  anchor.after(bar);
}

/* ---------- 画面切り替え ---------- */

function showView(name) {
  for (const v of ["gate", "login", "worker", "operator"]) {
    $("view-" + v).classList.toggle("hidden", v !== name);
  }
  const isLoggedIn = name !== "login" && name !== "gate";
  $("header-user").classList.toggle("hidden", !isLoggedIn);
  // オペレーター画面のときだけ、ヘッダーに画面切り替えタブを出す
  $("op-tabs").classList.toggle("hidden", name !== "operator");
  document.querySelector(".app-header").classList.toggle("has-tabs", name === "operator");
  if (name === "worker") $("user-label").textContent = `作業者：${state.workerName} さん`;
  if (name === "operator") $("user-label").textContent = "オペレーター";
}

function logout() {
  state.role = null;
  state.workerName = "";
  state.token = "";
  state.editingSheetId = null;
  sessionStorage.removeItem("nippo-session");
  showView("login");
}

function saveSession() {
  sessionStorage.setItem("nippo-session", JSON.stringify({
    role: state.role, workerName: state.workerName, token: state.token
  }));
}

async function restoreSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem("nippo-session"));
    if (!s || !s.role) return false;
    Object.assign(state, s);
    if (s.role === "worker") {
      await enterWorker();
    } else {
      await enterOperator();
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------- マスタ ---------- */

async function loadMasters() {
  state.masters = await api("/api/masters");
}

function applyMastersToForms() {
  fillSelectStrings($("q-worktype"), state.masters.workTypes.map((w) => w.name), { emptyLabel: "すべて" });
  const dl = $("places-list");
  dl.innerHTML = "";
  for (const p of state.masters.places) {
    const o = document.createElement("option");
    o.value = p;
    dl.appendChild(o);
  }
}

/* ---------- 作業ブロック（紙の作業①②…に相当） ---------- */

// detail文字列 → マスタの選択肢との対応（○のついた項目 + その他自由記入）に分解
function parseDetail(workType, detailStr) {
  const m = masterFor(workType);
  const selected = [];
  let rest = detailStr || "";
  if (m) {
    for (const item of [...m.details].sort((a, b) => b.length - a.length)) {
      if (rest.includes(item)) {
        selected.push(item);
        rest = rest.replace(item, " ");
      }
    }
  }
  const other = rest.split(" ").map((s) => s.replace(/^[、\s]+|[、\s]+$/g, "")).filter(Boolean).join("、");
  return { selected, other };
}

function buildDetailChips(block, workType, selectedItems = []) {
  const wrap = block.querySelector(".detail-chips");
  wrap.innerHTML = "";
  const m = masterFor(workType);
  const details = m ? m.details : [];
  for (const item of details) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (selectedItems.includes(item) ? " on" : "");
    b.dataset.value = item;
    b.textContent = item;
    wrap.appendChild(b);
  }
  block.querySelector(".detail-area").classList.toggle("no-choices", details.length === 0);
}

function buildEntryBlock(container, entry = null) {
  const block = document.createElement("fieldset");
  block.className = "entry";
  if (entry?.id) block.dataset.entryId = entry.id;

  const chips = state.masters.workTypes.map((w) => {
    const label = w.rate > 0 ? `${w.name}<span class="chip-rate">${yen(w.rate)}円</span>` : w.name;
    const on = entry && entry.workType === w.name ? " on" : "";
    return `<button type="button" class="chip wt-chip${on}" data-value="${escapeHtml(w.name)}">${label}</button>`;
  }).join("");

  block.innerHTML = `
    <legend><span class="entry-no">作業①</span>
      <button type="button" class="btn-danger-text entry-del">この作業を削除</button>
    </legend>
    <div class="chip-label">作業区分（○をつける） <span class="req">必須</span></div>
    <div class="chip-group wt-chips">${chips}</div>
    <div class="detail-area">
      <div class="chip-label">具体的内容（該当に○・複数可）</div>
      <div class="chip-group detail-chips"></div>
      <input type="text" class="detail-other" placeholder="その他（自由記入）">
    </div>
    <div class="grid-3">
      <label>開始時刻
        <input type="time" class="t-start">
      </label>
      <label>終了時刻
        <input type="time" class="t-end">
      </label>
      <label class="dur-label">時間 <span class="req">必須</span>
        <span class="dur-inputs">
          <input type="number" class="t-dur-h" min="0" max="24" placeholder="0"><span class="dur-unit">時間</span>
          <input type="number" class="t-dur-m" min="0" max="59" placeholder="0"><span class="dur-unit">分</span>
        </span>
      </label>
    </div>
    <label>場所
      <input type="text" class="t-place" list="places-list" placeholder="例：第1圃場、○○さん宅前の田">
    </label>
    <div class="entry-amount hidden"></div>
  `;

  if (entry) {
    const { selected, other } = parseDetail(entry.workType, entry.detail);
    buildDetailChips(block, entry.workType, selected);
    block.querySelector(".detail-other").value = other;
    block.querySelector(".t-start").value = entry.startTime || "";
    block.querySelector(".t-end").value = entry.endTime || "";
    setBlockMinutes(block, entryMinutes(entry));
    block.querySelector(".t-place").value = entry.place || "";
  } else {
    buildDetailChips(block, "");
  }

  container.appendChild(block);
  renumberEntries(container);
  updateEntryAmount(block);
  return block;
}

function renumberEntries(container) {
  const blocks = [...container.querySelectorAll(".entry")];
  blocks.forEach((b, i) => {
    b.querySelector(".entry-no").textContent = "作業" + (MARU[i] || i + 1);
    b.querySelector(".entry-del").classList.toggle("hidden", blocks.length === 1);
  });
}

function entryWorkType(block) {
  const on = block.querySelector(".wt-chip.on");
  return on ? on.dataset.value : "";
}

// 入力欄（時間＋分）⇔ 分
function blockMinutes(block) {
  const h = Number(block.querySelector(".t-dur-h").value) || 0;
  const m = Number(block.querySelector(".t-dur-m").value) || 0;
  return Math.max(0, Math.round(h * 60 + m));
}

function setBlockMinutes(block, minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  block.querySelector(".t-dur-h").value = m >= 60 ? Math.floor(m / 60) : "";
  block.querySelector(".t-dur-m").value = m % 60 > 0 ? m % 60 : "";
}

function readEntry(block) {
  const selected = [...block.querySelectorAll(".detail-chips .chip.on")].map((b) => b.dataset.value);
  const other = block.querySelector(".detail-other").value.trim();
  return {
    id: block.dataset.entryId || undefined,
    workType: entryWorkType(block),
    detail: [...selected, other].filter(Boolean).join("、"),
    place: block.querySelector(".t-place").value.trim(),
    startTime: block.querySelector(".t-start").value,
    endTime: block.querySelector(".t-end").value,
    minutes: blockMinutes(block)
  };
}

function updateEntryAmount(block) {
  const el = block.querySelector(".entry-amount");
  const workType = entryWorkType(block);
  const mins = blockMinutes(block);
  const m = masterFor(workType);
  const rate = m ? Number(m.rate) || 0 : 0;
  if (workType && mins > 0 && rate > 0) {
    el.textContent = `金額：${yen(Math.round((rate * mins) / 60))}円（${yen(rate)}円/時 × ${fmtDur(mins)}）`;
    el.classList.remove("hidden");
  } else if (workType && mins > 0) {
    el.textContent = "この作業区分は時間単価による金額計算の対象外です";
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
  updateSheetTotal(block.closest("#entries") ? $("sheet-total") : null);
}

function updateSheetTotal(totalEl) {
  if (!totalEl) return;
  let total = 0, totalMins = 0;
  for (const block of $("entries").querySelectorAll(".entry")) {
    const m = masterFor(entryWorkType(block));
    const mins = blockMinutes(block);
    totalMins += mins;
    if (m && m.rate > 0) total += Math.round((m.rate * mins) / 60);
  }
  if (total > 0) {
    totalEl.textContent = `この日報の合計：${fmtDur(totalMins)} ／ ${yen(total)}円`;
    totalEl.classList.remove("hidden");
  } else {
    totalEl.classList.add("hidden");
  }
}

// チップ操作（作業区分・具体的内容）と時刻計算をコンテナ単位で委譲
function wireEntryContainer(container) {
  container.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) {
      const block = chip.closest(".entry");
      if (chip.classList.contains("wt-chip")) {
        const wasOn = chip.classList.contains("on");
        block.querySelectorAll(".wt-chip").forEach((c) => c.classList.remove("on"));
        if (!wasOn) chip.classList.add("on");
        buildDetailChips(block, wasOn ? "" : chip.dataset.value);
        block.querySelector(".detail-other").value = "";
      } else {
        chip.classList.toggle("on");
      }
      updateEntryAmount(chip.closest(".entry"));
      return;
    }
    const del = e.target.closest(".entry-del");
    if (del) {
      del.closest(".entry").remove();
      renumberEntries(container);
      updateSheetTotal(container.id === "entries" ? $("sheet-total") : null);
    }
  });
  container.addEventListener("change", (e) => {
    const block = e.target.closest(".entry");
    if (!block) return;
    if (e.target.classList.contains("t-start") || e.target.classList.contains("t-end")) {
      const mins = calcMinutes(block.querySelector(".t-start").value, block.querySelector(".t-end").value);
      if (mins !== null) setBlockMinutes(block, mins);
      updateEntryAmount(block);
    }
  });
  container.addEventListener("input", (e) => {
    const block = e.target.closest(".entry");
    if (block && (e.target.classList.contains("t-dur-h") || e.target.classList.contains("t-dur-m"))) {
      updateEntryAmount(block);
    }
  });
}

/* ---------- 作業者画面 ---------- */

async function enterWorker() {
  state.role = "worker";
  await loadMasters();
  applyMastersToForms();
  $("f-worker-name").textContent = state.workerName;
  resetReportForm();
  showView("worker");
  saveSession();
  await loadMyReports();
}

function resetReportForm() {
  state.editingSheetId = null;
  $("f-date").value = todayStr();
  $("f-note").value = "";
  $("entries").innerHTML = "";
  buildEntryBlock($("entries"));
  $("worker-form-title").textContent = "作 業 日 報";
  $("btn-submit").textContent = "この内容で提出する";
  $("btn-cancel-edit").classList.add("hidden");
  updateSheetTotal($("sheet-total"));
  updateDeadlineNote();
}

function readSheetForm() {
  return {
    date: $("f-date").value,
    worker: state.workerName,
    note: $("f-note").value.trim(),
    entries: [...$("entries").querySelectorAll(".entry")].map(readEntry)
  };
}

/* ---------- 提出前の確認画面 ---------- */

// サーバーと同じ内容の事前チェック（不備があれば確認画面を出さずに知らせる）
function clientValidateSheet(body) {
  if (!body.date) return "日付を入力してください";
  if (!Array.isArray(body.entries) || body.entries.length === 0) return "作業を1つ以上記入してください";
  for (let i = 0; i < body.entries.length; i++) {
    const label = "作業" + (MARU[i] || i + 1);
    if (!body.entries[i].workType) return `${label}の作業区分に○をつけてください`;
    if (!(entryMinutes(body.entries[i]) > 0)) return `${label}の時間を入力してください（開始・終了時刻を入れると自動計算されます）`;
  }
  return null;
}

function confirmSummaryHtml(body) {
  const row = (k, v) => `<div class="confirm-row"><span class="confirm-k">${k}</span><span class="confirm-v">${escapeHtml(v)}</span></div>`;
  let totalAmount = 0;
  let totalMins = 0;
  const entries = body.entries.map((e, i) => {
    const m = masterFor(e.workType);
    const rate = m ? Number(m.rate) || 0 : 0;
    const mins = entryMinutes(e);
    totalMins += mins;
    const amount = rate > 0 ? Math.round((rate * mins) / 60) : null;
    if (amount) totalAmount += amount;
    const time = e.startTime && e.endTime ? `${e.startTime}〜${e.endTime}（${fmtDur(mins)}）` : fmtDur(mins);
    return `
      <div class="confirm-entry">
        <div class="confirm-entry-head">作業${MARU[i] || i + 1}　${escapeHtml(e.workType)}</div>
        ${e.detail ? row("具体的内容", e.detail) : ""}
        ${row("時間", time)}
        ${e.place ? row("場所", e.place) : ""}
        ${row("金額", amount !== null ? `${yen(amount)}円（${yen(rate)}円/時）` : "－（時間単価の対象外）")}
      </div>`;
  }).join("");
  return `
    ${deadlineAlertHtml(body)}
    ${row("日付", body.date)}
    ${row("氏名", body.worker)}
    ${entries}
    ${body.note ? `<div class="confirm-entry">${row("特記事項", body.note)}</div>` : ""}
    <div class="confirm-total">合計　${fmtDur(totalMins)} ／ ${yen(totalAmount)}円</div>
  `;
}

function openConfirmModal(body) {
  state.pendingSubmit = body;
  const isEdit = !!state.editingSheetId;
  $("confirm-title").textContent = isEdit ? "この内容で更新しますか？" : "この内容で提出しますか？";
  $("btn-confirm-submit").textContent = isEdit ? "更新する" : "提出する";
  $("confirm-body").innerHTML = confirmSummaryHtml(body);
  $("confirm-modal").classList.remove("hidden");
}

function closeConfirmModal() {
  state.pendingSubmit = null;
  $("confirm-modal").classList.add("hidden");
}

function sheetCardHtml(s, { mode = "mine" } = {}) {
  const entries = s.entries.map((e, i) => {
    const dur = fmtDur(entryMinutes(e));
    const time = e.startTime && e.endTime ? `${e.startTime}〜${e.endTime}（${dur}）` : dur;
    const amount = e.amount !== null && e.amount !== undefined ? `${yen(e.amount)}円` : "";
    const meta = [e.place, time, amount].filter(Boolean).join(" ／ ");
    return `
      <div class="rc-entry">
        <div class="rc-entry-head">${MARU[i] || i + 1} ${escapeHtml(e.workType)}</div>
        ${e.detail ? `<div class="rc-note">${escapeHtml(e.detail)}</div>` : ""}
        ${meta ? `<div class="rc-meta">${escapeHtml(meta)}</div>` : ""}
      </div>`;
  }).join("");
  const confirmed = s.confirmed
    ? '<span class="badge badge-ok">確認済</span>'
    : '<span class="badge">未確認</span>';
  const opEdited = s.operatorEdited
    ? '<span class="badge badge-warn">オペレーター修正あり</span>'
    : "";
  const histBtn = `<button class="btn-edit-text" data-act="history" data-id="${s.id}">履歴</button>`;
  let actions;
  if (mode === "trash") {
    actions = `${histBtn}<button class="btn-edit-text" data-act="restore" data-id="${s.id}">復元</button>`;
  } else if (s.confirmed) {
    actions = `${histBtn}<span class="rc-locked">確認済みのため変更不可</span>`;
  } else {
    actions = `${histBtn}
       <button class="btn-edit-text" data-act="edit" data-id="${s.id}">編集</button>
       <button class="btn-danger-text" data-act="del" data-id="${s.id}">削除</button>`;
  }
  const head = mode === "trash"
    ? `${escapeHtml(s.date)}${mode === "trash" && s.worker ? "　" + escapeHtml(s.worker) : ""}　<span class="badge">削除済</span>`
    : `${escapeHtml(s.date)} ${confirmed} ${opEdited} ${lateBadgeHtml(s)}${s.totalAmount > 0 ? `　<b>${yen(s.totalAmount)}円</b>` : ""}`;
  return `
    <div class="rc-head">
      <span>${head}</span>
      <span class="rc-actions">${actions}</span>
    </div>
    ${entries}
    ${s.note ? `<div class="rc-meta">特記事項：${escapeHtml(s.note)}</div>` : ""}
    ${mode === "trash" && s.deletedAt ? `<div class="rc-meta">削除：${escapeHtml(fmtDateTime(s.deletedAt))}（${escapeHtml(s.deletedBy || "")}）</div>` : ""}
  `;
}

/* ---------- 変更履歴の表示 ---------- */

const ACTION_LABELS = {
  create: "提出", update: "修正", delete: "削除",
  restore: "復元", confirm: "確認（印）", unconfirm: "確認解除", masters: "マスタ変更",
  restoredb: "バックアップから全データを復元"
};

// 履歴に記録された日報スナップショットの要約テキスト
function snapshotSummary(s) {
  if (!s) return "";
  if (!Array.isArray(s.entries)) {
    return s.restoredFrom ? `復元元：${s.restoredFrom}` : "";
  }
  const lines = (s.entries || []).map((e, i) => {
    const rate = Number(e.rate) || 0;
    const mins = entryMinutes(e);
    const amount = rate > 0 ? `＝${yen(Math.round((rate * mins) / 60))}円` : "";
    return `${MARU[i] || i + 1}${e.workType} ${fmtDur(mins)}${e.place ? "＠" + e.place : ""}${e.detail ? "（" + e.detail + "）" : ""}${amount}`;
  });
  const total = (s.entries || []).reduce((sum, e) => {
    const rate = Number(e.rate) || 0;
    return sum + (rate > 0 ? Math.round((rate * entryMinutes(e)) / 60) : 0);
  }, 0);
  return [
    `${s.date}　${s.worker}`,
    ...lines,
    s.note ? `特記事項：${s.note}` : "",
    `合計 ${yen(total)}円`
  ].filter(Boolean).join("\n");
}

function historyEventHtml(h) {
  const ts = fmtDateTime(h.ts);
  const label = ACTION_LABELS[h.action] || h.action;
  let body = "";
  if (h.action === "update") {
    body = `
      <div class="hist-snap"><div class="hist-snap-label">変更前</div><pre>${escapeHtml(snapshotSummary(h.before))}</pre></div>
      <div class="hist-snap"><div class="hist-snap-label">変更後</div><pre>${escapeHtml(snapshotSummary(h.after))}</pre></div>`;
  } else if (h.before || h.after) {
    body = `<div class="hist-snap"><pre>${escapeHtml(snapshotSummary(h.after || h.before))}</pre></div>`;
  }
  return `
    <div class="hist-event">
      <div class="hist-head"><b>${escapeHtml(ts)}</b>　${escapeHtml(h.actor)} が<b>${escapeHtml(label)}</b></div>
      ${body}
    </div>`;
}

async function openHistoryModal(sheetId) {
  const q = state.role === "worker"
    ? `?sheetId=${encodeURIComponent(sheetId)}&worker=${encodeURIComponent(state.workerName)}`
    : `?sheetId=${encodeURIComponent(sheetId)}`;
  const events = await api("/api/history" + q);
  $("history-body").innerHTML = events.length === 0
    ? '<p class="empty">履歴がありません</p>'
    : events.map(historyEventHtml).join("");
  $("history-modal").classList.remove("hidden");
}

async function loadMyReports() {
  const list = await api("/api/reports?worker=" + encodeURIComponent(state.workerName));
  state.myReports = list;
  const wrap = $("my-reports");
  wrap.innerHTML = "";
  if (list.length === 0) {
    wrap.innerHTML = '<p class="empty">まだ日報がありません。上のフォームから提出してください。</p>';
  } else {
    for (const s of list) {
      const div = document.createElement("div");
      div.className = "report-card";
      div.innerHTML = sheetCardHtml(s);
      wrap.appendChild(div);
    }
  }
  await loadMyTrash();
}

async function loadMyTrash() {
  const list = await api("/api/trash?worker=" + encodeURIComponent(state.workerName));
  state.myTrash = list;
  $("my-trash-card").classList.toggle("hidden", list.length === 0);
  const wrap = $("my-trash");
  wrap.innerHTML = "";
  for (const s of list) {
    const div = document.createElement("div");
    div.className = "report-card trash-card";
    div.innerHTML = sheetCardHtml(s, { mode: "trash" });
    wrap.appendChild(div);
  }
  collapseList(wrap, 3, 10);
}

function startEditSheet(s) {
  state.editingSheetId = s.id;
  $("f-date").value = s.date || todayStr();
  $("f-note").value = s.note || "";
  $("entries").innerHTML = "";
  for (const e of s.entries) buildEntryBlock($("entries"), e);
  $("worker-form-title").textContent = "日報を編集中";
  $("btn-submit").textContent = "更新する";
  $("btn-cancel-edit").classList.remove("hidden");
  updateSheetTotal($("sheet-total"));
  updateDeadlineNote();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- オペレーター画面 ---------- */

async function enterOperator() {
  state.role = "operator";
  await loadMasters();
  applyMastersToForms();
  renderWorkTypeEditor();
  renderDeadlineEditor();
  $("m-places").value = state.masters.places.join("\n");
  showView("operator");
  showOpTab(savedOpTab());
  saveSession();
  await searchReports();
  await loadBackups();
}

/* ---------- バックアップと復元 ---------- */

function backupLabel(key) {
  let m = key.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]} 時点（毎日の自動控え）`;
  m = key.match(/^safety-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/);
  if (m) return `復元直前の控え（${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}）`;
  return key;
}

async function loadBackups() {
  const list = await api("/api/backups");
  const tbody = $("backup-tbody");
  tbody.innerHTML = list.length === 0
    ? '<tr><td colspan="3" class="empty">まだ控えがありません（毎日の最初の記録時に自動で作られます）</td></tr>'
    : "";
  for (const b of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(backupLabel(b.key))}</td>
      <td>${Number(b.reports) || 0}枚</td>
      <td><button class="btn-edit-text" data-key="${escapeHtml(b.key)}">この時点に戻す</button></td>`;
    tbody.appendChild(tr);
  }
  collapseList(tbody, 7, 15);
}

$("backup-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-key]");
  if (!btn) return;
  const label = backupLabel(btn.dataset.key);
  if (!confirm(`現在の全データを「${label}」の内容に置き換えます。\n（今の状態は「復元直前の控え」として自動保存されるので、やり直せます）\n\nよろしいですか？`)) return;
  try {
    await api(`/api/backups/${encodeURIComponent(btn.dataset.key)}/restore`, { method: "POST", body: "{}" });
    toast("復元しました");
    await enterOperator(); // 一覧・集計・マスタをすべて読み直す
  } catch (err) {
    toast(err.message, true);
  }
});

$("btn-restore-file").addEventListener("click", async () => {
  const f = $("restore-file").files[0];
  if (!f) {
    toast("ファイルを選んでください", true);
    return;
  }
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch {
    toast("ファイルが読み取れません（「バックアップ保存」で保存したファイルを選んでください）", true);
    return;
  }
  if (!confirm(`現在の全データをファイル「${f.name}」の内容に置き換えます。\n（今の状態は「復元直前の控え」として自動保存されるので、やり直せます）\n\nよろしいですか？`)) return;
  try {
    await api("/api/backups/restore-upload", { method: "POST", body: JSON.stringify({ data }) });
    toast("復元しました");
    $("restore-file").value = "";
    await enterOperator();
  } catch (err) {
    toast(err.message, true);
  }
});

function filterQuery() {
  const params = new URLSearchParams();
  if ($("q-from").value) params.set("from", $("q-from").value);
  if ($("q-to").value) params.set("to", $("q-to").value);
  if ($("q-worker").value) params.set("worker", $("q-worker").value);
  if ($("q-place").value.trim()) params.set("place", $("q-place").value.trim());
  if ($("q-worktype").value) params.set("workType", $("q-worktype").value);
  return params;
}

async function searchReports() {
  const sheets = await api("/api/reports?" + filterQuery().toString());
  state.operatorSheets = sheets;
  updateFilterSummary();
  renderOperatorReports(sheets);
  renderStats(sheets);
  renderAggregates(sheets);
  updateWorkerFilterOptions(sheets);
  await loadOpTrash();
}

async function loadOpTrash() {
  const list = await api("/api/trash");
  const wrap = $("op-trash");
  wrap.innerHTML = "";
  if (list.length === 0) {
    wrap.innerHTML = '<p class="empty">ごみ箱は空です</p>';
    collapseList(wrap, 3, 10); // 前回の「続きを見る」が残っていれば消す
    return;
  }
  for (const s of list) {
    const div = document.createElement("div");
    div.className = "report-card trash-card";
    div.innerHTML = sheetCardHtml(s, { mode: "trash" });
    wrap.appendChild(div);
  }
  collapseList(wrap, 3, 10);
}

function updateWorkerFilterOptions(sheets) {
  const sel = $("q-worker");
  const current = sel.value;
  const names = new Set([...sel.options].map((o) => o.value).filter(Boolean));
  for (const s of sheets) names.add(s.worker);
  fillSelectStrings(sel, [...names].sort((a, b) => a.localeCompare(b, "ja")), { emptyLabel: "すべて" });
  sel.value = current;
}

function renderOperatorReports(sheets) {
  const cardView = opListView() === "card";
  $("op-cards").classList.toggle("hidden", !cardView);
  $("op-table-wrap").classList.toggle("hidden", cardView);
  document.querySelectorAll(".op-view-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === (cardView ? "card" : "table")));
  const unconfirmed = sheets.filter((s) => !s.confirmed).length;
  $("op-list-summary").innerHTML = sheets.length === 0 ? "" :
    `<b>${sheets.length}</b>枚` + (unconfirmed
      ? `・<span class="op-unconfirmed">未確認 ${unconfirmed}枚</span>`
      : "・すべて確認済み");
  if (cardView) {
    renderOperatorCards(sheets);
  } else {
    // カード表示の「続きを見る」が残らないように片付けてから表を出す
    const bar = $("op-cards").nextElementSibling;
    if (bar && bar.classList.contains("more-actions")) bar.remove();
    renderOperatorTable(sheets);
  }
}

// 「2026-09-16」→「9月16日（水）」
function fmtDateWd(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = "日月火水木金土"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return (y !== Number(todayJst().slice(0, 4)) ? y + "年" : "") + m + "月" + d + "日（" + wd + "）";
}

// 日報を日付ごとにまとめたカードで表示（1日分＝1かたまり、最初は7日分）
function renderOperatorCards(sheets) {
  const wrap = $("op-cards");
  wrap.innerHTML = "";
  if (sheets.length === 0) {
    wrap.innerHTML = '<p class="empty">該当する日報がありません</p>';
    collapseList(wrap, 7, 7, "日分");
    return;
  }
  const countByDate = new Map();
  for (const s of sheets) countByDate.set(s.date, (countByDate.get(s.date) || 0) + 1);
  let group = null;
  let groupDate = null;
  for (const s of sheets) {
    if (s.date !== groupDate) {
      groupDate = s.date;
      group = document.createElement("section");
      group.className = "op-day";
      group.innerHTML = `<h3 class="op-day-head"><span>${escapeHtml(fmtDateWd(s.date))}</span><span class="op-day-count">${countByDate.get(s.date)}枚</span></h3>`;
      wrap.appendChild(group);
    }
    const entries = s.entries.map((e, i) => {
      const dur = fmtDur(entryMinutes(e));
      const time = e.startTime && e.endTime ? `${e.startTime}〜${e.endTime}` : "";
      const sub = [time, e.place, e.detail].filter(Boolean).map(escapeHtml).join("　");
      const amount = e.amount !== null && e.amount !== undefined ? yen(e.amount) + "円" : "－";
      return `
        <li>
          <div class="op-entry-main">
            <span class="op-entry-no">${MARU[i] || i + 1}</span>
            <span class="op-entry-wt">${escapeHtml(e.workType)}</span>
            <span class="op-entry-dur">${dur}</span>
            <span class="op-entry-yen">${amount}</span>
          </div>
          ${sub ? `<div class="op-entry-sub">${sub}</div>` : ""}
        </li>`;
    }).join("");
    const badges = lateBadgeHtml(s);
    const card = document.createElement("article");
    card.className = "op-card" + (s.confirmed ? " is-confirmed" : "");
    card.innerHTML = `
      <div class="op-card-head">
        <label class="op-confirm" title="確認（紙の印・サインに相当）">
          <input type="checkbox" class="chk-confirm" data-id="${s.id}" ${s.confirmed ? "checked" : ""}>
          <span>${s.confirmed ? "確認済" : "未確認"}</span>
        </label>
        <div class="op-card-name">${escapeHtml(s.worker)}</div>
        <div class="op-card-yen">${s.totalAmount > 0 ? yen(s.totalAmount) + "<small>円</small>" : "－"}</div>
      </div>
      ${badges ? `<div class="op-card-badges">${badges}</div>` : ""}
      <ul class="op-entries">${entries}</ul>
      ${s.note ? `<div class="op-card-note">特記事項：${escapeHtml(s.note)}</div>` : ""}
      <div class="op-card-actions">
        <button class="btn-edit-text" data-act="history" data-id="${s.id}">履歴</button>
        <button class="btn-edit-text" data-act="edit" data-id="${s.id}">編集</button>
        <button class="btn-danger-text" data-act="del" data-id="${s.id}">削除</button>
      </div>`;
    group.appendChild(card);
  }
  collapseList(wrap, 7, 7, "日分");
}

// 従来の表での表示
function renderOperatorTable(sheets) {
  const tbody = $("report-tbody");
  tbody.innerHTML = "";
  if (sheets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">該当する日報がありません</td></tr>';
    return;
  }
  for (const s of sheets) {
    s.entries.forEach((e, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.classList.add("sheet-first");
      const time = e.startTime && e.endTime ? `${e.startTime}-${e.endTime} (${fmtDur(entryMinutes(e))})` : fmtDur(entryMinutes(e));
      const first = i === 0;
      tr.innerHTML = `
        <td>${first ? `<input type="checkbox" class="chk-confirm" data-id="${s.id}" ${s.confirmed ? "checked" : ""}>` : ""}</td>
        <td>${first ? escapeHtml(s.date) + (lateBadgeHtml(s) ? "<br>" + lateBadgeHtml(s) : "") : ""}</td>
        <td>${first ? escapeHtml(s.worker) : ""}</td>
        <td>${escapeHtml(e.workType)}</td>
        <td class="wrap">${escapeHtml(e.detail || "")}</td>
        <td class="wrap">${escapeHtml(e.place || "")}</td>
        <td>${escapeHtml(time)}</td>
        <td class="num">${e.rate > 0 ? yen(e.rate) : "－"}</td>
        <td class="num">${e.amount !== null && e.amount !== undefined ? yen(e.amount) : "－"}</td>
        <td class="wrap">${first ? escapeHtml(s.note || "") : ""}</td>
        <td class="rc-actions">${first ? `
          <button class="btn-edit-text" data-act="history" data-id="${s.id}">履歴</button>
          <button class="btn-edit-text" data-act="edit" data-id="${s.id}">編集</button>
          <button class="btn-danger-text" data-act="del" data-id="${s.id}">削除</button>` : ""}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
}

function renderStats(sheets) {
  $("stat-count").textContent = sheets.length;
  const totalMins = sheets.reduce((s, x) => s + (Number(x.totalMinutes) || 0), 0);
  $("stat-hours").textContent = Math.round((totalMins / 60) * 10) / 10;
  const totalAmount = sheets.reduce((s, x) => s + (Number(x.totalAmount) || 0), 0);
  $("stat-amount").textContent = yen(totalAmount);
  $("stat-workers").textContent = new Set(sheets.map((x) => x.worker)).size;
}

function renderAggregates(sheets) {
  const flat = [];
  for (const s of sheets) {
    for (const e of s.entries) flat.push({ worker: s.worker, ...e });
  }
  const agg = (key) => {
    const map = new Map();
    for (const r of flat) {
      const k = r[key] || "（未入力）";
      const cur = map.get(k) || { count: 0, minutes: 0, amount: 0 };
      cur.count += 1;
      cur.minutes += entryMinutes(r);
      cur.amount += Number(r.amount) || 0;
      map.set(k, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].amount - a[1].amount || b[1].minutes - a[1].minutes);
  };
  const render = (tbodyId, rows) => {
    const tbody = $(tbodyId);
    tbody.innerHTML = rows.length === 0 ? '<tr><td colspan="4" class="empty">データなし</td></tr>' : "";
    for (const [name, v] of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${v.count}</td><td>${Math.round((v.minutes / 60) * 10) / 10}</td><td class="num">${yen(v.amount)}</td>`;
      tbody.appendChild(tr);
    }
  };
  render("agg-worker", agg("worker"));
  render("agg-worktype", agg("workType"));
}

async function openEditModal(sheetId) {
  // 絞り込みで作業行が省かれている可能性があるため、全行を取得し直す
  const s = await api("/api/reports/" + sheetId);
  state.modalSheetId = s.id;
  $("e-date").value = s.date || "";
  $("e-worker").value = s.worker || "";
  $("e-note").value = s.note || "";
  $("modal-entries").innerHTML = "";
  for (const e of s.entries) buildEntryBlock($("modal-entries"), e);
  $("modal").classList.remove("hidden");
}

/* ---------- マスタ編集UI ---------- */

function workTypeRowHtml(name, rate, details) {
  return `
    <td><input type="text" class="wt-name" value="${escapeHtml(name)}" placeholder="作業区分名"></td>
    <td><input type="number" class="wt-rate" value="${rate > 0 ? rate : ""}" min="0" step="10" placeholder="0"></td>
    <td><input type="text" class="wt-details" value="${escapeHtml((details || []).join("/"))}" placeholder="例：出荷調整/箱洗い等"></td>
    <td><button type="button" class="btn-danger-text wt-del">削除</button></td>
  `;
}

function renderWorkTypeEditor() {
  const tbody = $("worktype-tbody");
  tbody.innerHTML = "";
  for (const w of state.masters.workTypes) {
    const tr = document.createElement("tr");
    tr.innerHTML = workTypeRowHtml(w.name, Number(w.rate) || 0, w.details);
    tbody.appendChild(tr);
  }
}

function readWorkTypeEditor() {
  return [...$("worktype-tbody").rows].map((tr) => ({
    name: tr.querySelector(".wt-name").value.trim(),
    rate: Number(tr.querySelector(".wt-rate").value) || 0,
    details: tr.querySelector(".wt-details").value.split("/").map((s) => s.trim()).filter(Boolean)
  })).filter((w) => w.name);
}

/* ---------- イベント登録 ---------- */

// ログインタブ切り替え
$("tab-worker").addEventListener("click", () => {
  $("tab-worker").classList.add("active");
  $("tab-operator").classList.remove("active");
  $("form-login-worker").classList.remove("hidden");
  $("form-login-operator").classList.add("hidden");
});
$("tab-operator").addEventListener("click", () => {
  $("tab-operator").classList.add("active");
  $("tab-worker").classList.remove("active");
  $("form-login-operator").classList.remove("hidden");
  $("form-login-worker").classList.add("hidden");
});

// 作業者ログイン（苗字と名前の間のスペースは自動で詰める）
$("form-login-worker").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("login-name").value.replace(/\s+/g, "");
  if (!name) return;
  $("login-name").value = name;
  state.workerName = name;
  localStorage.setItem("nippo-worker-name", name);
  try {
    await enterWorker();
  } catch (err) {
    toast(err.message, true);
  }
});

// オペレーターログイン
$("form-login-operator").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { token } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("login-password").value })
    });
    state.token = token;
    $("login-password").value = "";
    await enterOperator();
  } catch (err) {
    toast(err.message, true);
  }
});

$("btn-logout").addEventListener("click", logout);

// 作業ブロックのイベント（作業者フォーム・モーダル共通）
wireEntryContainer($("entries"));
wireEntryContainer($("modal-entries"));

$("btn-add-entry").addEventListener("click", () => buildEntryBlock($("entries")));
$("btn-modal-add-entry").addEventListener("click", () => buildEntryBlock($("modal-entries")));

// 日報の提出・更新（作業者）: まず確認画面を表示
$("form-report").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = readSheetForm();
  const err = clientValidateSheet(body);
  if (err) {
    toast(err, true);
    return;
  }
  openConfirmModal(body);
});

// 確認画面で「提出する／更新する」→ 実際に送信
$("btn-confirm-submit").addEventListener("click", async () => {
  const body = state.pendingSubmit;
  if (!body) return;
  const btn = $("btn-confirm-submit");
  btn.disabled = true; // 二重送信防止
  try {
    const isEdit = !!state.editingSheetId;
    const saved = isEdit
      ? await api("/api/reports/" + state.editingSheetId, { method: "PUT", body: JSON.stringify(body) })
      : await api("/api/reports", { method: "POST", body: JSON.stringify(body) });
    if (saved && saved.lateNotice) {
      // 締め日後は、すぐ消えるお知らせではなく、押して閉じる画面で確実に伝える
      showLateModal(saved.lateNotice, isEdit);
    } else {
      toast(isEdit ? "日報を更新しました" : "日報を提出しました");
    }
    closeConfirmModal();
    resetReportForm();
    await loadMyReports();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("btn-confirm-back").addEventListener("click", closeConfirmModal);
$("confirm-modal").addEventListener("click", (e) => {
  if (e.target === $("confirm-modal")) closeConfirmModal();
});

$("btn-cancel-edit").addEventListener("click", resetReportForm);
$("f-date").addEventListener("change", updateDeadlineNote);
$("f-date").addEventListener("input", updateDeadlineNote);
$("btn-late-ok").addEventListener("click", () => $("late-modal").classList.add("hidden"));

// 自分の日報の編集・削除・履歴
$("my-reports").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "edit") {
      const s = state.myReports.find((x) => x.id === id);
      if (s) startEditSheet(s);
    } else if (btn.dataset.act === "history") {
      await openHistoryModal(id);
    } else if (btn.dataset.act === "del") {
      const target = state.myReports.find((x) => x.id === id);
      const lateDel = target && pastDeadline(target.date);
      const delMsg = "この日報を削除しますか？（ごみ箱に移動し、あとで復元できます）" + (lateDel ? `

※${fmtMonthOf(target.date)}の締め日（${fmtMd(lateDel.deadline)}）を過ぎています。削除した場合も理事へ直接ご連絡ください。` : "");
      if (!confirm(delMsg)) return;
      await api(`/api/reports/${id}?worker=${encodeURIComponent(state.workerName)}`, { method: "DELETE" });
      toast("ごみ箱に移動しました");
      if (state.editingSheetId === id) resetReportForm();
      await loadMyReports();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// 自分のごみ箱: 復元・履歴
$("my-trash").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "restore") {
      await api(`/api/trash/${id}/restore?worker=${encodeURIComponent(state.workerName)}`, {
        method: "POST",
        body: JSON.stringify({ worker: state.workerName })
      });
      toast("復元しました");
      await loadMyReports();
    } else if (btn.dataset.act === "history") {
      await openHistoryModal(id);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// オペレーター: 検索
$("form-filter").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await searchReports();
  } catch (err) {
    toast(err.message, true);
  }
});

$("btn-clear-filter").addEventListener("click", async () => {
  $("form-filter").reset();
  try {
    await searchReports();
  } catch (err) {
    toast(err.message, true);
  }
});

// 出力の共通処理（絞り込み条件＋認証をURLに付ける）
function exportParams() {
  const params = filterQuery();
  params.set("token", state.token);
  if (state.siteCode) params.set("code", state.siteCode);
  return params;
}

// 月別出役明細書（Excel）: 全員分
$("btn-export").addEventListener("click", () => {
  const params = exportParams();
  params.delete("worker"); // 作業者の絞り込みは無視して全員分
  window.location.href = "/api/export-xlsx?" + params.toString();
});

// 月別出役明細書（Excel）: 絞り込んだ作業者のみ
$("btn-export-one").addEventListener("click", () => {
  const worker = $("q-worker").value;
  if (!worker) {
    toast("「作業者」で対象の方を選んでから押してください", true);
    return;
  }
  window.location.href = "/api/export-xlsx?" + exportParams().toString();
});

// 年間集計表（Excel）: 期間未指定なら今の年度、作業者を選べばその人のみ
$("btn-export-year").addEventListener("click", () => {
  window.location.href = "/api/export-year-xlsx?" + exportParams().toString();
});

// 作業明細（CSV・従来形式）
$("btn-export-detail").addEventListener("click", () => {
  const params = exportParams();
  params.set("detail", "1");
  window.location.href = "/api/export?" + params.toString();
});

// バックアップ（全データ）のダウンロード
$("btn-backup").addEventListener("click", () => {
  let url = "/api/backup?token=" + encodeURIComponent(state.token);
  if (state.siteCode) url += "&code=" + encodeURIComponent(state.siteCode);
  window.location.href = url;
});

// オペレーター: 一覧の編集・削除・確認チェック
$("op-report-list").addEventListener("click", async (e) => {
  const chk = e.target.closest(".chk-confirm");
  if (chk) {
    try {
      await api(`/api/reports/${chk.dataset.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ confirmed: chk.checked })
      });
      toast(chk.checked ? "確認済みにしました（作業者は変更できなくなります）" : "確認を解除しました");
      await searchReports();
    } catch (err) {
      chk.checked = !chk.checked;
      toast(err.message, true);
    }
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "edit") {
      await openEditModal(id);
    } else if (btn.dataset.act === "history") {
      await openHistoryModal(id);
    } else if (btn.dataset.act === "del") {
      if (!confirm("この日報を削除しますか？（ごみ箱に移動し、あとで復元できます）")) return;
      await api("/api/reports/" + id, { method: "DELETE" });
      toast("ごみ箱に移動しました");
      await searchReports();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// オペレーターのごみ箱: 復元・履歴
$("op-trash").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === "restore") {
      await api(`/api/trash/${id}/restore`, { method: "POST", body: JSON.stringify({}) });
      toast("復元しました");
      await searchReports();
    } else if (btn.dataset.act === "history") {
      await openHistoryModal(id);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// 履歴モーダルを閉じる
$("btn-history-close").addEventListener("click", () => $("history-modal").classList.add("hidden"));
$("history-modal").addEventListener("click", (e) => {
  if (e.target === $("history-modal")) $("history-modal").classList.add("hidden");
});

// モーダル編集の保存
$("form-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    date: $("e-date").value,
    worker: $("e-worker").value.trim(),
    note: $("e-note").value.trim(),
    entries: [...$("modal-entries").querySelectorAll(".entry")].map(readEntry)
  };
  try {
    await api("/api/reports/" + state.modalSheetId, { method: "PUT", body: JSON.stringify(body) });
    $("modal").classList.add("hidden");
    toast("日報を更新しました");
    await searchReports();
  } catch (err) {
    toast(err.message, true);
  }
});

$("btn-modal-close").addEventListener("click", () => $("modal").classList.add("hidden"));
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) $("modal").classList.add("hidden");
});

// 作業区分マスタ: 行の追加・削除
$("btn-add-worktype").addEventListener("click", () => {
  const tr = document.createElement("tr");
  tr.innerHTML = workTypeRowHtml("", 0, []);
  $("worktype-tbody").appendChild(tr);
  tr.querySelector(".wt-name").focus();
});

$("worktype-tbody").addEventListener("click", (e) => {
  if (e.target.classList.contains("wt-del")) {
    e.target.closest("tr").remove();
  }
});

// マスタ保存
$("btn-save-masters").addEventListener("click", async () => {
  const workTypes = readWorkTypeEditor();
  if (workTypes.length === 0) {
    toast("作業区分を1つ以上登録してください", true);
    return;
  }
  const places = $("m-places").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    state.masters = await api("/api/masters", {
      method: "PUT",
      body: JSON.stringify({ workTypes, places })
    });
    applyMastersToForms();
    renderWorkTypeEditor();
    $("m-places").value = state.masters.places.join("\n");
    toast("マスタを保存しました");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- オペレーター画面のタブ ---------- */

const OP_TABS = ["reports", "summary", "settings", "data"];

function savedOpTab() {
  try { return localStorage.getItem("nippo-op-tab") || "reports"; } catch { return "reports"; }
}

function showOpTab(name) {
  if (!OP_TABS.includes(name)) name = "reports";
  for (const t of OP_TABS) $("op-panel-" + t).classList.toggle("hidden", t !== name);
  document.querySelectorAll(".op-tab").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  // 絞り込みは「日報」「集計・出力」でだけ使う
  $("op-filter").classList.toggle("hidden", !(name === "reports" || name === "summary"));
  try { localStorage.setItem("nippo-op-tab", name); } catch { /* 保存できなくても動作に支障なし */ }
  window.scrollTo({ top: 0 });
}

$("op-tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".op-tab");
  if (b) showOpTab(b.dataset.tab);
});

// 日報一覧の「カード／表」切り替え（端末ごとに覚えておく）
function opListView() {
  try { return localStorage.getItem("nippo-op-listview") === "table" ? "table" : "card"; } catch { return "card"; }
}

$("op-view-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".op-view-btn");
  if (!b) return;
  try { localStorage.setItem("nippo-op-listview", b.dataset.view); } catch { /* 無視 */ }
  renderOperatorReports(state.operatorSheets);
});

// 絞り込みを閉じているときに見せる「いまの条件」
function updateFilterSummary() {
  const from = $("q-from").value, to = $("q-to").value;
  const parts = [from || to ? (from ? fmtMd(from) : "") + "〜" + (to ? fmtMd(to) : "") : "すべての期間"];
  parts.push($("q-worker").value || "全員");
  if ($("q-worktype").value) parts.push($("q-worktype").value);
  if ($("q-place").value.trim()) parts.push("場所「" + $("q-place").value.trim() + "」");
  $("op-filter-summary").textContent = parts.join("・");
}

/* ---------- 締め日の設定（経理） ---------- */

function dlOverrideRow(ym = "", date = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="month" class="dl-ym" value="${escapeHtml(ym)}"></td>
    <td><input type="date" class="dl-date" value="${escapeHtml(date)}"></td>
    <td><button type="button" class="btn-danger-text dl-del">削除</button></td>`;
  return tr;
}

function renderDeadlineEditor() {
  const cfg = (state.masters && state.masters.deadline) ||
    { enabled: false, monthOffset: 1, day: 5, overrides: {} };
  $("dl-enabled").checked = !!cfg.enabled;
  $("dl-offset").value = String(Number(cfg.monthOffset) === 0 ? 0 : 1);
  $("dl-day").value = cfg.day || 5;
  const tbody = $("dl-override-tbody");
  tbody.innerHTML = "";
  for (const ym of Object.keys(cfg.overrides || {}).sort()) {
    tbody.appendChild(dlOverrideRow(ym, cfg.overrides[ym]));
  }
  updateDeadlineEditorState();
}

// 入力内容 → 設定。不備があれば { error } を返す
function readDeadlineEditor() {
  const day = Math.round(Number($("dl-day").value));
  if (!(day >= 1 && day <= 31)) return { error: "基本の締め日は1〜31の数字で入力してください" };
  const overrides = {};
  for (const tr of $("dl-override-tbody").querySelectorAll("tr")) {
    const ym = tr.querySelector(".dl-ym").value;
    const date = tr.querySelector(".dl-date").value;
    if (!ym && !date) continue; // 空の行は無視
    if (!/^[0-9]{4}-[0-9]{2}$/.test(ym) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      return { error: "月ごとの締め日は「対象の月」と「締め日」を両方入力してください" };
    }
    if (overrides[ym]) return { error: fmtMonthOf(ym + "-01") + "が2回登録されています" };
    if (date < ym + "-01") return { error: fmtMonthOf(ym + "-01") + "の締め日が、その月より前の日付になっています" };
    overrides[ym] = date;
  }
  return {
    cfg: {
      enabled: $("dl-enabled").checked,
      monthOffset: Number($("dl-offset").value) === 0 ? 0 : 1,
      day,
      overrides
    }
  };
}

// 入力に合わせて「先月・今月・来月の締め日」の見本を更新
function updateDeadlineEditorState() {
  const enabled = $("dl-enabled").checked;
  $("dl-body").classList.toggle("dl-disabled", !enabled);
  const preview = $("dl-preview");
  if (!enabled) {
    preview.textContent = "いまは締め日を使っていません（作業者にはいつでも案内なしで提出してもらいます）。";
    return;
  }
  const r = readDeadlineEditor();
  if (r.error) {
    preview.textContent = "⚠ " + r.error;
    return;
  }
  const today = todayJst();
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y--; }
  const items = [];
  for (let i = 0; i < 3; i++) {
    const date = y + "-" + String(m).padStart(2, "0") + "-01";
    const dl = deadlineFor(date, r.cfg);
    const past = today > dl;
    items.push(`<li>${fmtMonthOf(date)}の日報 → <b>${fmtMd(dl)}</b>まで${past ? '<span class="dl-past">（締め日を過ぎています）</span>' : ""}</li>`);
    if (++m > 12) { m = 1; y++; }
  }
  preview.innerHTML = `<div class="dl-preview-title">この設定での締め日</div><ul>${items.join("")}</ul>`;
}

for (const id of ["dl-enabled", "dl-offset", "dl-day"]) {
  $(id).addEventListener("input", updateDeadlineEditorState);
  $(id).addEventListener("change", updateDeadlineEditorState);
}
$("dl-override-tbody").addEventListener("input", updateDeadlineEditorState);
$("dl-override-tbody").addEventListener("change", updateDeadlineEditorState);
$("dl-override-tbody").addEventListener("click", (e) => {
  if (e.target.closest(".dl-del")) {
    e.target.closest("tr").remove();
    updateDeadlineEditorState();
  }
});
$("btn-dl-add").addEventListener("click", () => {
  $("dl-override-tbody").appendChild(dlOverrideRow());
  updateDeadlineEditorState();
});
$("btn-save-deadline").addEventListener("click", async () => {
  const r = readDeadlineEditor();
  if (r.error) {
    toast(r.error, true);
    return;
  }
  try {
    state.masters.deadline = await api("/api/deadline", { method: "PUT", body: JSON.stringify(r.cfg) });
    renderDeadlineEditor();
    toast(r.cfg.enabled ? "締め日を保存しました" : "締め日を使わない設定にしました");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- 合言葉ゲート ---------- */

$("form-gate").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("gate-code").value.trim();
  if (!code) return;
  try {
    await api("/api/gate/check", { method: "POST", body: JSON.stringify({ code }) });
    state.siteCode = code;
    localStorage.setItem("nippo-site-code", code);
    $("gate-code").value = "";
    const restored = await restoreSession();
    if (!restored) showView("login");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- 初期化 ---------- */

(async () => {
  const savedName = localStorage.getItem("nippo-worker-name");
  if (savedName) $("login-name").value = savedName;
  // 公開運用（合言葉あり）かどうかを確認し、未入力ならゲート画面から始める
  try {
    const gate = await api("/api/gate");
    if (gate.gated && !state.siteCode) {
      showView("gate");
      return;
    }
  } catch { /* ゲート確認に失敗しても通常の流れへ */ }
  const restored = await restoreSession();
  if (!restored) showView("login");
})();
