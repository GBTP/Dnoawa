/**
 * 谱面资源包的浏览器侧模型。
 *
 * 网页上的资源编辑不把 chart.zip 当成一个不可分割的文件，而是把它展开成
 * 谱面、背景、演出效果和天键音效。build() 时再用客户端约定的条目名拼回去。
 */

import { buildZip, readZip } from './media.js';

const isWav = name => name.toLowerCase().endsWith('.wav');
const baseName = name => name.split('/').pop().toLowerCase();

function entry(name, data, store = true) {
  return { name, data: data instanceof Uint8Array ? data : new Uint8Array(data), store };
}

/**
 * 把 ZIP 条目分到界面能理解的资源槽位。
 * 未知条目原样放进 others，避免编辑一张手工制作的包时丢掉扩展内容。
 */
export function classifyChartEntries(entries) {
  const model = {
    chart: null,
    background: null,
    effect: null,
    sfx: [],
    others: [],
  };

  for (const item of entries) {
    const lower = item.name.toLowerCase();
    const data = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data);
    const current = entry(item.name, data, item.store ?? (lower.endsWith('.wav') || lower === 'bg.jpg' || lower === 'effect.bin'));

    if (baseName(item.name) === 'chart.aff' && !model.chart) model.chart = current;
    else if (item.name === 'bg.jpg' && !model.background) model.background = current;
    else if (item.name === 'effect.bin' && !model.effect) model.effect = current;
    else if (isWav(item.name)) model.sfx.push(current);
    else model.others.push(current);
  }

  return model;
}

/** @param {Uint8Array} bytes */
export async function openChartPackage(bytes) {
  const model = classifyChartEntries(await readZip(bytes));
  if (!model.chart) throw new Error('压缩文件里没有 chart.aff');
  return model;
}

/**
 * 以客户端约定的名字重新生成谱面包。
 * @param {{chart: object, background?: object|null, effect?: object|null,
 *   sfx?: object[], others?: object[]}} model
 */
export async function buildChartPackage(model) {
  if (!model?.chart?.data) throw new Error('缺少谱面文件');

  const entries = [entry('chart.aff', model.chart.data, false)];
  if (model.background?.data) entries.push(entry('bg.jpg', model.background.data, true));
  if (model.effect?.data) entries.push(entry('effect.bin', model.effect.data, true));
  for (const sound of model.sfx || []) {
    if (!sound?.name || !sound.data) continue;
    entries.push(entry(sound.name, sound.data, true));
  }
  for (const other of model.others || []) {
    if (!other?.name || !other.data) continue;
    // 未知条目也原样保留；重新压缩不影响客户端读取。
    entries.push(entry(other.name, other.data, other.store ?? true));
  }
  return buildZip(entries);
}

export function packageFileCount(model) {
  return (model?.chart ? 1 : 0) + (model?.background ? 1 : 0) +
    (model?.effect ? 1 : 0) + (model?.sfx?.length || 0) + (model?.others?.length || 0);
}

export function packageResourceNames(model) {
  return [
    model?.chart?.name,
    model?.background?.name,
    model?.effect?.name,
    ...(model?.sfx || []).map(item => item.name),
    ...(model?.others || []).map(item => item.name),
  ].filter(Boolean);
}
