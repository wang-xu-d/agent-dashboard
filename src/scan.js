// 扫描编排层：调用各平台适配器 → 增量写入用量事实表 → 聚合出 snapshot。
// 设计要点：
//   - 日志按字节偏移增量解析（data/index.json 记录每个文件读到哪），第二次扫描几乎零成本；
//   - 用量事实以 "agent:session:messageId" 去重，追加进 data/facts.ndjson；
//   - 成本在聚合时计算（单价可能被用户随时改动），未知单价返回 null 而不是 0。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, FACTS_FILE, INDEX_FILE, PRICING_FILE, SCAN } from './config.js';
import { readJsonSafe, writeJsonAtomic, ensureDir, parseLine } from './lib/fsx.js';
import { derivePrices, resolvePrice, costOf, normalizeModel } from './lib/pricing.js';
import { maskArgs } from './lib/mask.js';
import * as claude from './adapters/claude.js';
import * as codex from './adapters/codex.js';
import * as trae from './adapters/trae.js';

export const ADAPTERS = [claude, codex, trae];

/* ------------------------------ 持久化 ------------------------------ */

function loadIndex() {
  const idx = readJsonSafe(INDEX_FILE, null);
  if (!idx || idx.version !== 1) return { version: 1, offsets: {}, reported: {} };
  idx.offsets = idx.offsets || {};
  idx.reported = idx.reported || {};
  return idx;
}

function loadFacts() {
  const facts = new Map();
  if (!fs.existsSync(FACTS_FILE)) return facts;
  const text = fs.readFileSync(FACTS_FILE, 'utf8');
  for (const line of text.split('\n')) {
    const f = parseLine(line);
    if (f?.key) facts.set(f.key, f);
  }
  return facts;
}

/** 供 API 查询接口复用：直接读取持久化的事实表。 */
export function readFactsFile() {
  return loadFacts();
}

function appendFacts(list) {
  if (!list.length) return;
  ensureDir(DATA_DIR);
  fs.appendFileSync(FACTS_FILE, `${list.map((f) => JSON.stringify(f)).join('\n')}\n`);
}

/* ---------------------------- 扫描主流程 ---------------------------- */

let inFlight = null;

/**
 * 执行一次扫描。
 * @param {{full?: boolean}} opts full=true 时清空索引与事实表，全量重扫
 */
