// 成本计算：
// 1) 先用 pricing.json 里的显式单价（用户可编辑）；
// 2) 没有显式单价的模型，用 Claude 每次会话的 `cost-state` 记录反推单价（最小二乘）；
// 3) 都拿不到 → 返回 null，前端应显示"未配置单价"而不是假的 0。
//
// 反推的意义：这台机器的 Claude 走第三方 base_url，平台不写 costUSD 的地方很多，
// 但 cost-state 里每个 model 都带 tokens + costUSD，足够解出 每百万 token 单价。

export const CACHE_READ_MULT = 0.1; // 缓存读 ≈ 输入价 10%
export const CACHE_WRITE_MULT = 1.25; // 缓存写 ≈ 输入价 125%

/**
 * 把 `gpt-6.1-sol[1m]`、`anthropic/claude-opus-5` 这类名字归一化，
 * 便于把同一模型的多个变体合并计价。
 */
export function normalizeModel(model) {
  if (!model) return 'unknown';
  let m = String(model).trim();
  m = m.replace(/\[[^\]]*\]$/, ''); // 去掉 [1m] / [200k] 之类的上下文后缀
  m = m.split('/').pop() || m; // 去掉 provider/ 前缀
  return m.toLowerCase();
}

/** 单次用量二元组：(等效输入 token, 输出 token)。缓存按倍数折算进输入。 */
function effectiveTokens(u, pricing) {
  const cr = pricing.cacheReadMultiplier ?? CACHE_READ_MULT;
  const cw = pricing.cacheWriteMultiplier ?? CACHE_WRITE_MULT;
  const inTok = (u.input || 0) + (u.cacheRead || 0) * cr + (u.cacheWrite || 0) * cw;
  return { inTok, outTok: u.output || 0 };
}

/**
 * 用 (tokens, costUSD) 样本反推每百万 token 的输入价与输出价。
 * 解 2x2 正规方程；样本量 < 3 或方程奇异时返回 null。
 */
export function derivePrices(samples, pricing = {}) {
  const rows = samples
    .filter((s) => s && Number.isFinite(s.costUSD) && s.costUSD > 0)
    .map((s) => {
      const { inTok, outTok } = effectiveTokens(s, pricing);
      return { inTok, outTok, cost: s.costUSD };
    })
    .filter((r) => r.inTok + r.outTok > 0);

  if (rows.length < 3) return null;

  let Saa = 0, Sab = 0, Sbb = 0, Sa = 0, Sb = 0;
  for (const r of rows) {
    Saa += r.inTok * r.inTok;
    Sab += r.inTok * r.outTok;
    Sbb += r.outTok * r.outTok;
    Sa += r.inTok * r.cost;
    Sb += r.outTok * r.cost;
  }
  const det = Saa * Sbb - Sab * Sab;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    // 退化：只有输入维度有变化
    if (Saa > 0) {
      const a = Sa / Saa;
      return { input: a * 1e6, output: null, samples: rows.length, fit: 'input-only' };
    }
    return null;
  }
  const a = (Sa * Sbb - Sb * Sab) / det; // 每 token 输入价
  const b = (Sb * Saa - Sa * Sab) / det; // 每 token 输出价

  // 合理性检查：每百万 token 价格应为正且在 (0, 2000] 区间内
  const input = a * 1e6;
  const output = b * 1e6;
  if (!Number.isFinite(input) || input <= 0 || input > 2000) return null;
  if (!Number.isFinite(output) || output < 0 || output > 2000) return null;

  return { input, output, samples: rows.length, fit: 'lsq' };
}

/**
 * @param {string} model
 * @param {{models?: Record<string,{input:number|null,output:number|null}>, derived?: Record<string, any>}} pricing
 */
export function resolvePrice(model, pricing) {
  const key = normalizeModel(model);
  const explicit = pricing.models?.[key];
  if (explicit && Number.isFinite(explicit.input) && Number.isFinite(explicit.output)) {
    return { input: explicit.input, output: explicit.output, source: 'table' };
  }
  const d = pricing.derived?.[key];
  if (d && Number.isFinite(d.input) && Number.isFinite(d.output)) {
    return { input: d.input, output: d.output, source: 'derived', samples: d.samples };
  }
  // 兜底：用户配置的默认单价（例如中转站对所有模型统一定价）。
  // 这类价格不是"精确值"，前端应标成"按默认价估算"。
  const def = pricing.default;
  if (def && Number.isFinite(def.input) && Number.isFinite(def.output)) {
    return { input: def.input, output: def.output, source: 'default' };
  }
  return null;
}

/**
 * 计算单条用量事实的美元成本。
 * @returns {{costUSD: number, priceSource: string}|{costUSD: null, priceSource: 'unknown'}}
 */
export function costOf(usage, price, pricing = {}) {
  if (!price) return { costUSD: null, priceSource: 'unknown' };
  const cr = pricing.cacheReadMultiplier ?? CACHE_READ_MULT;
  const cw = pricing.cacheWriteMultiplier ?? CACHE_WRITE_MULT;
  const inCost =
    ((usage.input || 0) + (usage.cacheRead || 0) * cr + (usage.cacheWrite || 0) * cw) *
    (price.input / 1e6);
  const outCost = (usage.output || 0) * (price.output / 1e6);
  const costUSD = inCost + outCost;
  return { costUSD, priceSource: price.source };
}
