#!/usr/bin/env node
/**
 * obsidian-daily.mjs — 从 Obsidian vault（GitHub 私有库）拉日报，解析后落进群文件库
 *
 * 背景：QQ 群里的日报文件由别的机器人发送，官方 Bot API 不给附件 url（events 里
 * `attachments[].url` 是空串，且没有任何“拉群文件”的接口），所以下载不到。
 * 那个机器人会把日报同步进 Obsidian 仓库并 push，于是改从 Git 取：内容一致，
 * 还能拿到提交时间当日期。
 *
 * 仓库可能有 300MB+，但日报只占一个目录，所以用部分克隆：
 *   git clone --filter=blob:none --sparse <repo> <dir>
 *   git sparse-checkout set 日报
 * 这样工作区只检出 日报/，每次 pull 只补当天新增的 blob，别的笔记一份都不落盘。
 *
 * 落盘位置（与 adapter 的 rememberGroupFile 同一个仓）：
 *   群聊/<群openid>/文件/<YYYY-MM-DD>.jsonl      每行 {t,name,src,len,body}
 *   群聊/<群openid>/文件/日报/<YYYY>/<MM>/<YYYY-MM-DD>_<原文件名>   原件副本
 *
 * 用法：
 *   node scripts/obsidian-daily.mjs            # 拉取并入库
 *   node scripts/obsidian-daily.mjs --dry-run  # 只列出会处理哪些文件
 *
 * 环境变量（都有默认值）：
 *   OBSIDIAN_REPO      仓库地址，默认 https://github.com/SUZQC/obsidian-vault.git
 *   OBSIDIAN_CLONE     克隆目录，默认 E:\DS House\cache\obsidian-vault
 *   OBSIDIAN_SPARSE    稀疏检出目录，默认 日报
 *   OBSIDIAN_GROUP_KEY 群 openid，默认 73E78B1AB6363FDAA3A687F4E52D09A5
 *   OBSIDIAN_SINCE_DAYS 首次运行回溯天数，默认 7
 *   DSH_GROUP_LOG_DIR  群聊根目录，默认 E:\DS House\workspace\群聊
 *   DSH_PYTHON_EXE     抽正文用的 Python，默认 DSH 自带运行时
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const CFG = {
  repo: process.env.OBSIDIAN_REPO?.trim() || "https://github.com/SUZQC/obsidian-vault.git",
  clone: process.env.OBSIDIAN_CLONE?.trim() || path.join("E:", "DS House", "cache", "obsidian-vault"),
  sparse: (process.env.OBSIDIAN_SPARSE?.trim() || "日报").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
  groupKey: process.env.OBSIDIAN_GROUP_KEY?.trim() || "73E78B1AB6363FDAA3A687F4E52D09A5",
  groupRoot: process.env.DSH_GROUP_LOG_DIR?.trim() || path.join("E:", "DS House", "workspace", "群聊"),
  sinceDays: Math.max(1, Number(process.env.OBSIDIAN_SINCE_DAYS) || 7),
  python:
    process.env.DSH_PYTHON_EXE?.trim() ||
    path.join(
      process.env.USERPROFILE || "C:\\Users\\10640",
      ".dsh",
      "dsh-runtimes",
      "dsh-primary-runtime",
      "dependencies",
      "python",
      "python.exe",
    ),
};

const STATE_FILE = `${CFG.clone}.state.json`;
// GitHub 在这台机器上被 hosts 指到 127.0.0.1，只能走本地代理：
// CONNECT 由代理自己解析域名，不碰 hosts。没设代理时保持原样（直连）。
const PROXY =
  process.env.OBSIDIAN_HTTP_PROXY?.trim() ||
  process.env.HTTPS_PROXY?.trim() ||
  process.env.HTTP_PROXY?.trim() ||
  "";
const EXTRACT_EXTS = new Set([".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".json"]);
const MAX_BYTES = 20 * 1024 * 1024; // 与 adapter 的 FILE_MAX_BYTES 一致
const BODY_LIMIT = 20000; // 与 rememberGroupFile 一致
const DRY_RUN = process.argv.includes("--dry-run");
// 补历史时绕开“今天的完成标记”检查
const IGNORE_DONE = process.env.OBSIDIAN_IGNORE_DONE === "1" || process.argv.includes("--ignore-done");

// ── 小工具 ──────────────────────────────────────────────────

function log(msg) {
  console.log(`[obsidian-daily] ${msg}`);
}

function die(msg) {
  console.error(`[obsidian-daily] 失败：${msg}`);
  process.exit(1);
}

/** 跑 git：禁掉交互提示（定时任务里不能弹认证窗），中文路径不转义 */
function git(args, { cwd = CFG.clone, timeout = 120_000 } = {}) {
  const proxyArgs = PROXY ? ["-c", `http.proxy=${PROXY}`] : [];
  const res = spawnSync("git", ["-c", "core.quotepath=false", ...proxyArgs, ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_LFS_SKIP_SMUDGE: "1",
    },
  });
  return {
    ok: res.status === 0,
    out: String(res.stdout ?? "").trim(),
    err: String(res.stderr ?? "").trim(),
    status: res.status,
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** "2026-11-25T21:05:12+08:00" → { date: "2026-11-25", hhmm: "21:05" }（按本地时区） */
function stampOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// ── 抽正文（复用 adapter 的 Python 抽取，失败返回空串）─────────
let extractor = null;

async function loadExtractor() {
  if (extractor) return extractor;
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, "lib", "qq", "adapter.js")).href);
  extractor = mod.extractFileText;
  return extractor;
}

