#!/usr/bin/env node
// 本地预览静态演示站（不起 API，只托管 demo/ 里的文件）。
//
// 用法：node scripts/preview-demo.mjs [--port 7800] [--out demo]
//
// 目的：在推送 GitHub Pages 之前，用和线上一致的「纯静态」方式检查页面。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const out = { port: 7800, dir: 'demo', help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || 7800;
    else if (argv[i] === '--out') out.dir = argv[++i] || 'demo';
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('用法：node scripts/preview-demo.mjs [--port 7800] [--out demo]');
  process.exit(0);
}

const root = path.resolve(PROJECT_ROOT, opts.dir);
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`[demo] 未找到 ${path.join(root, 'index.html')}\n[demo] 请先运行：node scripts/build-demo.mjs`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  const inside = path.relative(root, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`未找到：${pathname}`);
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
});

server.listen(opts.port, '127.0.0.1', () => {
  console.log(`[demo] 静态演示站已启动：http://127.0.0.1:${opts.port}`);
  console.log(`[demo] 目录：${root}`);
  console.log('[demo] 这是纯静态预览（不能重新扫描），与 GitHub Pages 上的行为一致。');
});
