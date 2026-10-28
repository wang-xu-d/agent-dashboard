// HTTP API 集成测试：用 fixture 起一个真实服务进程，逐个打端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, applyEnv, cleanup } from './helpers/fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitReady(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${out}`)), timeoutMs);
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('API 已启动')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code=${code}）：${out}`));
    });
  });
}

test('HTTP API：只读端点、脱敏、POST 重扫', async (t) => {
  const fx = makeFixture();
  applyEnv(fx);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, DASH_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitReady(child);
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => {
      const res = await fetch(base + p);
      const json = await res.json();
      return { status: res.status, headers: res.headers, json };
    };

    await t.test('health / agents', async () => {
      const health = await get('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.data.status, 'ok');
      assert.equal(health.headers.get('cache-control'), 'no-store');
      assert.equal(health.headers.get('access-control-allow-origin'), '*');

      const agents = await get('/api/agents');
      const byId = Object.fromEntries(agents.json.data.map((a) => [a.id, a]));
      assert.equal(byId.claude.skillCount, 1);
      assert.equal(byId.claude.mcpCount, 2);
      assert.equal(byId.claude.tokens, 1650);
      assert.equal(byId.codex.skillCount, 2);
      assert.equal(byId.trae.installed, false);
    });

    await t.test('skills / matrix', async () => {
      const all = await get('/api/skills');
      assert.equal(all.json.meta.count, 3);
      assert.deepEqual(all.json.meta.byAgent, { claude: 1, codex: 2 });

      const codex = await get('/api/skills?agent=codex');
      assert.equal(codex.json.meta.count, 2);

      const filtered = await get('/api/skills?q=foo');
      assert.equal(filtered.json.meta.count, 1);
      assert.equal(filtered.json.data[0].name, 'foo');

      const builtin = await get('/api/skills?source=builtin');
      assert.equal(builtin.json.meta.count, 1);

      const matrix = await get('/api/skills/matrix');
      assert.equal(matrix.json.meta.count, 3);
    });

    await t.test('mcps 默认过滤内置工具集 + 脱敏', async () => {
      const r = await get('/api/mcps');
      assert.equal(r.json.meta.count, 4);
      assert.equal(r.json.meta.enabled, 4);
      assert.equal(r.json.meta.builtinBundlesHidden, 0);
      const text = JSON.stringify(r.json);
      assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'));
      assert.ok(!text.includes('super-secret-value'));
      assert.ok(!text.includes('abc123456789012345678901234567890'));

      const withBuiltin = await get('/api/mcps?includeBuiltin=1');
      assert.equal(withBuiltin.json.meta.count, 4);

      const claudeOnly = await get('/api/mcps?agent=claude');
      assert.equal(claudeOnly.json.meta.count, 2);
    });

    await t.test('usage 汇总 / 分组 / 时间窗', async () => {
      const totals = await get('/api/usage');
      assert.equal(totals.json.data.records, 4);
      assert.equal(totals.json.data.totalTokens, 2480);
      assert.ok(Math.abs(totals.json.data.costUSD - 0.01044) < 1e-9);
      assert.equal(totals.json.meta.reported.costUSD, 0.5);

      const byModel = await get('/api/usage?groupBy=model');
      assert.equal(byModel.json.data.length, 2);

      const byAgent = await get('/api/usage?groupBy=agent');
      assert.equal(byAgent.json.data.length, 2);

      const byDay = await get('/api/usage?groupBy=day');
      assert.ok(byDay.json.data.length >= 1);
      assert.equal(
        byDay.json.data.reduce((a, d) => a + d.totalTokens, 0),
        2480,
      );

      const summary = await get('/api/usage/summary?from=2026-10-01&to=2026-10-31');
      assert.equal(summary.json.data.totals.records, 4);

      const future = await get('/api/usage/summary?from=2027-01-01');
      assert.equal(future.json.data.totals.records, 0, '时间窗外应为空，而不是报错');
      assert.equal(future.json.data.reconciliation.reportedCostUSD, 0, '上报成本也要按时间窗过滤');

      const windowed = await get('/api/usage?groupBy=model&agent=codex');
      assert.equal(windowed.json.data.length, 1);
      assert.equal(windowed.json.data[0].model, 'gpt-demo');
    });

    await t.test('pricing', async () => {
      const r = await get('/api/pricing');
      assert.deepEqual(r.json.data.default, { input: 10, output: 20 });
      assert.equal(r.json.data.models['gpt-demo'].input, 2);
      assert.equal(r.json.data.cacheReadMultiplier, 0.1);
    });

    await t.test('POST /api/scan 与错误处理', async () => {
      const res = await fetch(`${base}/api/scan?full=1`, { method: 'POST' });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.data.facts, 4);
      assert.equal(json.meta.full, true);

      const snap = await get('/api/snapshot');
      assert.equal(snap.json.meta.cacheHit, true, 'POST 扫描后快照应直接命中缓存');

      const notFound = await get('/api/nope');
      assert.equal(notFound.status, 404);
      assert.equal(notFound.json.ok, false);

      const wrongMethod = await fetch(`${base}/api/scan`);
      assert.equal(wrongMethod.status, 405);

      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type') || '', /text\/html/);
    });

    await t.test('前端静态资源与路径穿越防护', async () => {
      const index = await fetch(`${base}/`);
      const html = await index.text();
      assert.match(html, /app\.js/, '首页应引用前端脚本');
      assert.match(html, /styles\.css/, '首页应引用样式表');

      const assets = [
        ['/app.js', /javascript/],
        ['/styles.css', /text\/css/],
        ['/favicon.svg', /svg/],
      ];
      for (const [p, type] of assets) {
        const res = await fetch(base + p);
        assert.equal(res.status, 200, `${p} 应可访问`);
        assert.match(res.headers.get('content-type') || '', type, `${p} 的 content-type`);
        assert.equal(res.headers.get('cache-control'), 'no-cache');
      }

      const apiIndex = await get('/api');
      assert.equal(apiIndex.status, 200);
      assert.ok(Array.isArray(apiIndex.json.data) && apiIndex.json.data.length >= 8);
      assert.ok(apiIndex.json.data.some((e) => e.path === '/api/snapshot?refresh=1'));

      // 编码后的 ../ 不应逃出 public/
      const traversal = await fetch(`${base}/..%2fpackage.json`);
      assert.ok([403, 404].includes(traversal.status), `路径穿越应被拒绝，实际 ${traversal.status}`);
      const missing = await fetch(`${base}/nope.js`);
      assert.equal(missing.status, 404);
      const badJson = await missing.json();
      assert.equal(badJson.ok, false);
    });
  } finally {
    child.kill();
    cleanup(fx);
  }
});
