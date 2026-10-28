# Agent Dashboard · 扫描层 + 只读 API + 可视化面板

本机装了哪些 Agent（Claude Code / Codex / Trae CN）、各自有哪些 skill 和 MCP、这些会话烧了多少 token 和钱——这些信息散落在十几个 JSON / TOML / JSONL 文件里。这个项目把它们归一化成一份统一视图，并暴露成本地只读 HTTP API，附带一个零依赖的可视化面板。

**当前进度：扫描层 + API + 四个前端视图已完成（含测试）。**

- 零依赖：只用 Node 内置模块（`node:http`、`node:fs`），没有构建步骤，不需要 `npm install`
- 只读：不修改任何 Agent 的配置和日志
- 增量：按字节偏移解析日志，第二次扫描只读新增部分（本机 67 个会话文件全量 1.5s，增量 ~0.7s）
- 不伪造数据：拿不到单价就返回 `null`，不写 0；平台不写日志就明确标 `usageAvailable: false`

## 快速开始

要求 Node ≥ 20（本机 22.12 实测）。

```bash
npm start                    # 一键：按需扫描 → 起服务 → 就绪后自动开浏览器
npm run scan                 # 增量扫描 + 打印人读摘要
npm run scan -- --full       # 清空索引后全量重扫
npm run scan:json            # 输出完整 snapshot JSON（前端/管道用）
npm run serve                # 只起服务：打开 http://127.0.0.1:7788
npm test                     # 26 个测试：纯函数 / 扫描层 / HTTP 接口
```

Windows 下也可以直接**双击根目录的 `start.bat`**（内部调用 `node scripts/start.mjs`，找不到 Node 会提示安装）。需要参数时在 cmd 里跑，脚本直接读参数：

```text
start.bat [--no-open] [--port 7799] [--full] [--help]
node scripts/start.mjs [--no-open] [--port 7799] [--full] [--help]
```

- 首次运行（没有 `data/index.json`）会自动全量扫描一次；平时直接启动，不会重复扫
- 服务就绪（`/api/health` 返回 ok）后才开浏览器；端口上已经有本面板在跑时不重复启动，直接开浏览器
- `--no-open` 只起服务、不弹浏览器；`--full` 启动前重扫；`Ctrl+C` 干净停止
- 忘记参数就 `node scripts/start.mjs --help`（注意 PowerShell 会吞掉 `npm start --` 后面的参数，带参数请用上面两种写法）

服务起好后浏览器打开 **http://127.0.0.1:7788** 即是面板；页面右上角「重新扫描」等价于 `POST /api/scan`，不用重启服务。`/api` 会列出所有端点。

本机实测结果（2026-10-26）：

```
Claude Code 2.1.300  · 29 skill · 0 MCP · 中转站 http://127.0.0.1:15721
Codex               ·  5 skill · 2 MCP · https://ahhilai.top/v1
Trae CN 1.107.1     · 68 skill · 6 MCP（含 4 个平台内置工具集）

3058 条用量事实 · 520.52M token · 缓存命中率 90.3%
自算成本 $559.13 · 平台上报成本（Claude cost-state）$646.90 · 比值 0.86
```

## 数据源

全部只读，路径都通过环境变量可覆盖（见文末）。

