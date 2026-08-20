# Dnoawa — Anoawa 社区网站

原生 HTML/CSS/JS，无依赖无构建。改完直接推，GitHub Pages 即部署。
仓库结构和本地预览方式见 `README.md`，这里只记「不看就会踩」的东西。

## 三个仓库的关系

| | 是什么 | 本地路径 |
|---|---|---|
| Dnoawa | 本仓库，社区网站 | `../Dnoawa` |
| Bnoawa | 后端 API | `../Bnoawa`（私有仓库，含明文凭据） |
| Anoawa | Unity 客户端 | `../Anoawa` |

**动任何涉及后端契约的东西之前，先读 `../Bnoawa/CLAUDE.md`。** 它把业务规则的
「为什么」写得很细，很多约定光看 DTO 是推不出来的。

网页和客户端消费同一套 API，**凡是两边都要做的事（转码参数、每页条数、
文件识别规则），以客户端的实现为准**——那边是先有的，用户对它的行为有预期。
改之前去 `../Anoawa/Assets/Scripts/` 找对应实现，别自己定。

## 后端契约里最容易搞错的几处

**布尔开关缺字段 = true。** `DeleteAccountRequest` / `DeleteProfileRequest` 的三个
删除范围开关都**没有** `[Required]`，缺字段时按 `true`（全删）反序列化。想保留
必须显式发 `false`。所有相关调用都显式发三个布尔值，别用「有值才提交」的惯例。

**两种 token 严格互斥。**

| | profileToken | accountToken |
|---|---|---|
| 存哪 | `localStorage`，7 天 | **只放内存**，1 小时 |
| 谁要 | 默认所有端点 | `/api/profiles/*`、删谱面、生成谱面转让码 |

accountToken 不落盘是**隐私**要求不是权限要求：账号级端点的每个响应都在回答
「这个账号名下有哪些身份」，那是小号之间唯一可关联的信息。`api.js` 的 `request()`
用 `account: true` 切换，拿错了后端是 403 而不是静默降级。

规则是**「不可逆的事都要提权」**——删谱面、生成转让码要 accountToken，但撤销
转让码不要（可逆方向）。加新调用前先确认端点在哪个 Controller。

**一次性明文只出现一次。** 转让码（身份的和谱面的）库里存 SHA-256，响应之后
任何接口都取不回来。UI 必须当场让用户复制，并写明「关掉就看不到了」。

**空结果的形状不统一。** 新端点是分页包装（`{items, totalCount, page, pageSize}`，
空时 `items: []`），老端点有裸数组的。别假设，去看 DTO。

**404 和 403 不能混。** 后端约定 403 是「存在但当前不可见」（如审核中的谱面对
非上传者），404 才是真的没了。前端只在 404 时才能说「已删除」。

## 网页独有的约束

**媒体资源走 LeanCloud 原始 URL，不走 302 端点。** `<img>` 和 `<audio>` 带不了
`Authorization` 头，走 `/api/levels/{id}/cover` 必然 401。`LevelResponse` 里直接
给了 `coverUrl` / `previewUrl`，用那个。

配套的两件事：封面加 `referrerpolicy="no-referrer"` 绕开 Referer 防盗链；
`<audio>` **不要**加 `crossorigin`——媒体播放跨域本不需要 CORS，加了反而强制走
检查，CDN 没返 ACAO 就直接没声音。

**Safari 放不了 Ogg Vorbis**，而后端强制这个格式。`js/audio.js` 的做法是先挂原生
`<audio>`、出错再换 WASM 解码器——不只看 `canPlayType`，因为 CDN 返回的是
`audio/x-vorbis+ogg` 这个非标准 MIME，对 MIME 严格的浏览器会认为自己能播然后卡住，
那种情况能力检测判不出来。

**vendor/ 里的 WASM 随仓库提交，不从 CDN 拉。** 那些库默认从 unpkg 取 wasm，
国内大概率不通。用 `createEncoder(mime, 'vendor/ogg.wasm')` 而不是库自带的
`createOggEncoder()`。

## 已经踩过的坑

**`[hidden]` 会被类选择器的 `display` 覆盖。** 栽过三次（`.pager`、`.hot-periods`、
`.title-options`）。给任何可能被 `hidden` 控制的组件写 `display` 时，配一条
`.foo[hidden] { display: none }`。加完新组件跑一次这个扫描：

