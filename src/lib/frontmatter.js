// 极简 YAML frontmatter 解析：只取 SKILL.md / command / agent 头部需要的标量字段。
// 支持 `key: value`、引号包裹、`|` / `>` 块标量。不引入 yaml 依赖。

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  // 允许文件开头有 BOM 或空行
  const cleaned = text.replace(/^\uFEFF/, '');
  const m = cleaned.match(FM_RE);
  if (!m) return {};
  const body = m[1];
  const out = {};
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();

    // 块标量：`key: |` 或 `key: >`，后续缩进行全部拼进来
    if (value === '' || value === '|' || value === '>' || /^[|>][-+]?$/.test(value)) {
      const collect = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collect.push(lines[i + 1].trim());
        i++;
      }
      const joined = collect.join(value.startsWith('>') ? ' ' : '\n').trim();
      out[key] = joined;
      continue;
    }
    // 去引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 正文（去掉 frontmatter 后的部分），用于按需展示摘要。 */
export function stripFrontmatter(text) {
  return String(text || '').replace(FM_RE, '').trim();
}
