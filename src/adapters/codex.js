// Codex (OpenAI Codex Desktop / CLI) 适配器。
// 数据来源（只读）：
//   ~/.codex/config.toml            模型/provider + [mcp_servers.*]
//   ~/.codex/skills/、plugins/      SKILL.md
//   ~/.codex/sessions/**/rollout-*.jsonl   会话事件流（token_usage_record 事件带用量）
import path from 'node:path';
import { AGENT_HOMES, SCAN } from '../config.js';
import { exists, readJsonSafe, readTextSafe, walkFiles, readNewLines, parseLine } from '../lib/fsx.js';
import { parseToml, tomlSectionEntries } from '../lib/toml.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { maskEnv, maskHeaders, maskUrl } from '../lib/mask.js';
import { cliVersion } from '../lib/version.js';

export const id = 'codex';
export const label = 'Codex';

const HOME_DIR = () => AGENT_HOMES.codex;
const configFile = () => path.join(HOME_DIR(), 'config.toml');

function readConfig() {
  const text = readTextSafe(configFile(), 1024 * 1024);
  return parseToml(text || '');
}

export function detect() {
  const home = HOME_DIR();
  const installed = exists(home);
  const cfg = readConfig();
  const providerName = cfg.top.model_provider || null;
  const providerTable = providerName ? cfg.tables[`model_providers.${providerName}`] : null;
  // CLI 可能不在 PATH：优先用 config.toml 里记录的 CODEX_CLI_PATH
  const cliFromConfig = cfg.tables['mcp_servers.node_repl.env']?.CODEX_CLI_PATH || null;
  const version = installed ? cliVersion('codex') || (cliFromConfig ? cliVersion(cliFromConfig) : null) : null;
  return {
    id,
    label,
    installed,
    home,
    configFiles: [configFile()].filter(exists),
    version,
    provider: providerTable?.base_url || providerName,
    models: cfg.top.model ? [cfg.top.model] : [],
    usageAvailable: true,
  };
}

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

export function listSkills() {
  const home = HOME_DIR();
  const items = [];
  const seen = new Set();
  const push = (it) => {
    if (!it || seen.has(it.id)) return;
    seen.add(it.id);
    items.push(it);
  };

  // 用户级 + 内置（.system）
  for (const file of walkFiles(path.join(home, 'skills'), {
    match: (_f, n) => n === 'SKILL.md',
    maxEntries: 20_000,
  })) {
    const isBuiltin = file.includes(`${path.sep}.system${path.sep}`) || file.includes('/.system/');
    push(readSkillFile(file, {
      type: 'skill',
      source: isBuiltin ? 'builtin' : 'user',
      namespace: isBuiltin ? 'system' : null,
    }));
  }

  // 插件缓存里的 skill
  for (const file of walkFiles(path.join(home, 'plugins'), {
    match: (_f, n) => n === 'SKILL.md',
    maxEntries: 30_000,
  })) {
    const rel = path.relative(path.join(home, 'plugins'), file).split(path.sep);
    push(readSkillFile(file, {
      type: 'skill',
      source: 'plugin',
      namespace: rel[0] === 'cache' ? rel[2] || rel[1] : rel[1] || rel[0],
    }));
  }
  return items;
}

export function listMcps() {
  const cfg = readConfig();
  const servers = tomlSectionEntries(cfg.tables, 'mcp_servers');
  const items = [];
  for (const [name, raw] of Object.entries(servers)) {
    const transport = raw.type === 'sse' ? 'sse' : raw.type === 'http' ? 'http' : raw.url ? 'http' : 'stdio';
    const isRemote = transport !== 'stdio';
    items.push({
      id: `${id}:user:${name}`,
      agent: id,
      name,
      scope: 'user',
      transport,
      command: isRemote ? null : raw.command || null,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      url: isRemote ? maskUrl(raw.url || raw.command) : null,
      env: maskEnv(raw.env),
      headers: maskHeaders(raw.headers),
      enabled: raw.enabled !== false,
      toolCount: null,
      sourcePath: configFile(),
    });
  }
  return items;
}

/**
 * 解析 rollout jsonl：session_meta / turn_context / token_usage_record。
 * token_usage_record 的 payload.usage 是"本次响应"的用量（不是累计），直接作为事实。
 */
export function readUsage(emitFact, emitSessionCost, offsets) {
  const root = path.join(HOME_DIR(), 'sessions');
  const files = walkFiles(root, {
    match: (_f, n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    maxEntries: 100_000,
  });
  const cfg = readConfig();
  const configModel = cfg.top.model || null;
  let parsedFiles = 0;
  let sessionMeta = 0;

  for (const file of files) {
    const { lines, offset } = readNewLines(file, offsets[file] || 0);
    offsets[file] = offset;
    if (!lines.length) continue;
    parsedFiles++;

    let sessionId = path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
    let model = configModel;
    let cwd = null;

    for (const line of lines) {
      if (!line.includes('"session_meta"') && !line.includes('"token_usage_record"') && !line.includes('"turn_context"')) {
        continue;
      }
      const rec = parseLine(line);
      if (!rec) continue;
      const p = rec.payload || {};

      if (rec.type === 'session_meta') {
        sessionMeta++;
        sessionId = p.session_id || p.id || sessionId;
        cwd = p.cwd || cwd;
        model = p.model || model;
        continue;
      }
      if (rec.type === 'turn_context') {
        cwd = p.cwd || cwd;
        model = p.model || p.model_slug || model;
        continue;
      }
      if (rec.type !== 'token_usage_record') continue;

      const u = p.usage;
      if (!u) continue;
      emitFact({
        key: `${id}:${sessionId}:${p.response_id || rec.ordinal}`,
        agent: id,
        ts: Date.parse(rec.timestamp) || null,
        model: model || 'unknown',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cached_input_tokens || 0,
        cacheWrite: u.cache_write_input_tokens || 0,
        sessionId,
        cwd: cwd || p.cwd || null,
        subagent: Boolean(p.sub_agent || p.initiating_agent_path),
        sourceFile: file,
      });
    }

    // Codex 不在本地写 costUSD，成本只能靠单价表/反推
    emitSessionCost({
      agent: id,
      sessionId,
      cwd,
      totalCostUSD: null,
      models: null,
      sourceFile: file,
    });
  }
  return { files: files.length, parsedFiles, sessionMeta };
}
