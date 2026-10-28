// Agent Dashboard 前端：单页、零依赖、原生 ESM。
// 数据全部来自本机只读 API（首次 GET /api/snapshot，时间窗筛选走 /api/usage/summary）。

const VIEWS = ['overview', 'cost', 'skills', 'mcps'];

const AGENT_META = {
  claude: { label: 'Claude Code', color: 'var(--claude)' },
  codex: { label: 'Codex', color: 'var(--codex)' },
  trae: { label: 'Trae CN', color: 'var(--trae)' },
};

const SOURCE_LABEL = {
  user: '用户',
  builtin: '内置',
  plugin: '插件',
  marketplace: '市场',
};
const SOURCE_BADGE = {
  user: 'badge-accent',
  builtin: 'badge-info',
  plugin: 'badge-violet',
  marketplace: 'badge-muted',
};
const SCOPE_LABEL = {
  user: '用户配置',
  project: '项目级',
  'runtime-cache': '运行时缓存',
  builtin: '平台内置',
};
const PRICE_LABEL = {
  table: '单价表',
  derived: '反推',
  default: '默认价',
  unknown: '未定价',
};

const state = {
  snapshot: null,
  loading: true,
  error: null,
  view: currentView(),
  trendMetric: 'tokens',
  costRange: 30,
  costAgent: '',
  costUsage: null,
  costLoading: false,
  costError: null,
  skills: { q: '', agents: new Set(), source: '', disabledOnly: false, crossOnly: false, selected: null },
  mcps: { q: '', agents: new Set(), scope: '', includeBuiltin: false },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 小工具 ----------
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtInt = (n) => new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/** 坐标轴用的紧凑数字：200.00M → 200M，避免窄屏挤压绘图区。 */
function axisText(n, metric) {
  if (metric === 'cost') return fmtCost(n);
  const v = Number(n) || 0;
  const trim = (x) => String(Math.round(x * 10) / 10);
  if (v >= 1e9) return `${trim(v / 1e9)}B`;
  if (v >= 1e6) return `${trim(v / 1e6)}M`;
  if (v >= 1e3) return `${trim(v / 1e3)}K`;
  return String(Math.round(v));
}

function fmtCost(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v === 0) return '$0';
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

/** 单价（美元 / 百万 token）：按量级选精度，避免反推浮点尾数铺满表格。 */
function fmtUnitPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  if (Math.abs(v) >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

const fmtPct = (x) => (x === null || x === undefined || Number.isNaN(Number(x)) ? '—' : `${(Number(x) * 100).toFixed(1)}%`);

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDay(ts) {
  if (!ts) return '—';
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(5);
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

function relTime(ts) {
  if (!ts) return null;
  const t = new Date(Number(ts)).getTime();
  if (Number.isNaN(t)) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const agentLabel = (id) => AGENT_META[id]?.label || id;
const agentColor = (id) => AGENT_META[id]?.color || 'var(--accent)';

function badge(text, kind = 'muted', extra = '') {
  return `<span class="badge badge-${kind} ${extra}">${esc(text)}</span>`;
}

function agentBadge(agent) {
  const cls = AGENT_META[agent] ? `badge-${agent}` : 'badge-muted';
  return `<span class="badge badge-agent ${cls}">${esc(agentLabel(agent))}</span>`;
}

function emptyBlock(title, hint) {
  return `<div class="empty">
    <svg class="ico" aria-hidden="true"><use href="#i-inbox"/></svg>
    <b>${esc(title)}</b>
    ${hint ? `<p>${esc(hint)}</p>` : ''}
  </div>`;
}

function debounce(fn, ms = 160) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- 数据 ----------
async function api(path, options) {
  const res = await fetch(path, { headers: { accept: 'application/json' }, ...options });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || !json.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

async function loadSnapshot() {
  state.loading = true;
  state.error = null;
  try {
    const json = await api('/api/snapshot');
    state.snapshot = json.data;
    state.loading = false;
  } catch (err) {
    state.loading = false;
    state.error = String(err.message || err);
  }
}

async function loadCostUsage() {
  state.costLoading = true;
  state.costError = null;
  const status = $('#cost-status');
  if (status) status.textContent = '正在重算…';
  const params = new URLSearchParams();
  if (state.costRange) params.set('from', isoDaysAgo(state.costRange));
  if (state.costAgent) params.set('agent', state.costAgent);
  const qs = params.toString();
  try {
    const json = await api(`/api/usage/summary${qs ? `?${qs}` : ''}`);
    state.costUsage = json.data;
  } catch (err) {
    state.costError = String(err.message || err);
  } finally {
    state.costLoading = false;
    if (state.view === 'cost') renderCost();
  }
}

// ---------- 路由 ----------
function currentView() {
  const hash = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(hash) ? hash : 'overview';
}

function setupNav() {
  window.addEventListener('hashchange', () => {
    state.view = currentView();
    render();
  });
}

function renderChrome() {
  const snap = state.snapshot;
  for (const view of VIEWS) {
    const link = $(`[data-nav="${view}"]`);
    if (!link) continue;
    if (view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $$('.view').forEach((section) => {
    section.hidden = section.dataset.view !== state.view;
  });

  if (!snap) return;
  const installed = snap.agents.filter((a) => a.installed);
  const usage = snap.usage;
  const meta = $('#topbar-meta');
  meta.innerHTML = `
    <span class="meta-item"><span class="dot is-ok"></span><b>${installed.length}</b>/${snap.agents.length} 个平台已安装</span>
    <span class="meta-item"><b>${fmtInt(usage.totals.records)}</b> 条用量记录</span>
    <span class="meta-item"><b>${fmtTokens(usage.totals.totalTokens)}</b> token</span>
    <span class="meta-item"><span class="dot"></span>更新于 <b>${fmtTime(snap.generatedAt)}</b></span>`;

  const badgeOf = {
    overview: `${installed.length} 平台`,
    cost: fmtTokens(usage.totals.totalTokens),
    skills: fmtInt(snap.skills.length),
    mcps: fmtInt(snap.mcps.filter((m) => m.scope !== 'builtin').length),
  };
  $$('[data-badge]').forEach((el) => {
    el.textContent = badgeOf[el.dataset.badge] || '';
  });

  const subs = {
    overview: `${installed.map((a) => a.label).join(' · ') || '未检测到平台'} · ${fmtInt(snap.skills.length)} 个 skill · ${fmtInt(snap.mcps.filter((m) => m.scope !== 'builtin').length)} 个 MCP`,
    skills: `${fmtInt(snap.skills.length)} 个 skill 实例，聚合为 ${fmtInt(snap.skillMatrix.length)} 个同名组`,
    mcps: `${fmtInt(snap.mcps.filter((m) => m.scope !== 'builtin').length)} 个配置的 MCP，另有 ${fmtInt(snap.mcps.filter((m) => m.scope === 'builtin').length)} 个平台内置工具集`,
  };
  for (const [view, text] of Object.entries(subs)) {
    const el = $(`[data-sub="${view}"]`);
    if (el) el.textContent = text;
  }
}

function render() {
  renderChrome();
  if (state.error) return renderError(state.error);
  if (!state.snapshot) return;
  if (state.view === 'overview') renderOverview();
  if (state.view === 'cost') {
    renderCost();
    // 首次进入（或换过筛选条件后重新进入）时按时间窗重算一次
    if (!state.costUsage && !state.costLoading) loadCostUsage();
  }
  if (state.view === 'skills') renderSkills();
  if (state.view === 'mcps') renderMcps();
}

function renderError(message) {
  $$('[data-root]').forEach((root) => {
    root.innerHTML = `
      <section class="card">
        <div class="empty">
          <svg class="ico" aria-hidden="true"><use href="#i-warn"/></svg>
          <b>读取本地数据失败</b>
          <p>${esc(message)}</p>
          <p class="dim">确认 <code>npm run serve</code> 正在运行，然后重试。</p>
          <button class="btn btn-ghost" type="button" data-retry>重试</button>
        </div>
      </section>`;
  });
  $$('[data-retry]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await loadSnapshot();
      render();
    }),
  );
}

// ---------- 总览 ----------
function renderOverview() {
  const snap = state.snapshot;
  const usage = snap.usage;
  const root = $('[data-root="overview"]');
  const totals = usage.totals;
  const recon = usage.reconciliation || {};
  const ratio = recon.ratio;
  // /api/snapshot 里的 agent 不带计数，这里按平台汇总一次
  const stats = Object.fromEntries(
    snap.agents.map((a) => {
      const byAgent = usage.byAgent.find((b) => b.agent === a.id);
      return [
        a.id,
        {
          skills: snap.skills.filter((s) => s.agent === a.id).length,
          mcps: snap.mcps.filter((m) => m.agent === a.id && m.scope !== 'builtin').length,
          tokens: byAgent?.totalTokens || 0,
          cost: byAgent?.costUSD || 0,
        },
      ];
    }),
  );

  root.innerHTML = `
    <div class="agent-grid">
      ${snap.agents.map((agent) => agentCard(agent, stats[agent.id] || {})).join('')}
    </div>

    <div class="kpi-grid">
      <article class="kpi">
        <div class="kpi-label">总 token</div>
        <b class="kpi-value">${fmtTokens(totals.totalTokens)}</b>
        <div class="kpi-sub">输入 ${fmtTokens(totals.input)} · 输出 ${fmtTokens(totals.output)}</div>
      </article>
      <article class="kpi">
        <div class="kpi-label">自算成本</div>
        <b class="kpi-value">${fmtCost(totals.costUSD)}</b>
        <div class="kpi-sub">按 pricing.json 单价估算</div>
      </article>
      <article class="kpi">
        <div class="kpi-label">平台上报成本</div>
        <b class="kpi-value">${fmtCost(usage.reported?.costUSD)}</b>
        <div class="kpi-sub">${fmtInt(usage.reported?.sessions)} 个会话 · Claude cost-state</div>
      </article>
      <article class="kpi">
        <div class="kpi-label">缓存命中率</div>
        <b class="kpi-value">${fmtPct(totals.cacheHitRate)}</b>
        <div class="kpi-bar"><i style="width:${Math.min(100, (totals.cacheHitRate || 0) * 100).toFixed(1)}%"></i></div>
      </article>
      <article class="kpi">
        <div class="kpi-label">用量记录</div>
        <b class="kpi-value">${fmtInt(totals.records)}</b>
        <div class="kpi-sub">${usage.byProject.length} 个项目 · ${usage.byModel.length} 个模型</div>
      </article>
    </div>

    <div class="split">
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">近 30 天用量</div>
            <div class="card-sub">按日聚合 · 悬停或用左右方向键查看单日数值</div>
          </div>
          <div class="seg" role="group" aria-label="趋势指标">
            <button type="button" data-trend="tokens" aria-pressed="${state.trendMetric === 'tokens'}">Token</button>
            <button type="button" data-trend="cost" aria-pressed="${state.trendMetric === 'cost'}">成本</button>
          </div>
        </div>
        <div class="chart-wrap" id="trend-chart" tabindex="0"
             aria-label="近 30 天用量趋势折线图，使用左右方向键查看每日数值"></div>
        <details class="dim" style="margin-top:10px;font-size:11.5px">
          <summary style="cursor:pointer">查看每日数据表</summary>
          <div class="table-wrap" style="margin-top:8px">
            <table>
              <thead><tr><th>日期</th><th class="num">token</th><th class="num">成本</th><th class="num">记录</th></tr></thead>
              <tbody>
                ${lastDays(usage.byDay, 30)
                  .map(
                    (d) => `<tr><td class="mono">${esc(d.key)}</td><td class="num">${fmtTokens(d.totalTokens)}</td>
                    <td class="num">${fmtCost(d.costUSD)}</td><td class="num">${fmtInt(d.records)}</td></tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">模型成本占比</div>
            <div class="card-sub">Top 5 · 自算成本</div>
          </div>
          <a class="card-sub" href="#/cost">明细<svg class="ico" aria-hidden="true" style="display:inline;width:13px;height:13px;vertical-align:-2px"><use href="#i-arrow"/></svg></a>
        </div>
        ${modelShareBars(usage.byModel)}
      </section>
    </div>

    <div class="split">
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">项目消耗</div>
            <div class="card-sub">按会话 cwd 聚合 · Top 5</div>
          </div>
        </div>
        ${projectRows(usage.byProject)}
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">口径与单价</div>
            <div class="card-sub">数字背后的假设</div>
          </div>
        </div>
        <div class="mini-list">
          <div class="mini-row"><span>自算 / 上报</span><b>${ratio ? ratio.toFixed(2) : '—'}</b></div>
          <div class="mini-row"><span>未配置单价的 token</span><b>${fmtTokens(totals.unknownCostTokens)}</b></div>
          <div class="mini-row"><span>默认单价（输入 / 输出）</span><b>${priceText(snap.pricing?.default)}</b></div>
          <div class="mini-row"><span>缓存读 / 写倍率</span><b>${snap.pricing?.cacheReadMultiplier ?? '—'}× / ${snap.pricing?.cacheWriteMultiplier ?? '—'}×</b></div>
        </div>
        <div class="note" style="margin-top:14px">
          <svg class="ico" aria-hidden="true"><use href="#i-info"/></svg>
          <span>自算成本按单价表估算，覆盖所有平台；上报成本只来自 Claude 的 cost-state。两者口径不同，比值用于交叉校验。</span>
        </div>
        ${snap.agents.some((a) => !a.usageAvailable) ? `<div class="note is-warn" style="margin-top:10px">
          <svg class="ico" aria-hidden="true"><use href="#i-warn"/></svg>
          <span>${snap.agents.filter((a) => !a.usageAvailable).map((a) => esc(a.label)).join('、')} 没有本地 token 日志，只统计 skill 与 MCP。</span>
        </div>` : ''}
      </section>
    </div>`;

  bindTrendControls();
  drawTrend();
}

function agentCard(agent, stats) {
  const off = !agent.installed;
  const provider = agent.provider ? agent.provider.replace(/^https?:\/\//, '') : '—';
  return `
    <article class="agent-card ${off ? 'is-off' : ''}" style="--agent-color:${agentColor(agent.id)}">
      <div class="agent-top">
        <div>
          <div class="agent-name"><span class="swatch"></span>${esc(agent.label)}</div>
          <div class="agent-ver">${esc(agent.version || '版本未知')}</div>
        </div>
        ${off ? badge('未安装', 'muted') : badge(agent.usageAvailable ? '用量可读' : '无用量日志', agent.usageAvailable ? 'accent' : 'warn')}
      </div>
      <div class="agent-provider" title="${esc(agent.provider || '')}">
        <svg class="ico" aria-hidden="true" style="width:12px;height:12px"><use href="#i-term"/></svg>
        ${esc(provider)}
      </div>
      <div class="agent-stats">
        <div class="agent-stat"><span>Skill</span><b>${fmtInt(stats.skills || 0)}</b></div>
        <div class="agent-stat"><span>MCP</span><b>${fmtInt(stats.mcps || 0)}</b></div>
        <div class="agent-stat"><span>Token</span><b>${fmtTokens(stats.tokens || 0)}</b></div>
      </div>
      ${agent.usageNote ? `<div class="agent-note"><svg class="ico" aria-hidden="true"><use href="#i-info"/></svg><span>${esc(agent.usageNote)}</span></div>` : ''}
    </article>`;
}

function priceText(p) {
  if (!p) return '未配置';
  return `${fmtUnitPrice(p.input)} / ${fmtUnitPrice(p.output)}`;
}

function modelShareBars(rows) {
  const top = rows.filter((m) => m.costUSD > 0).slice(0, 5);
  if (!top.length) return emptyBlock('还没有可归因的成本', '先运行一次扫描，或检查 pricing.json 是否配置了单价。');
  const max = Math.max(...top.map((m) => m.costUSD));
  return `<div class="bar-list">
    ${top
      .map(
        (m) => `<div class="bar-row">
          <span class="bar-label" title="${esc(m.model)}">${esc(m.model)}</span>
          <span class="bar-value">${fmtCost(m.costUSD)}</span>
          <span class="bar-track"><i class="bar-fill" style="width:${((m.costUSD / max) * 100).toFixed(1)}%"></i></span>
        </div>`,
      )
      .join('')}
  </div>`;
}

function projectRows(rows) {
  const top = rows.slice(0, 5);
  if (!top.length) return emptyBlock('还没有项目维度的数据');
  return `<div class="mini-list">
    ${top
      .map(
        (p) => `<div class="mini-row">
          <span class="truncate" style="flex:1" title="${esc(p.cwd || '')}">${esc(p.cwd || '未知目录')}</span>
          <b>${fmtTokens(p.totalTokens)}</b>
          <b class="dim">${fmtCost(p.costUSD)}</b>
        </div>`,
      )
      .join('')}
  </div>`;
}

function lastDays(rows, days) {
  if (!days) return rows;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);
  return rows.filter((d) => new Date(`${d.key}T00:00:00`).getTime() >= cutoff.getTime());
}

// ---------- 折线图（手写 SVG，无依赖） ----------
let chartNonce = 0;

function bindTrendControls() {
  $$('[data-trend]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.trendMetric = btn.dataset.trend;
      $$('[data-trend]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.trend === state.trendMetric)));
      drawTrend();
    });
  });
}

function drawTrend() {
  const container = $('#trend-chart');
  if (!container || !state.snapshot) return;
  const rows = lastDays(state.snapshot.usage.byDay, 30);
  drawLineChart(container, rows, state.trendMetric);
}

function drawLineChart(container, rows, metric) {
  if (!rows.length) {
    container.innerHTML = emptyBlock('还没有用量数据', '扫描后，使用过 Agent 的日期会出现在这里。');
    container.removeAttribute('tabindex');
    return;
  }
  container.setAttribute('tabindex', '0');
  const width = Math.max(300, container.clientWidth || 640);
  const height = 224;
  const pad = { l: 48, r: 14, t: 16, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const valueOf = (r) => Number(metric === 'cost' ? r.costUSD : r.totalTokens) || 0;
  const values = rows.map(valueOf);
  const max = niceMax(Math.max(1, ...values));
  const xAt = (i) => pad.l + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yAt = (v) => pad.t + innerH - (v / max) * innerH;
  const points = rows.map((r, i) => [xAt(i), yAt(values[i])]);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${points.at(-1)[0].toFixed(1)} ${(pad.t + innerH).toFixed(1)} L${points[0][0].toFixed(1)} ${(pad.t + innerH).toFixed(1)} Z`;
  const gradId = `areaGrad${++chartNonce}`;

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (max / tickCount) * i);
  const yGrid = ticks
    .map((t) => {
      const y = yAt(t);
      return `<line class="grid-line" x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}"/>
        <text class="axis-text" x="${pad.l - 8}" y="${y + 3.5}" text-anchor="end">${axisText(t, metric)}</text>`;
    })
    .join('');

  const labelStep = Math.max(1, Math.ceil(rows.length / (width < 520 ? 4 : 7)));
  const candidates = [];
  for (let i = 0; i < rows.length; i += labelStep) candidates.push(i);
  if (candidates.at(-1) !== rows.length - 1) candidates.push(rows.length - 1);
  // 刻度太近时用靠后的那一天替换，避免末尾两天标签叠字
  const minGap = 42;
  const labelIndexes = [];
  for (const i of candidates) {
    if (labelIndexes.length && xAt(i) - xAt(labelIndexes.at(-1)) < minGap) labelIndexes[labelIndexes.length - 1] = i;
    else labelIndexes.push(i);
  }
  const xLabels = labelIndexes
    .map((i) => `<text class="axis-text" x="${xAt(i)}" y="${height - 8}" text-anchor="middle">${esc(fmtDay(rows[i].key))}</text>`)
    .join('');

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
      aria-label="按日用量趋势，共 ${rows.length} 天，最高 ${metric === 'cost' ? fmtCost(Math.max(...values)) : fmtTokens(Math.max(...values))}">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22C55E" stop-opacity=".28"/>
          <stop offset="100%" stop-color="#22C55E" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${yGrid}
      ${xLabels}
      <path d="${area}" style="fill:url(#${gradId})"/>
      <path class="series-line" d="${line}"/>
      <g class="hover" style="opacity:0">
        <line class="hover-line" y1="${pad.t}" y2="${pad.t + innerH}"/>
        <circle class="hover-dot" r="4"/>
      </g>
      <rect class="hit" x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}"/>
    </svg>`;

  const svg = container.querySelector('svg');
  const hover = container.querySelector('.hover');
  const lineEl = hover.querySelector('.hover-line');
  const dotEl = hover.querySelector('.hover-dot');
  const tooltip = $('#tooltip');
  let active = -1;

  const showAt = (index, clientX, clientY) => {
    active = Math.max(0, Math.min(rows.length - 1, index));
    const [px, py] = points[active];
    lineEl.setAttribute('x1', px);
    lineEl.setAttribute('x2', px);
    dotEl.setAttribute('cx', px);
    dotEl.setAttribute('cy', py);
    hover.style.opacity = '1';
    const row = rows[active];
    tooltip.innerHTML = `<b>${esc(row.key)}</b>
      <div class="tt-row"><span>token</span><span>${fmtInt(row.totalTokens)}</span></div>
      <div class="tt-row"><span>成本</span><span>${fmtCost(row.costUSD)}</span></div>
      <div class="tt-row"><span>记录</span><span>${fmtInt(row.records)}</span></div>`;
    tooltip.hidden = false;
    const rect = container.getBoundingClientRect();
    const scale = rect.width / width;
    const tipX = clientX ?? rect.left + px * scale;
    const tipY = clientY ?? rect.top + py * scale;
    const maxX = window.innerWidth - tooltip.offsetWidth - 12;
    const maxY = window.innerHeight - tooltip.offsetHeight - 12;
    tooltip.style.left = `${Math.max(12, Math.min(maxX, tipX + 14))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(maxY, tipY - 10))}px`;
  };

  const hide = () => {
    hover.style.opacity = '0';
    tooltip.hidden = true;
    active = -1;
  };

  svg.addEventListener('pointermove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const xInSvg = ((evt.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i][0] - xInSvg);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    showAt(nearest, evt.clientX, evt.clientY);
  });
  svg.addEventListener('pointerleave', hide);

  container.onkeydown = (evt) => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') {
      if (evt.key === 'Escape') hide();
      return;
    }
    evt.preventDefault();
    const next = active < 0 ? rows.length - 1 : active + (evt.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    const [px, py] = points[next];
    const rect = container.getBoundingClientRect();
    showAt(next, rect.left + (px / width) * rect.width, rect.top + (py / height) * rect.height);
  };
  container.onblur = () => hide();
}

function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ---------- 模型开销 ----------
function renderCost() {
  const snap = state.snapshot;
  const root = $('[data-root="cost"]');
  const usage = state.costUsage || snap.usage;
  const totals = usage.totals || {};
  const recon = usage.reconciliation || {};
  const reported = usage.reported || {};
  const ratio = recon.ratio;

  root.innerHTML = `
    <div class="toolbar" role="group" aria-label="开销筛选">
      <div class="toolbar-group">
        <span class="toolbar-label">时间窗</span>
        <div class="seg" id="cost-range">
          ${[
            [7, '7 天'],
            [30, '30 天'],
            [90, '90 天'],
            [0, '全部'],
          ]
            .map(
              ([days, label]) =>
                `<button type="button" data-range="${days}" aria-pressed="${state.costRange === days}">${label}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="toolbar-group">
        <span class="toolbar-label">平台</span>
        <select id="cost-agent" aria-label="按平台筛选">
          <option value="">全部平台</option>
          ${snap.agents
            .map((a) => `<option value="${a.id}" ${state.costAgent === a.id ? 'selected' : ''}>${esc(a.label)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="toolbar-spacer"></div>
      <span class="card-sub" id="cost-status">${state.costLoading ? '正在重算…' : `已加载 ${fmtInt(totals.records || 0)} 条记录`}</span>
    </div>

    ${state.costError ? `<div class="note is-warn"><svg class="ico" aria-hidden="true"><use href="#i-warn"/></svg><span>${esc(state.costError)}</span></div>` : ''}

    <div class="kpi-grid">
      <article class="kpi">
        <div class="kpi-label">自算成本</div>
        <b class="kpi-value">${fmtCost(totals.costUSD)}</b>
        <div class="kpi-sub">${fmtTokens(totals.totalTokens)} token · ${fmtInt(totals.records)} 条记录</div>
      </article>
      <article class="kpi">
        <div class="kpi-label">平台上报成本</div>
        <b class="kpi-value">${fmtCost(reported.costUSD)}</b>
        <div class="kpi-sub">${fmtInt(reported.sessions)} 个会话有账单</div>
      </article>
      <article class="kpi">
        <div class="kpi-label">自算 / 上报</div>
        <b class="kpi-value">${ratio ? ratio.toFixed(2) : '—'}<small>×</small></b>
        <div class="kpi-bar"><i style="width:${Math.min(100, (ratio || 0) * 100).toFixed(1)}%"></i></div>
      </article>
      <article class="kpi">
        <div class="kpi-label">未配置单价的 token</div>
        <b class="kpi-value">${fmtTokens(totals.unknownCostTokens)}</b>
        <div class="kpi-sub">${totals.unknownCostTokens ? '这部分成本未计入' : '所有模型都有单价'}</div>
      </article>
    </div>

    <div class="split split-wide">
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">按模型</div>
            <div class="card-sub">成本降序 · 占比按 token 计</div>
          </div>
        </div>
        ${modelTable(usage.byModel || [], totals.totalTokens)}
      </section>

      <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <section class="card">
          <div class="card-head"><div><div class="card-title">成本对账</div><div class="card-sub">自算 vs 平台账单</div></div></div>
          ${reconBlock(recon, reported, totals)}
        </section>
        <section class="card">
          <div class="card-head"><div><div class="card-title">单价来源</div><div class="card-sub">pricing.json</div></div></div>
          ${pricingBlock(snap.pricing, usage.priceStatus || [])}
        </section>
      </div>
    </div>

    <div class="split">
      <section class="card">
        <div class="card-head"><div><div class="card-title">按平台</div><div class="card-sub">token 与成本分摊</div></div></div>
        ${agentTable(usage.byAgent || [], totals.totalTokens)}
        ${(() => {
          const silent = snap.agents.filter((a) => !a.usageAvailable).map((a) => esc(a.label));
          if (!silent.length) return '';
          return `<div class="table-foot">${silent.join('、')} 没有本地用量日志，不计入上方分摊。</div>`;
        })()}
      </section>
      <section class="card">
        <div class="card-head"><div><div class="card-title">按项目</div><div class="card-sub">Top 10 · 按 cwd</div></div></div>
        ${projectTable(usage.byProject || [], totals.totalTokens)}
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">每日成本</div>
          <div class="card-sub">当前筛选条件下按日聚合</div>
        </div>
      </div>
      <div class="chart-wrap" id="cost-chart" tabindex="0" aria-label="每日成本趋势折线图"></div>
    </section>`;

  $('#cost-range')?.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-range]');
    if (!btn) return;
    state.costRange = Number(btn.dataset.range);
    $$('#cost-range button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.costRange)));
    loadCostUsage();
  });
  $('#cost-agent')?.addEventListener('change', (evt) => {
    state.costAgent = evt.target.value;
    loadCostUsage();
  });
  const chart = $('#cost-chart');
  if (chart) {
    const rows = state.costRange ? lastDays(usage.byDay || [], state.costRange) : usage.byDay || [];
    drawLineChart(chart, rows, 'cost');
  }
}

function modelTable(rows, totalTokens) {
  if (!rows.length) return emptyBlock('当前筛选下没有用量记录', '换一个时间窗或平台试试。');
  return `<div class="table-wrap tall">
    <table>
      <thead>
        <tr>
          <th scope="col">模型</th>
          <th scope="col" class="num">输入</th>
          <th scope="col" class="num">输出</th>
          <th scope="col" class="num">缓存读</th>
          <th scope="col" class="num">缓存写</th>
          <th scope="col" class="num">合计</th>
          <th scope="col" class="num">成本</th>
          <th scope="col">占比</th>
          <th scope="col">单价</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (m) => `<tr>
              <td>
                <div class="strong model-name" title="${esc(m.model)}">${esc(m.model)}</div>
                <div class="mono dim">${fmtInt(m.records)} 条</div>
              </td>
              <td class="num">${fmtTokens(m.input)}</td>
              <td class="num">${fmtTokens(m.output)}</td>
              <td class="num">${fmtTokens(m.cacheRead)}</td>
              <td class="num">${fmtTokens(m.cacheWrite)}</td>
              <td class="num strong">${fmtTokens(m.totalTokens)}</td>
              <td class="num strong">${fmtCost(m.costUSD)}</td>
              <td>
                <div class="share">
                  <span class="share-track"><i style="width:${totalTokens ? ((m.totalTokens / totalTokens) * 100).toFixed(1) : 0}%"></i></span>
                  <span class="mono dim">${totalTokens ? fmtPct(m.totalTokens / totalTokens) : '—'}</span>
                </div>
              </td>
              <td>${priceBadge(m.priceSource)}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
  <div class="table-foot">成本 = (输入 + 缓存读×倍率 + 缓存写×倍率) × 输入单价 + 输出 × 输出单价；单价为 0 时该行成本记 0，未配置单价则不计入。</div>`;
}

function priceBadge(source) {
  const kind = { table: 'accent', derived: 'info', default: 'violet', unknown: 'danger' }[source] || 'muted';
  return badge(PRICE_LABEL[source] || source || '—', kind);
}

function agentTable(rows, totalTokens) {
  if (!rows.length) return emptyBlock('没有可分摊的数据');
  return `<div class="table-wrap">
    <table>
      <thead><tr><th scope="col">平台</th><th scope="col" class="num">记录</th><th scope="col" class="num">token</th><th scope="col" class="num">成本</th><th scope="col" class="num">token 占比</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (a) => `<tr>
              <td>${agentBadge(a.agent)}</td>
              <td class="num">${fmtInt(a.records)}</td>
              <td class="num">${fmtTokens(a.totalTokens)}</td>
              <td class="num">${fmtCost(a.costUSD)}</td>
              <td class="num dim">${totalTokens ? fmtPct(a.totalTokens / totalTokens) : '—'}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function projectTable(rows, totalTokens) {
  if (!rows.length) return emptyBlock('没有项目维度数据');
  return `<div class="table-wrap">
    <table>
      <thead><tr><th scope="col">项目目录</th><th scope="col" class="num">记录</th><th scope="col" class="num">token</th><th scope="col" class="num">成本</th></tr></thead>
      <tbody>
        ${rows
          .slice(0, 10)
          .map(
            (p) => `<tr>
              <td><div class="mono truncate" title="${esc(p.cwd || '')}">${esc(p.cwd || '未知目录')}</div></td>
              <td class="num">${fmtInt(p.records)}</td>
              <td class="num">${fmtTokens(p.totalTokens)}</td>
              <td class="num">${fmtCost(p.costUSD)}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function reconBlock(recon, reported, totals) {
  const computed = recon.computedCostUSD || 0;
  const reportedCost = recon.reportedCostUSD || 0;
  if (!reportedCost) {
    return `<div class="note">
      <svg class="ico" aria-hidden="true"><use href="#i-info"/></svg>
      <span>当前筛选范围内没有平台账单（Claude cost-state）。Codex / Trae CN 不写 costUSD，只能看自算成本。</span>
    </div>`;
  }
  const max = Math.max(computed, reportedCost) || 1;
  const dims = [
    ['输入', totals.input, reported.tokens?.input],
    ['输出', totals.output, reported.tokens?.output],
    ['缓存读', totals.cacheRead, reported.tokens?.cacheRead],
    ['缓存写', totals.cacheWrite, reported.tokens?.cacheWrite],
  ];
  return `<div class="compare">
    <div class="compare-row">
      <span class="compare-label">自算</span>
      <div class="compare-track"><div class="compare-fill is-computed" style="width:${((computed / max) * 100).toFixed(1)}%"></div></div>
      <span class="compare-num">${fmtCost(computed)}</span>
    </div>
    <div class="compare-row">
      <span class="compare-label">平台上报</span>
      <div class="compare-track"><div class="compare-fill is-reported" style="width:${((reportedCost / max) * 100).toFixed(1)}%"></div></div>
      <span class="compare-num">${fmtCost(reportedCost)}</span>
    </div>
    <div class="ratio-line">
      <span class="ratio-value">${recon.ratio ? recon.ratio.toFixed(2) : '—'}</span>
      <span class="ratio-note">自算 / 上报 · ${fmtInt(reported.sessions)} 个会话有账单</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">维度</th><th scope="col" class="num">自算</th><th scope="col" class="num">上报</th><th scope="col" class="num">比值</th></tr></thead>
        <tbody>
          ${dims
            .map(
              ([label, mine, theirs]) => `<tr>
                <td class="dim">${label}</td>
                <td class="num">${fmtTokens(mine)}</td>
                <td class="num">${fmtTokens(theirs)}</td>
                <td class="num ${theirs && mine / theirs < 0.9 ? 'strong' : 'dim'}">${theirs ? (mine / theirs).toFixed(2) : '—'}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="note">
      <svg class="ico" aria-hidden="true"><use href="#i-info"/></svg>
      <span>上报账单按会话文件的最后修改时间归入时间窗，会话内金额为整段累计；日志记录的是实际服务的模型名，账单记录的是请求的模型名，两者无法逐一对应。差额主要来自重试计费与覆盖范围，因此只做整体比值校验。</span>
    </div>
  </div>`;
}

function pricingBlock(pricing, priceStatus) {
  const unknown = priceStatus.filter((p) => p.priceSource === 'unknown');
  const derived = Object.entries(pricing?.derived || {});
  const explicit = Object.entries(pricing?.models || {});
  return `<div class="mini-list">
    <div class="mini-row"><span>默认单价</span><b>${priceText(pricing?.default)}</b></div>
    <div class="mini-row"><span>缓存读倍率</span><b>${pricing?.cacheReadMultiplier ?? '—'}×</b></div>
    <div class="mini-row"><span>缓存写倍率</span><b>${pricing?.cacheWriteMultiplier ?? '—'}×</b></div>
    <div class="mini-row"><span>显式配置的模型</span><b>${explicit.length || 0}</b></div>
    <div class="mini-row"><span>自动反推的模型</span><b>${derived.length}</b></div>
  </div>
  ${
    derived.length
      ? `<div class="table-wrap" style="margin-top:12px">
          <table>
            <thead><tr><th scope="col">反推单价</th><th scope="col" class="num">输入</th><th scope="col" class="num">输出</th></tr></thead>
            <tbody>${derived
              .map(
                ([model, p]) => `<tr><td class="mono">${esc(model)}</td><td class="num">${fmtUnitPrice(p.input)}</td><td class="num">${fmtUnitPrice(p.output)}</td></tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>
        <div class="table-foot">单位为美元 / 百万 token，由 Claude cost-state 的 token 与金额最小二乘反推。</div>`
      : ''
  }
  ${
    unknown.length
      ? `<div class="note is-warn" style="margin-top:12px">
          <svg class="ico" aria-hidden="true"><use href="#i-warn"/></svg>
          <span>${unknown.map((u) => esc(u.model)).join('、')} 没有可用单价，成本未计入。请在 pricing.json 里补 models，或配置 default。</span>
        </div>`
      : ''
  }`;
}

// ---------- Skill 矩阵 ----------
function renderSkills() {
  const snap = state.snapshot;
  const root = $('[data-root="skills"]');
  const f = state.skills;

  const instances = snap.skills.filter((s) => {
    if (f.agents.size && !f.agents.has(s.agent)) return false;
    if (f.source && s.source !== f.source) return false;
    if (f.disabledOnly && s.enabled !== false) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![s.name, s.description, s.namespace].some((v) => String(v ?? '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const groups = new Map();
  for (const s of instances) {
    const key = String(s.name).toLowerCase();
    const row = groups.get(key) || { name: s.name, instances: [], agents: new Set() };
    row.instances.push(s);
    row.agents.add(s.agent);
    groups.set(key, row);
  }
  let rows = [...groups.values()].sort(
    (a, b) => b.agents.size - a.agents.size || b.instances.length - a.instances.length || a.name.localeCompare(b.name),
  );
  if (f.crossOnly) rows = rows.filter((r) => r.agents.size > 1);

  const disabledCount = snap.skills.filter((s) => s.enabled === false).length;
  const crossCount = snap.skillMatrix.filter((r) => Object.keys(r.agents).length > 1).length;
  const builtinCount = snap.skills.filter((s) => s.source === 'builtin').length;
  if (f.selected && !rows.some((r) => r.name === f.selected)) f.selected = null;

  root.innerHTML = `
    <div class="toolbar" role="group" aria-label="Skill 筛选">
      <div class="field">
        <svg class="ico" aria-hidden="true"><use href="#i-search"/></svg>
        <input type="search" id="skill-q" placeholder="搜索 skill 名称 / 描述 / 命名空间" value="${esc(f.q)}" aria-label="搜索 skill">
      </div>
      <div class="toolbar-group">
        ${snap.agents
          .map(
            (a) =>
              `<button class="chip" type="button" data-skill-agent="${a.id}" aria-pressed="${f.agents.has(a.id)}">
                ${esc(a.label)} <span class="dim">${snap.skills.filter((s) => s.agent === a.id).length}</span>
              </button>`,
          )
          .join('')}
      </div>
      <div class="toolbar-group">
        <select id="skill-source" aria-label="按来源筛选">
          <option value="">全部来源</option>
          ${['user', 'builtin', 'plugin', 'marketplace']
            .map((s) => `<option value="${s}" ${f.source === s ? 'selected' : ''}>${SOURCE_LABEL[s]}</option>`)
            .join('')}
        </select>
      </div>
      <button class="chip" type="button" id="skill-disabled" aria-pressed="${f.disabledOnly}">
        <svg class="ico" aria-hidden="true"><use href="#i-x"/></svg>仅看禁用
      </button>
      <button class="chip" type="button" id="skill-cross" aria-pressed="${f.crossOnly}">
        <svg class="ico" aria-hidden="true"><use href="#i-overview"/></svg>仅看跨平台
      </button>
      <div class="toolbar-spacer"></div>
      <span class="card-sub">${fmtInt(rows.length)} 组 / ${fmtInt(instances.length)} 个实例</span>
    </div>

    <div class="kpi-grid">
      <article class="kpi"><div class="kpi-label">Skill 实例</div><b class="kpi-value">${fmtInt(snap.skills.length)}</b><div class="kpi-sub">${fmtInt(snap.skillMatrix.length)} 个同名组</div></article>
      <article class="kpi"><div class="kpi-label">跨平台同名</div><b class="kpi-value">${fmtInt(crossCount)}</b><div class="kpi-sub">同时在 2 个以上平台安装</div></article>
      <article class="kpi"><div class="kpi-label">已禁用</div><b class="kpi-value">${fmtInt(disabledCount)}</b><div class="kpi-sub">来自各平台配置</div></article>
      <article class="kpi"><div class="kpi-label">平台内置</div><b class="kpi-value">${fmtInt(builtinCount)}</b><div class="kpi-sub">随平台分发的 skill</div></article>
    </div>

    <div class="split split-wide">
      <section class="card">
        <div class="card-head">
          <div><div class="card-title">矩阵</div><div class="card-sub">点一行查看所在路径与启用状态</div></div>
        </div>
        ${
          rows.length
            ? `<div class="matrix-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Skill</th>
                      ${snap.agents.map((a) => `<th scope="col">${esc(a.label)}</th>`).join('')}
                    </tr>
                  </thead>
                  <tbody>
                    ${rows
                      .map(
                        (row) => `<tr class="row-selectable" data-skill="${esc(row.name)}"
                          aria-selected="${f.selected === row.name}">
                          <td>
                            <div class="skill-name">
                              <b>${esc(row.name)}</b>
                              <span class="skill-desc" title="${esc(descOf(row))}">${esc(descOf(row) || '无描述')}</span>
                            </div>
                          </td>
                          ${snap.agents
                            .map((a) => `<td>${cellFor(row.instances.filter((s) => s.agent === a.id))}</td>`)
                            .join('')}
                        </tr>`,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
              <div class="swipe-hint"><svg class="ico" aria-hidden="true"><use href="#i-arrow"/></svg>表格可横向滚动，查看各平台列</div>`
            : emptyBlock('没有匹配的 skill', '放宽筛选条件，或点右上角「重新扫描」。')
        }
      </section>

      <aside class="card detail" id="skill-detail"></aside>
    </div>`;

  const search = $('#skill-q');
  search?.addEventListener(
    'input',
    debounce(() => {
      f.q = search.value.trim();
      renderSkills();
      const again = $('#skill-q');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 220),
  );
  $$('[data-skill-agent]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.skillAgent;
      if (f.agents.has(id)) f.agents.delete(id);
      else f.agents.add(id);
      renderSkills();
    }),
  );
  $('#skill-source')?.addEventListener('change', (evt) => {
    f.source = evt.target.value;
    renderSkills();
  });
  $('#skill-disabled')?.addEventListener('click', () => {
    f.disabledOnly = !f.disabledOnly;
    renderSkills();
  });
  $('#skill-cross')?.addEventListener('click', () => {
    f.crossOnly = !f.crossOnly;
    renderSkills();
  });
  $$('[data-skill]').forEach((tr) =>
    tr.addEventListener('click', () => {
      f.selected = f.selected === tr.dataset.skill ? null : tr.dataset.skill;
      $$('[data-skill]').forEach((row) => row.setAttribute('aria-selected', String(row.dataset.skill === f.selected)));
      renderSkillDetail();
      // 窄屏详情在矩阵下方，选中后带到可视区
      if (f.selected && window.innerWidth <= 1180) {
        $('#skill-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }),
  );
  renderSkillDetail();
}

function descOf(row) {
  const withDesc = row.instances.find((s) => s.description);
  return withDesc?.description || '';
}

function cellFor(list) {
  if (!list.length) return '<span class="dim">—</span>';
  const shown = list.slice(0, 2);
  return `<div class="cell-stack">
    ${shown
      .map(
        (s) => `<span class="badge ${SOURCE_BADGE[s.source] || 'badge-muted'}">
          ${esc(SOURCE_LABEL[s.source] || s.source)}${s.enabled === false ? ' · 禁用' : ''}
          ${s.usageCount ? ` · ${s.usageCount}×` : ''}
        </span>`,
      )
      .join('')}
    ${list.length > shown.length ? `<span class="cell-more">+${list.length - shown.length}</span>` : ''}
  </div>`;
}

function renderSkillDetail() {
  const panel = $('#skill-detail');
  if (!panel) return;
  const f = state.skills;
  const snap = state.snapshot;
  if (!f.selected) {
    panel.innerHTML = `<div class="detail-empty">
      <svg class="ico" aria-hidden="true"><use href="#i-skills"/></svg>
      选择左侧任意一行<br>查看该 skill 在各平台的安装位置
    </div>`;
    return;
  }
  const instances = snap.skills.filter((s) => String(s.name).toLowerCase() === String(f.selected).toLowerCase());
  const first = instances.find((s) => s.description);
  const namespaces = [...new Set(instances.map((s) => s.namespace).filter(Boolean))];
  panel.innerHTML = `
    <div class="card-head">
      <div>
        <div class="detail-title">${esc(f.selected)}</div>
        <div class="card-sub">${fmtInt(instances.length)} 个实例 · ${fmtInt(new Set(instances.map((s) => s.agent)).size)} 个平台</div>
      </div>
      ${badge(`${instances.filter((s) => s.enabled !== false).length}/${instances.length} 启用`, 'accent')}
    </div>
    <div class="detail-desc">${esc(first?.description || '没有描述')}</div>
    ${namespaces.length ? `<div class="mcp-pills" style="margin-bottom:12px">${namespaces.map((n) => badge(n, 'violet', 'mono')).join('')}</div>` : ''}
    ${instances
      .map(
        (s) => `<div class="instance">
          <div class="instance-head">
            ${agentBadge(s.agent)}
            ${badge(SOURCE_LABEL[s.source] || s.source, SOURCE_BADGE[s.source] || 'muted')}
            ${s.enabled === false ? badge('已禁用', 'danger') : badge('启用', 'accent')}
          </div>
          <div class="instance-path" title="${esc(s.path)}">${esc(s.path)}</div>
          <div class="instance-meta">
            <span>类型 ${esc(s.type || 'skill')}</span>
            ${s.usageCount ? `<span>用过 ${fmtInt(s.usageCount)} 次</span>` : ''}
            ${s.lastUsedAt ? `<span>最近 ${relTime(s.lastUsedAt) || '—'}</span>` : ''}
            ${s.version ? `<span>v${esc(s.version)}</span>` : ''}
          </div>
        </div>`,
      )
      .join('')}`;
}

// ---------- MCP 清单 ----------
function renderMcps() {
  const snap = state.snapshot;
  const f = state.mcps;
  const root = $('[data-root="mcps"]');

  const visible = snap.mcps
    .filter((m) => (f.includeBuiltin ? true : m.scope !== 'builtin'))
    .filter((m) => (f.agents.size ? f.agents.has(m.agent) : true))
    .filter((m) => (f.scope ? m.scope === f.scope : true))
    .filter((m) => {
      if (!f.q) return true;
      const q = f.q.toLowerCase();
      return [m.name, m.command, m.url, m.sourcePath].some((v) => String(v ?? '').toLowerCase().includes(q));
    })
    .sort((a, b) => a.agent.localeCompare(b.agent) || String(a.name).localeCompare(String(b.name)));

  const enabled = visible.filter((m) => m.enabled === true).length;
  const disabled = visible.filter((m) => m.enabled === false).length;
  const unknownState = visible.filter((m) => m.enabled === null).length;
  const builtinHidden = snap.mcps.filter((m) => m.scope === 'builtin').length;

  root.innerHTML = `
    <div class="toolbar" role="group" aria-label="MCP 筛选">
      <div class="field">
        <svg class="ico" aria-hidden="true"><use href="#i-search"/></svg>
        <input type="search" id="mcp-q" placeholder="搜索名称 / 命令 / URL" value="${esc(f.q)}" aria-label="搜索 MCP">
      </div>
      <div class="toolbar-group">
        ${snap.agents
          .map(
            (a) =>
              `<button class="chip" type="button" data-mcp-agent="${a.id}" aria-pressed="${f.agents.has(a.id)}">
                ${esc(a.label)} <span class="dim">${snap.mcps.filter((m) => m.agent === a.id && (f.includeBuiltin || m.scope !== 'builtin')).length}</span>
              </button>`,
          )
          .join('')}
      </div>
      <div class="toolbar-group">
        <select id="mcp-scope" aria-label="按范围筛选">
          <option value="">全部范围</option>
          ${['user', 'project', 'runtime-cache', 'builtin']
            .map((s) => `<option value="${s}" ${f.scope === s ? 'selected' : ''}>${SCOPE_LABEL[s]}</option>`)
            .join('')}
        </select>
      </div>
      <button class="chip" type="button" id="mcp-builtin" aria-pressed="${f.includeBuiltin}">
        <svg class="ico" aria-hidden="true"><use href="#i-mcps"/></svg>显示平台内置${builtinHidden ? ` (+${builtinHidden})` : ''}
      </button>
      <div class="toolbar-spacer"></div>
      <span class="card-sub">${fmtInt(visible.length)} 个 · 启用 ${enabled} / 禁用 ${disabled}${unknownState ? ` / 状态未知 ${unknownState}` : ''}</span>
    </div>

    ${
      visible.length
        ? `<div class="mcp-grid">${visible.map(mcpCard).join('')}</div>`
        : emptyBlock('没有匹配的 MCP', '试试切换平台、范围，或打开「显示平台内置」。')
    }

    <div class="note">
      <svg class="ico" aria-hidden="true"><use href="#i-info"/></svg>
      <span>env / headers / URL 参数均已脱敏，只保留末 4 位。${builtinHidden ? '平台内置工具集默认隐藏，它们随平台分发、不消耗你的配置。' : ''}</span>
    </div>`;
  $('#mcp-q')?.addEventListener(
    'input',
    debounce((evt) => {
      f.q = evt.target.value.trim();
      renderMcps();
      const again = $('#mcp-q');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 220),
  );
  $$('[data-mcp-agent]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.mcpAgent;
      if (f.agents.has(id)) f.agents.delete(id);
      else f.agents.add(id);
      renderMcps();
    }),
  );
  $('#mcp-scope')?.addEventListener('change', (evt) => {
    f.scope = evt.target.value;
    renderMcps();
  });
  $('#mcp-builtin')?.addEventListener('click', () => {
    f.includeBuiltin = !f.includeBuiltin;
    renderMcps();
  });
}

function mcpCard(m) {
  const stateBadge =
    m.enabled === true
      ? badge('已启用', 'accent')
      : m.enabled === false
        ? badge('已禁用', 'danger')
        : badge('运行时缓存', 'info');
  const target = m.url
    ? `<div class="mcp-target">${esc(m.url)}</div>`
    : `<div class="mcp-target">${esc(m.command || '—')}${(m.args || []).length ? ` <span class="arg">${esc(m.args.join(' '))}</span>` : ''}</div>`;
  const envKeys = Object.entries(m.env || {});
  const headerKeys = Object.entries(m.headers || {});
  const pills = [
    badge(m.transport ? m.transport.toUpperCase() : '未知协议', 'muted', 'mono'),
    badge(SCOPE_LABEL[m.scope] || m.scope || '—', m.scope === 'builtin' ? 'info' : 'muted'),
    m.toolCount ? badge(`${m.toolCount} 个工具`, 'violet') : '',
  ]
    .filter(Boolean)
    .join('');

  return `<article class="mcp-card ${m.enabled === false ? 'is-off' : ''}">
    <div class="mcp-top">
      <div>
        <div class="mcp-name">${esc(m.name)}</div>
        <div class="dim" style="font-size:11px">${esc(agentLabel(m.agent))}</div>
      </div>
      ${stateBadge}
    </div>
    <div class="mcp-pills">${pills}</div>
    ${target}
    ${
      envKeys.length
        ? `<details class="mcp-env">
            <summary>环境变量（${envKeys.length}）</summary>
            <div class="mcp-env-list">
              ${envKeys
                .map(
                  ([k, v]) => `<div class="mcp-env-row"><span>${esc(k)}</span><span>${esc(v === '' ? '（空）' : v)}</span></div>`,
                )
                .join('')}
            </div>
          </details>`
        : ''
    }
    ${
      headerKeys.length
        ? `<details class="mcp-env">
            <summary>请求头（${headerKeys.length}）</summary>
            <div class="mcp-env-list">
              ${headerKeys
                .map(([k, v]) => `<div class="mcp-env-row"><span>${esc(k)}</span><span>${esc(v || '（空）')}</span></div>`)
                .join('')}
            </div>
          </details>`
        : ''
    }
    <div class="mcp-foot" title="${esc(m.sourcePath || '')}">${esc(m.sourcePath || '')}</div>
  </article>`;
}

// ---------- 刷新 ----------
async function rescan() {
  const btn = $('#btn-refresh');
  if (btn?.classList.contains('is-busy')) return;
  btn?.classList.add('is-busy');
  btn?.setAttribute('disabled', '');
  try {
    const json = await api('/api/scan?full=0', { method: 'POST' });
    await loadSnapshot();
    if (state.view === 'cost') await loadCostUsage();
    render();
    toast(`扫描完成 · ${fmtInt(json.data.facts)} 条事实（新增 ${fmtInt(json.data.newFacts)}）· ${json.data.durationMs}ms`);
  } catch (err) {
    toast(`扫描失败：${err.message || err}`, true);
  } finally {
    btn?.classList.remove('is-busy');
    btn?.removeAttribute('disabled');
  }
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.hidden = false;
  el.className = `toast is-on ${isError ? 'is-error' : ''}`;
  el.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${isError ? 'i-warn' : 'i-check'}"/></svg><span>${esc(message)}</span>`;
  requestAnimationFrame(() => el.classList.add('is-on'));
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => {
      el.hidden = true;
    }, 200);
  }, 4200);
}

// ---------- 启动 ----------
function bindGlobal() {
  $('#btn-refresh')?.addEventListener('click', rescan);
  window.addEventListener('keydown', (evt) => {
    if (evt.key === 'r' && (evt.ctrlKey || evt.metaKey) && !evt.shiftKey) {
      evt.preventDefault();
      rescan();
    }
  });
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.view === 'overview') drawTrend();
      if (state.view === 'cost') {
        const chart = $('#cost-chart');
        const usage = state.costUsage || state.snapshot?.usage;
        if (chart && usage) {
          const rows = state.costRange ? lastDays(usage.byDay || [], state.costRange) : usage.byDay || [];
          drawLineChart(chart, rows, 'cost');
        }
      }
    }, 180);
  });
}

async function boot() {
  setupNav();
  bindGlobal();
  await loadSnapshot();
  render();
}

boot();
