#!/usr/bin/env node
/* =====================================================================
   デザインシステムの守り番（仕様: DESIGN_SYSTEM.md）
   使い方:  node scripts/check-design-tokens.js
   次のどれかに当てはまると一覧を出して失敗（終了コード1）します。

   1. style.css に生の値（色コード、rgb()、px/rem/em の寸法）が書かれている
   2. style.css が tokens.css に無いトークンを使っている（書き間違い）
   3. tokens.css の第2層・第3層に生の値が書かれている（第1層だけが値を持つ）
   4. HTML に style="" や <style> がある／tokens.css → style.css の順で読み込んでいない
   5. app.js が画面の部品に直接スタイルを書いている（style="" / .style.xxx =）
   6. 決められた色の組み合わせが読みやすさの基準（WCAG 2.2 AA）を下回っている
   ===================================================================== */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const problems = [];
const fail = (file, line, msg) => problems.push(`${file}${line ? ":" + line : ""}  ${msg}`);

// 色コード・色関数・長さの単位（数値 + px/rem/em）
const RAW_VALUE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|(?<![\w-])-?\d*\.?\d+(?:px|rem|em)\b/g;

// コメントを空白に置き換える（行番号は保つ）
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function scanRawValues(file, css, { fromIndex = 0 } = {}) {
  const lines = stripComments(css).split("\n");
  let offset = 0;
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart + line.length < fromIndex) return;
    // メディアクエリの条件（ブレークポイント）は DESIGN_SYSTEM.md で定めた値だけを許可
    const target = line.trim().startsWith("@media") ? "" : line;
    for (const m of target.matchAll(RAW_VALUE)) {
      fail(file, i + 1, `生の値「${m[0]}」があります。tokens.css のトークン（var(--…)）を使ってください`);
    }
  });
}

// ---------- tokens.css の読み取り ----------
const tokensCss = read("public/tokens.css");
const rootBlock = tokensCss.slice(tokensCss.indexOf(":root"), tokensCss.indexOf("}", tokensCss.indexOf(":root")));
const defined = new Map();
for (const m of stripComments(tokensCss).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  if (!defined.has(m[1])) defined.set(m[1], m[2].trim());
}

// 3. 第2層以降は値を持たない（var() の組み合わせだけ）
const semanticStart = tokensCss.indexOf("第2層: Semantic");
if (semanticStart < 0) fail("public/tokens.css", 0, "「第2層: Semantic」の見出しが見つかりません");
scanRawValues("public/tokens.css", tokensCss, { fromIndex: semanticStart });

