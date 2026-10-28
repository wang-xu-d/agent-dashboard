// 测试用 fixture：在临时目录里造一套 Claude / Codex 的最小数据，
// 断言值全部可手算（见 test/scan.test.js 里的注释）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2));
}

function writeJsonl(file, rows) {
  write(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** Claude 会话日志：同一 message.id 写 3 次（首条是流式中间态），去重后只应算 1 条。 */
export function claudeLines() {
  return [
    { type: 'user', sessionId: 's1', timestamp: '2026-10-20T10:00:00.000Z', cwd: 'C:/proj', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-10-20T10:00:05.000Z',
      cwd: 'C:/proj',
      message: { id: 'msg_1', model: 'demo-model', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-10-20T10:00:06.000Z',
      cwd: 'C:/proj',
      message: {
        id: 'msg_1',
        model: 'demo-model',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-10-20T10:00:07.000Z',
      cwd: 'C:/proj',
      message: {
        id: 'msg_1',
        model: 'demo-model',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      },
    },
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-10-20T10:01:00.000Z',
      cwd: 'C:/proj',
      message: { id: 'msg_2', model: 'demo-model', usage: { input_tokens: 200, output_tokens: 100 } },
    },
    // 本地合成记录（0 token）：必须被跳过，不能算成 0 元模型行
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-10-20T10:01:01.000Z',
      cwd: 'C:/proj',
      message: { id: 'msg_3', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
    },
    {
      type: 'cost-state',
      sessionId: 's1',
      totalCostUSD: 0.5,
      modelUsage: {
        'demo-model': { inputTokens: 300, outputTokens: 150, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.5 },
      },
    },
  ];
}

/** Codex rollout：每个 token_usage_record 就是一次响应的用量。 */
export function codexLines() {
  return [
    { type: 'session_meta', timestamp: '2026-10-20T09:00:00.000Z', payload: { id: 'codex-s1', cwd: 'C:/proj', model: 'gpt-demo' } },
    {
      type: 'token_usage_record',
      timestamp: '2026-10-20T09:00:10.000Z',
      ordinal: 1,
      payload: { response_id: 'resp_1', usage: { input_tokens: 200, output_tokens: 20, cached_input_tokens: 500, cache_write_input_tokens: 0 } },
    },
    {
      type: 'token_usage_record',
      timestamp: '2026-10-20T09:01:10.000Z',
      ordinal: 2,
      payload: { response_id: 'resp_2', usage: { input_tokens: 100, output_tokens: 10 } },
    },
  ];
}

const CODEX_TOML = `model = "gpt-demo"
model_provider = "demo"

[model_providers.demo]
base_url = "https://demo.local/v1"

[mcp_servers.demo-stdio]
command = "node"
args = ["server.js"]

[mcp_servers.demo-stdio.env]
DEMO_TOKEN = "abc123456789012345678901234567890"

[mcp_servers.demo-http]
type = "http"
url = "https://demo.local/mcp?token=leak-me"
`;

const PRICING = {
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  default: { input: 10, output: 20 },
  models: { 'gpt-demo': { input: 2, output: 8 } },
};

/** 造 fixture 并返回可注入环境变量的路径。 */
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dash-'));
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const traeHome = path.join(home, '.trae-cn');
  const dataDir = path.join(root, 'data');
  const pricingFile = path.join(root, 'pricing.json');

  writeJson(path.join(home, '.claude.json'), {
    mcpServers: {
      'global-mcp': { type: 'http', url: 'http://localhost:1234/mcp?key=super-secret-value' },
    },
    skillUsage: { 'demo-skill': { usageCount: 7, lastUsedAt: '2026-10-01T00:00:00.000Z' } },
    projects: {},
  });
  writeJson(path.join(claudeHome, 'settings.json'), {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' },
    mcpServers: {
      'demo-mcp': {
        command: 'npx',
        args: ['-y', 'demo-mcp'],
        env: { DEMO_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz123456', DEMO_MODE: 'fast' },
      },
    },
  });
  write(
    path.join(claudeHome, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示用 skill\n---\n\n正文内容\n',
  );
  writeJsonl(path.join(claudeHome, 'projects', 'demo', 's1.jsonl'), claudeLines());

  write(path.join(codexHome, 'config.toml'), CODEX_TOML);
  write(path.join(codexHome, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: codex 用户 skill\n---\n');
  write(path.join(codexHome, 'skills', '.system', 'bar', 'SKILL.md'), '---\nname: bar\ndescription: codex 内置 skill\n---\n');
  writeJsonl(path.join(codexHome, 'sessions', '2026', '10', '20', 'rollout-codex-s1.jsonl'), codexLines());

  writeJson(pricingFile, PRICING);

  return { root, home, claudeHome, codexHome, traeHome, dataDir, pricingFile };
}

/** 把 fixture 注入环境变量；必须在 import src/* 之前调用。 */
export function applyEnv(fx) {
  process.env.DASH_HOME = fx.home;
  process.env.DASH_CLAUDE_HOME = fx.claudeHome;
  process.env.DASH_CODEX_HOME = fx.codexHome;
  process.env.DASH_TRAE_HOME = fx.traeHome;
  process.env.DASH_TRAE_USER_DIR = path.join(fx.root, 'no-such-trae-user-dir');
  process.env.DASH_DATA_DIR = fx.dataDir;
  process.env.DASH_PRICING_FILE = fx.pricingFile;
  process.env.DASH_SNAPSHOT_TTL_MS = '60000';
}

export function cleanup(fx) {
  try {
    fs.rmSync(fx.root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
