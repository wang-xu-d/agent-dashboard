// 极简 TOML 解析：只覆盖 Codex config.toml 里用到的形状
// （[table.sub] 表头、字符串/单引号字符串、数组、布尔、数字）。
// 不追求完整 TOML 语义，值解析失败时退化为原始字符串。

function parseValue(raw) {
  const v = raw.trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const body = v.slice(1, -1).trim();
    if (!body) return [];
    const parts = [];
    let cur = '';
    let quote = null;
    for (const ch of body) {
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ',') {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.filter((p) => p !== '');
  }
  return v;
}

/**
 * @returns {{ top: Record<string, any>, tables: Record<string, Record<string, any>> }}
 */
export function parseToml(text) {
  const top = {};
  const tables = {};
  if (typeof text !== 'string') return { top, tables };

  let current = top;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const key = header[1].trim();
      current = tables[key] || (tables[key] = {});
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let rawValue = kv[2];

    // 多行数组：一直吃到出现 ']'
    if (rawValue.trim().startsWith('[') && !rawValue.includes(']')) {
      while (i + 1 < lines.length && !rawValue.includes(']')) {
        rawValue += ` ${lines[++i].trim()}`;
      }
    }
    current[kv[1]] = parseValue(rawValue);
  }
  return { top, tables };
}

/** 取 `mcp_servers` 前缀下的所有条目：{ name: {...} } */
export function tomlSectionEntries(tables, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(tables)) {
    if (!key.startsWith(`${prefix}.`)) continue;
    const rest = key.slice(prefix.length + 1);
    const [name, ...sub] = rest.split('.');
    if (!name) continue;
    if (sub.length === 0) {
      out[name] = out[name] || {};
      Object.assign(out[name], value);
    } else if (sub.length === 1) {
      out[name] = out[name] || {};
      out[name][sub[0]] = value;
    }
  }
  return out;
}