| 平台 | Agent / 版本 | Skill | MCP | 用量日志 | 平台上报成本 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/`、`claude --version`；provider 取 `settings.json` 的 `ANTHROPIC_BASE_URL` | `~/.claude/skills`、`plugins/{marketplaces,cache}`、`commands`、`agents` | `~/.claude.json` 的 `mcpServers` + `projects[cwd].mcpServers`（含 `disabledMcpServers`）+ 项目里 `.mcp.json`；`settings.json` | `~/.claude/projects/**/*.jsonl` 的 `assistant.message.usage` | 同一批文件里的 `cost-state`（每会话最后一条累计快照） |
| Codex | `~/.codex/config.toml`（`model_provider` / `model`） | `~/.codex/skills`（`.system` 记为内置）、`plugins` | `config.toml` 的 `[mcp_servers.*]` | `~/.codex/sessions/**/rollout-*.jsonl` 的 `token_usage_record` | 无 |
| Trae CN | `~/.trae-cn/`、`%LOCALAPPDATA%\Programs\Trae CN\...\package.json` | `skills`、`builtin_skills`、`plugins/<registry>/<plugin>/<ver>/skills`，应用 `skill-config.json` 的禁用/删除状态 | `%APPDATA%\Trae*\User\mcp.json` + `~/.trae-cn/mcps/**/tools/*.json` 运行时缓存（数工具数） | **无本地 token 日志** | 无 |

## 目录结构

```
start.bat                Windows 双击启动（调用 scripts/start.mjs）
scripts/
  start.mjs              一键启动：按需扫描 → 起服务 → 健康检查 → 打开浏览器
public/
  index.html             单页骨骼（4 个 view + SVG 图标 sprite）
  styles.css             设计令牌与全部组件样式（含响应式与 reduced-motion）
  app.js                 路由 / 渲染 / 手写 SVG 折线图 / 客户端筛选
  favicon.svg
src/
  config.js              路径与端口（全部可用 DASH_* 环境变量覆盖）
  scan.js                扫描编排 + 事实表持久化 + 聚合（day/model/agent/project）
  server.js              只读 HTTP API + 静态托管（node:http）
  cli.js                 命令行摘要
  adapters/
    claude.js  codex.js  trae.js   统一接口：detect / listSkills / listMcps / readUsage
  lib/
    fsx.js               安全读写、BFS 遍历、append-only JSONL 增量读取
    frontmatter.js       极简 YAML frontmatter（SKILL.md 用）
    toml.js              极简 TOML（Codex config.toml 用）
    pricing.js           单价解析 + 最小二乘反推 + 成本计算
    mask.js              密钥脱敏（env / headers / url / MCP 启动参数）
    version.js           CLI 版本探测（带超时）
test/
  lib.test.js            纯函数单测
  scan.test.js           fixture 目录跑真实扫描：去重、增量、成本、对账
  api.test.js            起真实服务进程打所有端点 + 静态资源/路径穿越
  helpers/fixture.js     测试用最小数据集
data/                   运行时生成（已 gitignore）
  index.json             每个日志文件读到哪个字节 + 平台上报成本
  facts.ndjson           用量事实表（append-only，同 key 后写覆盖）
pricing.json            单价表（可手改）
```

## 归一化模型

**Agent**：`id, label, installed, home, version, provider, models, configFiles, usageAvailable, usageNote`

**Skill**：`id, agent, name, description, type(skill|command|agent), source(user|builtin|plugin|marketplace), namespace, version, enabled, path, usageCount?, lastUsedAt?`
→ 同名 skill 跨平台会聚成 `skillMatrix` 的一行，便于看"哪些 skill 三个平台都有"。

**MCP**：`id, agent, name, scope(user|project|runtime-cache|builtin), transport(stdio|sse|http), command, args, url, env, headers, enabled(true|false|null), toolCount, tools?, sourcePath`
→ `scope=builtin` 是平台内置工具集（如 Trae 的 `integrated_*`），默认从列表和 CLI 里隐藏。`enabled=null` 表示只能从运行时缓存看到、配置里已无记录。

**用量事实**：`key, agent, ts, model, input, output, cacheRead, cacheWrite, sessionId, cwd, subagent, sourceFile`
→ 成本不在事实里写死，而是聚合时按当前 `pricing.json` 现算，方便随时改单价重估。

## 增量与去重

- `data/index.json` 记录每个日志文件的字节偏移；`readNewLines` 只消费以 `\n` 结尾的完整行，文件被截断则自动从头读。
- Claude 的一个 API 响应会被写成 2~15 条 `assistant` 记录：首条是流式中间态（`output=0`、无 cache），其余是同一份最终 usage 的重复写入。因此事实键是 `claude:<sessionId>:<message.id>`，同键只保留 **token 总量最大** 的一条（`scan.js` 的 `emitFact` 做 upsert）。不做这一步会虚高约 2.2 倍。
- 0 token 的 `<synthetic>` 记录直接跳过，避免出现一行 $0 的假模型。
- 子代理（`subagents/agent-*.jsonl`、`isSidechain`）的用量会归到同一会话下。

## 成本模型

```
costUSD = (input + cacheRead × 0.1 + cacheWrite × 1.25) × priceIn / 1e6
        + output × priceOut / 1e6
```

单价按优先级解析，`priceSource` 会跟着每一行返回：

1. `table`：`pricing.json` 的 `models` 里显式写的；
2. `derived`：用 Claude `cost-state` 的 (tokens, costUSD) 样本做二元最小二乘反推（≥3 个样本，解出的单价需落在 (0, 2000] 内）；
3. `default`：`pricing.json` 的兜底价（适合"中转站对所有模型统一定价"的情况）；
4. `unknown`：都没有 → `costUSD: null`，聚合里计入 `unknownCostTokens`，前端应显示"未配置单价"。

本机 `pricing.json` 只有兜底价 `$5 / $25`，因为实测这台机器的中转站对 `claude-opus-5`、`gpt-6.1-sol[1m]`、`qwen3.8-max[1m]` 等**所有**模型都按 $5/M 输入、$25/M 输出计费（缓存读 $0.5、缓存写 $6.25），三者的 `cost-state` 金额都能被这个公式精确复现。换中转站或官方 API 时改这里即可。

## 前端面板

`public/` 是纯静态单页：原生 ESM + 手写 SVG，无框架、无图表库、无构建。

| 视图 | 路由 | 内容 |
| --- | --- | --- |
| 总览 | `#/overview` | 各平台安装状态与版本、skill/MCP/token 计数、总 token / 自算成本 / 上报成本 / 缓存命中率 / 记录数 KPI、近 30 天用量趋势（可切 token/成本）、模型成本 Top 5、项目 Top 5、口径说明 |
| 模型开销 | `#/cost` | 时间窗（7/30/90/全部）与平台筛选、按模型拆 9 列（含占比条与单价来源）、成本对账（自算 vs 平台账单 + 四维比值）、单价来源与反推表、按平台/按项目分摊、每日成本曲线 |
| Skill 矩阵 | `#/skills` | 同名 skill 跨平台矩阵（搜名称/描述/命名空间、按平台/来源/禁用/仅跨平台筛选），点一行在右侧看每个实例的路径、来源、启用状态、使用次数 |
| MCP 清单 | `#/mcps` | MCP 卡片（transport、scope、工具数、启动命令/URL、脱敏后的 env/headers），默认隐藏平台内置工具集，可切换显示 |

实现要点：

- 首屏只打 `GET /api/snapshot`；成本视图再按时间窗打 `GET /api/usage/summary`，筛选全部在客户端完成
- 折线图为手写 SVG：悬停十字线 + tooltip，聚焦后可用 `←/→` 逐日查看、`Esc` 关闭；每张图下方都有「查看每日数据表」兜底
- 所有来自文件的内容都经 `esc()` 转义；窗口 resize 时才重绘图表（180ms 防抖）
- 响应式：1440 / 1024 / 768 / 375 四档验证；窄屏下侧栏变成顶部横向 tab，宽表格保留可读列宽并横向滚动，矩阵有「可横向滚动」提示
- 可见焦点、`aria-current` / `aria-pressed` / `aria-selected` 状态、`prefers-reduced-motion` 降级，深色 slate + 绿色强调，正文对比度 ≥ 4.5:1

## API

响应统一包络 `{ ok, data, meta }`，只监听 `127.0.0.1`，`cache-control: no-store`，允许跨域（方便本地前端直接 fetch）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/snapshot?refresh=1` | 全量快照（前端首屏一个请求搞定） |
| GET | `/api/agents` | Agent 列表，附带 `skillCount / mcpCount / tokens / costUSD` |
| GET | `/api/skills?agent=&source=&enabled=1\|0&q=` | Skill 列表，`meta` 里有按平台/来源的计数 |
| GET | `/api/skills/matrix` | 同名 skill 跨平台矩阵 |
| GET | `/api/mcps?agent=&scope=&q=&includeBuiltin=1` | MCP 列表，默认隐藏平台内置工具集 |
| GET | `/api/usage` | 用量总览（totals + reported + reconciliation） |
| GET | `/api/usage?groupBy=day\|model\|agent\|project&from=&to=&agent=` | 分组明细；带过滤条件时用事实表重算，口径一致 |
| GET | `/api/usage/summary?from=&to=&agent=` | 带时间窗的完整汇总 |
| GET | `/api/pricing` | 当前生效的单价（含反推结果） |
| POST | `/api/scan?full=1` | 强制重扫（`full=1` 清空索引）；返回事实数与耗时 |

`from` / `to` 支持 `YYYY-MM-DD` 或 epoch 毫秒，`to` 按当天 23:59:59.999 处理。

```js
// GET /api/usage/summary 的关键字段
{
  totals: { input, output, cacheRead, cacheWrite, totalTokens, costUSD, unknownCostTokens, records, cacheHitRate },
  reported: { costUSD, sessions, tokens: {…}, byModel: [...] },   // Claude cost-state 口径
  reconciliation: { computedCostUSD, reportedCostUSD, ratio, note },
  byDay: [...], byModel: [...], byAgent: [...], byProject: [...],
  priceStatus: [...]                                              // 每个模型的单价来源与 token 量
}
```

### 脱敏

任何进入 API 的 `env` / `headers` / `url` / MCP `args` 都会先过 `lib/mask.js`：

- key 名命中 `key|token|secret|passw|credential|auth|cookie|bearer|private` 的值一律变成 `***` + 末 4 位；
- key 名不含敏感词时，只对"明确像密钥"的值兜底打码（`sk-`、`ghp_`、`AKIA`、`xoxb-`、JWT 前缀，或长度 ≥32 且大小写数字符号混排）；
- 路径、命令行、版本号、`window.location` 这类正常内容保持可读（否则面板没法看）；
- URL 里名字可疑的 query 参数替换成 `***`；
- MCP 启动参数里的 `--api-key=xxx`、`--token xxx` 形式只打码值，命令与路径保留。

测试里会断言快照序列化后不含任何明文密钥。

## 成本对账（为什么自算是 $559 而平台是 $647）

| 口径 | input | output | cacheRead | cacheWrite | 成本 |
| --- | --- | --- | --- | --- | --- |
| 本工具（去重后，含 Codex） | 49.92M | 2.63M | 466.27M | 1.69M | $559.13 |
| Claude `cost-state` 上报（23 个会话） | 52.48M | 3.10M | 592.18M | 1.77M | $646.90 |
| 比值 | 0.95 | 0.85 | 0.79 | 0.96 | 0.86 |

上报金额本身与 $5/$25 公式**精确自洽**（按上报 token 复算 = $646.91），所以差异来自两侧口径：

- 日志里记录的是**实际服务的模型名**（如 `deepseek-flash`），`cost-state` 记录的是**请求的模型名**（如 `claude-opus-5`），两者按模型对不上，只能整体对比；
- `cost-state` 含重试/失败请求的计费，而失败的响应不一定落进 transcript；
- 单会话看，大部分会话比值在 0.9~1.0；个别会话（最大那一个）明显偏低，属于该会话日志与计费快照的覆盖差异。

结论：**自算成本用于趋势和分摊，平台上报成本用于"实际账单"**，两者都保留在 API 里（`totals.costUSD` vs `reported.costUSD`），前端展示时标注口径即可。`GET /api/usage/summary` 的 `reconciliation` 就是给前端做校验提示用的。

按时间窗查询时，上报成本用会话文件的 `mtime` 归入窗口（会话内金额按整段累计），这样 7 天视图不会拿"全部账单"去比"7 天自算"。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DASH_CLAUDE_HOME` | `~/.claude` | Claude 目录 |
| `DASH_CODEX_HOME` | `~/.codex` | Codex 目录 |
| `DASH_TRAE_HOME` | `~/.trae-cn` | Trae CN 目录 |
| `DASH_TRAE_USER_DIR` | 自动探测 `%APPDATA%\Trae*\User` | 指定 Trae 的 User 目录 |
| `DASH_HOME` | `os.homedir()` | 推导 `~/.claude.json` 等路径 |
| `DASH_DATA_DIR` | `./data` | 索引与事实表位置 |
| `DASH_PRICING_FILE` | `./pricing.json` | 单价表 |
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `7788` | API 监听地址 |
| `DASH_SNAPSHOT_TTL_MS` | `60000` | snapshot 内存缓存时长 |
| `DASH_MAX_WALK` | `60000` | 单次目录遍历条目上限 |

## 已知限制

1. **Trae CN 没有本地 token/费用日志**：只统计 skill 与 MCP，`usageAvailable=false`，不猜数据。
2. **Codex 不写 costUSD**：只能按单价表/反推估算。
3. **成本只在 Claude 侧有"平台账单"**（`cost-state`），其余平台只有自算值。
4. **没有用 SQLite**：本机 Node 22.12 的 `node:sqlite` 需要实验性 flag，所以用 `data/facts.ndjson` + 内存 Map 代替。3058 条事实（约 1.5MB）毫无压力；如果日志涨到十万级，应换 SQLite 或按会话分片。
5. **只在 Windows 上实测过**（路径探测、`%APPDATA%`、CLI 版本探测都是按 Windows 写的；其他平台未验证）。
6. **内置 vs 用户 MCP 的判定是启发式**：Trae 运行时缓存里 `integrated_*` 或以 `d.agentKinds.size === 0` 判定为内置，极少数情况可能误判，可通过 `includeBuiltin=1` 自行核对。
7. **Claude `cost-state` 只保留每个文件最后一条**（它是累计快照，不会丢信息；但如果文件被人工截断，上报值可能缺失）。

## 后续可做

1. **历史对比**：把每日聚合按周/月留档，看成本与缓存命中率的变化（现在只有原始事实表，随时可以重算）。
2. **会话级下钻**：从项目/模型点进具体会话，看单次请求的 token 与耗时（事实表里已有 `sessionId`）。
3. **单价编辑**：在面板里直接改 `pricing.json`（需要引入一个写接口，并加 CSRF/回环校验）。
4. **告警**：日成本或未定价 token 超过阈值时提示（可复用现有 `/api/usage/summary`）。
