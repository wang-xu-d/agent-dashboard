// Trae CN 适配器。
// 数据来源（只读）：
//   ~/.trae-cn/skills、builtin_skills、builtin、plugins/<registry>/<plugin>/<ver>/skills   → skill
//   ~/.trae-cn/skill-config.json         启用/禁用/删除状态
//   <APPDATA>/Trae CN/User/mcp.json      MCP 配置（带 disabled 标记）
//   ~/.trae-cn/mcps/**/tools/*.json      运行时缓存的 MCP 工具清单（可数出工具数）
//   <LOCALAPPDATA>/Programs/Trae CN/resources/app/package.json   版本号
// 说明：Trae 不在本地落 token/费用日志，因此 usageAvailable = false（不伪造数据）。
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_HOMES, SCAN, findTraeUserDirs, HOME } from '../config.js';
import { exists, readJsonSafe, readTextSafe, walkFiles } from '../lib/fsx.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { maskEnv, maskHeaders, maskUrl } from '../lib/mask.js';

export const id = 'trae';
export const label = 'Trae CN';

const HOME_DIR = () => AGENT_HOMES.trae;
const skillConfigFile = () => path.join(HOME_DIR(), 'skill-config.json');

function productInfo() {
  const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const names = ['Trae CN', 'Trae'];
  for (const n of names) {
    const cands = [
      path.join(local, 'Programs', n, 'resources', 'app', 'package.json'),
      path.join(local, n, 'resources', 'app', 'package.json'),
      path.join(roaming, n, 'resources', 'app', 'package.json'),
    ];
    for (const c of cands) {
      const pkg = readJsonSafe(c, null);
      if (pkg?.version) return { version: pkg.version, productName: pkg.name || n, appPath: c };
    }
  }
  return { version: null, productName: null, appPath: null };
}

export function detect() {
  const home = HOME_DIR();
  const userDirs = findTraeUserDirs();
  const info = productInfo();
  return {
    id,
    label,
    installed: exists(home) || userDirs.length > 0,
    home,
    configFiles: [skillConfigFile(), ...userDirs.map((d) => path.join(d, 'mcp.json'))].filter(exists),
    version: info.version,
    provider: null,
    models: [],
    usageAvailable: false,
    usageNote: 'Trae 未在本地写 token/费用日志，当前只统计 skill 与 MCP',
  };
}

function norm(name) {
  return String(name || '').toLowerCase().replace(/[\s_\-.]/g, '');
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
  const cfg = readJsonSafe(skillConfigFile(), {}) || {};
  const disabled = new Set(cfg.disabledSkills || []);
  const deleted = new Set(cfg.deletedSkills || []);
  const builtinStatus = cfg.builtinSkillStatus || {};
  const managed = cfg.managedSkills || {};

  const items = [];
  const seen = new Set();
  const push = (it) => {
    if (!it || seen.has(it.id)) return;
    if (deleted.has(it.name)) return;
    seen.add(it.id);
    items.push(it);
  };

  const isEnabled = (name) => {
    if (disabled.has(name)) return false;
    if (builtinStatus[name] === false) return false;
    return true;
  };

  const roots = [
    { dir: path.join(home, 'skills'), source: 'user' },
    { dir: path.join(home, 'builtin_skills'), source: 'builtin' },
    { dir: path.join(home, 'builtin'), source: 'builtin' },
  ];
  for (const r of roots) {
    for (const file of walkFiles(r.dir, { match: (_f, n) => n === 'SKILL.md', maxEntries: 30_000 })) {
      const base = path.basename(path.dirname(file));
      push(readSkillFile(file, {
        type: 'skill',
        source: r.source,
        namespace: r.source === 'user' ? null : 'builtin',
        enabled: isEnabled(base),
      }));
    }
  }

  // marketplace 插件：<home>/plugins/<registry>/<plugin>/<ver>/skills/**/SKILL.md
  for (const file of walkFiles(path.join(home, 'plugins'), {
    match: (_f, n) => n === 'SKILL.md',
    maxEntries: 40_000,
  })) {
    const rel = path.relative(path.join(home, 'plugins'), file).split(path.sep);
    const plugin = rel[1] || rel[0];
    const base = path.basename(path.dirname(file));
    push(readSkillFile(file, {
      type: 'skill',
      source: managed[base] === 'marketplace' || rel[0] === 'trae-remote-official' ? 'marketplace' : 'plugin',
      namespace: plugin,
      enabled: isEnabled(base),
    }));
  }
  return items;
}

