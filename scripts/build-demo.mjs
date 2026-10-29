#!/usr/bin/env node
// 构建静态演示站（GitHub Pages 用）。
//
// GitHub Pages 只能托管静态文件，跑不了 Node 服务。这里的做法是：
//   1) 在临时目录合成一套 Claude Code / Codex / Trae CN 的假数据（skill、MCP、会话日志）；
//   2) 用**真实扫描层**（src/scan.js）跑一次全量扫描，保证演示数据的 schema 与真实扫描完全一致；
//   3) 把 snapshot 与 4 个时间窗 × 4 个平台的 usage 汇总预生成成静态 JSON；
//   4) 复制前端并注入 demo 模式标记，输出到 demo/。
//
// 不提交任何本机真实 data/，也不会读取用户的 ~/.claude 等目录（所有 DASH_* 都指向临时目录）。
//
// 用法：node scripts/build-demo.mjs [--out demo]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const NOW = Date.now();

/** 平台上报成本相对自算成本的倍数：造出「平台账单比自算略高」的对账场景。 */
const REPORTED_MULT = 1.25;

const TABLE_PRICES = {
  'claude-sonnet-4.5': { input: 3, output: 15 },
  'claude-opus-4.6': { input: 5, output: 25 },
  'gpt-5.2': { input: 1.5, output: 6 },
};
const DERIVED_MODEL = 'claude-haiku-4.5';
const DERIVED_PRICE = { input: 1, output: 5 };
const DEFAULT_MODEL = 'gpt-5-mini';

const PROJECTS = [
  { dir: 'C:/work/web-app', name: 'web-app' },
  { dir: 'C:/work/data-pipeline', name: 'data-pipeline' },
  { dir: 'C:/work/agent-dashboard', name: 'agent-dashboard' },
];

const DEMO_VERSIONS = { claude: '2.1.300', codex: '0.49.0', trae: '1.107.1' };

const HELP = `用法：node scripts/build-demo.mjs [--out demo]

把一个使用合成示例数据的纯静态演示站生成到 --out 目录（默认 demo/）。
生成后可直接 python -m http.server 或 node scripts/preview-demo.mjs 预览。`;

