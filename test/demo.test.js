// 演示站构建测试：跑一次真实构建，检查产物完整、数据量合理、且没有泄漏构建机路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['claude', 'codex', 'trae'];
const BUCKETS = ['7', '30', '90', 'all'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('build-demo 生成完整静态演示站', () => {
  const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dash-demo-test-')), 'demo');
  try {
    const res = spawnSync(process.execPath, ['scripts/build-demo.mjs', '--out', outDir], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `构建失败：\n${res.stderr || res.stdout}`);

    // 1) 前端与静态入口齐全
    for (const file of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'api/snapshot.json', 'api/index.json', 'api/pricing.json']) {
      assert.ok(fs.existsSync(path.join(outDir, file)), `缺少 ${file}`);
    }
    for (const bucket of BUCKETS) {
      for (const agent of ['all', ...AGENTS]) {
        assert.ok(fs.existsSync(path.join(outDir, 'api', `usage-${bucket}-${agent}.json`)), `缺少 usage-${bucket}-${agent}.json`);
      }
    }

    // 2) index.html 注入了 demo 标记与横幅，并把 /api 链接改到静态文件
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /window\.__DEMO__ = true/);
    assert.match(html, /demo-strip/);
    assert.match(html, /href="api\/index\.json"/);
    assert.match(html, /在线演示/);
    assert.ok(!html.includes('href="/api"'), '演示页不应再引用 /api 服务端点');

    // 3) snapshot 与真实 /api/snapshot 同 schema，且三个平台都已安装
    const snap = readJson(path.join(outDir, 'api', 'snapshot.json')).data;
    assert.deepEqual(snap.agents.map((a) => a.id), AGENTS);
    assert.ok(snap.agents.every((a) => a.installed), '演示数据应覆盖三个平台');
    assert.ok(snap.skills.length >= 30, `skill 太少：${snap.skills.length}`);
    assert.ok(snap.mcps.length >= 8, `MCP 太少：${snap.mcps.length}`);
    assert.ok(snap.skillMatrix.length >= 20);
    assert.ok(snap.usage.totals.records > 500, `用量记录太少：${snap.usage.totals.records}`);
    assert.ok(snap.usage.totals.totalTokens > 1e6);

    // 4) 成本对账：比值应落在可解释区间（演示数据按自算成本的 1.25× 生成上报账单）
    const ratio = snap.usage.reconciliation.ratio;
    assert.ok(Number.isFinite(ratio) && ratio > 0.7 && ratio < 1.3, `对账比值异常：${ratio}`);

    // 5) 单价来源覆盖 table / derived / default 三种
    const sources = new Set(snap.usage.byModel.map((m) => m.priceSource));
    for (const s of ['table', 'derived', 'default']) assert.ok(sources.has(s), `缺少单价来源：${s}`);

    // 6) 时间窗汇总：30 天窗口的 byDay 不应超过 30 天，且 7 天窗口明显小于全部
    const u30 = readJson(path.join(outDir, 'api', 'usage-30-claude.json')).data;
    assert.ok(u30.byDay.length <= 30, `30 天窗口返回了 ${u30.byDay.length} 天`);
    assert.ok(u30.totals.records > 0);
    const u7 = readJson(path.join(outDir, 'api', 'usage-7-all.json')).data;
    const uAll = readJson(path.join(outDir, 'api', 'usage-all-all.json')).data;
    assert.ok(u7.totals.records < uAll.totals.records);
    assert.ok(u7.byDay.length <= 7);

    // 7) 脱敏：JSON 与 HTML 里都不应出现构建机的临时目录 / 用户名
    const tmpPosix = os.tmpdir().split(path.sep).join('/');
    const needles = [tmpPosix, 'agent-dash-demo-', process.env.USERNAME || 'wangx'].filter(Boolean);
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(json|html|js|css|svg)$/.test(e.name)) files.push(full);
      }
    };
    walk(outDir);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of needles) {
        assert.ok(!text.includes(needle), `${path.relative(outDir, file)} 泄漏了本地路径：${needle}`);
      }
    }

    // 8) 9 个 MCP 的 env / URL / 启动参数仍应保留脱敏痕迹
    const mcpText = JSON.stringify(snap.mcps);
    assert.ok(mcpText.includes('***'), 'MCP 配置里应能看到脱敏后的密钥');
    assert.ok(!mcpText.includes('demo-fs-key-1234567890'), '明文密钥不应进入演示数据');
  } finally {
    fs.rmSync(path.dirname(outDir), { recursive: true, force: true });
  }
});
