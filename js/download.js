/**
 * 获取游戏的渠道信息。
 *
 * 这里是唯一的事实来源——登录页、谱面库、拉起失败的提示、下载页都读它。
 * 群号或 TestFlight 链接变了只改这一处。
 *
 * 注意三个平台里只有 iOS 有直接链接，Android 和 Windows 都是"进群拿安装包"，
 * 所以入口文案是"获取游戏"而不是"下载"。
 */

export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/XMcFWlQA';

export const PLATFORMS = [
  {
    os: 'Android',
    title: 'APK',
    note: '从群文件下载后直接安装。Android 11 及以上首次导入谱面时需要授予文件访问权限。',
    action: { label: '查看社区群', href: '#community' },
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
    note: '从群文件下载压缩包，解压后运行。桌面版更新节奏可能与移动端不同。',
    action: { label: '查看社区群', href: '#community' },
  },
];

export const COMMUNITY = [
  { label: 'QQ 一群', value: '694748554' },
  { label: 'QQ 二群', value: '499564108' },
  { label: 'QQ 频道', value: 'ngqny4035b' },
];

export const COMMUNITY_NOTE = '安装包、更新公告与谱面交流都在群内。一群无法加入时可以选择二群。';
