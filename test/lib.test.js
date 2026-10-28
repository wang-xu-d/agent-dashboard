// 纯函数单测：单价、TOML/YAML 解析、脱敏、增量读取。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeModel, resolvePrice, costOf, derivePrices } from '../src/lib/pricing.js';
import { parseToml, tomlSectionEntries } from '../src/lib/toml.js';
import { parseFrontmatter } from '../src/lib/frontmatter.js';
import { looksSecret, maskEnv, maskHeaders, maskUrl, maskValue, maskArgs } from '../src/lib/mask.js';
import { readNewLines, walkFiles } from '../src/lib/fsx.js';

test('normalizeModel 去掉上下文后缀与 provider 前缀', () => {
  assert.equal(normalizeModel('gpt-6.1-sol[1m]'), 'gpt-6.1-sol');
  assert.equal(normalizeModel('anthropic/claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('  Qwen3.8-Max  '), 'qwen3.8-max');
  assert.equal(normalizeModel(null), 'unknown');
});

test('costOf 按 输入 + 缓存读*0.1 + 缓存写*1.25 计价', () => {
  const pricing = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };
  const usage = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 };
  // (100 + 100*0 + 1000*0.1 + 200*1.25) = 450 → 450 * 10/1e6 = 0.0045；输出 50 * 20/1e6 = 0.001
  const { costUSD, priceSource } = costOf(usage, { input: 10, output: 20, source: 'table' }, pricing);
  assert.equal(priceSource, 'table');
  assert.ok(Math.abs(costUSD - 0.0055) < 1e-12, `实际 ${costUSD}`);
});

test('resolvePrice 优先级：models → derived → default → null', () => {
  const pricing = {
    models: { 'a-model': { input: 1, output: 2 } },
    derived: { 'a-model': { input: 9, output: 9 }, 'b-model': { input: 3, output: 4 } },
    default: { input: 5, output: 6 },
  };
  assert.equal(resolvePrice('a-model', pricing).source, 'table');
  assert.equal(resolvePrice('b-model', pricing).source, 'derived');
  assert.equal(resolvePrice('c-model', pricing).source, 'default');
  assert.equal(resolvePrice('c-model', { models: {}, derived: {} }), null);
});

test('derivePrices 能从样本里还原单价（3 个以上样本）', () => {
  const samples = [
    { input: 1_000_000, output: 0, costUSD: 5 },
    { input: 0, output: 1_000_000, costUSD: 25 },
    { input: 500_000, output: 200_000, costUSD: 2.5 + 5 },
  ];
  const p = derivePrices(samples);
  assert.ok(p, '应能解出单价');
  assert.ok(Math.abs(p.input - 5) < 1e-6, `input=${p.input}`);
  assert.ok(Math.abs(p.output - 25) < 1e-6, `output=${p.output}`);
  assert.equal(derivePrices(samples.slice(0, 2)), null, '样本不足 3 条应放弃');
});

test('parseToml 支持表头 / 数组 / 布尔 / 嵌套 env 表', () => {
  const text = [
    'model = "gpt-demo"',
    'model_provider = \'demo\'',
    'enabled = true',
    '[model_providers.demo]',
    'base_url = "https://demo.local/v1"',
    '[mcp_servers.foo]',
    'command = "node"',
    'args = ["a", "b",',
    '  "c"]',
    '[mcp_servers.foo.env]',
    'FOO_TOKEN = "xxx"',
  ].join('\n');
  const { top, tables } = parseToml(text);
  assert.equal(top.model, 'gpt-demo');
  assert.equal(top.model_provider, 'demo');
  assert.equal(top.enabled, true);
  assert.equal(tables['model_providers.demo'].base_url, 'https://demo.local/v1');

  const servers = tomlSectionEntries(tables, 'mcp_servers');
  assert.equal(servers.foo.command, 'node');
  assert.deepEqual(servers.foo.args, ['a', 'b', 'c']);
  assert.equal(servers.foo.env.FOO_TOKEN, 'xxx');
});

test('parseFrontmatter 支持引号、块标量与无头部文件', () => {
  assert.deepEqual(parseFrontmatter('---\nname: foo\ndescription: "带引号"\n---\n正文'), {
    name: 'foo',
    description: '带引号',
  });
  const block = parseFrontmatter('---\nname: bar\ndescription: |\n  第一行\n  第二行\n---\n');
  assert.equal(block.description, '第一行\n第二行');
  assert.deepEqual(parseFrontmatter('普通 markdown'), {});
});

test('脱敏：密钥打码，路径/版本号等非敏感值保留', () => {
  assert.equal(looksSecret('sk-abcdefghijklmnopqrstuvwxyz123456'), true);
  assert.equal(looksSecret('C:\\Users\\wangx\\AppData\\Local\\Programs\\node.exe'), false);
  assert.equal(looksSecret('/usr/local/bin/node'), false);
  assert.equal(looksSecret('26.1002.52244'), false);
  assert.equal(looksSecret('chrome,iab,mcpapps'), false);

  const env = maskEnv({
    DEMO_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    DEMO_MODE: 'fast',
    NODE_PATH: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.equal(env.DEMO_API_KEY, '***3456');
  assert.equal(env.DEMO_MODE, 'fast');
  assert.equal(env.NODE_PATH, 'C:\\Program Files\\nodejs\\node.exe');

  assert.equal(maskValue('short'), '***');
  assert.deepEqual(maskHeaders({ Authorization: 'Bearer abcdefgh', 'Content-Type': 'application/json' }), {
    Authorization: '***efgh',
    'Content-Type': 'application/json',
  });
  assert.equal(maskUrl('http://localhost:1234/mcp?key=super-secret-value&x=1'), 'http://localhost:1234/mcp?key=***&x=1');
});

test('maskArgs 打码命令行里的密钥参数，保留路径与开关', () => {
  const masked = maskArgs([
    '--api-key=sk-abcdefghijklmnopqrstuvwxyz123456',
    '--token',
    'super-secret-value',
    '--port',
    '8080',
    'C:\\Program Files\\nodejs\\node.exe',
    '--verbose',
    'sk-abcdefghijklmnopqrstuvwxyz123456',
  ]);
  assert.deepEqual(masked, [
    '--api-key=***3456',
    '--token',
    '***alue',
    '--port',
    '8080',
    'C:\\Program Files\\nodejs\\node.exe',
    '--verbose',
    '***3456',
  ]);
  assert.deepEqual(maskArgs(undefined), []);
});

test('readNewLines 只消费完整行，支持增量与截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsx-'));
  const file = path.join(dir, 'a.jsonl');
  try {
    fs.writeFileSync(file, '{"a":1}\n{"b":2}');
    let r = readNewLines(file, 0);
    assert.deepEqual(r.lines, ['{"a":1}']);
    assert.equal(r.offset, '{"a":1}\n'.length);

    // 补上半行 + 新的一行
    fs.appendFileSync(file, '\n{"c":3}\n');
    r = readNewLines(file, r.offset);
    assert.deepEqual(r.lines, ['{"b":2}', '{"c":3}']);

    // 没有任何新增
    const again = readNewLines(file, r.offset);
    assert.deepEqual(again.lines, []);

    // 文件被截断 → 从头读
    fs.writeFileSync(file, '{"z":9}\n');
    assert.deepEqual(readNewLines(file, 9999).lines, ['{"z":9}']);

    // 目录遍历：跳过 node_modules
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 's.jsonl'), '');
    const files = walkFiles(dir, { match: (_f, n) => n.endsWith('.jsonl') });
    assert.equal(files.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
