// 探测 CLI 版本号（只探测一次，失败就返回 null，不重试）。
import { execFileSync } from 'node:child_process';
import { SCAN } from '../config.js';

const cache = new Map();

export function cliVersion(cmd, args = ['--version']) {
  const key = `${cmd} ${args.join(' ')}`;
  if (cache.has(key)) return cache.get(key);
  let version = null;
  try {
    const out = execFileSync(cmd, args, {
      timeout: SCAN.versionTimeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    version = String(out).trim().split(/\r?\n/)[0].slice(0, 80) || null;
  } catch {
    version = null;
  }
  cache.set(key, version);
  return version;
}