```bash
python3 - <<'PY'
import re, pathlib
css = re.sub(r'/\*.*?\*/', '', pathlib.Path('app.css').read_text(encoding='utf-8'), flags=re.S)
d = {}
for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
    m = re.search(r'display:\s*([\w-]+)', body)
    if m and m.group(1) != 'none':
        for one in sel.split(','):
            one = one.strip()
            if one.startswith('.') and ' ' not in one and ':' not in one: d[one] = m.group(1)
for page in pathlib.Path('.').glob('*.html'):
    html = page.read_text(encoding='utf-8')
    for m in list(re.finditer(r'<\w+[^>]*class="([^"]+)"[^>]*\bhidden\b', html)) + \
             list(re.finditer(r"el\('\w+',\s*\{\s*class:\s*'([^']+)'[^}]*hidden:\s*true", html)):
        for c in m.group(1).split():
            if '.'+c in d and f'.{c}[hidden]' not in css: print(f'  ✗ {page.name}: .{c}')
PY
```

**暂时性死区。** 页面脚本是顶层执行的，`let`/`const` 声明必须排在第一次调用之前。
踩过一次：`load()` 写在 `let requestSeq = 0` 之前，进页面一片空白、点搜索才正常——
因为 `load` 是 async，`ReferenceError` 变成未处理的 rejection，界面上毫无提示。

**拖进来的 `File` 没有 `webkitRelativePath`。** 那是 `<input webkitdirectory>` 才有的，
拖放路径下目录信息在 `entry.fullPath` 上。按路径识别的文件（`Arcade/Project.arcade`）
必须自己把它挂上去。

**`<a>` 里不能嵌 `<a>`。** 浏览器会把内层移出去。卡片本身是链接时，角标要做成
兄弟节点 + 绝对定位。

## 改动之后

没有测试和构建，所以每次改完至少跑这三样：

```bash
# 1. 所有 JS 模块和页面内联脚本的语法
for f in js/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "✗ $f"; done

# 2. 导入的符号是否真的被导出（改模块导出后最容易断）
# 3. 起服务器看各页 200
python3 -m http.server 4173
```

**部署后必须 Purge Cloudflare 缓存。** HTML 是 `max-age=600`，JS/CSS 被 Cloudflare
覆盖成 `max-age=14400`——同时改了 HTML 和 JS 的话，有最长 4 小时窗口两边版本对不上，
ES module 导入失配是硬报错、整页白屏。栽过一次。

**生产 CORS 不放行 localhost。** 本地联调要自己起后端，用 `?api=http://localhost:58271`
切过去（该参数只在页面来自 localhost 时生效，线上放开等于给了钓鱼入口）。

## 设计

暗色、中性近黑 `#0b0b0d`，**零投影零圆角**，渐变只剩下拉箭头和无封面时的兜底。
（`app.css` 里唯一的 `box-shadow` 是 `inset`，用来画排行榜自己那行的竖线，
不是投影。）这是一次刻意的重构——之前那版是
「深色 SaaS 落地页」的默认长相，原样换给任何产品都成立，说明它没在讲这个产品的事。

颜色只在两处出现，且都是功能性的：

1. 谱面自己的 `themeColor`（卡片下一条 2px、详情页标题上一条 3px、无封面时的兜底色）
2. 难度档色，取自客户端 `ChartFolderScanner.DiffColors`，五档一一对应

除此之外全站只有黑白灰，**交互色就是白**。加新组件时别引入新的强调色——
底子安静，`themeColor` 才浮得出来，那是这里唯一别处抄不走的东西。

文档站（`docs/`）复用同一套 token，但它没有曲绘，所以全是黑白灰。

## 有意没做的事

- **谱面包下载入口**：`chartPackageUrl` 就在响应里，但游戏那边「下载的谱面默认不能
  再导出」是防二次分发的，网页放裸下载会绕过它。不是安全控制，只是不去背书那条路径。
- **提交成绩、联机**：只能由游戏客户端调，网页能提交成绩等于开挂通道。
- **谱面详情页放开搜索引擎收录**：它需要登录，爬虫拿到的是空壳，收录了用户搜进来
  就被踢到登录页。等后端支持匿名浏览再说。
- **浏览器内转码视频**：ffmpeg.wasm 的核心是 GPL，而本仓库公开、客户端闭源；
  多线程版还要 COOP/COEP 响应头，GitHub Pages 设不了。现在的做法是验合规 + 给
  ffmpeg 命令让用户自己转。
- **B 站 UID 做成自动链接**：后端不验证归属，谁都能填别人的 UID。做成需要主动点击
  的按钮 + 「未验证」标记，责任归属才清楚。等有了归属验证再放开。