export async function scan(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runScan(opts)
    .then((snapshot) => {
      // 扫描结果就是最新快照，直接写进内存缓存，避免 POST /api/scan 后
      // 紧接着的 GET 又拿到过期快照（或白跑一次扫描）
      cached = snapshot;
      cachedAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function runScan({ full = false } = {}) {
  const started = Date.now();
  ensureDir(DATA_DIR);

  if (full) {
    for (const f of [INDEX_FILE, FACTS_FILE]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const index = loadIndex();
  const facts = loadFacts();
  const newFacts = [];
  const newKeys = new Set();
  const knownKeys = new Set(facts.keys());
  const usageStats = {};

  const weightOf = (f) => (f.input || 0) + (f.output || 0) + (f.cacheRead || 0) + (f.cacheWrite || 0);

  /**
   * 写入一条用量事实。
   * 同一个 key（同一次 API 响应）可能被平台写入多次，且首条常是流式中间态、
   * 后续才是最终 usage。这里只保留 token 总量最大的一条，避免重复计费。
   * 覆盖写法：同 key 追加一行，读取时后者覆盖前者。
   */
  const emitFact = (fact) => {
    if (!fact.key) return;
    if (!knownKeys.has(fact.key)) {
      knownKeys.add(fact.key);
      newKeys.add(fact.key);
    }
    const prev = facts.get(fact.key);
    if (prev) {
      if (weightOf(fact) <= weightOf(prev)) return;
      facts.set(fact.key, fact);
      newFacts.push(fact);
      return;
    }
    facts.set(fact.key, fact);
    newFacts.push(fact);
  };

  const emitSessionCost = (report) => {
    index.reported[`${report.agent}:${report.sessionId}`] = report;
  };

  // 1) agent 探测 + skill / mcp 扫描
  const agents = [];
  const skills = [];
  const mcps = [];
  for (const adapter of ADAPTERS) {
    let info = null;
    try {
      info = adapter.detect();
    } catch (err) {
      info = { id: adapter.id, label: adapter.label, installed: false, error: String(err.message || err) };
    }
    agents.push(info);
    if (!info?.installed) continue;

    try {
      skills.push(...adapter.listSkills());
    } catch (err) {
      info.skillError = String(err.message || err);
    }
    try {
      mcps.push(...adapter.listMcps().map((m) => ({ ...m, args: maskArgs(m.args) })));
    } catch (err) {
      info.mcpError = String(err.message || err);
    }
  }

  // 2) 用量增量解析
  for (const adapter of ADAPTERS) {
    const info = agents.find((a) => a.id === adapter.id);
    if (!info?.installed) continue;
    try {
      usageStats[adapter.id] = adapter.readUsage(emitFact, emitSessionCost, index.offsets);
    } catch (err) {
      usageStats[adapter.id] = { error: String(err.message || err) };
    }
  }

  // 3) 落盘
  appendFacts(newFacts);
  writeJsonAtomic(INDEX_FILE, index);

  const snapshot = buildSnapshot({
    agents,
    skills,
    mcps,
    facts,
    reported: index.reported,
    usageStats,
    scanMs: Date.now() - started,
    newFactCount: newKeys.size,
    appendedLines: newFacts.length,
  });

  return snapshot;
}

/* ------------------------------ 聚合 ------------------------------ */

function dayKey(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function boundOf(value, endOfDay = false) {
  if (value === undefined || value === null || value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const t = Date.parse(`${value}T00:00:00`);
    return endOfDay ? t + 86_400_000 - 1 : t;
  }
  const t = Number(value);
  return Number.isFinite(t) ? t : null;
}

/** 从未被显式配置的模型里反推单价（样本来自 Claude cost-state）。 */
export function buildDerivedPricing(reported) {
  const samplesByModel = new Map();
  for (const report of Object.values(reported)) {
    if (!report?.models) continue;
    for (const [rawModel, m] of Object.entries(report.models)) {
      if (!m || !Number.isFinite(m.costUSD) || !m.costUSD) continue;
      const key = normalizeModel(rawModel);
      const list = samplesByModel.get(key) || [];
      list.push({
        input: m.inputTokens || 0,
        output: m.outputTokens || 0,
        cacheRead: m.cacheReadInputTokens || 0,
        cacheWrite: m.cacheCreationInputTokens || 0,
        costUSD: m.costUSD,
      });
      samplesByModel.set(key, list);
    }
  }
  const derived = {};
  for (const [model, samples] of samplesByModel) {
    const p = derivePrices(samples);
    if (p) derived[model] = p;
  }
  return derived;
}

export function loadPricing(reported) {
  const table = readJsonSafe(PRICING_FILE, {}) || {};
  return {
    cacheReadMultiplier: table.cacheReadMultiplier ?? 0.1,
    cacheWriteMultiplier: table.cacheWriteMultiplier ?? 1.25,
    models: table.models || {},
    default: table.default || null,
    derived: buildDerivedPricing(reported),
  };
}

/** 聚合用量事实：支持时间窗与平台过滤，按 day / model / agent / project 分组。 */
export function aggregateUsage(facts, reported, pricing, filter = {}) {
  const from = boundOf(filter.from, false);
  const to = boundOf(filter.to, true);
  const agentFilter = filter.agent || null;

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUSD: 0, unknownCostTokens: 0, records: 0 };
  const byDay = new Map();
  const byModel = new Map();
  const byAgent = new Map();
  const byProject = new Map();
  const priceUsage = new Map();

  const bucket = (map, key, seed) => {
    let b = map.get(key);
    if (!b) {
      b = { key, ...seed, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUSD: 0, records: 0, unknownCostTokens: 0 };
      map.set(key, b);
    }
    return b;
  };

  for (const f of facts.values()) {
    if (agentFilter && f.agent !== agentFilter) continue;
    if (from !== null && (f.ts || 0) < from) continue;
    if (to !== null && (f.ts || 0) > to) continue;

    const price = resolvePrice(f.model, pricing);
    const { costUSD, priceSource } = costOf(f, price, pricing);
    const tokens = (f.input || 0) + (f.output || 0) + (f.cacheRead || 0) + (f.cacheWrite || 0);

    totals.input += f.input || 0;
    totals.output += f.output || 0;
    totals.cacheRead += f.cacheRead || 0;
    totals.cacheWrite += f.cacheWrite || 0;
    totals.totalTokens += tokens;
    totals.records += 1;
    if (costUSD === null) totals.unknownCostTokens += tokens;
    else totals.costUSD += costUSD;

    const targets = [
      [byDay, dayKey(f.ts), { date: dayKey(f.ts) }],
      [byModel, normalizeModel(f.model), { model: f.model, normalized: normalizeModel(f.model), priceSource }],
      [byAgent, f.agent, { agent: f.agent }],
      [byProject, f.cwd || 'unknown', { cwd: f.cwd || null }],
    ];
    for (const [map, key, seed] of targets) {
      const b = bucket(map, key, seed);
      b.input += f.input || 0;
      b.output += f.output || 0;
      b.cacheRead += f.cacheRead || 0;
      b.cacheWrite += f.cacheWrite || 0;
      b.totalTokens += tokens;
      b.records += 1;
      if (costUSD === null) b.unknownCostTokens += tokens;
      else b.costUSD += costUSD;
    }

    // 单价解析来源统计，前端可提示"哪些模型没有单价"
    const pu = priceUsage.get(normalizeModel(f.model)) || { model: f.model, normalized: normalizeModel(f.model), priceSource, tokens: 0 };
    pu.tokens += tokens;
    priceUsage.set(normalizeModel(f.model), pu);
  }

  const sortedDays = [...byDay.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));

  // 平台上报成本（Claude cost-state）：用于交叉校验自算成本
  const reportedTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const reportedByModel = new Map();
  let reportedCostUSD = 0;
  let reportedSessions = 0;
  for (const [key, r] of Object.entries(reported || {})) {
    if (agentFilter && !key.startsWith(`${agentFilter}:`)) continue;
    if (!Number.isFinite(r?.totalCostUSD) || r.totalCostUSD <= 0) continue;
    // 会话级账单按会话文件 mtime 归入时间窗；没有 ts 的旧数据不参与过滤
    const rts = Number(r?.ts);
    if (Number.isFinite(rts) && rts > 0) {
      if (from !== null && rts < from) continue;
      if (to !== null && rts > to) continue;
    }
    reportedCostUSD += r.totalCostUSD;
    reportedSessions++;
    for (const [rawModel, m] of Object.entries(r.models || {})) {
      const b = reportedByModel.get(rawModel) || { model: rawModel, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUSD: 0 };
      const input = m.inputTokens || 0;
      const output = m.outputTokens || 0;
      const cacheRead = m.cacheReadInputTokens || 0;
      const cacheWrite = m.cacheCreationInputTokens || 0;
      b.input += input;
      b.output += output;
      b.cacheRead += cacheRead;
      b.cacheWrite += cacheWrite;
      b.totalTokens += input + output + cacheRead + cacheWrite;
      b.costUSD += Number(m.costUSD) || 0;
      reportedByModel.set(rawModel, b);
      reportedTotals.input += input;
      reportedTotals.output += output;
      reportedTotals.cacheRead += cacheRead;
      reportedTotals.cacheWrite += cacheWrite;
      reportedTotals.totalTokens += input + output + cacheRead + cacheWrite;
    }
  }

  return {
    totals: { ...totals, cacheHitRate: totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : null },
    byDay: sortedDays,
    byModel: [...byModel.values()].sort((a, b) => b.costUSD - a.costUSD || b.totalTokens - a.totalTokens),
    byAgent: [...byAgent.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byProject: [...byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 20),
    priceStatus: [...priceUsage.values()].sort((a, b) => b.tokens - a.tokens),
    reported: {
      costUSD: reportedCostUSD,
      sessions: reportedSessions,
      tokens: reportedTotals,
      byModel: [...reportedByModel.values()].sort((a, b) => b.costUSD - a.costUSD),
    },
    // 自算 vs 平台上报的交叉校验：比值接近 1 说明去重与单价都对得上
    reconciliation: {
      computedCostUSD: totals.costUSD,
      reportedCostUSD,
      ratio: reportedCostUSD > 0 ? totals.costUSD / reportedCostUSD : null,
      note: 'computed 按 pricing.json 单价估算，覆盖所有已支持平台；reported 仅来自 Claude cost-state（模型名与日志里的实服模型名不同）。两者口径不完全一致，比值仅供交叉校验。',
    },
  };
}

/* ------------------------------ snapshot ------------------------------ */

let cached = null;
let cachedAt = 0;

export async function getSnapshot({ refresh = false, full = false } = {}) {
  if (!refresh && !full && cached && Date.now() - cachedAt < SCAN.snapshotTtlMs) {
    return { ...cached, cacheHit: true };
  }
  const snap = await scan({ full });
  cached = snap;
  cachedAt = Date.now();
  return { ...snap, cacheHit: false };
}

export function invalidateCache() {
  cached = null;
  cachedAt = 0;
}

function buildSnapshot({ agents, skills, mcps, facts, reported, usageStats, scanMs, newFactCount, appendedLines }) {
  const pricing = loadPricing(reported);
  const usage = aggregateUsage(facts, reported, pricing, {});

  const skillMatrix = [];
  const byName = new Map();
  for (const s of skills) {
    const key = normalizeModel(s.name);
    const row = byName.get(key) || { name: s.name, instances: [], agents: {} };
    row.agents[s.agent] = (row.agents[s.agent] || 0) + 1;
    row.instances.push({ agent: s.agent, source: s.source, enabled: s.enabled, namespace: s.namespace, path: s.path });
    byName.set(key, row);
  }
  for (const row of byName.values()) skillMatrix.push(row);

  return {
    generatedAt: Date.now(),
    durationMs: scanMs,
    agents,
    skills,
    mcps,
    usage,
    skillMatrix: skillMatrix.sort((a, b) => Object.keys(b.agents).length - Object.keys(a.agents).length || a.name.localeCompare(b.name)),
    pricing: {
      models: pricing.models,
      derived: pricing.derived,
      default: pricing.default,
      cacheReadMultiplier: pricing.cacheReadMultiplier,
      cacheWriteMultiplier: pricing.cacheWriteMultiplier,
    },
    meta: {
      facts: facts.size,
      newFacts: newFactCount,
      appendedLines,
      usageStats,
      dataDir: DATA_DIR,
      pricingFile: path.relative(process.cwd(), PRICING_FILE),
    },
  };
}
