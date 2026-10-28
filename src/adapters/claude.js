// Claude Code 适配器。
// 数据来源（均为只读）：
//   ~/.claude/                     settings.json、skills/、plugins/、projects/（会话 jsonl）
//   ~/.claude.json                 mcpServers（全局）、projects[*].mcpServers（项目级）、skillUsage
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_HOMES, HOME, SCAN } from '../config.js';
import { exists, readJsonSafe, readTextSafe, walkFiles, readNewLines, parseLine } from '../lib/fsx.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { maskEnv, maskHeaders, maskUrl } from '../lib/mask.js';
import { cliVersion } from '../lib/version.js';

export const id = 'claude';
export const label = 'Claude Code';

const HOME_DIR = () => AGENT_HOMES.claude;
const GLOBAL_JSON = () => path.join(HOME, '.claude.json');
const settingsFile = () => path.join(HOME_DIR(), 'settings.json');

const SKIP_MARKETPLACE = new Set(['node_modules', '.git', '.tmp']);

function readSkillFile(file, meta) {
  const text = readTextSafe(file, SCAN.maxSkillBytes);
  if (!text) return null;
  const fm = parseFrontmatter(text);
  const name = fm.name || path.basename(path.dirname(file));
  return {
    id: `${id}:${meta.type}:${name}@${meta.namespace || 'local'}`,
    agent: id,
    name,
    description: fm.description || '',
    type: meta.type,
    source: meta.source,
    namespace: meta.namespace || null,
    version: fm.version || null,
    enabled: meta.enabled !== false,
    path: file,
  };
}

/** 扫描 skills / commands / agents 三类可加载单元。 */
export function listSkills() {
  const home = HOME_DIR();
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  // 1) 用户级 skills：<home>/skills/<name>/SKILL.md
  for (const file of walkFiles(path.join(home, 'skills'), {
    match: (_f, name) => name === 'SKILL.md',
    maxEntries: 20_000,
  })) {
    push(readSkillFile(file, { type: 'skill', source: 'user' }));
  }

  // 2) marketplace：<home>/plugins/marketplaces/<mkt>/skills/<name>/SKILL.md
  for (const file of walkFiles(path.join(home, 'plugins', 'marketplaces'), {
    match: (_f, name) => name === 'SKILL.md',
    skipDirs: SKIP_MARKETPLACE,
    maxEntries: 20_000,
  })) {
    const rel = path.relative(path.join(home, 'plugins', 'marketplaces'), file).split(path.sep);
    push(readSkillFile(file, { type: 'skill', source: 'marketplace', namespace: rel[0] }));
  }

  // 3) 插件缓存：<home>/plugins/cache/<mkt>/<plugin>/<ver>/skills/<name>/SKILL.md
  for (const file of walkFiles(path.join(home, 'plugins', 'cache'), {
    match: (_f, name) => name === 'SKILL.md',
    skipDirs: SKIP_MARKETPLACE,
    maxEntries: 20_000,
  })) {
    const rel = path.relative(path.join(home, 'plugins', 'cache'), file).split(path.sep);
    push(readSkillFile(file, { type: 'skill', source: 'plugin', namespace: rel[1] || rel[0] }));
  }

  // 4) 自定义 slash commands / subagents（单文件 .md）
  for (const [dirName, type] of [['commands', 'command'], ['agents', 'agent']]) {
    for (const file of walkFiles(path.join(home, dirName), {
      match: (_f, name) => name.endsWith('.md'),
      maxDepth: 1,
      maxEntries: 5_000,
    })) {
      push(readSkillFile(file, { type, source: 'user' }));
    }
  }

  // 使用次数（~/.claude.json 的 skillUsage，很有价值的一列）
  const usage = readJsonSafe(GLOBAL_JSON(), {})?.skillUsage || {};
  for (const item of items) {
    const u = usage[item.name] || usage[`project:${item.name}`];
    if (u) {
      item.usageCount = u.usageCount ?? 0;
      item.lastUsedAt = u.lastUsedAt ?? null;
    }
  }
  return items;
}

function normalizeMcpEntry(name, raw, meta) {
  if (!raw || typeof raw !== 'object') return null;
  const transport = raw.type === 'sse' ? 'sse' : raw.type === 'http' ? 'http' : raw.url ? 'http' : 'stdio';
  const isRemote = transport !== 'stdio';
  return {
    id: `${id}:${meta.scope}:${name}`,
    agent: id,
    name,
    scope: meta.scope,
    transport,
    command: isRemote ? null : raw.command || null,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    url: isRemote ? maskUrl(raw.url || raw.command) : null,
    env: maskEnv(raw.env),
    headers: maskHeaders(raw.headers),
    enabled: meta.enabled !== false,
    toolCount: null, // Claude 不落地工具清单，只能运行时发现
    sourcePath: meta.sourcePath,
  };
}

