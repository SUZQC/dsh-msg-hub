/**
 * adapter.js — QQ 适配器（QQ 开放平台官方 API v2）
 *
 * 用 @tencent-connect/qqbot-nodejs 的 QQBot：
 *   - WebSocket 长连接收发（官方通道）
 *   - bot.on('message') 收消息 → bridge.inbound
 *   - bot.sendText 回复
 *
 * 凭证：state/qq/accounts.json（扫码绑定写入，见 scripts/qq-login.mjs）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QQBot, FileKVStore, kvSessionPersistence } from "@tencent-connect/qqbot-nodejs";
import { listQqAccounts } from "./credentials.js";
import { diagLog } from "../diag.js";
import { saveMedia, mediaHint, guessImageExt } from "../media.js";
import { transcribeAudio, isAsrEnabled } from "../asr.js";

function resolveQqDataDir(appId) {
  return path.join(
    process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
      path.join(fileURLToPath(new URL("../../", import.meta.url)), "state", "qq", "data"),
    String(appId),
  );
}

// ── 文件附件解析（docx / xlsx / pptx / 纯文本）───────────────
// QQ 的文件消息 content 为空，正文在附件里；这里下载后本地抽文字再喂给模型。
const PY_EXE =
  process.env.DSH_PYTHON_EXE?.trim() ||
  path.join(
    process.env.USERPROFILE || "C:\\Users\\10640",
    ".dsh",
    "dsh-runtimes",
    "dsh-primary-runtime",
    "dependencies",
    "python",
    "python.exe",
  );
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const FILE_TEXT_LIMIT = 4000;

const PY_EXTRACT = [
  "import sys, os",
  "p = sys.argv[1]",
  "ext = os.path.splitext(p)[1].lower()",
  "out = []",
  "try:",
  "    if ext == '.docx':",
  "        from docx import Document",
  "        d = Document(p)",
  "        out += [x.text for x in d.paragraphs]",
  "        for t in d.tables:",
  "            for row in t.rows:",
  "                out.append(' | '.join(c.text.strip() for c in row.cells))",
  "    elif ext == '.xlsx':",
  "        from openpyxl import load_workbook",
  "        wb = load_workbook(p, read_only=True, data_only=True)",
  "        for ws in wb.worksheets:",
  "            out.append('## ' + str(ws.title))",
  "            for i, row in enumerate(ws.iter_rows(values_only=True)):",
  "                if i >= 200: break",
  "                out.append(' | '.join('' if c is None else str(c) for c in row))",
  "    elif ext == '.pptx':",
  "        from pptx import Presentation",
  "        pr = Presentation(p)",
  "        for i, s in enumerate(pr.slides):",
  "            out.append('## slide ' + str(i + 1))",
  "            for sh in s.shapes:",
  "                if getattr(sh, 'has_text_frame', False): out.append(sh.text_frame.text)",
  "    elif ext in ('.txt', '.md', '.csv', '.json', '.log'):",
  "        out.append(open(p, encoding='utf-8', errors='replace').read())",
  "    else:",
  "        sys.exit(0)",
  "except Exception as e:",
  "    sys.stderr.write(str(e))",
  "    sys.exit(2)",
  "sys.stdout.write('\\n'.join(x for x in out if x and x.strip())[:8000])",
].join("\n");

/** 用 DSH 自带 Python 抽取文件正文；失败/不支持返回空串 */
export function extractFileText(filePath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PY_EXE, ["-c", PY_EXTRACT, filePath], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve("");
    }, 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (err) diagLog(`[qq] 文件解析 stderr: ${err.slice(0, 200)}`);
      resolve(out.trim());
    });
  });
}

// ─────────────────────────────────────────────────────────────
// 群聊只读缓冲：非 @ 的群消息只落盘 + 记内存，不进模型。
// 好处：群里聊什么她“知道”（@ 时带上最近 N 条），但不会每条都烧钱。
// 目录：<workspace>\群聊\<群openid>\原文\<YYYY-MM-DD>.md
// ─────────────────────────────────────────────────────────────
const GROUP_LOG_ROOT =
  process.env.DSH_GROUP_LOG_DIR?.trim() || path.join("E:", "DS House", "workspace", "群聊");
const GROUP_BUF_MAX = 60;
const GROUP_CTX_N = 12;
// 机器人自己在群里的 mention id（从 2026-11-21 的群消息里观察到）。
// 开了「获取群内全部消息」后，@ 机器人不一定再发 GROUP_AT_MESSAGE_CREATE，
// 而是以 GROUP_MESSAGE_CREATE 到达，内容里是 <@这个id>。换应用/换群要重新观察。
const BOT_MENTION_ID =
  process.env.DSH_QQ_BOT_MENTION_ID?.trim() || "33C4C78A75DF38BEC088A7F8B89BF25E";
const groupBuffers = new Map();
const groupIdNames = new Map(); // groupKey -> Map(openid -> 昵称)
const groupLastInject = new Map(); // groupKey -> epoch ms，上次把上下文送给模型的时间

