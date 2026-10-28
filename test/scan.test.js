// 扫描层集成测试：用 fixture 目录跑真实的 detect / listSkills / listMcps / readUsage，
// 并校验去重、增量、成本与上报对账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeFixture, applyEnv, cleanup } from './helpers/fixture.js';

const fx = makeFixture();
applyEnv(fx);
const { scan, getSnapshot, aggregateUsage, loadPricing, readFactsFile } = await import('../src/scan.js');

test('扫描层：agent / skill / MCP / 用量去重与成本', async (t) => {
  const snap = await scan({ full: true });

  await t.test('agent 探测', () => {
    const byId = Object.fromEntries(snap.agents.map((a) => [a.id, a]));
    assert.equal(byId.claude.installed, true);
    assert.equal(byId.codex.installed, true);
    assert.equal(byId.trae.installed, false, 'fixture 里没有 Trae 目录，不应判为已安装');
    assert.equal(byId.trae.usageAvailable, false);
  });

  await t.test('skill 扫描（用户级 + 内置）', () => {
    const names = snap.skills.map((s) => `${s.agent}:${s.name}:${s.source}`);
    assert.ok(names.includes('claude:demo-skill:user'), names.join(', '));
    assert.ok(names.includes('codex:foo:user'));
    assert.ok(names.includes('codex:bar:builtin'));
    assert.equal(snap.skills.length, 3);
    const demo = snap.skills.find((s) => s.name === 'demo-skill');
    assert.equal(demo.usageCount, 7, '应合并 ~/.claude.json 里的 skillUsage');
    assert.equal(demo.enabled, true);
    assert.equal(snap.skillMatrix.length, 3);
  });

  await t.test('MCP 扫描 + 密钥脱敏', () => {
    const names = snap.mcps.map((m) => `${m.agent}:${m.name}`).sort();
    assert.deepEqual(names, ['claude:demo-mcp', 'claude:global-mcp', 'codex:demo-http', 'codex:demo-stdio']);

    const demoMcp = snap.mcps.find((m) => m.name === 'demo-mcp');
    assert.equal(demoMcp.transport, 'stdio');
    assert.equal(demoMcp.env.DEMO_API_KEY, '***3456');
    assert.equal(demoMcp.env.DEMO_MODE, 'fast', '非敏感变量应保留可读');

    const globalMcp = snap.mcps.find((m) => m.name === 'global-mcp');
    assert.equal(globalMcp.transport, 'http');
    assert.ok(globalMcp.url.includes('key=***'), globalMcp.url);

    const demoHttp = snap.mcps.find((m) => m.name === 'demo-http');
    assert.ok(demoHttp.url.includes('token=***'), demoHttp.url);

    const text = JSON.stringify(snap);
    assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'), '快照里不能出现明文密钥');
    assert.ok(!text.includes('abc123456789012345678901234567890'));
    assert.ok(!text.includes('super-secret-value'));
  });

  await t.test('用量去重 + 成本计算', () => {
    const u = snap.usage;
    // 手工核对：claude msg_1 (100/50/1000/200) + msg_2 (200/100) + codex resp_1 (200/20/500) + resp_2 (100/10)
    assert.equal(u.totals.records, 4, '同 message.id 的 3 条记录应只算 1 条，<synthetic> 应跳过');
    assert.equal(u.totals.input, 600);
    assert.equal(u.totals.output, 180);
    assert.equal(u.totals.cacheRead, 1500);
    assert.equal(u.totals.cacheWrite, 200);
    assert.equal(u.totals.totalTokens, 2480);
    assert.equal(u.totals.unknownCostTokens, 0);
    // claude：(100+1000*0.1+200*1.25)*10/1e6 + 50*20/1e6 = 0.0055
    //          (200)*10/1e6 + 100*20/1e6 = 0.004
    // codex： gpt-demo 走 models 表 2/8 → (200+500*0.1)*2/1e6 + 20*8/1e6 = 0.00066
    //                                  (100)*2/1e6 + 10*8/1e6 = 0.00028
    assert.ok(Math.abs(u.totals.costUSD - 0.01044) < 1e-9, `实际 ${u.totals.costUSD}`);

    const models = Object.fromEntries(u.byModel.map((m) => [m.model, m]));
    assert.equal(models['gpt-demo'].priceSource, 'table');
    assert.equal(models['demo-model'].priceSource, 'default', '无显式单价时用 default 兜底');
    assert.ok(!models['<synthetic>'], '<synthetic> 不应出现在模型列表');

    const agents = Object.fromEntries(u.byAgent.map((b) => [b.agent, b]));
    assert.equal(agents.claude.totalTokens, 1650);
    assert.equal(agents.codex.totalTokens, 830);
    assert.equal(u.byProject[0].cwd, 'C:/proj');
  });

  await t.test('平台上报成本与交叉校验', () => {
    const u = snap.usage;
    assert.equal(u.reported.sessions, 1, '只有 Claude 有 cost-state');
    assert.equal(u.reported.costUSD, 0.5);
    assert.equal(u.reported.tokens.input, 300);
    assert.equal(u.reported.tokens.cacheRead, 1000);
    assert.equal(u.reported.byModel[0].model, 'demo-model');
    assert.ok(Math.abs(u.reconciliation.ratio - 0.01044 / 0.5) < 1e-9);
  });

  await t.test('归属字段与增量索引', () => {
    assert.equal(snap.meta.facts, 4);
    assert.equal(snap.meta.newFacts, 4);
    const index = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'index.json'), 'utf8'));
    assert.ok(Object.keys(index.offsets).length >= 2, '应记录两个日志文件的读取偏移');
    assert.ok(index.reported['claude:s1']);
    assert.equal(index.reported['codex:codex-s1'].totalCostUSD, null, 'Codex 不写 costUSD');
  });
});

