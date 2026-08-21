/**
 * 获取游戏的渠道信息。
 *
 * 这里是唯一的事实来源——登录页、谱面库、拉起失败的提示、下载页都读它。
 * 群号或 TestFlight 链接变了只改这一处。
 *
 * Android / Windows 的直链走 GBTP/Anoawa-Releases 的 latest 重定向，永远指向最新
 * release，**发新版不用回来改这里**——前提是那边的资产文件名固定不带版本号。
 * 谁要是把资产传成 Anoawa-1.1.3.apk 这种名字，下面两行立刻 404，
 * 约定和发布脚本都在那个仓库的 README 里。
 *
 * 群入口保留成备选而不是删掉：GitHub 在国内经常慢到下不完 70MB 的包，
 * 群文件里是同一份安装包，那是兜底不是历史遗留。
 */

export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/XMcFWlQA';
export const RELEASES_URL = 'https://github.com/GBTP/Anoawa-Releases/releases';

const latest = (file) => `${RELEASES_URL}/latest/download/${file}`;

export const PLATFORMS = [
  {
    os: 'Android',
    title: 'APK',
    note: '下载后直接安装，系统提示来源未知时允许即可。Android 11 及以上首次导入谱面时需要授予文件访问权限。',
    action: { label: '下载 APK', href: latest('Anoawa-Android.apk'), download: true },
    alt: { label: '群文件下载', href: '#community' },
  },
  {
    os: 'iOS',
    title: 'TestFlight',
    note: '先从 App Store 安装 TestFlight，再加入 Anoawa 公测。名额和更新以群内公告为准。',
    action: { label: '加入 TestFlight ↗', href: TESTFLIGHT_URL, external: true },
  },
  {
    os: 'Windows',
    title: '桌面版',
    note: '解压整个压缩包再运行 Anoawa.exe，它依赖同级的 Anoawa_Data 文件夹。仅支持 64 位，更新节奏可能与移动端不同。',
    action: { label: '下载压缩包', href: latest('Anoawa-Windows-x64.zip'), download: true },
    alt: { label: '群文件下载', href: '#community' },
  },
];

export const DOWNLOAD_NOTE = '安装包托管在 GitHub，国内直连可能较慢或中断，下不动就走群文件。';

export const COMMUNITY = [
  { label: 'QQ 一群', value: '694748554' },
  { label: 'QQ 二群', value: '499564108' },
  { label: 'QQ 频道', value: 'ngqny4035b' },
];

export const COMMUNITY_NOTE = '群里有同一份安装包，另有更新公告与谱面交流。一群无法加入时可以选择二群。';