// tokens.css 内の参照先がすべて定義済みか
for (const m of tokensCss.matchAll(/var\((--[a-z0-9-]+)/g)) {
  if (!defined.has(m[1])) fail("public/tokens.css", 0, `未定義のトークン ${m[1]} を参照しています`);
}

// ---------- 1・2. style.css ----------
const styleCss = read("public/style.css");
scanRawValues("public/style.css", styleCss);
stripComments(styleCss).split("\n").forEach((line, i) => {
  for (const m of line.matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!defined.has(m[1])) fail("public/style.css", i + 1, `tokens.css に無いトークン ${m[1]} を使っています`);
  }
  // 第1層の色を部品から直接使わない（役割の名前＝第2層を通す）
  for (const m of line.matchAll(/var\((--color-(?:green|terra|red|yellow|neutral|white-alpha|ink-alpha)-[a-z0-9-]+)/g)) {
    fail("public/style.css", i + 1, `第1層の色 ${m[1]} を直接使っています。役割の名前（--color-text など）を使ってください`);
  }
  if (/:root\b/.test(line)) fail("public/style.css", i + 1, "style.css でトークンを定義しないでください（tokens.css に書く）");
});

// ---------- 4. HTML ----------
for (const file of ["public/index.html", "public/help.html"]) {
  const html = read(file);
  html.split("\n").forEach((line, i) => {
    if (/\sstyle\s*=\s*["']/.test(line)) fail(file, i + 1, "style=\"\" で直接見た目を書かないでください（style.css の部品を使う）");
    if (/<style[\s>]/.test(line)) fail(file, i + 1, "<style> ブロックを書かないでください（style.css に集約する）");
  });
  const t = html.indexOf('href="tokens.css"'), s = html.indexOf('href="style.css"');
  if (t < 0 || s < 0 || t > s) fail(file, 0, "tokens.css → style.css の順で読み込んでください");
}

// ---------- 5. app.js ----------
read("public/app.js").split("\n").forEach((line, i) => {
  if (/\sstyle\s*=\s*["'`]/.test(line)) fail("public/app.js", i + 1, "画面の部品に style=\"\" を書かないでください（クラスで指定する）");
  if (/\.style\.[a-zA-Z]+\s*=/.test(line)) fail("public/app.js", i + 1, "要素の .style を直接書き換えないでください（クラスの付け外しで指定する）");
});

// ---------- 6. 読みやすさ（WCAG 2.2 AA）----------
const resolve = (name, seen = new Set()) => {
  if (seen.has(name)) return null;
  seen.add(name);
  const v = defined.get(name);
  if (!v) return null;
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? resolve(ref[1], seen) : v;
};
const lum = (hex) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4]
    .map((k) => parseInt(full.slice(k, k + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((acc, c, k) => acc + c * [0.2126, 0.7152, 0.0722][k], 0);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [前景, 背景, 基準]  文字は4.5、入力欄の枠・フォーカス枠など文字以外は3
const PAIRS = [
  ["--color-text", "--color-bg-page", 4.5],
  ["--color-text", "--color-bg-surface", 4.5],
  ["--color-text", "--color-bg-surface-paper", 4.5],
  ["--color-text", "--color-bg-subtle", 4.5],
  ["--color-text", "--color-bg-info-subtle", 4.5],
  ["--color-text-subtle", "--color-bg-page", 4.5],
  ["--color-text-subtle", "--color-bg-surface", 4.5],
  ["--color-text-subtle", "--color-bg-surface-paper", 4.5],
  ["--color-text-subtle", "--color-bg-subtle", 4.5],
  ["--segment-text", "--segment-bg", 4.5],
  ["--segment-active-text", "--segment-active-bg", 4.5],
  ["--input-placeholder", "--input-bg", 4.5],
  ["--input-border", "--input-bg", 3],
  ["--input-border", "--color-bg-surface-paper", 3],
  ["--chip-border", "--chip-bg", 3],
  ["--color-text-brand", "--color-bg-brand-subtle", 4.5],
  ["--table-header-text", "--table-header-bg", 4.5],
  ["--button-link-text", "--color-bg-surface", 4.5],
  ["--button-link-text", "--color-bg-subtle", 4.5],
  ["--button-danger-link-text", "--color-bg-surface", 4.5],
  ["--button-secondary-text", "--button-secondary-bg", 4.5],
  ["--color-text-inverse", "--color-bg-brand", 4.5],
  ["--color-text-inverse", "--color-bg-brand-bold", 4.5],
  ["--badge-strong-text", "--badge-success-bg", 4.5],
  ["--badge-strong-text", "--badge-warning-bg", 4.5],
  ["--badge-strong-text", "--badge-danger-bg", 4.5],
  ["--badge-neutral-text", "--badge-neutral-bg", 4.5],
  ["--color-text-accent", "--color-bg-surface", 4.5],
  ["--color-text-accent", "--color-bg-subtle", 4.5],
  ["--color-text-accent-bold", "--color-bg-accent-subtle", 4.5],
  ["--alert-danger-text", "--alert-danger-bg", 4.5],
  ["--alert-info-text", "--alert-info-bg", 4.5],
  ["--tab-active-text", "--tab-active-bg", 4.5],
  ["--focus-ring-color", "--color-bg-surface", 3],
  ["--focus-ring-color", "--color-bg-page", 3]
];
const contrastLines = [];
for (const [fg, bg, need] of PAIRS) {
  const a = resolve(fg), b = resolve(bg);
  if (!/^#[0-9a-fA-F]{3,8}$/.test(a || "") || !/^#[0-9a-fA-F]{3,8}$/.test(b || "")) {
    fail("public/tokens.css", 0, `コントラストを確認できません: ${fg} / ${bg}（単色のトークンを指定してください）`);
    continue;
  }
  const r = ratio(a, b);
  contrastLines.push(`  ${r >= need ? "OK" : "NG"} ${r.toFixed(2).padStart(5)}:1（基準 ${need}）${fg} / ${bg}`);
  if (r < need) fail("public/tokens.css", 0, `読みやすさ不足 ${r.toFixed(2)}:1（基準 ${need}:1）${fg} / ${bg}`);
}

// ---------- 結果 ----------
console.log(`トークン定義: ${defined.size}個`);
console.log("色の組み合わせ（WCAG 2.2 AA）:");
console.log(contrastLines.join("\n"));
if (problems.length) {
  console.log(`\n✗ デザインシステムの違反が ${problems.length} 件あります:`);
  for (const p of problems) console.log("  - " + p);
  process.exit(1);
}
console.log("\n✓ 違反はありません（DESIGN_SYSTEM.md に準拠）");
