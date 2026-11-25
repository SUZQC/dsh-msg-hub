# PATCHES · 本 fork 相对上游 0.1.11 的改动

> 上游：`AbcdefgXW/dsh-msg-hub@0.1.11`（2026-09-18 发布，之后无更新）
> 这个 fork 先服务一处私有部署（Windows + DSH 0.2.2 + QQ 官方机器人），所以分成两类：
> **A 类**是上游应当修的问题（可直接提 PR），**B 类**是本地能力（上游不一定收）。
> 拆成两个 commit：`fix:` = A 类，`feat:` = B 类。

---

## A 类 · 上游应当修（可提 PR）

| # | 位置 | 问题 | 改法 |
|---|---|---|---|
| A1 | `lib/bridge.js` `lib/media.js` | `WORKSPACE_CWD` 默认 `/workspace`，Windows 上不存在，启动报 `working-directory does not exist` | 默认值改成配置出来（本 fork 直接写死本机工作区，可用 `DSH_CHANNELS_CWD` 覆盖）。上游建议改成 `os.homedir()` 下的目录或强制要求配置 |
| A2 | `lib/bridge.js` `createBridge()` | 把 `defaultModel.currentSelection()` 原样塞进 agentOptions；DSH 0.2.x 在 step 准备后再提 `reasoningEffort` 会直接抛错（上游只声明兼容 0.1.x） | 组装前剥离该字段 |
| A3 | `index.js` | 同一条群 @ 会以 `GROUP_AT_MESSAGE_CREATE` 和 `GROUP_MESSAGE_CREATE` 各推一次 → 回复两遍 | 会话 + 内容 3 秒窗口去重（`qqRecentMessages`） |
| A4 | `lib/qq/adapter.js` `handleMessage` | 平台把 mention 剥掉后 `content` 是空串，原代码 `if (!text) return` → **@ 机器人完全没反应** | 空内容时先判 `mentions[].is_you`/mention id，是 @ 就回一句固定话术（不进模型） |
| A5 | `lib/qq/adapter.js` 发送者解析 | 只取 `author.username`，该字段有时为空 → 退化成 openid，看起来“没有发言人”；`author.member_nickname` 才是昵称 | 四级兜底：`member_nickname → username → senderName → openid 前 24 位` |
| A6 | `lib/qq/adapter.js` 入站内容 | QQ 表情以标签形式到达：`<faceType=1,faceId="344",ext="<base64>">`，`ext` 是 `{"text":"大怨种"}`。原样塞给模型，污染上下文和日志 | `normalizeQqMarkup()`：有 `ext` → `[表情:名]`，没有 → `[表情]` |
| A7 | `lib/qq/adapter.js` `sendQqText` | 平台不回推机器人自己发的消息 → 上游没有任何地方记录“机器人说了什么”，群聊记忆只有单边 | 发送成功后补一行 `- HH:MM <机器人名>: …` 到原文（多行压成一行，≤300 字） |
| A8 | `lib/qq/adapter.js` 群消息 | 全量群消息模式下没有任何可观测日志，分不清“平台没推”还是“推了没处理” | `rawEvent` 打每个 dispatch 事件类型；群消息打 `author=` 诊断行 |
| A9 | `lib/qq/adapter.js` 文件消息 | 文件消息 `content` 为空，附件永远不会被解析，用户问文件时模型只能编 | 下载附件 → 抽正文 → 落盘 → 只在被问时注入（见 B5） |
| A10 | `package.json` `engines` | 只声明 `peerDependencies: ^0.1.0-rc.6`，任何 `0.2.x` DSH 都不满足 → 插件显示“异常”、`enabled` 但根本不加载。`dsh.compatibility.dshReleases` 只是给人看的，加载器不读它（见 `dsh-app-boot/src/plugin-compatibility.ts`：`engines.dsh` 优先，没有才逐个查 dsh peers，`semver.satisfies(…, { includePrerelease: true })`） | 加 `"engines": { "dsh": "^0.2.2-rc.5" }`。`engines.dsh` 一旦存在就单独裁决，peers 不再参与；`^0.2.2-rc.5` 在 `includePrerelease` 下覆盖整个 `0.2.x`（含 rc.6、0.2.3-rc.1） |
| A11 | `lib/qq/adapter.js` `mdForQq` | QQ 文本消息不支持 markdown，原函数只处理代码块/行内码，`**粗体**`、`# 标题`、`- 列表`、`[文字](链接)` 原样出现在手机 QQ 上 | 统一降级成纯文本：标题去 `#`、列表→`·`、引用去 `>`、表格压成 `· a · b`、粗体/斜体/删除线去标记、链接保留「文字（url）」；群聊原文记录也改用清洗后的文本 |