/** 从 ~/.trae-cn/mcps 的运行时缓存里数出每个 server 的工具数。 */
function discoveredTools() {
  const root = path.join(HOME_DIR(), 'mcps');
  const files = walkFiles(root, {
    match: (f) => /[\\/]tools[\\/][^\\/]+\.json$/.test(f),
    maxEntries: 60_000,
    maxDepth: 8,
  });
  const byServer = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep);
    // 期望形状：<scope>/<agentKind>/<serverDir>/tools/<tool>.json
    const toolsIdx = rel.indexOf('tools');
    if (toolsIdx <= 0) continue;
    const serverDir = rel[toolsIdx - 1];
    const scope = rel[0];
    const agentKind = rel[1] && rel[1] !== serverDir ? rel[1] : null;

    let meta = null;
    const metaFile = path.join(root, ...rel.slice(0, toolsIdx), 'SERVER_METADATA.json');
    if (exists(metaFile)) meta = readJsonSafe(metaFile, null);

    const displayName = (meta?.server_name || serverDir).replace(/^mcp_/, '');
    const key = norm(displayName);
    const entry = byServer.get(key) || {
      name: displayName,
      description: meta?.description || null,
      toolCount: 0,
      tools: [],
      scopes: new Set(),
      agentKinds: new Set(),
    };
    entry.toolCount++;
    const toolName = path.basename(file, '.json');
    if (entry.tools.length < 200) entry.tools.push(toolName);
    entry.scopes.add(scope);
    if (agentKind) entry.agentKinds.add(agentKind);
    byServer.set(key, entry);
  }
  return byServer;
}

export function listMcps() {
  const items = [];
  const seen = new Set();
  const discovered = discoveredTools();

  for (const userDir of findTraeUserDirs()) {
    const file = path.join(userDir, 'mcp.json');
    const cfg = readJsonSafe(file, {}) || {};
    for (const [name, raw] of Object.entries(cfg.mcpServers || {})) {
      if (!raw || typeof raw !== 'object') continue;
      const transport = raw.url ? 'http' : 'stdio';
      const d = discovered.get(norm(name));
      const it = {
        id: `${id}:user:${name}`,
        agent: id,
        name,
        scope: 'user',
        transport,
        command: transport === 'stdio' ? raw.command || null : null,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        url: transport === 'http' ? maskUrl(raw.url) : null,
        env: maskEnv(raw.env),
        headers: maskHeaders(raw.headers),
        enabled: raw.disabled ? false : true,
        toolCount: d?.toolCount ?? null,
        tools: d?.tools || [],
        workspaces: d ? [...d.scopes] : [],
        agentKinds: d ? [...d.agentKinds] : [],
        sourcePath: file,
      };
      items.push(it);
      seen.add(norm(name));
    }
  }

  // 只在运行时缓存里出现、配置里已经删掉的 server 也列出来（灰色，便于清理）。
  // `integrated_*` 是 Trae 内置工具集（浏览器 / 代码模式等），不是用户装的 MCP，
  // 单独标成 scope='builtin'，默认列表里会被前端/接口过滤掉。
  for (const [key, d] of discovered) {
    if (seen.has(key)) continue;
    const isBuiltin = /^integrated/i.test(d.name) || d.agentKinds.size === 0;
    items.push({
      id: `${id}:runtime:${d.name}`,
      agent: id,
      name: d.name,
      scope: isBuiltin ? 'builtin' : 'runtime-cache',
      transport: null,
      command: null,
      args: [],
      url: null,
      env: {},
      headers: {},
      enabled: null,
      description: d.description,
      toolCount: d.toolCount,
      tools: d.tools,
      workspaces: [...d.scopes],
      agentKinds: [...d.agentKinds],
      sourcePath: path.join(HOME_DIR(), 'mcps'),
    });
  }
  return items;
}

export function readUsage(emitFact, emitSessionCost, offsets) {
  // Trae 没有本地 token 日志：明确返回 0 文件，由上层标注 usageAvailable=false
  void emitFact;
  void emitSessionCost;
  void offsets;
  return { files: 0, parsedFiles: 0, unsupported: true };
}
