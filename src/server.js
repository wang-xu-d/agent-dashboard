// 只读 HTTP API（默认 127.0.0.1:7788）+ 前端静态页。
// 路由：
//   GET  /                          前端单页（public/index.html）
//   GET  /api                       端点清单
//   GET  /api/health                健康检查
//   GET  /api/snapshot[?refresh=1]  全量快照（前端首屏用这一个就够）
//   GET  /api/agents                已安装 agent 列表
//   GET  /api/skills?agent=&enabled=&q=
//   GET  /api/skills/matrix         跨平台同名 skill 矩阵
//   GET  /api/mcps?agent=&scope=
//   GET  /api/usage?from=&to=&agent=&groupBy=day|model|agent|project
//   POST /api/scan[?full=1]          强制重扫
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SERVER, DATA_DIR, INDEX_FILE, ROOT } from './config.js';
import { getSnapshot, scan, aggregateUsage, loadPricing, readFactsFile } from './scan.js';
import { readJsonSafe } from './lib/fsx.js';

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': res.req?.headers?.origin || '*',
  });
  res.end(body);
}

function ok(res, data, meta = {}) {
  send(res, 200, { ok: true, data, meta });
}

function fail(res, status, message) {
  send(res, status, { ok: false, error: message });
}

function filterList(list, q, fields) {
  if (!q) return list;
  const needle = String(q).toLowerCase();
  return list.filter((item) => fields.some((f) => String(item[f] ?? '').toLowerCase().includes(needle)));
}

const routes = {
  '/api/health': () => ({
    data: { status: 'ok', uptimeSec: Math.round(process.uptime()), dataDir: DATA_DIR },
    meta: {},
  }),

  '/api/snapshot': async (ctx) => {
    const snap = await getSnapshot({ refresh: ctx.query.get('refresh') === '1' });
    return { data: snap, meta: { generatedAt: snap.generatedAt, cacheHit: snap.cacheHit } };
  },

  '/api/agents': async () => {
    const snap = await getSnapshot({});
    const counts = {};
    for (const s of snap.skills) counts[s.agent] = (counts[s.agent] || 0) + 1;
    const mcpCounts = {};
    for (const m of snap.mcps) mcpCounts[m.agent] = (mcpCounts[m.agent] || 0) + 1;
    const data = snap.agents.map((a) => ({
      ...a,
      skillCount: counts[a.id] || 0,
      mcpCount: mcpCounts[a.id] || 0,
      tokens: snap.usage.byAgent.find((b) => b.agent === a.id)?.totalTokens || 0,
      costUSD: snap.usage.byAgent.find((b) => b.agent === a.id)?.costUSD || 0,
    }));
    return { data, meta: { generatedAt: snap.generatedAt } };
  },

  '/api/skills': async (ctx) => {
    const snap = await getSnapshot({});
    const agent = ctx.query.get('agent');
    const enabled = ctx.query.get('enabled');
    let data = snap.skills;
    if (agent) data = data.filter((s) => s.agent === agent);
    if (enabled === '1' || enabled === '0') data = data.filter((s) => Boolean(s.enabled) === (enabled === '1'));
    data = filterList(data, ctx.query.get('q'), ['name', 'description', 'namespace']);
    const source = ctx.query.get('source');
    if (source) data = data.filter((s) => s.source === source);
    return {
      data,
      meta: { count: data.length, byAgent: groupCount(data, 'agent'), bySource: groupCount(data, 'source'), generatedAt: snap.generatedAt },
    };
  },

  '/api/skills/matrix': async () => {
    const snap = await getSnapshot({});
    return { data: snap.skillMatrix, meta: { count: snap.skillMatrix.length } };
  },

  '/api/mcps': async (ctx) => {
    const snap = await getSnapshot({});
    const agent = ctx.query.get('agent');
    const scope = ctx.query.get('scope');
    const includeBuiltin = ctx.query.get('includeBuiltin') === '1';
    let data = snap.mcps;
    // 默认隐藏平台内置工具集（如 Trae 的 integrated_*），只显示用户配置的 MCP
    if (!includeBuiltin) data = data.filter((m) => m.scope !== 'builtin');
    if (agent) data = data.filter((m) => m.agent === agent);
    if (scope) data = data.filter((m) => m.scope === scope);
    data = filterList(data, ctx.query.get('q'), ['name', 'command', 'url']);
    return {
      data,
      meta: {
        count: data.length,
        byAgent: groupCount(data, 'agent'),
        enabled: data.filter((m) => m.enabled === true).length,
        disabled: data.filter((m) => m.enabled === false).length,
        unknownState: data.filter((m) => m.enabled === null).length,
        builtinBundlesHidden: snap.mcps.filter((m) => m.scope === 'builtin').length,
        generatedAt: snap.generatedAt,
      },
    };
  },

  '/api/usage': async (ctx) => {
    const snap = await getSnapshot({});
    const groupBy = ctx.query.get('groupBy') || null;
    // 从快照的聚合结果里取；需要自定义时间窗时走 /api/usage/query 语义（见下）
    const usage = snap.usage;
    if (!groupBy) return { data: usage.totals, meta: { reported: usage.reported } };
    const key = { day: 'byDay', model: 'byModel', agent: 'byAgent', project: 'byProject' }[groupBy];
    if (!key) return { data: null, meta: { error: `groupBy 只支持 day|model|agent|project` } };
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    let rows = usage[key];
    if (from || to || ctx.query.get('agent')) {
      // 有过滤条件时：用事实表重算（保证口径一致）
      rows = await requery({ from, to, agent: ctx.query.get('agent'), groupBy });
    }
    return { data: rows, meta: { groupBy, generatedAt: snap.generatedAt } };
  },

  '/api/usage/summary': async (ctx) => {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const agent = ctx.query.get('agent');
    const snap = await getSnapshot({});
    if (!from && !to && !agent) return { data: snap.usage, meta: { generatedAt: snap.generatedAt } };
    const data = await requery({ from, to, agent, groupBy: null });
    return { data, meta: { from, to, agent, generatedAt: snap.generatedAt } };
  },

  '/api/pricing': async () => {
    const snap = await getSnapshot({});
    return { data: snap.pricing, meta: { note: 'derived = 从 Claude cost-state 反推的单价；null 表示未知' } };
  },
};

