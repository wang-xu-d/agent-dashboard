// 文件系统小工具：安全读写、目录遍历、append-only JSONL 增量读取。
import fs from 'node:fs';
import path from 'node:path';

export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readTextSafe(file, maxBytes = Infinity) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_SKIP = new Set(['node_modules', '.git', '.tmp', 'tmp', 'cache', '.cache', 'dist', 'out']);

/**
 * 广度优先遍历目录，收集满足条件的文件。
 * 不跟随符号链接，跳过 node_modules/.git 等噪音目录，并有总条目上限。
 */
export function walkFiles(root, opts = {}) {
  const {
    match = () => true,
    skipDirs = DEFAULT_SKIP,
    maxEntries = 60_000,
    maxDepth = 12,
  } = opts;
  const files = [];
  if (!exists(root)) return files;
  const queue = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return files;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name) || depth >= maxDepth) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && match(full, e.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * 读取 append-only 文本文件从 offset 开始的新增完整行。
 * 只返回以 \n 结尾的行，避免把正在写入的半行算进去；返回新的安全 offset。
 */
export function readNewLines(file, offset = 0) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { lines: [], offset: 0, size: 0 };
  }
  let start = offset;
  if (stat.size < start) start = 0; // 文件被截断/重写 → 从头读
  if (stat.size === start) return { lines: [], offset: start, size: stat.size };

  const len = stat.size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { lines: [], offset: start, size: stat.size };
  const usable = text.slice(0, lastNl);
  const nextOffset = start + Buffer.byteLength(usable, 'utf8') + 1;
  return { lines: usable.split('\n'), offset: nextOffset, size: stat.size };
}

/** 安全 JSON 解析一行；坏行直接跳过（日志文件常有半行/脏行）。 */
export function parseLine(line) {
  if (!line || line.length < 2) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** FNV-1a 32 位哈希，用于生成稳定的去重键（同一记录重复写入 → 同键）。 */
export function hashKey(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