// ── 仓库 ────────────────────────────────────────────────────

function ensureRepo() {
  const isRepo = fs.existsSync(path.join(CFG.clone, ".git"));

  if (!isRepo) {
    if (DRY_RUN) {
      log(`[dry-run] 会克隆 ${CFG.repo} → ${CFG.clone}`);
      return { cloned: true, changed: 0 };
    }
    fs.mkdirSync(path.dirname(CFG.clone), { recursive: true });
    log(`首次克隆（blob 过滤 + 稀疏）：${CFG.repo}`);
    const r = git(
      ["clone", "--filter=blob:none", "--sparse", CFG.repo, CFG.clone],
      { cwd: path.dirname(CFG.clone), timeout: 600_000 },
    );
    if (!r.ok) {
      die(
        `克隆失败：${r.err || r.status}\n` +
          `  私有库需要凭据：git config --global credential.helper manager，然后手动 clone 一次输入 token；\n` +
          `  或直接设置 OBSIDIAN_REPO=https://<token>@github.com/...（不推荐，token 会留在 .git/config）。`,
      );
    }
  } else {
    if (DRY_RUN) {
      log(`[dry-run] 会 git pull --ff-only（${CFG.clone}）`);
      return { cloned: false, changed: 0 };
    }
    const r = git(["pull", "--ff-only", "--quiet"]);
    if (!r.ok) die(`git pull 失败：${r.err || r.status}`);
  }

  // 稀疏范围始终锁在日报目录：别的笔记不落盘、也进不了解析
  const sparseNow = fs.existsSync(CFG.clone)
    ? git(["sparse-checkout", "list"]).out.split(/\r?\n/).map((s) => s.replace(/\/$/, "")).filter(Boolean)
    : [];
  if (!sparseNow.includes(CFG.sparse)) {
    const r = git(["sparse-checkout", "set", CFG.sparse]);
    if (!r.ok) die(`sparse-checkout 设置失败：${r.err || r.status}`);
    log(`稀疏检出已限定为 ${CFG.sparse}/`);
  }
  return { cloned: !isRepo, changed: 0 };
}

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (st && typeof st.sha === "string" && st.sha) return st;
  } catch {}
  return null;
}

function writeState(head) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ sha: head, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

/** 本次要处理的仓库相对路径（只认 日报/ 前缀） */
function changedPaths() {
  const head = git(["rev-parse", "HEAD"]).out;
  if (!head) die("读不到 HEAD");
  const state = readState();
  const scope = `-- ${CFG.sparse}/`;

  if (state?.sha && git(["cat-file", "-e", `${state.sha}^{commit}`]).ok) {
    // 增量：上次处理到的 sha..HEAD，只看日报目录
    const r = git(["diff", "--name-only", "--diff-filter=AMR", `${state.sha}..${head}`, "--", `${CFG.sparse}/`]);
    if (!r.ok) die(`git diff 失败：${r.err || r.status}`);
    return { head, files: r.out ? r.out.split(/\r?\n/).filter(Boolean) : [], base: state.sha };
  }

  // 首次运行：回溯 N 天，取这段时间里被动过的文件（避免把全部历史日报都灌进去）
  const since = new Date(Date.now() - CFG.sinceDays * 86400_000).toISOString();
  const r = git([
    "log",
    `--since=${since}`,
    "--name-only",
    "--diff-filter=AMR",
    "--format=",
    "--",
    `${CFG.sparse}/`,
  ]);
  if (!r.ok) die(`git log 失败：${r.err || r.status}`);
  const files = [...new Set(r.out.split(/\r?\n/).filter(Boolean))];
  log(`首次运行：回溯 ${CFG.sinceDays} 天，命中 ${files.length} 个文件`);
  return { head, files, base: null };
}