function groupCount(list, field) {
  const out = {};
  for (const item of list) out[item[field]] = (out[item[field]] || 0) + 1;
  return out;
}

/** 带时间窗/平台过滤的重新聚合。 */
async function requery({ from, to, agent, groupBy }) {
  // 复用 scan 模块的持久化事实表与聚合逻辑，保证与 snapshot 口径一致
  const facts = readFactsFile();
  const idx = readJsonSafe(INDEX_FILE, {}) || {};
  const pricing = loadPricing(idx.reported || {});
  const agg = aggregateUsage(facts, idx.reported || {}, pricing, { from, to, agent });
  if (!groupBy) return agg;
  const key = { day: 'byDay', model: 'byModel', agent: 'byAgent', project: 'byProject' }[groupBy];
  return agg[key];
}

const API_INDEX = [
  { method: 'GET', path: '/api/health', desc: '健康检查' },
  { method: 'GET', path: '/api/snapshot?refresh=1', desc: '全量快照（首屏一个请求）' },
  { method: 'GET', path: '/api/agents', desc: 'Agent 列表（带 skill/MCP 计数与用量）' },
  { method: 'GET', path: '/api/skills?agent=&source=&enabled=&q=', desc: 'Skill 列表' },
  { method: 'GET', path: '/api/skills/matrix', desc: '跨平台同名 skill 矩阵' },
  { method: 'GET', path: '/api/mcps?agent=&scope=&q=&includeBuiltin=1', desc: 'MCP 列表（默认隐藏内置工具集）' },
  { method: 'GET', path: '/api/usage?groupBy=day|model|agent|project&from=&to=&agent=', desc: '分组用量' },
  { method: 'GET', path: '/api/usage/summary?from=&to=&agent=', desc: '汇总 + 平台上报 + 对账' },
  { method: 'GET', path: '/api/pricing', desc: '当前生效单价' },
  { method: 'POST', path: '/api/scan?full=1', desc: '强制重扫' },
];

// ---------- 前端静态文件 ----------
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel || 'index.html');
  const inside = path.relative(PUBLIC_DIR, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return fail(res, 403, '禁止访问');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, `未找到：${pathname}`);
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    // 本地开发工具：禁用强缓存，改完刷新就能看到
    'cache-control': 'no-cache',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/api') return ok(res, API_INDEX, { count: API_INDEX.length });
    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
    if (pathname === '/api/scan') {
      if (req.method !== 'POST') return fail(res, 405, '请用 POST /api/scan?full=1');
      const full = url.searchParams.get('full') === '1';
      const snap = await scan({ full });
      return ok(res, { generatedAt: snap.generatedAt, agents: snap.agents.length, skills: snap.skills.length, mcps: snap.mcps.length, facts: snap.meta.facts, newFacts: snap.meta.newFacts, durationMs: snap.durationMs }, { full });
    }

    const handler = routes[pathname];
    if (!handler) return fail(res, 404, `未知端点：${pathname}`);
    const result = await handler({ query: url.searchParams, req });
    return ok(res, result.data, result.meta || {});
  } catch (err) {
    return fail(res, 500, String(err?.stack || err?.message || err));
  }
});

server.listen(SERVER.port, SERVER.host, () => {
  console.log(`[agent-dashboard] API 已启动： http://${SERVER.host}:${SERVER.port}`);
  console.log(`[agent-dashboard] 数据目录： ${DATA_DIR}`);
});
