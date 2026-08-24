/**
 * AFF 中的天键音效引用分析。
 *
 * 客户端 ChartSfxRegistry 对 fx 名称的解析规则必须在网页端保持一致：
 * glass / glass_wav / glass.wav 最终都查找 glass.wav，none 表示默认音。
 */

export function resolveSfxFileName(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name || name.toLowerCase() === 'none') return null;
  if (name.toLowerCase().endsWith('.wav')) return name;
  if (name.toLowerCase().endsWith('_wav')) return `${name.slice(0, -4)}.wav`;
  return `${name}.wav`;
}

/**
 * 从所有 arc 行收集 fx 字段。多收普通蛇的 none 没有副作用，漏掉一个真实引用才会
 * 让客户端悄悄回落默认音效，所以这里不试图复刻客户端的音符分类。
 */
export function referencedSfx(affText) {
  const found = new Map();
  const text = String(affText || '');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*arc\(([^)]*)\)/i);
    if (!match) continue;
    const fields = match[1].split(',');
    const name = resolveSfxFileName(fields[8]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, name);
  }
  return [...found.values()];
}

/**
 * 对照 AFF 引用和 ZIP 内 wav，返回缺失、闲置和已匹配三组名字。
 * @param {string} affText
 * @param {Array<{name: string}>} sounds
 */
export function analyzeSfx(affText, sounds = []) {
  const referenced = referencedSfx(affText);
  const byKey = new Map(sounds.map(item => [item.name.toLowerCase(), item.name]));
  const referencedKeys = new Set(referenced.map(name => name.toLowerCase()));
  const missing = referenced.filter(name => !byKey.has(name.toLowerCase()));
  const unused = sounds
    .filter(item => !referencedKeys.has(item.name.toLowerCase()))
    .map(item => item.name);
  const matched = referenced
    .filter(name => byKey.has(name.toLowerCase()))
    .map(name => byKey.get(name.toLowerCase()));
  return { referenced, missing, unused, matched };
}