/** 扫描 MCP 配置：全局 + 项目级 + 项目目录下的 .mcp.json。 */
export function listMcps() {
  const items = [];
  const g = readJsonSafe(GLOBAL_JSON(), {}) || {};
  const settings = readJsonSafe(settingsFile(), {}) || {};

  const addMap = (map, meta) => {
    for (const [name, raw] of Object.entries(map || {})) {
      const it = normalizeMcpEntry(name, raw, meta);
      if (it) items.push(it);
    }
  };

  addMap(g.mcpServers, { scope: 'user', sourcePath: GLOBAL_JSON() });
  addMap(settings.mcpServers, { scope: 'user', sourcePath: settingsFile() });

  // 项目级：projects[cwd].mcpServers / disabledMcpServers
  for (const [cwd, proj] of Object.entries(g.projects || {})) {
    if (!proj || typeof proj !== 'object') continue;
    const disabled = new Set(proj.disabledMcpServers || []);
    for (const [name, raw] of Object.entries(proj.mcpServers || {})) {
      const it = normalizeMcpEntry(name, raw, {
        scope: 'project',
        enabled: !disabled.has(name),
        sourcePath: GLOBAL_JSON(),
      });
      if (it) items.push({ ...it, projectCwd: cwd });
    }
    // 项目目录里的 .mcp.json
    const dotMcp = path.join(cwd, '.mcp.json');
    if (exists(dotMcp)) {
      const parsed = readJsonSafe(dotMcp, {}) || {};
      for (const [name, raw] of Object.entries(parsed.mcpServers || {})) {
        const it = normalizeMcpEntry(name, raw, { scope: 'project', sourcePath: dotMcp });
        if (it) items.push({ ...it, projectCwd: cwd, fromProjectFile: true });
      }
    }
  }
  return items;
}

/**
 * 增量解析 Claude 会话日志，产出用量事实与"会话级平台上报成本"。
 * @param {(fact:object)=>void} emitFact
 * @param {(report:object)=>void} emitSessionCost
 * @param {Record<string, number>} offsets 每个文件已解析到的字节偏移（会被就地更新）
 */
export function readUsage(emitFact, emitSessionCost, offsets) {
  const root = path.join(HOME_DIR(), 'projects');
  const files = walkFiles(root, { match: (_f, n) => n.endsWith('.jsonl'), maxEntries: 200_000 });
  let parsedFiles = 0;

  for (const file of files) {
    const { lines, offset } = readNewLines(file, offsets[file] || 0);
    offsets[file] = offset;
    if (!lines.length) continue;
    parsedFiles++;

    // 同一文件里 cost-state 是累计快照，只保留最后一条
    let lastCostState = null;

    for (const line of lines) {
      // 廉价预过滤，避免对 90% 的行做 JSON.parse
      if (!line.includes('"usage"') && !line.includes('"cost-state"')) continue;
      const rec = parseLine(line);
      if (!rec) continue;

      if (rec.type === 'cost-state') {
        lastCostState = rec;
        continue;
      }
      if (rec.type !== 'assistant') continue;

      const msg = rec.message;
      const u = msg?.usage;
      if (!u) continue;

      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const cacheWrite = u.cache_creation_input_tokens || 0;
      // `<synthetic>` 是本地合成的记录（0 token），不产生费用
      if (input + output + cacheRead + cacheWrite === 0) continue;

      const model = msg.model || rec.requestedModel || 'unknown';
      // 一次 API 响应会被写成多条 assistant 记录：首条是流式中间态（out=0、无 cache），
      // 后续几条是同一份最终 usage 的重复写入。因此按 message.id 去重，
      // 由上层保留"token 总量最大"的那条（见 scan.js 的 emitFact）。
      const messageId = msg.id || rec.uuid;
      const key = `${id}:${rec.sessionId || path.basename(file, '.jsonl')}:${messageId}`;

      emitFact({
        key,
        agent: id,
        ts: Date.parse(rec.timestamp) || null,
        model,
        input,
        output,
        cacheRead,
        cacheWrite,
        sessionId: rec.sessionId || null,
        cwd: rec.cwd || null,
        subagent: rec.isSidechain === true,
        sourceFile: file,
      });
    }

    if (lastCostState && lastCostState.modelUsage) {
      // 会话文件没有自带汇总时间；用文件 mtime 近似会话最后活动时间，
      // 供按时间窗过滤上报成本（增量读取时也拿得到）。
      let sessionTs = null;
      try {
        sessionTs = Math.round(fs.statSync(file).mtimeMs);
      } catch {
        sessionTs = null;
      }
      emitSessionCost({
        agent: id,
        sessionId: lastCostState.sessionId || path.basename(file, '.jsonl'),
        cwd: null,
        ts: sessionTs,
        totalCostUSD: lastCostState.totalCostUSD ?? null,
        models: lastCostState.modelUsage,
        sourceFile: file,
      });
    }
  }
  return { files: files.length, parsedFiles };
}

export function detect() {
  const home = HOME_DIR();
  const installed = exists(home) || exists(GLOBAL_JSON());
  const settings = readJsonSafe(settingsFile(), {}) || {};
  const baseUrl = settings.env?.ANTHROPIC_BASE_URL || null;
  return {
    id,
    label,
    installed,
    home,
    configFiles: [GLOBAL_JSON(), settingsFile()].filter(exists),
    version: installed ? cliVersion('claude') : null,
    provider: baseUrl,
    models: Object.keys(settings.modelSettings || {}),
    usageAvailable: true,
  };
}