/* ------------------------------ 小工具 ------------------------------ */

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  write(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** 固定种子的 LCG：每次构建的数据分布一致（日期仍相对今天，保证"最近 7/30/90 天"有意义）。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const round6 = (n) => Number(n.toFixed(6));
const uuidLike = (rng) =>
  [8, 4, 4, 4, 12]
    .map((len) => Array.from({ length: len }, () => '0123456789abcdef'[int(rng, 0, 15)]).join(''))
    .join('-');

const iso = (ts) => new Date(ts).toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (ts) => {
  const d = new Date(ts);
  return { y: String(d.getFullYear()), m: pad2(d.getMonth() + 1), d: pad2(d.getDate()) };
};

/** 与 src/lib/pricing.js 的成本公式保持一致。 */
function costOfTokens(u, price) {
  return (
    ((u.input || 0) + (u.cacheRead || 0) * 0.1 + (u.cacheWrite || 0) * 1.25) * (price.input / 1e6) +
    (u.output || 0) * (price.output / 1e6)
  );
}

function priceFor(model) {
  if (TABLE_PRICES[model]) return TABLE_PRICES[model];
  if (model === DERIVED_MODEL) return DERIVED_PRICE;
  return { input: 2, output: 8 };
}

/** 本地零点，往前偏移 offset 天。用零点做基准，避免「NOW + 几小时」跨到相邻日期。 */
function dayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

/** 前端 isoDaysAgo(days) 的等价实现（从今天往前数 days-1 天）。 */
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* ------------------------------ fixture ------------------------------ */

function skillMd(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;
}

function addSkill(root, name, description) {
  write(path.join(root, name, 'SKILL.md'), skillMd(name, description));
}

function createFixture(tmpRoot) {
  const home = path.join(tmpRoot, 'home');
  const claudeHome = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const traeHome = path.join(home, '.trae-cn');
  const appData = path.join(tmpRoot, 'appdata');
  const localAppData = path.join(tmpRoot, 'localappdata');
  const traeUserDir = path.join(appData, 'Trae CN', 'User');
  const dataDir = path.join(tmpRoot, 'data');
  const pricingFile = path.join(tmpRoot, 'pricing.json');
  const rng = makeRng(20261026);

  /* --- Claude：skills / commands / agents --- */
  const claudeSkills = [
    ['review', '代码审查：按团队清单逐条检查 diff，输出可执行的修改建议'],
    ['commit-message', '根据暂存区 diff 生成符合 Conventional Commits 的提交信息'],
    ['test-runner', '跑测试、定位第一条失败用例并给出最小修复建议'],
    ['refactor', '在不改变行为的前提下拆分函数、收敛重复逻辑'],
    ['doc-writer', '把模块实现整理成 README 与 API 文档'],
    ['security-scan', '扫描依赖与配置里的明文密钥、危险默认值'],
    ['api-design', 'REST/GraphQL 接口设计评审与错误码约定'],
    ['sql-optimizer', '分析慢查询执行计划并给出索引/改写建议'],
  ];
  for (const [name, desc] of claudeSkills) addSkill(path.join(claudeHome, 'skills'), name, desc);
  addSkill(path.join(claudeHome, 'plugins', 'marketplaces', 'anthropic-skills', 'skills'), 'pdf', '读取与生成 PDF：抽取表格、合并拆分、填表');
  addSkill(path.join(claudeHome, 'plugins', 'marketplaces', 'anthropic-skills', 'skills'), 'xlsx', '电子表格处理：公式、透视表与批量改写');
  addSkill(path.join(claudeHome, 'plugins', 'cache', 'acme', 'kit', '1.4.0', 'skills'), 'design-review', 'UI 走查：对比设计令牌、间距与对比度');
  addSkill(path.join(claudeHome, 'plugins', 'cache', 'acme', 'kit', '1.4.0', 'skills'), 'release-notes', '从提交历史归纳版本说明');
  write(path.join(claudeHome, 'commands', 'deploy.md'), skillMd('deploy', '构建并部署到预发环境，输出变更摘要'));
  write(path.join(claudeHome, 'agents', 'reviewer.md'), skillMd('reviewer', '只读子代理：对指定目录做静态审查'));

  writeJson(path.join(claudeHome, 'settings.json'), {
    env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.example.com/v1' },
    modelSettings: {},
    mcpServers: {
      postgres: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://demo:demo@localhost:5432/app'],
        env: { PGPASSWORD: 'demo-pg-password-1234' },
      },
    },
  });

  writeJson(path.join(home, '.claude.json'), {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '--api-key=demo-fs-key-1234567890', 'C:/work'],
        env: { FS_TOKEN: 'fs_demo_token_abcdef123456' },
      },
      github: {
        type: 'http',
        url: 'https://mcp.example.com/github?token=demo-github-token-abcd1234',
        headers: { Authorization: 'Bearer demo-github-token-abcdef123456', 'X-Client': 'agent-dashboard' },
      },
    },
    projects: {
      'C:/work/web-app': {
        mcpServers: { puppeteer: { command: 'npx', args: ['-y', 'puppeteer-mcp'] } },
        disabledMcpServers: ['puppeteer'],
      },
    },
    skillUsage: {
      review: { usageCount: 42, lastUsedAt: iso(NOW - DAY) },
      'commit-message': { usageCount: 18, lastUsedAt: iso(NOW - 2 * DAY) },
      'test-runner': { usageCount: 27, lastUsedAt: iso(NOW - 3 * DAY) },
      refactor: { usageCount: 9, lastUsedAt: iso(NOW - 9 * DAY) },
      'doc-writer': { usageCount: 12, lastUsedAt: iso(NOW - 12 * DAY) },
      'security-scan': { usageCount: 3, lastUsedAt: iso(NOW - 21 * DAY) },
    },
  });

  /* --- Claude：120 天会话日志（含 cost-state 对账数据；比 90 天窗口多出 30 天，便于区分「90 天」与「全部」） --- */
  const claudeFiles = [];
  for (let d = 119; d >= 0; d--) {
    let sessions = int(rng, 0, 2);
    if (d <= 6 && sessions === 0) sessions = 1; // 最近一周必须有数据
    if (d >= 82 && sessions === 0) sessions = 1;
    for (let s = 0; s < sessions; s++) {
      const sessionId = uuidLike(rng);
      const project = pick(rng, PROJECTS);
      const start = dayStart(d) + int(rng, 8, 20) * 3600 * 1000 + int(rng, 0, 3500) * 1000;
      const msgCount = int(rng, 5, 9);
      const rows = [
        {
          type: 'user',
          sessionId,
          timestamp: iso(start - 5000),
          cwd: project.dir,
          message: { role: 'user', content: '帮我改一下当前的实现' },
        },
      ];
      const usageByModel = {};
      let t = start;
      for (let m = 0; m < msgCount; m++) {
        const model = pickModel(rng);
        const usage = {
          input: int(rng, 400, 2400),
          output: int(rng, 200, 1400),
          cacheRead: int(rng, 5000, 40000),
          cacheWrite: int(rng, 0, 4000),
        };
        t += int(rng, 20, 120) * 1000;
        const messageId = `msg_${sessionId}_${m}`;
        const base = { type: 'assistant', sessionId, cwd: project.dir };
        // 与真实日志一样：先写一条流式中间态，再写两遍最终 usage（同 message.id，靠去重收敛）
        rows.push({
          ...base,
          timestamp: iso(t),
          message: {
            id: messageId,
            model,
            usage: { input_tokens: usage.input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        });
        for (let k = 0; k < 2; k++) {
          rows.push({
            ...base,
            timestamp: iso(t + k),
            message: {
              id: messageId,
              model,
              usage: {
                input_tokens: usage.input,
                output_tokens: usage.output,
                cache_read_input_tokens: usage.cacheRead,
                cache_creation_input_tokens: usage.cacheWrite,
              },
            },
          });
        }
        const u = (usageByModel[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        u.input += usage.input;
        u.output += usage.output;
        u.cacheRead += usage.cacheRead;
        u.cacheWrite += usage.cacheWrite;
      }

      const modelUsage = {};
      let total = 0;
      for (const [model, u] of Object.entries(usageByModel)) {
        const cost = round6(costOfTokens(u, priceFor(model)) * REPORTED_MULT);
        total += cost;
        modelUsage[model] = {
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadInputTokens: u.cacheRead,
          cacheCreationInputTokens: u.cacheWrite,
          costUSD: cost,
        };
      }
      rows.push({ type: 'cost-state', sessionId, totalCostUSD: round6(total), modelUsage });

      const end = t + 6000;
      const file = path.join(claudeHome, 'projects', `demo-${project.name}`, `${sessionId}.jsonl`);
      writeJsonl(file, rows);
      // cost-state 的上报成本按会话文件 mtime 归入时间窗
      fs.utimesSync(file, new Date(end), new Date(end));
      claudeFiles.push(file);
    }
  }

  /* --- Codex：config / skills / sessions --- */
  write(
    path.join(codexHome, 'config.toml'),
    `model = "gpt-5.2"
model_provider = "demo-gateway"

[model_providers.demo-gateway]
base_url = "https://gateway.example.com/v1"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp"]

[mcp_servers.playwright.env]
DEMO_TOKEN = "demo-codex-token-abcdef123456"

[mcp_servers.deepwiki]
type = "http"
url = "https://mcp.example.com/deepwiki?token=demo-deepwiki-token-1234"

[mcp_servers.context7]
type = "http"
url = "https://mcp.example.com/context7"
`,
  );
  for (const [name, desc] of [
    ['review', 'Codex 侧代码审查清单'],
    ['commit-message', '生成提交信息'],
    ['test-runner', '运行并总结测试结果'],
    ['refactor', '小步重构建议'],
    ['doc-writer', '补全模块文档'],
    ['security-scan', '依赖与密钥扫描'],
    ['migration', '数据库迁移脚本生成与回滚方案'],
    ['pr-summary', '汇总 PR 变更点'],
  ]) {
    addSkill(path.join(codexHome, 'skills'), name, desc);
  }
  addSkill(path.join(codexHome, 'skills', '.system'), 'plan', '把需求拆成可执行步骤（内置）');
  addSkill(path.join(codexHome, 'skills', '.system'), 'apply-patch', '按补丁修改文件（内置）');

  for (let d = 119; d >= 0; d--) {
    if (rng() > 0.62) continue;
    const sessionId = uuidLike(rng);
    const project = pick(rng, PROJECTS);
    const model = rng() < 0.78 ? 'gpt-5.2' : DEFAULT_MODEL;
    const start = dayStart(d) + int(rng, 9, 22) * 3600 * 1000;
    const rows = [
      {
        type: 'session_meta',
        timestamp: iso(start),
        payload: { id: sessionId, session_id: sessionId, cwd: project.dir, model },
      },
    ];
    let t = start;
    const count = int(rng, 4, 7);
    for (let m = 0; m < count; m++) {
      t += int(rng, 30, 240) * 1000;
      rows.push({
        type: 'token_usage_record',
        timestamp: iso(t),
        ordinal: m + 1,
        payload: {
          response_id: `resp_${sessionId}_${m}`,
          usage: {
            input_tokens: int(rng, 200, 1200),
            output_tokens: int(rng, 60, 500),
            cached_input_tokens: int(rng, 1000, 9000),
            cache_write_input_tokens: int(rng, 0, 500),
          },
        },
      });
    }
    const date = localDate(start);
    writeJsonl(path.join(codexHome, 'sessions', date.y, date.m, date.d, `rollout-${sessionId}.jsonl`), rows);
  }

  /* --- Trae CN：skills / skill-config / mcp.json / 运行时工具缓存 --- */
  for (const [name, desc] of [
    ['review', 'Trae 侧代码审查'],
    ['commit-message', '写提交信息'],
    ['test-runner', '跑测试并汇总'],
    ['refactor', '重构建议'],
    ['doc-writer', '英文/中文文档互转'],
    ['security-scan', '安全扫描'],
    ['frontend-design', '页面结构与视觉层级建议'],
    ['data-viz', '图表选型与配色'],
  ]) {
    addSkill(path.join(traeHome, 'skills'), name, desc);
  }
  addSkill(path.join(traeHome, 'builtin_skills'), 'trae-browser', '内置浏览器工具集（页面抓取与截图）');
  addSkill(path.join(traeHome, 'builtin_skills'), 'code-mode', '内置代码模式工具集');
  addSkill(path.join(traeHome, 'plugins', 'trae-remote-official', 'lark-suite', '1.2.0', 'skills'), 'lark-doc', '飞书云文档读写');
  addSkill(path.join(traeHome, 'plugins', 'trae-remote-official', 'lark-suite', '1.2.0', 'skills'), 'lark-sheets', '飞书电子表格读写');

  writeJson(path.join(traeHome, 'skill-config.json'), {
    disabledSkills: ['data-viz'],
    deletedSkills: ['legacy-helper'],
    builtinSkillStatus: { 'code-mode': false },
    managedSkills: { 'lark-doc': 'marketplace', 'lark-sheets': 'marketplace' },
  });

  writeJson(path.join(traeUserDir, 'mcp.json'), {
    mcpServers: {
      'lark-mcp': { url: 'https://mcp.example.com/lark?token=demo-lark-token-1234' },
      figma: {
        command: 'npx',
        args: ['-y', 'figma-mcp', '--api-key=demo-figma-key-5678'],
        env: { FIGMA_TOKEN: 'figd_demo_token_abcdef123456' },
      },
      'browser-tools': { command: 'node', args: ['browser-mcp.js'], disabled: true },
    },
  });

  const runtimeServers = [
    { scope: 'user', agentKind: 'default', dir: 'lark-mcp', name: 'lark-mcp', desc: '飞书开放平台 MCP', tools: 12 },
    { scope: 'user', agentKind: 'default', dir: 'figma', name: 'figma', desc: 'Figma 设计稿读取', tools: 8 },
    { scope: 'user', agentKind: 'default', dir: 'browser-tools', name: 'browser-tools', desc: '本地浏览器自动化', tools: 6 },
    { scope: 'integrated', agentKind: null, dir: 'browser_tools', name: 'integrated_browser', desc: 'Trae 内置浏览器工具集', tools: 9 },
  ];
  for (const s of runtimeServers) {
    const base = s.agentKind
      ? path.join(traeHome, 'mcps', s.scope, s.agentKind, s.dir)
      : path.join(traeHome, 'mcps', s.scope, s.dir);
    writeJson(path.join(base, 'SERVER_METADATA.json'), { server_name: s.name, description: s.desc });
    for (let i = 1; i <= s.tools; i++) {
      writeJson(path.join(base, 'tools', `tool_${i}.json`), { name: `${s.name}_tool_${i}`, description: `${s.desc} · 工具 ${i}` });
    }
  }

  writeJson(path.join(localAppData, 'Programs', 'Trae CN', 'resources', 'app', 'package.json'), {
    name: 'Trae CN',
    version: DEMO_VERSIONS.trae,
  });

  /* --- 单价表 --- */
  writeJson(pricingFile, {
    _README: '演示数据：models 里是显式单价；claude-haiku-4.5 由 cost-state 反推；gpt-5-mini 走 default 兜底。',
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    default: { input: 2, output: 8 },
    models: TABLE_PRICES,
  });

  return {
    root: tmpRoot,
    home,
    claudeHome,
    codexHome,
    traeHome,
    traeUserDir,
    appData,
    localAppData,
    dataDir,
    pricingFile,
    claudeFiles,
  };
}

function pickModel(rng) {
  const r = rng();
  if (r < 0.5) return 'claude-sonnet-4.5';
  if (r < 0.75) return 'claude-opus-4.6';
  return DERIVED_MODEL;
}

/** 必须在 import src/* 之前调用：config.js 在模块加载时就读取这些环境变量。 */
function applyEnv(fx) {
  process.env.DASH_HOME = fx.home;
  process.env.DASH_CLAUDE_HOME = fx.claudeHome;
  process.env.DASH_CODEX_HOME = fx.codexHome;
  process.env.DASH_TRAE_HOME = fx.traeHome;
  process.env.DASH_TRAE_USER_DIR = fx.traeUserDir;
  process.env.DASH_DATA_DIR = fx.dataDir;
  process.env.DASH_PRICING_FILE = fx.pricingFile;
  process.env.DASH_SNAPSHOT_TTL_MS = '600000';
  process.env.APPDATA = fx.appData;
  process.env.LOCALAPPDATA = fx.localAppData;
}

/* ------------------------------ 脱敏 ------------------------------ */

/** 把临时目录/本机路径替换成 ~ / %APPDATA% 这类中性写法，防止演示站泄漏构建机路径。 */
function makeSanitizer(root) {
  const posix = root.split(path.sep).join('/');
  const replacements = [
    [`${posix}/home`, '~'],
    [`${posix}/appdata`, '%APPDATA%'],
    [`${posix}/localappdata`, '%LOCALAPPDATA%'],
    [`${posix}/data`, 'data'],
    [`${posix}/`, ''],
    [posix, ''],
  ];
  const str = (value) => {
    let s = value.split('\\').join('/');
    for (const [from, to] of replacements) s = s.split(from).join(to);
    return s;
  };
  const deep = (value) => {
    if (typeof value === 'string') return str(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = deep(v);
      return out;
    }
    return value;
  };
  return deep;
}

/* ------------------------------ 输出 ------------------------------ */

function buildIndexHtml(source) {
  let html = source;
  html = html.replace(
    '<title>Agent Dashboard · 本地 Agent 统一视图</title>',
    '<title>Agent Dashboard · 在线演示</title>',
  );
  html = html.replace(
    '<small>本地 Agent 统一视图 · 只读</small>',
    '<small>在线演示 · 合成示例数据</small>',
  );
  html = html.replace(
    '<a class="skip-link" href="#main">跳到主内容</a>',
    `<a class="skip-link" href="#main">跳到主内容</a>

<div class="demo-strip" role="note">
  <span class="demo-strip-tag">演示站</span>
  <span>本页使用<strong>合成示例数据</strong>（Claude Code / Codex / Trae CN 的虚构 skill、MCP 与 token 用量），不是任何人的本机真实数据。</span>
  <a class="demo-strip-link" href="https://github.com/wang-xu-d/agent-dashboard" target="_blank" rel="noopener">查看源码与本地运行方式</a>
</div>`,
  );
  html = html.replaceAll('href="/api"', 'href="api/index.json"');
  html = html.replace(
    '<span>数据来源：本机配置与日志文件的只读扫描</span>',
    '<span>数据来源：构建时生成的合成示例数据（非本机真实信息）</span>',
  );
  html = html.replace(
    '<script src="app.js" type="module"></script>',
    '<script>window.__DEMO__ = true;</script>\n<script src="app.js" type="module"></script>',
  );
  if (!html.includes('__DEMO__') || !html.includes('demo-strip')) {
    throw new Error('index.html 注入失败：请检查 public/index.html 的结构是否被改动');
  }
  return html;
}

function buildApiIndex(apiFiles) {
  return {
    ok: true,
    data: apiFiles,
    meta: { demo: true, note: '演示站为静态快照：每个 API 端点对应一个预生成的 JSON 文件，不能重新扫描。' },
  };
}

/* ------------------------------ 主流程 ------------------------------ */

function parseArgs(argv) {
  const out = { out: 'demo', help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i] || 'demo';
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const outDir = path.resolve(PROJECT_ROOT, opts.out);
  if (outDir === PROJECT_ROOT) throw new Error('--out 不能是项目根目录（请用 demo 这类子目录）');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dash-demo-'));
  try {
    const fx = createFixture(tmpRoot);
    applyEnv(fx);

    // 动态 import：必须在设置 DASH_* 之后，config.js 才会指向 fixture 目录
    const { scan, readFactsFile, loadPricing, aggregateUsage } = await import('../src/scan.js');
    const { INDEX_FILE } = await import('../src/config.js');
    const { readJsonSafe } = await import('../src/lib/fsx.js');

    const snap = await scan({ full: true });
    const facts = readFactsFile();
    const reported = readJsonSafe(INDEX_FILE, {})?.reported || {};
    const pricing = loadPricing(reported);

    // 版本号固定成演示值（真实 CLI 版本取决于构建机，不应泄漏到演示站）
    for (const agent of snap.agents) {
      if (DEMO_VERSIONS[agent.id]) agent.version = DEMO_VERSIONS[agent.id];
    }

    const sanitize = makeSanitizer(tmpRoot);
    const safeSnap = sanitize(snap);
    safeSnap.meta.dataDir = 'data';
    safeSnap.meta.pricingFile = 'pricing.json';

    const windows = [
      { bucket: '7', days: 7 },
      { bucket: '30', days: 30 },
      { bucket: '90', days: 90 },
      { bucket: 'all', days: null },
    ];
    const agents = ['all', 'claude', 'codex', 'trae'];
    const apiDir = path.join(outDir, 'api');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(apiDir, { recursive: true });

    writeJson(path.join(apiDir, 'snapshot.json'), {
      ok: true,
      data: safeSnap,
      meta: { demo: true, generatedAt: safeSnap.generatedAt },
    });

    const apiFiles = [
      { method: 'GET', path: 'api/snapshot.json', desc: '全量快照（与 /api/snapshot 同 schema，演示数据）' },
    ];

    const summaryFiles = [];
    for (const w of windows) {
      const from = w.days ? isoDaysAgo(w.days) : null;
      for (const agent of agents) {
        const data = aggregateUsage(facts, reported, pricing, {
          from,
          agent: agent === 'all' ? null : agent,
        });
        const name = `usage-${w.bucket}-${agent}.json`;
        const file = path.join(apiDir, name);
        writeJson(file, {
          ok: true,
          data: sanitize(data),
          meta: { demo: true, from, agent: agent === 'all' ? null : agent, generatedAt: snap.generatedAt },
        });
        summaryFiles.push(file);
        apiFiles.push({
          method: 'GET',
          path: `api/${name}`,
          desc: `用量汇总 · 时间窗 ${w.bucket === 'all' ? '全部' : `${w.days} 天`} · 平台 ${agent}`,
        });
      }
    }

    writeJson(path.join(apiDir, 'pricing.json'), {
      ok: true,
      data: sanitize(snap.pricing),
      meta: { demo: true, note: '演示数据：derived 来自合成的 Claude cost-state' },
    });
    apiFiles.push({ method: 'GET', path: 'api/pricing.json', desc: '当前生效单价（含反推结果）' });
    writeJson(path.join(apiDir, 'index.json'), buildApiIndex(apiFiles));

    // 复制前端并注入 demo 标记
    const publicDir = path.join(PROJECT_ROOT, 'public');
    const indexPath = path.join(publicDir, 'index.html');
    write(path.join(outDir, 'index.html'), buildIndexHtml(fs.readFileSync(indexPath, 'utf8')));
    for (const file of ['styles.css', 'app.js', 'favicon.svg']) {
      write(path.join(outDir, file), fs.readFileSync(path.join(publicDir, file)));
    }
    // GitHub Pages 的 Actions 产物不需要 Jekyll，但放一个 .nojekyll 可以兼容手动上传分支的方式
    write(path.join(outDir, '.nojekyll'), '');

    const totals = snap.usage.totals;
    const ratio = snap.usage.reconciliation?.ratio;
    console.log(`[demo] 已生成静态演示站：${outDir}`);
    console.log(
      `[demo] ${snap.agents.filter((a) => a.installed).length} 个平台 · ${snap.skills.length} 个 skill · ${snap.mcps.length} 个 MCP · ${totals.records} 条用量记录`,
    );
    console.log(
      `[demo] 总 token ${(totals.totalTokens / 1e6).toFixed(1)}M · 自算 $${totals.costUSD.toFixed(2)} · 上报 $${snap.usage.reported.costUSD.toFixed(2)} · 比值 ${ratio ? ratio.toFixed(2) : '—'}`,
    );
    console.log(`[demo] ${summaryFiles.length} 份时间窗汇总 + snapshot/pricing/index，共 ${apiFiles.length + 2} 个 JSON`);
    console.log('[demo] 本地预览：node scripts/preview-demo.mjs');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