function tsParts(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hhmm: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function groupLogFile(groupKey, dateKey = tsParts().date) {
  return path.join(GROUP_LOG_ROOT, String(groupKey), "原文", `${dateKey}.md`);
}

function seedGroupBuffer(groupKey) {
  const buf = [];
  try {
    const f = groupLogFile(groupKey);
    const dateKey = tsParts().date;
    if (fs.existsSync(f)) {
      for (const ln of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = /^- (\d{2}:\d{2}) ([^:]+): (.*)$/.exec(ln);
        if (m) {
          buf.push({ hhmm: m[1], who: m[2], text: m[3], ts: Date.parse(`${dateKey}T${m[1]}:00`) || 0 });
        }
      }
    }
  } catch {}
  groupBuffers.set(groupKey, buf.slice(-GROUP_BUF_MAX));
  return groupBuffers.get(groupKey);
}

function groupBuffer(groupKey) {
  return groupBuffers.get(groupKey) || seedGroupBuffer(groupKey);
}

/** 记下 groupKey 里 openid → 昵称，供把 <@id> 还原成 @昵称 */
function rememberGroupSender(groupKey, id, name) {
  if (!id || !name) return;
  let m = groupIdNames.get(groupKey);
  if (!m) {
    m = new Map();
    groupIdNames.set(groupKey, m);
  }
  m.set(String(id), String(name).slice(0, 24));
}

/**
 * QQ 表情在 content 里是标签：<faceType=1,faceId="344",ext="eyJ0ZXh0Ijoi5aSn5oCo56eNIn0=">
 * ext 是 base64 的 {"text":"大怨种"}（平台自带表情名）；没有 ext 时退化成 [表情]。
 */
function faceLabel(id, ext) {
  let name = "";
  if (ext) {
    try {
      const j = JSON.parse(Buffer.from(String(ext).replace(/^["']|["']$/g, ""), "base64").toString("utf8"));
      if (j && typeof j.text === "string") name = j.text.trim();
    } catch {}
  }
  if (!name) return "[表情]";
  return `[表情:${name.slice(0, 8)}]`;
}

/** 把 QQ 的标记洗干净：表情标签 → [表情:名]，其余原样 */
function normalizeQqMarkup(text) {
  return String(text ?? "").replace(
    /<faceType=\d+,faceId=["']?([0-9A-Za-z]+)["']?(?:,ext=("[^"]*"|'[^']*'|[^>,\s]+))?\s*\/?>/gi,
    (_m, id, ext) => faceLabel(id, ext),
  );
}

/** 把 <@openid> 换成可读的 @昵称；@ 机器人时写成 “@你” */
function prettyGroupText(groupKey, text) {
  return String(text).replace(/<@!?([0-9A-Za-z_-]+)>/g, (_m, id) => {
    if (id === BOT_MENTION_ID) return "@你";
    const name = groupIdNames.get(groupKey)?.get(String(id));
    return name ? `@${name}` : "@某人";
  });
}

function rememberGroupLine(groupKey, hhmm, who, text, ts = Date.now()) {
  const buf = groupBuffer(groupKey);
  // 一行一条：把换行压成空格（文件解析正文是多行的，不压会破坏原文格式）
  const oneLine = String(text).replace(/\s*\n\s*/g, " ").slice(0, 1500);
  const last = buf[buf.length - 1];
  const dup = last && last.text === oneLine && last.who === who && last.hhmm === hhmm;
  if (dup) return;
  buf.push({ hhmm, who, text: oneLine, ts });
  if (buf.length > GROUP_BUF_MAX) buf.splice(0, buf.length - GROUP_BUF_MAX);
  try {
    const f = groupLogFile(groupKey);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `- ${hhmm} ${who}: ${oneLine}\n`, "utf8");
  } catch (err) {
    diagLog(`[qq] 群聊原文写入失败: ${String(err)}`);
  }
}

// ── 群文件（按天存正文，可跨天搜） ──
// 正文：文件\<date>.jsonl，每行 {t,name,len,body}
// 用“扫目录 + 按天解析缓存”代替总索引：老数据没有总索引也能搜到
const dayFileCache = new Map(); // `${groupKey}|${date}` -> { mtime, rows }

function groupFileDir(groupKey) {
  return path.join(GROUP_LOG_ROOT, String(groupKey), "文件");
}

function groupFileIndex(groupKey, dateKey = tsParts().date) {
  return path.join(groupFileDir(groupKey), `${dateKey}.jsonl`);
}

function rememberGroupFile(groupKey, name, body) {
  try {
    const f = groupFileIndex(groupKey);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(
      f,
      JSON.stringify({ t: tsParts().hhmm, name, len: body.length, body: body.slice(0, 20000) }) + "\n",
      "utf8",
    );
    dayFileCache.delete(`${groupKey}|${tsParts().date}`); // 写了新的，下次读重新解析
  } catch (err) {
    diagLog(`[qq] 群文件索引写入失败: ${String(err)}`);
  }
}

function readDayFile(groupKey, dateKey) {
  const f = groupFileIndex(groupKey, dateKey);
  try {
    if (!fs.existsSync(f)) return [];
    const st = fs.statSync(f);
    const key = `${groupKey}|${dateKey}`;
    const cached = dayFileCache.get(key);
    if (cached && cached.mtime === st.mtimeMs) return cached.rows;
    const rows = fs
      .readFileSync(f, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    dayFileCache.set(key, { mtime: st.mtimeMs, rows });
    return rows;
  } catch {
    return [];
  }
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** 最近 days 天解析过的文件，新的在前：[{date,t,name,len,body}] */
function listGroupFiles(groupKey, days = 45) {
  let names = [];
  try {
    names = fs.readdirSync(groupFileDir(groupKey)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  } catch {
    return [];
  }
  const cutoff = shiftDate(tsParts().date, -(days - 1));
  const dates = names
    .map((n) => n.slice(0, 10))
    .filter((d) => d >= cutoff)
    .sort()
    .reverse();
  const out = [];
  for (const d of dates) {
    for (const r of readDayFile(groupKey, d).slice().reverse()) {
      if (!r || !r.name) continue;
      out.push({ date: d, t: r.t, name: r.name, len: r.len || String(r.body || "").length, body: r.body || "" });
    }
  }
  return out;
}

/** 兼容旧调用：只要最近几个 */
function recentGroupFiles(groupKey, limit = 2) {
  return listGroupFiles(groupKey, 45).slice(0, limit);
}

/** 文件名里能拿来“对上话”的词：中文取 2-gram，英文/数字取 4 字以上 */
const FILE_STOP = new Set(["ai", "doc", "docs", "docx", "pdf", "xlsx", "pptx", "md", "txt", "file", "文件", "文档", "附件"]);

function fileNameTokens(name) {
  const stem = String(name || "").replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const tokens = new Set();
  for (const seg of stem.split(/[^0-9A-Za-z\u4e00-\u9fa5]+/)) {
    if (!seg) continue;
    if (/^[0-9A-Za-z]+$/.test(seg)) {
      if (seg.length >= 4) tokens.add(seg.toLowerCase());
      continue;
    }
    // 中文（可能夹着字母数字）：整段 + 所有 2-gram
    if (seg.length <= 6) tokens.add(seg);
    for (let i = 0; i + 2 <= seg.length; i += 1) tokens.add(seg.slice(i, i + 2));
  }
  return [...tokens].filter((t) => t.length >= 2 && !FILE_STOP.has(t));
}

/** 问句里的可搜词：中文 2-gram 去掉虚词，英文/数字 4 字以上 */
const QUERY_STOP = new Set([
  "这个", "那个", "哪些", "什么", "怎么", "怎样", "我们", "你们", "他们", "今天", "昨天", "前天",
  "现在", "可以", "是不", "不是", "一个", "有没", "没有", "就是", "还是", "觉得", "看的", "看了",
  "你说", "说说", "一下", "能不", "不能", "知道", "这些", "那些", "时候", "东西", "内容", "文件",
  "文档", "附件", "那种", "有点", "还有", "然后", "所以", "因为", "但是", "如果", "应该", "需要",
]);

function queryTokens(text) {
  const toks = new Set();
  for (const seg of String(text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ").split(" ")) {
    if (!seg) continue;
    if (/^[0-9A-Za-z]+$/.test(seg)) {
      if (seg.length >= 4) toks.add(seg.toLowerCase());
      continue;
    }
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const t = seg.slice(i, i + 2);
      if (QUERY_STOP.has(t)) continue;
      if (/^[0-9A-Za-z]+$/.test(t) && t.length < 4) continue;
      toks.add(t);
    }
  }
  return [...toks];
}

/** 这句话里提到的日期：今天/昨天/前天/大前天、2026-11-22、11月22日 */
function queryDates(text) {
  const q = String(text || "");
  const today = tsParts().date;
  const out = new Set();
  for (const [w, d] of [["大前天", -3], ["前天", -2], ["昨天", -1], ["今天", 0]]) {
    if (q.includes(w)) out.add(shiftDate(today, d));
  }
  const iso = q.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    out.add(`${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`);
  }
  const md = q.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (md) {
    const cand = `${today.slice(0, 4)}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    if (cand <= today) out.add(cand);
  }
  return out;
}

function snippetAround(text, pos, width = 900) {
  const s = String(text || "").replace(/\s+/g, " ");
  if (s.length <= width) return s;
  if (pos <= 0) return `${s.slice(0, width)}…`;
  const start = Math.max(0, pos - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${s.slice(start, start + width)}${start + width < s.length ? "…" : ""}`;
}

// ── 分块（RAG 的 chunk 层）：整篇不一次性塞进去，命中哪块给哪块 ──
const FILE_CHUNK = 900;
const FILE_CHUNK_OVERLAP = 120;

function splitChunks(body) {
  const text = String(body || "").replace(/\r\n/g, "\n");
  if (text.length <= FILE_CHUNK) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + FILE_CHUNK);
    if (end < text.length) {
      const brk = text.lastIndexOf("\n", end);
      if (brk > i + FILE_CHUNK * 0.5) end = brk;
    }
    chunks.push(text.slice(i, end));
    if (end >= text.length) break;
    i = Math.max(i + 1, end - FILE_CHUNK_OVERLAP);
  }
  return chunks;
}

/** 在正文里给每个分块打分，返回命中最多的那块 */
function bestChunk(body, toks) {
  const chunks = splitChunks(body);
  let best = null;
  chunks.forEach((chunk, idx) => {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const t of toks) if (lower.includes(t)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { chunk, idx, score, total: chunks.length };
  });
  return best;
}

/**
 * 她要“那个文件”时到底递哪份正文。优先级：
 * name（点名了文件名里的词）> keyword（正文里搜到）> date（只说了哪天）> ask（问文件/引用）> list（只给清单）
 */
function pickGroupFiles(groupKey, text, asksFile = false) {
  const all = listGroupFiles(groupKey, 45);
  if (!all.length) return { mode: "none", files: [] };
  const q = String(text || "");
  const dates = queryDates(q);
  const pool = dates.size ? all.filter((f) => dates.has(f.date)) : all;
  const named = pool.filter((f) => fileNameTokens(f.name).some((t) => q.includes(t)));
  if (named.length) {
    // 同一个文件名跨天重复（每天的日报）时只给最新那份
    const seen = new Set();
    const uniq = [];
    for (const f of named) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      uniq.push(f);
    }
    return { mode: "name", files: uniq.slice(0, 2) };
  }
  const toks = queryTokens(q);
  if (toks.length) {
    let best = null;
    for (const f of pool.slice(0, 40)) {
      const body = String(f.body || "");
      const lower = body.toLowerCase();
      // 先用整篇过一遍：词可能被切在块边界上
      let bodyScore = 0;
      for (const t of toks) if (lower.includes(t)) bodyScore += 1;
      if (bodyScore < 2) continue;
      const hit = bestChunk(body, toks);
      if (!hit) continue;
      const score = bodyScore + hit.score;
      if (!best || score > best.score) best = { f, score, hit };
    }
    if (best) {
      return {
        mode: "keyword",
        files: [
          {
            ...best.f,
            snippet: `（命中第 ${best.hit.idx + 1}/${best.hit.total} 块，全文 ${best.f.len} 字）\n${best.hit.chunk}`,
          },
        ],
      };
    }
  }
  // 只说了「昨天那份」而没有文件线索（闲聊里的“今天”“昨天”）→ 不当成要文件
  if (dates.size && pool.length && asksFile) return { mode: "date", files: pool.slice(0, 2) };
  if (asksFile) return { mode: "ask", files: all.slice(0, 2) };
  return { mode: "list", files: [] };
}

/** sinceMs>0 时只取“上次注入之后”的新消息，避免会话里反复堆同一批内容 */
function recentGroupContext(groupKey, n = GROUP_CTX_N, sinceMs = 0) {
  const items = groupBuffer(groupKey)
    .filter((l) => !sinceMs || (l.ts || 0) > sinceMs)
    .slice(-n);
  if (!items.length) return "";
  return items.map((l) => `- ${l.hhmm} ${l.who}: ${l.text}`).join("\n");
}

// ── 话题窗口：机器人刚在群里主动开了一个话题，30 分钟内群友的普通消息也接 ──
const topicWindowCache = new Map(); // groupKey -> { mtime, until }

function topicWindowActive(groupKey) {
  const f = path.join(GROUP_LOG_ROOT, String(groupKey), "_话题窗口.json");
  try {
    if (!fs.existsSync(f)) return false;
    const st = fs.statSync(f);
    const cached = topicWindowCache.get(groupKey);
    if (cached && cached.mtime === st.mtimeMs) return Date.now() < cached.until;
    const data = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
    const until = Number(data?.until) || 0;
    topicWindowCache.set(groupKey, { mtime: st.mtimeMs, until });
    return Date.now() < until;
  } catch {
    return false;
  }
}

// ── 群日记检索（v1：关键词 + 2-gram，读 索引\日记.jsonl） ──
const diaryIndexCache = new Map(); // groupKey -> { mtime, entries }
const groupInjectedDiary = new Map(); // groupKey -> Map(entryKey -> ts)，防重复注入

function loadDiaryIndex(groupKey) {
  const f = path.join(GROUP_LOG_ROOT, String(groupKey), "索引", "日记.jsonl");
  try {
    if (!fs.existsSync(f)) return [];
    const st = fs.statSync(f);
    const cached = diaryIndexCache.get(groupKey);
    if (cached && cached.mtime === st.mtimeMs) return cached.entries;
    const entries = fs
      .readFileSync(f, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    diaryIndexCache.set(groupKey, { mtime: st.mtimeMs, entries });
    return entries;
  } catch {
    return [];
  }
}

function termsOf(text) {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  for (const seg of t.replace(/[^\u4e00-\u9fa5]/g, " ").split(/\s+/)) {
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return out;
}

/** 从群日记索引里找和 query 相关的片段；找不到返回空串 */
function recallDiary(groupKey, query, limit = 2) {
  const entries = loadDiaryIndex(groupKey);
  if (!entries.length) return "";
  const terms = termsOf(query);
  if (!terms.size) return "";
  const scored = entries
    .map((e) => {
      const hay = termsOf(`${e.text || ""} ${(e.entities || []).join(" ")}`);
      let hit = 0;
      for (const t of terms) if (hay.has(t)) hit++;
      return { e, score: hit / Math.sqrt(terms.size) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return "";
  // 防“越滚越长”：同一条日记忆 6 小时内不重复注入
  const seen = groupInjectedDiary.get(groupKey) || new Map();
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 6 * 3600 * 1000) seen.delete(k);
  groupInjectedDiary.set(groupKey, seen);
  const fresh = scored.filter((x) => {
    const key = `${x.e.date}|${x.e.chunk ?? 0}|${String(x.e.text || "").slice(0, 24)}`;
    return !seen.has(key);
  });
  if (!fresh.length) return "";
  const picked = fresh.slice(0, limit);
  for (const x of picked) {
    seen.set(`${x.e.date}|${x.e.chunk ?? 0}|${String(x.e.text || "").slice(0, 24)}`, now);
  }
  return picked
    .map((x) => `- ${x.e.date}: ${x.e.text}`)
    .join("\n");
}

/**
 * 解析入站消息内容（文本 / 图片 / 语音）。
 *
 * - 文本：直接用 content
 * - 语音：QQ 官方在 attachment 里已给 asr_refer_text（转写好的文字）→ 直接采用，
 *         不花自建 ASR 的钱；为空时才兜底下载 voice_wav_url 走 ASR
 * - 图片：attachment.url 是直链（无需解密，区别于微信）→ 下载落盘 → read_image
 *
 * @param {object} msg SDK 的入站消息对象
 * @returns {Promise<string>} 给模型看的文本；无法处理时返回空字符串
 */
export async function extractQqContent(msg) {
  if (!msg) return "";
  const raw = typeof msg.content === "string" ? msg.content.trim() : "";
  if (raw) return raw;

  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (!atts.length) return "";

  const parts = [];
  for (const a of atts) {
    const type = String(a?.content_type ?? "").toLowerCase();
    try {
      if (type === "voice") {
        // 官方已转写：免费、即时，且比自建 ASR 更准
        const ref = typeof a.asr_refer_text === "string" ? a.asr_refer_text.trim() : "";
        if (ref) {
          diagLog(`[qq] 语音使用官方转写: "${ref.slice(0, 40)}"`);
          parts.push(`[语音] ${ref}`);
          continue;
        }
        // 兜底：下载 WAV 自己转写
        const wavUrl = a.voice_wav_url || a.url;
        if (!wavUrl) continue;
        if (!isAsrEnabled()) {
          diagLog("[qq] 收到语音：官方未给转写文本，且未配置 ASR（缺 state/asr.env）已跳过");
          continue;
        }
        const vr = await fetch(wavUrl, { signal: AbortSignal.timeout(60_000) });
        if (!vr.ok) throw new Error(`语音下载 HTTP ${vr.status}`);
        const vbuf = Buffer.from(await vr.arrayBuffer());
        const t = await transcribeAudio(vbuf, { filename: "voice.wav", mime: "audio/wav" });
        if (t) parts.push(`[语音] ${t}`);
        continue;
      }
      if (type.startsWith("image")) {
        if (!a.url) continue;
        const ir = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
        if (!ir.ok) throw new Error(`图片下载 HTTP ${ir.status}`);
        const ibuf = Buffer.from(await ir.arrayBuffer());
        const file = saveMedia(ibuf, { channel: "qq", ext: guessImageExt(ibuf) });
        if (file) {
          diagLog(`[qq] 图片已保存 ${ibuf.length} 字节: ${file}`);
          parts.push(mediaHint(file, { kind: "图片" }));
        }
        continue;
      }
      // 文件附件：下载 → 本地抽文字 → 只把文件名 + 正文前 4000 字喂给模型
      const fname = a.filename || a.name || a.file_name || "";
      if (fname || /file/i.test(type)) {
        let hint = `[文件] ${fname || "未命名文件"}`;
        try {
          if (a.url) {
            const fr = await fetch(a.url, { signal: AbortSignal.timeout(120_000) });
            if (fr.ok) {
              const fbuf = Buffer.from(await fr.arrayBuffer());
              if (fbuf.length > FILE_MAX_BYTES) {
                hint += "（超过 20MB，未下载）";
              } else if (fbuf.length > 0) {
                const extFromName = (String(fname).match(/\.[A-Za-z0-9]{1,6}$/) || [""])[0].toLowerCase();
                const saved = saveMedia(fbuf, { channel: "qq", ext: extFromName.replace(/^\./, "") || "bin" });
                if (saved) {
                  const body = await extractFileText(saved);
                  if (body) {
                    // 正文不进消息文本（否则会跟着说话人走、也把上下文撑爆）；
                    // 只留一行摘要，正文存进 文件\<日期>.jsonl，问文件时再注入。
                    hint += `（${extFromName || "未知格式"}，${body.length} 字，已解析；正文已存，问文件时会给）`;
                    diagLog(`[qq] 文件已解析 ${fname}: ${body.length} 字 → ${saved}`);
                    rememberGroupFile(msg.groupOpenid || "unknown", fname || "未命名文件", body);
                  } else {
                    hint += "（未能解析正文，只记文件名）";
                    diagLog(`[qq] 文件未能解析 ${fname} → ${saved}`);
                  }
                }
              }
            } else {
              hint += "（下载失败）";
            }
          }
        } catch (e) {
          hint += "（下载出错）";
          diagLog(`[qq] 文件下载失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        parts.push(hint);
      } else {
        diagLog(`[qq] 收到暂不支持的附件类型: ${type}（filename=${a.filename ?? "?"}）`);
      }
    } catch (e) {
      diagLog(`[qq] 附件处理失败（type=${type}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parts.join("\n");
}

/**
 * 启动一个 QQBot 账户。
 * @param {object} account {appId, appSecret}
 * @param {object} opts
 * @param {(text: string, peerKey: string, replyTarget: object, msg) => Promise<void>} opts.onMessage
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<() => void>} stop 函数
 */
export async function startQqBotAccount(account, { onMessage, abortSignal }) {
  const bot = new QQBot({
    appId: account.appId,
    appSecret: account.appSecret,
    accountId: account.appId,
    markdownSupport: false,
    userAgent: `dsh-msg-hub/0.1.0 (Node/${process.version})`,
    transport: "websocket",
    sessionPersistence: kvSessionPersistence({
      store: new FileKVStore({ dir: resolveQqDataDir(account.appId), fileName: "session.json" }),
      accountId: account.appId,
    }),
    tokenPrefetch: "sync",
    logger: {
      info: (m) => diagLog(`[qq ${account.appId}] ${m}`),
      warn: (m) => diagLog(`[qq ${account.appId}] WARN ${m}`),
      error: (m) => diagLog(`[qq ${account.appId}] ERROR ${m}`),
      debug: () => {},
    },
  });

  const handleMessage = async (ctx, msg) => {
    let text = "";
    try {
      text = await extractQqContent(msg);
    } catch (err) {
      diagLog(`[qq ${account.appId}] 内容解析失败: ${String(err)}`);
      return;
    }
    // 表情标签先洗成人话，否则原文和模型上下文里全是 <faceType=...>
    text = normalizeQqMarkup(text);
    // 会话键：c2c 私聊用用户 openid；群聊用 群openid:发送者openid（群内每人独立记忆）
    const scope = msg.replyTarget?.scope ?? msg.kind ?? "c2c";
    const targetId = msg.replyTarget?.targetId ?? msg.senderId;
    const senderId = msg.senderId ?? targetId;
    const peerKey = scope === "group" ? `group:${targetId}:${senderId}` : `c2c:${senderId}`;
    const isGroup = scope === "group";
    const groupKey = msg.groupOpenid || targetId;
    // @ 我 的判定提前算：空内容分支也要用（避免对“别的机器人发文件”乱回话）
    const msEarly = Array.isArray(msg.mentions) ? msg.mentions : [];
    const contentRaw = typeof msg.content === "string" ? msg.content : "";
    const atMeEarly =
      msEarly.some((m) => m && (m.is_you === true || m.isYou === true)) ||
      contentRaw.includes(`<@${BOT_MENTION_ID}>`) ||
      contentRaw.includes(`<@!${BOT_MENTION_ID}>`);

    if (!text) {
      const whoRaw0 = String(msg.senderName || senderId).slice(0, 24);
      const who0 = msg.senderIsBot ? `[AI] ${whoRaw0}` : whoRaw0;
      if (!isGroup || !atMeEarly) {
        // 空内容但不是 @ 我（别的机器人发文件/纯附件等）：只记账，不回复
        diagLog(`[qq ${account.appId}] 空内容 ${scope} from=${senderId}（非 @，只记账不回复）`);
        if (isGroup) rememberGroupLine(groupKey, tsParts().hhmm, who0, "（无文字消息）");
        return;
      }
      // 裸 @（平台把 mention 剥掉后 content 为空）：回一句固定话术，不进模型，省 token
      diagLog(`[qq ${account.appId}] 空内容 ${scope} from=${senderId}（裸 @）→ 固定话术，不进模型`);
      if (msg.replyTarget) {
        sendQqText(bot, msg.replyTarget, "在呢，怎么啦？").catch((err) => {
          diagLog(`[qq ${account.appId}] 固定话术发送失败: ${String(err)}`);
        });
      }
      return;
    }
    const stamp = tsParts();
    const authorRaw = msg.raw && msg.raw.author ? msg.raw.author : null;
    const whoRaw = String(
      msg.senderName || (authorRaw && (authorRaw.member_nickname || authorRaw.username)) || senderId,
    ).slice(0, 24);
    // 机器人发的消息打 [AI] 标，方便模型判断“这是同类/机器人”，自行决定要不要接话
    const who = msg.senderIsBot ? `[AI] ${whoRaw}` : whoRaw;
    if (isGroup) {
      // 诊断：把发送者原始字段打出来，便于核对“名字对不上”的问题
      diagLog(
        `[qq ${account.appId}] group author=${JSON.stringify(authorRaw || {}).slice(0, 200)} name="${whoRaw}"`,
      );
      // 用 mention 里的昵称补全 openid→昵称表（被 @ 的人不一定发过言）
      const ms0 = Array.isArray(msg.mentions) ? msg.mentions : [];
      for (const m of ms0) {
        if (!m) continue;
        rememberGroupSender(groupKey, m.id || m.member_openid, m.member_nickname || m.username);
      }
    }

    // ① 全量群消息：默认只记账；@ 我、或「话题窗口内群友接话」才走回复
    if (isGroup && msg.rawEventType === "GROUP_MESSAGE_CREATE") {
      const ms = Array.isArray(msg.mentions) ? msg.mentions : [];
      if (text.includes("<@")) {
        diagLog(`[qq ${account.appId}] 全量消息含 mention：${JSON.stringify(ms).slice(0, 400)}`);
      }
      const atMe =
        ms.some((m) => m && (m.is_you === true || m.isYou === true)) ||
        text.includes(`<@${BOT_MENTION_ID}>`) ||
        text.includes(`<@!${BOT_MENTION_ID}>`);
      // 触发条件：@ 她，或**任何消息里点名「小酥鱼/酥鱼」**（不再依赖窗口）。
      // 窗口只影响“要不要带最近上下文/文件正文”。
      const named = /小酥鱼|酥鱼/.test(text);
      const inWindow = topicWindowActive(groupKey);
      const trigger = atMe || (named && !msg.senderIsBot);
      if (!trigger) {
        rememberGroupSender(groupKey, senderId, msg.senderName);
        const pretty = prettyGroupText(groupKey, text);
        rememberGroupLine(groupKey, stamp.hhmm, who, pretty);
        diagLog(`[qq ${account.appId}] [只读] group ${stamp.hhmm} ${who}: "${pretty.slice(0, 40)}"`);
        return;
      }
      diagLog(
        `[qq ${account.appId}] 全量消息 → ${atMe ? "@我" : "点名"}，转回复${inWindow ? "（窗口内）" : ""}`,
      );
    }

    // ② @ 或私聊：群聊先取“上次注入之后”的新消息，再把这条本身也记进原文
    let modelText = text;
    if (isGroup) {
      rememberGroupSender(groupKey, senderId, msg.senderName);
      const pretty = prettyGroupText(groupKey, text);
      const since = groupLastInject.get(groupKey) || 0;
      let recent = recentGroupContext(groupKey, GROUP_CTX_N, since);
      const lastLine = recent ? recent.split("\n").pop() : "";
      if (lastLine && lastLine.endsWith(`: ${pretty}`)) {
        recent = recent.split("\n").slice(0, -1).join("\n");
      }
      rememberGroupLine(groupKey, stamp.hhmm, who, pretty);
      groupLastInject.set(groupKey, Date.now());
      const recall = recallDiary(groupKey, pretty);
      // 话题窗口内、群友（非机器人）的普通消息：按“接话”处理，不要求 @
      const inWindowChat =
        !atMeEarly && !msg.senderIsBot && topicWindowActive(groupKey);
      const parts = [];
      if (recall) {
        parts.push(`[群聊历史片段（来自日记，可能相关；不是本轮的对话）]\n${recall}`);
        diagLog(`[qq ${account.appId}] 日记忆命中 ${recall.split("\n").length} 条`);
      }
      if (recent) {
        parts.push(`[群聊最近消息，供你了解上下文；不要逐条复述]\n${recent}`);
        diagLog(`[qq ${account.appId}] 带 ${recent.split("\n").length} 条群聊上下文进模型（新增部分）`);
      }
      // 文件正文什么时候进上下文？跨天按优先级找（见 pickGroupFiles）：
      //   ① 点名了文件名里的词 → 那个文件正文（哪天都行）
      //   ② 正文里搜到关键词 → 相关片段
      //   ③ 只说了「昨天那份」→ 那天最新的文件
      //   ④ 问了「文件/附件/这篇/这个」或带引用 → 最近 2 个
      //   ⑤ 都没提 → 只给一行清单（让她知道群里有文件，不瞎说“没到手上”）
      const asksFile = /(文件|docx|附件|这篇|这个|这文件|文档|报告|表格)/i.test(pretty) || !!msg.refMsgIdx;
      const picked = pickGroupFiles(groupKey, pretty, asksFile);
      if (picked.files.length) {
        const head =
          {
            name: "[群里这个文件的正文（别人发的，不是你写的）。只按这里写的说，里面没有的直接说没有，别拿常识补]",
            keyword: "[从群文件里搜到的相关片段（只是节选，别当全文）。只按这里写的说，没提到就说没提到]",
            date: "[群里你说的那天的文件。只按正文说，别补]",
            ask: "[群里最近的文件（已解析正文）。只按正文说，别补]",
          }[picked.mode] || "[群文件]";
        const block = picked.files
          .map(
            (x) =>
              `- ${x.date} ${x.t} ${x.name}（${x.len} 字）\n  ${String(x.snippet || x.body).slice(0, 2500)}`,
          )
          .join("\n\n");
        parts.push(`${head}\n${block}`);
        diagLog(
          `[qq ${account.appId}] 群文件命中(${picked.mode}) ${picked.files.length} 个: ${picked.files
            .map((x) => `${x.date}/${x.name}`)
            .join(", ")}`,
        );
      } else {
        const list = listGroupFiles(groupKey, 45).slice(0, 5);
        if (list.length) {
          const block = list.map((x) => `- ${x.date} ${x.t} ${x.name}（${x.len} 字）`).join("\n");
          parts.push(`[群里最近的文件清单（只有名字，没有正文；别猜里面写了什么）]\n${block}`);
          diagLog(`[qq ${account.appId}] 群文件只给清单 ${list.length} 个`);
        } else if (asksFile) {
          parts.push(`[群里还没有解析成功的文件]`);
        }
      }
      if (parts.length) {
        const tail = inWindowChat
          ? `[群里在接你刚才的话题（没有 @ 你）]\n${pretty}`
          : `[刚刚 @你 的消息]\n${pretty}`;
        modelText = `${inWindowChat ? `[话题窗口] 你刚在群里开了一个话题，这是群友的接话。顺着聊，别客套，也别每句反问。\n\n` : ""}${parts.join(
          "\n\n",
        )}\n\n${tail}`;
      } else {
        modelText = inWindowChat
          ? `[话题窗口] 你刚在群里开了一个话题，这是群友的接话。顺着聊，别客套，也别每句反问。\n\n${pretty}`
          : pretty;
        diagLog(`[qq ${account.appId}] 无新增上下文、无日记忆命中，只带本条`);
      }
    }
    diagLog(`[qq ${account.appId}] 收到消息 ${scope} from=${senderId} text="${text.slice(0, 40)}"`);
    Promise.resolve(onMessage(modelText, peerKey, msg.replyTarget, msg, bot)).catch((err) => {
      diagLog(`[qq ${account.appId}] onMessage 失败: ${String(err)}`);
    });
  };

  const handleReady = () => {
    attempt = 0; // 连上了就重置退避计数
    diagLog(`[qq ${account.appId}] bot ready`);
  };

  bot.on("message", handleMessage);
  // 诊断：把网关收到的每一个 dispatch 事件类型都写进日志（含群事件、机器人增删群）。
  // 用于区分“平台没推事件”和“我们收到了但没处理”。
  bot.on("rawEvent", (ctx) => {
    try {
      diagLog(`[qq ${account.appId}] RAW ${ctx && ctx.eventType}`);
    } catch {}
  });
  bot.on("ready", handleReady);
  bot.on("resumed", handleReady);
  bot.on("error", (err) => {
    diagLog(`[qq ${account.appId}] bot error: ${err.message}`);
  });

  // 注意：bot.start() 的 promise 要等 WebSocket 断开才 resolve（长连接语义），
  // 不能 await——后台跑，用 ready 事件（带超时）确认启动成功。
  // 断开或启动失败后自动重连（指数退避 30s→60s→120s→240s→上限 5min），
  // 否则启动瞬间一次网络抖动就会导致永久掉线（实测重启时必现）。
  let stopped = false;
  let attempt = 0;
  abortSignal?.addEventListener("abort", () => {
    stopped = true;
  }, { once: true });
  const connect = () => {
    if (stopped) return;
    attempt += 1;
    bot
      .start()
      .catch((err) => {
        diagLog(`[qq ${account.appId}] start() 结束（连接断开）: ${String(err)}`);
      })
      .finally(() => {
        if (stopped) return;
        const delay = Math.min(30_000 * 2 ** Math.min(attempt - 1, 4), 5 * 60_000);
        diagLog(`[qq ${account.appId}] ${Math.round(delay / 1000)} 秒后第 ${attempt + 1} 次重连`);
        setTimeout(() => {
          if (!stopped) connect();
        }, delay);
      });
  };
  connect();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      diagLog(`[qq ${account.appId}] 等待 ready/resumed 超时（15s），继续运行`);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      resolve();
    }, 15_000);
    const onReady = () => {
      clearTimeout(timer);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      resolve();
    };
    const onError = (err) => {
      clearTimeout(timer);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      reject(err);
    };
    bot.on("ready", onReady);
    bot.on("resumed", onReady);
    bot.on("error", onError);
  });

  // 返回 bot 实例（供主动推送；stop 由实例自带，startQqBots 的 stops 数组另行收集）
  return bot;
}

/**
 * QQ markdown 预处理：QQ 官方 markdown 支持 标题/加粗/斜体/删除线/链接/列表/引用/分割线/图片，
 * 但代码块/行内代码/表格不支持——降级为文本样式（代码→【代码】、行内码去反引号、表格转对齐文本）。
 */
export function mdForQq(md) {
  return String(md || "")
    .replace(/\`\`\`[a-zA-Z0-9]*\n([\s\S]*?)\`\`\`/g, "【代码】\n$1")
    .replace(/\`([^\`\n]+)\`/g, "$1");
}

/** 发一条文本消息回复（markdown 自动）。群聊里发出后同时记进「原文」。 */
export async function sendQqText(bot, replyTarget, text) {
  await bot.sendText(replyTarget, mdForQq(text), { msgId: replyTarget?.msgId });
  // 平台不会把机器人自己的消息推回来，这里补记一笔，让原文/日记能看到“她说过什么”
  try {
    if (replyTarget?.scope === "group" && replyTarget?.targetId) {
      const gk = String(replyTarget.targetId);
      const line = String(text || "").replace(/\s*\n\s*/g, " ").slice(0, 300);
      if (line.trim()) {
        rememberGroupLine(gk, tsParts().hhmm, "小酥鱼", line);
        diagLog(`[qq] 自己的发言已记入原文 ${gk.slice(0, 8)}…: "${line.slice(0, 30)}"`);
      }
    }
  } catch (e) {
    diagLog(`[qq] 记自己的发言失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 启动所有已配置 QQ 账户。
 * @returns {Promise<{bots: Map<string, QQBot>, stop: () => void}>}
 */
export async function startQqBots({ onMessage, abortSignal }) {
  const accounts = listQqAccounts();
  const bots = new Map();
  const stops = [];

  for (const account of accounts) {
    try {
      const bot = await startQqBotAccount(account, { onMessage, abortSignal });
      bots.set(account.appId, bot);
      stops.push(() => bot.stop?.().catch?.(() => {}));
      diagLog(`[qq] 账户 ${account.appId} 已启动`);
    } catch (err) {
      diagLog(`[qq] 账户 ${account.appId} 启动失败: ${String(err)}`);
    }
  }

  return {
    bots,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