/** 文件最后一次提交的时间：{ date, hhmm } */
function fileStamp(relPath) {
  const iso = git(["log", "-1", "--format=%cI", "--", relPath]).out;
  return stampOf(iso);
}

/**
 * 文件名开头的日期优先：`2026.11.22-AI 日报.md` → 2026-11-22。
 * 归档会补录前几天的日报（一个提交里带 3 天），这时提交时间≠报告日期，
 * 所以有前缀就用前缀，没有才退回提交时间。
 */
function dateFromName(base) {
  const m = String(base).match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// ── 落盘 ────────────────────────────────────────────────────

function groupFileDir() {
  return path.join(CFG.groupRoot, CFG.groupKey, "文件");
}

function jsonlPath(date) {
  return path.join(groupFileDir(), `${date}.jsonl`);
}

/** 已有记录（按 src 去重，保证可重复跑） */
function existingSrcs(date) {
  const f = jsonlPath(date);
  const out = new Set();
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.src === "string" && row.src) out.add(row.src);
      else if (row && row.name) out.add(`name:${row.name}`);
    } catch {}
  }
  return out;
}

function appendRecord(date, row) {
  const f = jsonlPath(date);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(row) + "\n", "utf8");
}

/** 原件副本：文件/日报/<年>/<月>/<YYYY-MM-DD>_<原名> */
function archiveOriginal(date, relPath, srcFile) {
  const [y, m] = date.split("-");
  const dir = path.join(groupFileDir(), "日报", y, m);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${date}_${path.basename(relPath)}`);
  if (!fs.existsSync(dest)) fs.copyFileSync(srcFile, dest);
  return dest;
}

// ── 主流程 ──────────────────────────────────────────────────

async function main() {
  log(`仓库 ${CFG.repo}`);
  log(`克隆 ${CFG.clone}｜稀疏 ${CFG.sparse}/｜群 ${CFG.groupKey.slice(0, 8)}…`);
  if (PROXY) log(`代理 ${PROXY}`);

  const { cloned } = ensureRepo();

  // 上游 21:00 启动、等文档最多 45 分钟，所以完成时间会浮动。
  // 上游在同一次 commit 里写 日报/YYYY/MM/.done-YYYY.MM.DD，见到它才算今天齐了。
  if (!IGNORE_DONE) {
    const d = new Date();
    const y = String(d.getFullYear());
    const mo = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const markerRel = `${CFG.sparse}/${y}/${mo}/.done-${y}.${mo}.${day}`;
    const markerAbs = path.join(CFG.clone, ...markerRel.split("/"));
    if (!fs.existsSync(markerAbs)) {
      log(`今天的完成标记还没出现：${markerRel}`);
      log("上游可能还在等文档（最多 45 分钟），本次退出，交给外层 10 分钟后再试");
      process.exit(2);
    }
  }

  const { head, files } = changedPaths();

  if (files.length === 0) {
    log(`没有新日报（HEAD ${head.slice(0, 8)}）`);
    if (!DRY_RUN) writeState(head);
    return;
  }

  const extract = await loadExtractor();
  let done = 0;
  let skipped = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const base = path.basename(rel);
    if (!EXTRACT_EXTS.has(ext) || base.startsWith("~$")) {
      skipped += 1;
      continue;
    }

    const abs = path.join(CFG.clone, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      log(`跳过（工作区没有这个文件）：${rel}`);
      skipped += 1;
      continue;
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_BYTES) {
      log(`跳过（超过 20MB）：${rel}`);
      skipped += 1;
      continue;
    }

    const stamp = fileStamp(rel);
    if (!stamp) {
      log(`跳过（读不到提交时间）：${rel}`);
      skipped += 1;
      continue;
    }

    // 日期优先取文件名前缀（补录时提交时间会失真），没有才用提交时间
    const date = dateFromName(base) || stamp.date;

    if (existingSrcs(date).has(rel)) {
      log(`已入库，跳过：${date} ${base}`);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      log(`[dry-run] ${date} ${stamp.hhmm} 会处理：${rel}`);
      done += 1;
      continue;
    }

    const body = await extract(abs);
    if (!body) {
      log(`未解析出正文（原件仍会归档）：${rel}`);
    }
    const orig = archiveOriginal(date, rel, abs);
    appendRecord(date, {
      t: stamp.hhmm,
      name: base,
      src: rel,
      len: body.length,
      body: body.slice(0, BODY_LIMIT),
    });
    log(`入库：${stamp.date} ${base}｜${body.length} 字｜原件 → ${orig}`);
    done += 1;
  }

  if (!DRY_RUN) writeState(head);
  log(`完成：新增 ${done}，跳过 ${skipped}${cloned ? "（本次含首次克隆）" : ""}`);
}

main().catch((e) => die(e?.stack || String(e)));