> A9 是“功能缺失 + 会诱发编造”，修法牵涉较多本地约定（落盘路径、检索策略），整体放进了 B5。

## B 类 · 本地能力（上游不一定收）

| # | 能力 | 做法 |
|---|---|---|
| B1 | 群聊只读缓冲 | 非 @ 的群消息只记账：内存环形 60 条 + 落盘 `群聊\<gid>\原文\<日期>.md`；@ 时带最近 12 条进模型 |
| B2 | 群日记检索 | 日记压缩产物建 2-gram 索引（`索引\日记.jsonl`），@ 时命中片段注入，6 小时去重 |
| B3 | 话题窗口 | 机器人主动开话题后写 `_话题窗口.json`（30 分钟）；窗口内群友的接话按“闲聊”处理。读文件先剥 `\uFEFF`（PowerShell 会写 BOM） |
| B4 | 点名即接 | 触发条件：@ 机器人，或文本出现「小酥鱼/酥鱼」；引用**不算**触发（平台只给 `refMsgIdx`，判断不了引用对象） |
| B5 | 群文件解析与检索 | 附件下载（≤20MB）→ 抽正文（docx/xlsx/pptx/txt）→ 按天落盘 `文件\<日期>.jsonl`；跨天扫 45 天，四档命中（文件名 / 正文条目 / 指定日期 / 问文件）；**按条目切**（`01　…` 这类小标题，一条 = 事件内容 + 为什么值得关注，整条给，≤2000 字），没有条目结构才退回 900 字块；日期只当优先、空了退回全量；没命中只给文件清单；注入头带“只按这里写的说”防编造 |
| B6 | `[AI]` 标记 | 其他机器人发的消息标记为 `[AI] 名字`，让她自己判断要不要接 |
| B7 | 日报改从 Obsidian 仓库补 | 官方 Bot API 不给机器人发的文件 url（`attachments[].url` 是空串），也没有任何“拉群文件”的接口 → `scripts/obsidian-daily.mjs` 从 vault 私有库取：`--filter=blob:none --sparse` 只检出 `日报/`（实测整库 344MB，这样只有 1MB），按上次 sha 做 `git diff … -- 日报/` 增量，日期优先取文件名前缀 `2026.11.25-`（归档会一次补几天，提交时间会失真），没有才用提交时间；抽正文写 `文件\<日期>.jsonl`（多一个 `src` 字段存仓库相对路径），原件另存 `文件\日报\<年>\<月>\<日期>_<原文件名>`；幂等，可重复跑；GitHub 被 hosts 指到 127.0.0.1，所以支持 `OBSIDIAN_HTTP_PROXY` 走本地代理 |

## 部署特定值（换环境要改）

| 值 | 现在 | 覆盖方式 |
|---|---|---|
| 工作区 | `E:\DS House\workspace` | 环境变量 `DSH_CHANNELS_CWD` |
| 群聊记忆根 | `<工作区>\群聊` | 环境变量 `DSH_GROUP_LOG_DIR` |
| 机器人 mention id | 固定值（从群消息里观察来的） | 环境变量 `DSH_QQ_BOT_MENTION_ID`；换应用/换群要重新从日志里读 `<@…>` |
| 群目录名 | `groupOpenid` | 无需改 |

## 怎么验

1. `node --check lib/qq/adapter.js`；
2. 启动后 `gateway READY` / `bot ready`；
3. 群里不 @ 说一句 → 只出现 `[只读] group …`；
4. @ 或打字叫名字 → 回复，且日志有 `全量消息 → @我/点名`；
5. 发个 `.docx` → `文件已解析 … 字`；问「日报里讲什么」→ `群文件命中(name)`，回答不超出正文；
6. 发个 QQ 表情 → 原文是 `[表情:名]`；
7. `node scripts/obsidian-daily.mjs --dry-run` → 列出今天会处理哪些日报，不动盘。

## 已知限制

- 引用别人的消息无法判断引用对象（平台限制），所以引用不触发；
- 附件只解析 docx/xlsx/pptx/txt（PDF/OCR 未做）；
- 群聊 agent 没有文件工具，检索只能在 adapter 里做（要“她自己搜”得单独开只读工具）。
