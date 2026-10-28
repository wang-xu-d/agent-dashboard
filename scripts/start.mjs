#!/usr/bin/env node
// 一键启动：首次缺索引时自动扫描 → 起本地服务 → 等健康检查通过 → 打开浏览器。
//
// 用法：
//   node scripts/start.mjs               增量启动，就绪后打开浏览器
//   node scripts/start.mjs --no-open     只起服务（服务器 / 远程终端用）
//   node scripts/start.mjs --port 7799   换端口
//   node scripts/start.mjs --full        启动前先全量重扫（清空索引）
//   node scripts/start.mjs --help
//
// Windows 可直接双击根目录的 start.bat；也可以 npm start。

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'src', 'server.js');
const SCAN_ENTRY = path.join(ROOT, 'src', 'cli.js');
const DATA_DIR = process.env.DASH_DATA_DIR || path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);

function getOpt(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  const next = argv[i + 1];
  if (i >= 0 && next && !next.startsWith('--')) return next;
  return fallback;
}

const HELP = `一键启动 Agent Dashboard

用法：node scripts/start.mjs [选项]

选项：
  --no-open         只起服务，不打开浏览器
  --port <n>        监听端口（默认 DASH_PORT 或 7788）
  --full            启动前清空索引做一次全量扫描
  --help            显示这段帮助

行为：
  1. 首次运行（data/index.json 不存在）自动扫描一次
  2. 启动 src/server.js 并轮询 /api/health，就绪后打开面板
  3. 端口上已经有本面板在跑时，不重复启动，直接打开浏览器
  4. Ctrl+C 停止服务`;

if (hasFlag('help') || hasFlag('h')) {
  console.log(HELP);
  process.exit(0);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`[启动器] 需要 Node.js 20 或更新版本，当前是 ${process.versions.node}。`);
  process.exit(1);
}
if (!fs.existsSync(SERVER_ENTRY)) {
  console.error(`[启动器] 找不到 ${SERVER_ENTRY}，请在项目根目录运行。`);
  process.exit(1);
}

const defaultPort = Number(process.env.DASH_PORT || 7788);
const port = Number(getOpt('port', defaultPort));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[启动器] 端口不合法：${getOpt('port', defaultPort)}`);
  process.exit(1);
}

// 服务只监听本机时，健康检查也走 127.0.0.1；0.0.0.0 只是监听地址，不是可访问地址
const host = process.env.DASH_HOST || '127.0.0.1';
const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const baseUrl = `http://${probeHost}:${port}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口能否被本进程占用（true = 空闲）。 */
function isPortFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen({ port, host: probeHost, exclusive: true });
  });
}

/** 端口上是否已经有本面板在跑：判据是 /api/health 返回 ok。 */
async function probeHealth(timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? json.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 用系统默认浏览器打开 URL（失败只提示，不影响服务）。 */
function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => console.log(`[启动器] 无法自动打开浏览器，请手动访问 ${url}`));
    p.unref();
  } catch {
    console.log(`[启动器] 无法自动打开浏览器，请手动访问 ${url}`);
  }
}

/** 前台跑一个子进程，继承输出，等它结束。 */
function runToEnd(entry, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...extraArgs], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[启动器] 启动失败：${err.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

console.log('[启动器] Agent Dashboard');
console.log(`[启动器] 项目目录：${ROOT}`);

// 1) 首次运行没有索引，或显式要求 --full 时，先扫描
if (!fs.existsSync(INDEX_FILE)) {
  console.log('[启动器] 还没有扫描索引，先做一次全量扫描…');
  const code = await runToEnd(SCAN_ENTRY, ['scan', '--full']);
  if (code !== 0) {
    console.error('[启动器] 扫描失败，已中止。可单独运行 npm run scan 排查。');
    process.exit(1);
  }
} else if (hasFlag('full')) {
  console.log('[启动器] 按 --full 重新全量扫描…');
  const code = await runToEnd(SCAN_ENTRY, ['scan', '--full']);
  if (code !== 0) {
    console.error('[启动器] 扫描失败，已中止。');
    process.exit(1);
  }
}

// 2) 端口被占用时：如果占用者就是本面板，直接开浏览器；否则报错退出
const free = await isPortFree();
if (!free) {
  const health = await probeHealth();
  if (health) {
    console.log(`[启动器] ${baseUrl} 上已有一个面板在跑（数据目录 ${health.dataDir}），直接打开。`);
    console.log('[启动器] 这个窗口可以关闭，服务在另一个窗口里继续运行。');
    if (!hasFlag('no-open')) openBrowser(baseUrl);
    await delay(2500);
    process.exit(0);
  }
  console.error(`[启动器] 端口 ${port} 被其他程序占用。`);
  console.error(`[启动器] 换一个端口试试：node scripts/start.mjs --port 7799`);
  process.exit(1);
}

// 3) 启动服务并等待健康检查
console.log(`[启动器] 启动服务：${baseUrl}`);
const server = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DASH_PORT: String(port), DASH_HOST: host },
});

let exitCode = null;
server.on('exit', (code, signal) => {
  exitCode = code ?? (signal ? 130 : 0);
  if (!server.__ready) {
    console.error('[启动器] 服务未能启动，请看上面的报错。');
    process.exit(exitCode || 1);
  }
  console.log(`\n[启动器] 服务已停止（退出码 ${exitCode}）。`);
  process.exit(exitCode);
});

const deadline = Date.now() + 20_000;
let health = null;
while (Date.now() < deadline && exitCode === null) {
  health = await probeHealth(700);
  if (health) break;
  await delay(250);
}

if (!health) {
  console.error('[启动器] 服务在 20 秒内没有就绪，已中止。');
  server.kill();
  process.exit(1);
}

server.__ready = true;
console.log('');
console.log(`[启动器] 就绪 ✓  数据目录：${health.dataDir}`);
console.log(`[启动器] 面板：${baseUrl}`);
console.log(`[启动器] API ：${baseUrl}/api`);
console.log('[启动器] 按 Ctrl+C 停止服务');
console.log('');

if (!hasFlag('no-open')) openBrowser(baseUrl);

// 4) 转发中断信号，保证 Ctrl+C 能干净地关掉子进程
let closing = false;
function shutdown(signal) {
  if (closing) {
    server.kill('SIGKILL');
    process.exit(130);
  }
  closing = true;
  console.log('\n[启动器] 正在停止服务…（再按一次 Ctrl+C 强制结束）');
  server.kill(signal);
  // 子进程若 3 秒内没退出，兜底强杀
  setTimeout(() => {
    if (server.exitCode === null) server.kill('SIGKILL');
  }, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
