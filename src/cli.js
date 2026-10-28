// 命令行入口：
//   node src/cli.js scan          打印人类可读摘要（默认增量扫描）
//   node src/cli.js scan --full   清空索引全量重扫
//   node src/cli.js scan --json   输出完整 snapshot JSON（给前端/管道用）
import { getSnapshot } from './scan.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'scan';
const asJson = args.includes('--json');
const full = args.includes('--full');

const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const usd = (n) => (n === null || n === undefined ? '未配置单价' : `$${Number(n).toFixed(4)}`);
const pad = (s, w) => {
  const str = String(s ?? '');
  // 粗略按显示宽度补齐（CJK 按 2 列算）
  const width = [...str].reduce((acc, ch) => acc + (/[\u4e00-\u9fff\u3000-\u303f]/.test(ch) ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, w - width));
};
const tok = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

async function main() {
  if (cmd !== 'scan') {
    console.error(`未知命令：${cmd}\n用法：node src/cli.js scan [--json] [--full]`);
    process.exit(1);
  }
  const t0 = Date.now();
  const snap = await getSnapshot({ refresh: true, full });
  void t0;

  if (asJson) {
    process.stdout.write(JSON.stringify(snap, null, 2));
    return;
  }

  const line = '─'.repeat(76);
  console.log(`\n${line}\nAgent 本地统一视图 · 扫描完成（${snap.durationMs}ms，事实 ${snap.meta.facts} 条，新增 ${snap.meta.newFacts}）\n${line}`);

  console.log('\n■ 已安装 Agent');
  console.log(`  ${pad('平台', 12)}${pad('状态', 8)}${pad('版本', 22)}${pad('skill', 8)}${pad('MCP', 6)}provider`);
  for (const a of snap.agents) {
    const skills = snap.skills.filter((s) => s.agent === a.id).length;
    const mcps = snap.mcps.filter((m) => m.agent === a.id).length;
    console.log(
      `  ${pad(a.label, 12)}${pad(a.installed ? '已安装' : '未安装', 8)}${pad(a.version || '-', 22)}${pad(skills, 8)}${pad(mcps, 6)}${a.provider || '-'}`,
    );
  }

  console.log('\n■ Skill 分布');
  const byAgentSource = new Map();
  for (const s of snap.skills) {
    const k = `${s.agent}/${s.source}`;
    byAgentSource.set(k, (byAgentSource.get(k) || 0) + 1);
  }
  for (const [k, v] of [...byAgentSource.entries()].sort()) console.log(`  ${pad(k, 28)}${pad(v, 6)}`);
  const disabledSkills = snap.skills.filter((s) => s.enabled === false);
  console.log(`  合计 ${snap.skills.length} 个，其中已禁用 ${disabledSkills.length} 个`);
  if (disabledSkills.length) console.log(`  禁用的：${disabledSkills.slice(0, 8).map((s) => s.name).join(', ')}${disabledSkills.length > 8 ? ' …' : ''}`);

  console.log('\n■ MCP（不含平台内置工具集）');
  const userMcps = snap.mcps.filter((m) => m.scope !== 'builtin');
  for (const m of userMcps) {
    const state = m.enabled === true ? '启用' : m.enabled === false ? '禁用' : '未知';
    const transport = m.transport || '-';
    const target = m.url || m.command || '-';
    console.log(`  ${pad(m.agent, 8)}${pad(state, 6)}${pad(transport, 7)}${pad(m.name, 26)}${pad(`tools:${m.toolCount ?? '-'}`, 11)}${String(target).slice(0, 40)}`);
  }
  const builtinCount = snap.mcps.filter((m) => m.scope === 'builtin').length;
  if (builtinCount) console.log(`  （另有 ${builtinCount} 个平台内置工具集，如 Trae integrated_*，默认不计入）`);

  const u = snap.usage;
  console.log('\n■ 模型开销（来自会话日志）');
  console.log(`  记录数 ${fmt(u.totals.records)} · 总 token ${tok(u.totals.totalTokens)} · 输入 ${tok(u.totals.input)} · 输出 ${tok(u.totals.output)} · 缓存读 ${tok(u.totals.cacheRead)} · 缓存写 ${tok(u.totals.cacheWrite)}`);
  console.log(`  自算成本 ${usd(u.totals.costUSD)} · 缓存命中率 ${u.totals.cacheHitRate === null ? '-' : (u.totals.cacheHitRate * 100).toFixed(1) + '%'} · 无单价 token ${tok(u.totals.unknownCostTokens)}`);
  console.log(`  平台上报成本 ${usd(u.reported.costUSD)}（${u.reported.sessions} 个会话，Claude cost-state）`);
  if (u.reconciliation?.ratio) console.log(`  交叉校验：自算/上报 = ${u.reconciliation.ratio.toFixed(2)}（口径见 README「成本对账」）`);
  const agentLine = u.byAgent.map((b) => `${b.agent}:${tok(b.totalTokens)}`).join(' · ');
  console.log(`  按平台：${agentLine}`);

  console.log(`\n  ${pad('模型', 26)}${pad('token', 10)}${pad('自算成本', 14)}单价来源`);
  for (const m of u.byModel.slice(0, 12)) {
    console.log(`  ${pad(m.model, 26)}${pad(tok(m.totalTokens), 10)}${pad(usd(m.costUSD), 14)}${m.priceSource}`);
  }

  const derived = Object.entries(snap.pricing.derived || {});
  if (derived.length) {
    console.log('\n■ 反推单价（由 Claude cost-state 拟合，美元/百万 token）');
    for (const [model, p] of derived) {
      console.log(`  ${pad(model, 26)}in $${p.input.toFixed(2)}  out $${p.output.toFixed(2)}  样本 ${p.samples}`);
    }
  }
  if (snap.pricing.default) {
    console.log(`  兜底默认价：in $${snap.pricing.default.input} / out $${snap.pricing.default.output}（pricing.json 可改；标为 default 的行即按此估算）`);
  }

  console.log('\n■ 日趋势（最近 10 天）');
  for (const d of u.byDay.slice(-10)) {
    console.log(`  ${pad(d.key, 12)}${pad(tok(d.totalTokens), 10)}${pad(usd(d.costUSD), 14)}${d.records} rec`);
  }

  console.log('\n■ 项目 Top 5（按 token）');
  for (const p of u.byProject.slice(0, 5)) {
    console.log(`  ${pad(tok(p.totalTokens), 10)}${pad(usd(p.costUSD), 14)}${p.cwd || 'unknown'}`);
  }

  const unsupported = snap.agents.filter((a) => a.usageAvailable === false);
  if (unsupported.length) {
    console.log(`\n注：${unsupported.map((a) => `${a.label}（${a.usageNote || '无本地用量日志'}）`).join('、')} 暂无 token 数据。`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
