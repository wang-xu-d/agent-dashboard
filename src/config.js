// 全局配置：路径探测、端口、扫描参数。
// 所有路径都允许用环境变量覆盖，方便在测试里指向 fixture 目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.DASH_HOME || os.homedir();

const env = process.env;

// 三个平台的 home 目录（可用 DASH_*_HOME 覆盖）
export const AGENT_HOMES = {
  claude: env.DASH_CLAUDE_HOME || path.join(HOME, '.claude'),
  codex: env.DASH_CODEX_HOME || path.join(HOME, '.codex'),
  trae: env.DASH_TRAE_HOME || path.join(HOME, '.trae-cn'),
};

/** 探测 Trae 系列 IDE 的 User 目录（不同发行版目录名不同：Trae / Trae CN）。 */
export function findTraeUserDirs() {
  if (env.DASH_TRAE_USER_DIR) return fs.existsSync(env.DASH_TRAE_USER_DIR) ? [env.DASH_TRAE_USER_DIR] : [];
  const roaming = env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(roaming, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^trae/i.test(e.name)) continue;
    const userDir = path.join(roaming, e.name, 'User');
    if (fs.existsSync(userDir)) out.push(userDir);
  }
  return out;
}

// 运行时数据（扫描索引 + 用量事实表），不入库
export const DATA_DIR = env.DASH_DATA_DIR || path.join(ROOT, 'data');
export const INDEX_FILE = path.join(DATA_DIR, 'index.json');
export const FACTS_FILE = path.join(DATA_DIR, 'facts.ndjson');

export const SERVER = {
  host: env.DASH_HOST || '127.0.0.1',
  port: Number(env.DASH_PORT || 7788),
};

export const SCAN = {
  // snapshot 内存缓存有效期；超过后下次 GET 会触发增量重扫
  snapshotTtlMs: Number(env.DASH_SNAPSHOT_TTL_MS || 60_000),
  // 目录遍历上限，防止误扫到超大目录
  maxWalkEntries: Number(env.DASH_MAX_WALK || 60_000),
  maxSkillBytes: 256 * 1024,
  // 探测 CLI 版本时的超时
  versionTimeoutMs: 4000,
};

export const PRICING_FILE = env.DASH_PRICING_FILE || path.join(ROOT, 'pricing.json');
