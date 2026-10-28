// 脱敏：任何进入 API 响应的 env / header / token 都必须先过这里。
// 原则：只暴露"有值"和"末 4 位"，绝不透出完整密钥；
// 但路径、命令行、版本号这类非敏感值要保留原文，否则面板变得没用。

const SECRET_KEY_RE = /(key|token|secret|passw|credential|auth|cookie|bearer|private)/i;
const SECRET_PREFIX_RE = /^(sk-|sk_|ghp_|gho_|github_pat_|AKIA|xox[baprs]-|eyJ|glpat-|npm_)/;

/**
 * 判断某个字符串是否像密钥（用于 key 名不含敏感词时的兜底判断）。
 * 刻意排除：URL、文件路径（含 \ 或 /）、命令行、带空格的自然语言。
 */
export function looksSecret(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 20) return false;
  if (/^(https?|file|ws|wss):\/\//i.test(v)) return false;
  if (/\s/.test(v)) return false;
  // 路径 / 命令行 / 命名空间一律不当作密钥
  if (/[\\/]/.test(v)) return false;
  if (SECRET_PREFIX_RE.test(v)) return true;
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  // 长且大小写+数字混排（含符号更可疑）；GUID、版本串等只有 1~2 类，不会命中
  return v.length >= 32 && classes >= 3;
}

export function maskValue(value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  if (!s) return s;
  if (s.length <= 6) return '***';
  return `***${s.slice(-4)}`;
}

/** 脱敏 env 对象：key 名保留（便于看配了哪些变量），敏感值打码。 */
export function maskEnv(envObj) {
  if (!envObj || typeof envObj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(envObj)) {
    const raw = Array.isArray(v) ? v.join(',') : v;
    out[k] = SECRET_KEY_RE.test(k) || looksSecret(raw) ? maskValue(raw) : String(raw ?? '');
  }
  return out;
}

/** 脱敏 headers：敏感头打码，其余（content-type 等）原样保留。 */
export function maskHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_KEY_RE.test(k) || looksSecret(v) ? maskValue(v) : String(v ?? '');
  }
  return out;
}

/** URL 里的 query 参数脱敏（有些 MCP server 把 key 放 ?key=）。 */
export function maskUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 脱敏启动参数：`--api-key=xxx`、`--token xxx` 这类形式里，
 * flag 名命中敏感词就把值打码；命令行里的路径、开关原样保留。
 */
export function maskArgs(args) {
  if (!Array.isArray(args)) return [];
  const out = [];
  let secretNext = false;
  for (const raw of args) {
    const arg = String(raw ?? '');
    if (secretNext) {
      out.push(maskValue(arg));
      secretNext = false;
      continue;
    }
    const eq = arg.match(/^(--?[^=]+)=(.*)$/);
    if (eq && SECRET_KEY_RE.test(eq[1])) {
      out.push(`${eq[1]}=${maskValue(eq[2])}`);
      continue;
    }
    if (/^--?[^=]+$/.test(arg) && SECRET_KEY_RE.test(arg)) {
      secretNext = true;
      out.push(arg);
      continue;
    }
    out.push(looksSecret(arg) ? maskValue(arg) : arg);
  }
  return out;
}