test('增量扫描：新增日志行只产生新事实，全量重扫口径一致', async () => {
  const claudeJsonl = path.join(fx.claudeHome, 'projects', 'demo', 's1.jsonl');
  const extra = {
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-11-05T12:00:00.000Z',
    cwd: 'C:/proj2',
    message: { id: 'msg_4', model: 'demo-model', usage: { input_tokens: 1000, output_tokens: 100 } },
  };
  fs.appendFileSync(claudeJsonl, `${JSON.stringify(extra)}\n`);

  const inc = await scan({});
  assert.equal(inc.meta.newFacts, 1);
  assert.equal(inc.meta.facts, 5);
  assert.equal(inc.usage.totals.records, 5);
  assert.equal(inc.usage.totals.input, 1600);
  assert.equal(inc.usage.totals.output, 280);
  assert.equal(inc.usage.byDay.length, 2, '跨天后应有两个日期分组');

  // 再扫一次：没有新内容
  const again = await scan({});
  assert.equal(again.meta.newFacts, 0);
  assert.equal(again.meta.facts, 5);

  // 全量重扫：结果口径必须与增量一致
  const full = await scan({ full: true });
  assert.equal(full.meta.facts, 5);
  assert.equal(full.usage.totals.records, 5);
  assert.equal(full.usage.totals.input, 1600);
  assert.equal(full.usage.totals.costUSD, inc.usage.totals.costUSD);

  // 时间窗过滤：11-05 只有 1 条
  const facts = readFactsFile();
  const pricing = loadPricing({});
  const windowed = aggregateUsage(facts, {}, pricing, { from: '2026-10-25' });
  assert.equal(windowed.totals.records, 1);
  assert.equal(windowed.totals.input, 1000);

  // 平台过滤
  const onlyClaude = aggregateUsage(facts, {}, pricing, { agent: 'claude' });
  assert.equal(onlyClaude.totals.records, 3);
  assert.equal(onlyClaude.byAgent.length, 1);
});

test('getSnapshot 命中内存缓存', async () => {
  await scan({});
  const a = await getSnapshot({});
  const b = await getSnapshot({});
  assert.equal(a.meta.facts, 5);
  assert.equal(b.cacheHit, true);
  cleanup(fx);
});
