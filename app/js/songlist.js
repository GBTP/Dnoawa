/**
 * songlist / slst 解析。
 *
 * 移植自客户端 Anoawa/Assets/Scripts/Anoawa/Utils/SonglistReader.cs，
 * 行为逐字段对齐——谱师从 Arcaea 侧拿到的目录直接拖进来时，网页和客户端
 * 认出来的元数据必须一致。
 *
 * 刻意用正则而不是 JSON.parse：实际流通的 songlist 经常不是严格 JSON
 * （尾逗号、注释、单引号），客户端就是这么读的，这里跟着来才不会出现
 * "客户端能导入、网页说格式错误"。
 */

/** ChartFolderScanner.DifficultyCount */
export const DIFFICULTY_COUNT = 5;

/** ChartFolderScanner.DiffNames */
export const DIFF_NAMES = ['Past', 'Present', 'Future', 'Beyond', 'Eternal'];

/** ChartFolderScanner.DiffColors — 导入时按难度档给的默认主题色 */
export const DIFF_COLORS = ['#3A6FC4', '#4B9B4B', '#7B3FA0', '#B03030', '#5D4E76'];

/** ChartFolderScanner.s_SonglistNames */
const SONGLIST_NAMES = new Set([
  'songlist', 'slst', 'songlist.txt', 'slst.txt', 'songlist.json', 'slst.json',
]);

export function isSonglistName(fileName) {
  return SONGLIST_NAMES.has(fileName.toLowerCase());
}

/**
 * @returns {{hasRead: boolean, titleEn: ?string, titleJa: ?string, artist: ?string,
 *   bpm: ?string, bpmBase: number, previewStart: number, previewEnd: number,
 *   difficulties: Array<?{chartDesigner: ?string, jacketDesigner: ?string, rating: number}>}}
 */
export function parseSonglist(raw) {
  const empty = {
    hasRead: false,
    titleEn: null, titleJa: null, artist: null,
    bpm: null, bpmBase: 0, previewStart: 0, previewEnd: 0,
    difficulties: new Array(DIFFICULTY_COUNT).fill(null),
  };

  if (!raw) return empty;

  try {
    const result = {
      ...empty,
      titleEn: matchNested(raw, 'title_localized', 'en'),
      titleJa: matchNested(raw, 'title_localized', 'ja'),
      artist: matchString(raw, 'artist'),
      bpm: matchString(raw, 'bpm'),
      bpmBase: matchFloat(raw, 'bpm_base'),
      // songlist 里是毫秒
      previewStart: matchInt(raw, 'audioPreview') / 1000,
      previewEnd: matchInt(raw, 'audioPreviewEnd') / 1000,
      difficulties: readDifficulties(raw),
    };
    result.hasRead = true;
    return result;
  } catch {
    return empty;
  }
}

function readDifficulties(raw) {
  const list = new Array(DIFFICULTY_COUNT).fill(null);

  const arrayMatch = /"difficul\w*"\s*:\s*\[/.exec(raw);
  if (!arrayMatch) return list;

  const block = extractBracketBlock(raw, arrayMatch.index + arrayMatch[0].length - 1);
  if (!block) return list;

  const entries = block.match(/\{[^}]*\}/g) || [];
  entries.forEach((entry, i) => {
    const rc = /"ratingClass"\s*:\s*(\d+)/.exec(entry);
    const ratingClass = rc ? Number.parseInt(rc[1], 10) : i;
    if (ratingClass < 0 || ratingClass >= DIFFICULTY_COUNT) return;

    // jecketDesigner 是上游长期存在的拼写错误，客户端两个都认，这里跟着认
    const designer = matchString(entry, 'jacketDesigner') || matchString(entry, 'jecketDesigner');

    list[ratingClass] = {
      chartDesigner: matchString(entry, 'chartDesigner'),
      jacketDesigner: designer,
      rating: matchInt(entry, 'rating'),
    };
  });

  return list;
}

/** 从 openIndex 处的 '[' 起，配对到对应的 ']'。 */
function extractBracketBlock(raw, openIndex) {
  if (raw[openIndex] !== '[') return null;
  let depth = 0;
  for (let i = openIndex; i < raw.length; i += 1) {
    if (raw[i] === '[') depth += 1;
    else if (raw[i] === ']') depth -= 1;
    if (depth === 0) return raw.slice(openIndex, i + 1);
  }
  return null;
}

function matchString(raw, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*?)"`).exec(raw);
  return m ? m[1] : null;
}

function matchFloat(raw, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?[\\d.]+)`).exec(raw);
  return m ? Number.parseFloat(m[1]) || 0 : 0;
}

function matchInt(raw, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(raw);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function matchNested(raw, outerKey, innerKey) {
  const outer = new RegExp(`"${outerKey}"\\s*:\\s*\\{[^}]*\\}`).exec(raw);
  return outer ? matchString(outer[0], innerKey) : null;
}
