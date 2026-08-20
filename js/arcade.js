/**
 * 读 Arcade 编辑器工程文件（谱面目录下的 Arcade/Project.arcade）里的曲目信息。
 *
 * 移植自客户端 Anoawa/Assets/Scripts/Anoawa/Utils/ArcadeProjectReader.cs，
 * 只认最外层的 Title / Artist / BaseBpm 三个字段，逐难度的信息一概不管。
 *
 * 刻意用 JSON.parse + 只取三个顶层字段，而不是像 songlist 那样全文正则——
 * 客户端那边的注释写明了原因：Arcade 有不少分支，工程文件结构并不统一，
 * 难度信息在有的版本里叫 Difficulties（数组）、有的还并列一个 Difficulties2
 * （字典），而难度对象里同样有 Title 这种同名字段，外层字段的位置也不固定。
 * 正则"取第一个匹配"在这上面迟早取错人；只读顶层就不会碰到嵌套里的同名字段。
 *
 * songlist 那边情况相反——实际流通的 songlist 经常不是严格 JSON，所以那边必须
 * 用正则。两个文件用不同策略是有意的，别统一。
 */

/** ChartFolderScanner 里的路径：子目录 Arcade/ 下，不在谱面目录根部。 */
export function isArcadeProjectPath(relativePath) {
  const parts = relativePath.toLowerCase().split('/');
  const file = parts.pop();
  return file === 'project.arcade' && parts[parts.length - 1] === 'arcade';
}

/**
 * @returns {{hasRead: boolean, title: ?string, artist: ?string, baseBpm: number}}
 */
export function parseArcadeProject(raw) {
  const empty = { hasRead: false, title: null, artist: null, baseBpm: 0 };
  if (!raw) return empty;

  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    // 某个分支写出了非法 JSON，当作没有工程文件处理
    return empty;
  }
  if (!info || typeof info !== 'object') return empty;

  // 只取顶层的这三个，且类型不对就当没有——客户端用 DTO 反序列化天然做到这点，
  // JS 里得自己判，否则 Title 是个对象时会渲染成 "[object Object]"
  const str = value => typeof value === 'string' && value.trim() ? value : null;
  const num = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  return {
    hasRead: true,
    title: str(info.Title),
    artist: str(info.Artist),
    baseBpm: num(info.BaseBpm),
  };
}
