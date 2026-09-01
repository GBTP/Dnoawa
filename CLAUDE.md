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

**布尔开关缺字段 = true。** `DeleteAccountRequest` / `DeleteProfileRequest` 的两个
删除范围开关（`deleteLevels` / `deletePlayRecords`）都**没有** `[Required]`，缺字段时按
`true`（全删）反序列化。想保留必须显式发 `false`。所有相关调用都显式发两个布尔值，别用
「有值才提交」的惯例。评价（点赞三态、体感难度票）跟随 `deletePlayRecords`——它们都需
游玩过才能提交，是成绩的衍生物，不再单列 `deleteLikes`。

**两种 token 严格互斥。**

| | profileToken | accountToken |
|---|---|---|
| 存哪 | `localStorage`，30 天且会滑动续期 | **只放内存**，1 小时，从不续期 |
| 谁要 | 默认所有端点 | `/api/profiles/*`、删谱面、生成谱面转让码 |

accountToken 不落盘是**隐私**要求不是权限要求：账号级端点的每个响应都在回答
「这个账号名下有哪些身份」，那是小号之间唯一可关联的信息。`api.js` 的 `request()`
用 `account: true` 切换，拿错了后端是 403 而不是静默降级。

**profileToken 会滑动续期，网页端必须接住。** 剩余寿命少于 25 天时（`JwtSettings` 的
`ExpirationDays: 30` / `RenewWhenRemainingDays: 25`），服务端在响应头 `X-Refreshed-Token`
里带回一张新的——一直在用就一直在线，实际闲置门槛是 25～30 天。三件容易漏的事：

1. **要在状态码分支之前读。** token 有效、只是该端点不归它管时会拿到 403，那种响应里
   照样带着续期头，放在成功分支里读就等于少续一次。`api.js` 的 `adoptRefreshedToken`
   和 SDK 的 `HandleRefreshedToken` 都是这么排的。
2. **换到就要立刻用起来。** 后续请求还带旧的那张，服务端会一次次重新签发；一张 70MB
   谱面的 tus 上传有七十来片，等于七十次 RSA 签名全白签。`tus.js` 的 `createSession`
   把 headers 做成 getter 就是为了这个。
3. **写回去之前确认会话没变过。** 请求在途期间用户可能已经登出，或者并发的另一发先换过
   一张。不判就会把作废的会话复活、或者拿旧基准盖掉新的。

**accountToken 不参与续期**，服务端那条分支在续期代码之前就 `return` 了。让它自动续命
等于把「偷到 profileToken 也看不到你名下有几个身份」这条性质删掉，过期就老实走
`/api/auth/elevate`。所以 `account: true` 的请求不去读这个头。

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
额外的跨域检查。当前 CDN 实测会返 `access-control-allow-origin: *`，但音频的 MIME 是
`audio/x-vorbis+ogg`，Safari 仍可能按 Vorbis 能力检测误判，所以不要主动开启 CORS 媒体模式。

**Safari 放不了 Ogg Vorbis**，而后端强制这个格式。`js/audio.js` 的做法是先挂原生
`<audio>`、出错再换 WASM 解码器——不只看 `canPlayType`，因为 CDN 返回的是
`audio/x-vorbis+ogg` 这个非标准 MIME，对 MIME 严格的浏览器会认为自己能播然后卡住，
那种情况能力检测判不出来。

**vendor/ 里的 WASM 随仓库提交，不从 CDN 拉。** 那些库默认从 unpkg 取 wasm，
国内大概率不通。用 `createEncoder(mime, 'vendor/ogg.wasm')` 而不是库自带的
`createOggEncoder()`。

## 两条线路的选择与切换

后端有两个对外域名，指向的是**同一个后端实例**：

| | 主线路 `bnoawa.phi.zone` | 备用线路 `bnoawa.10minstudio.work` |
|---|---|---|
| 链路 | Cloudflare → Caddy → Kestrel | TapTap 云引擎 CDN → TapTapProxy → Kestrel |
| 对国内用户 | 常常是慢的那条 | 国内 CDN，常常反而更快 |

拓扑的完整记录在 `../Bnoawa/CLAUDE.md` 的「跨域与真实客户端 IP」一节，别在这边重复。
`js/endpoint.js` 是线路状态的唯一归属地，选路规则对齐客户端的
`BnoawaManager.SelectEndpointAsync`（延迟差 100ms 以内留在主线路）。

**「同一个实例」是所有判据的来源。** 能靠换线救回来的故障，按定义都是「请求根本没
到达后端」的链路故障；后端自己给出的 4xx/5xx 换条线只会拿到一模一样的答复。所以：

| 现象 | 判定 | 动作 |
|---|---|---|
| `fetch` 抛 `TypeError`、请求超时 | 链路层失败 | 走探活判据 |
| `502` / `504` / `520`–`527` | 边缘或反代失败 | 走探活判据 |
| `503` + `Retry-After` | SQLite 写锁，后端明说可重试 | **同线路**退避重试，最多 2 次 |
| `429` | 限流 | 直接抛，让用户看见还要等多久 |
| `400`/`401`/`403`/`404`/`500` | 后端的真实答复 | 直接抛，**绝不换线** |

**探活判据（`resolveFailure`）不是可有可无的一步。** 「线路坏了」和「这一发自己失败
了」症状完全一样（都是 `fetch` 抛异常），直接重试是在赌：前者请求没到过后端，重试任何
方法都安全；后者请求可能已经落库、只是回程丢了，重发 POST 就是重复提交。并发 ping 两条
线就能把两者分开，代价是失败路径上多一个往返。同一轮里的并发失败共用一次探测，
否则页面上五个请求一起挂会打出十个探测。

**每个请求最多用掉一次重试机会。** 线路来回抖的时候，没有这个上限就是重试风暴。

**超时是整套机制的前提。** `fetch` 默认没有超时，而线路被墙掉时最常见的形态不是立刻
报错，是 SYN 被丢、连接进黑洞，浏览器挂三十秒到一分半。没有超时，切换在最需要它的
场景里根本不会触发。普通请求 12 秒，tus 分片单独给 60 秒（1MB 在慢上行链路上会超过 12 秒）。

**测速不许阻塞首屏。** 网页每次导航都是全新的 JS 上下文，加载期测速等于给每个页面加一个
往返。做法是：粘性缓存（`localStorage['anoawa.endpoint']`，30 分钟）决定这次用哪条，
测速放在第一次请求成功之后的空闲时间，结果**下次导航才生效**。

**tus 上传中途可以换线**，因为两条线共用同一个 `TusDiskStore`，file ID 通用，而 tus 本来
就按 offset 续传——分片失败时 `HEAD` 一次拿回服务端权威的 `Upload-Offset` 再接着传，
重发同一段不会写重。后端不用改：`HEAD` 在 `WithMethods` 里，`Upload-Offset` 在
`WithExposedHeaders` 里。

**本机 `?api=` 覆盖生效时，整套切换是关掉的**——否则打 localhost 失败会切到生产，
排障时会非常迷惑。

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

**原生 `append()` 会把 `null` 变成写着 "null" 的文字节点。** 全站到处在用
`条件 ? el(...) : null` 这个写法，它在 `el()` 的子元素位置是安全的（`el` 会跳过
null / undefined / false），但直接喂给原生 `node.append(...)` 就会在页面上印出一个
"null"——个人空间看**别人**的谱面区栽过一次，非本人分支那条 `: null` 一直在那儿。
往原生 `append` / `prepend` / `before` / `after` / `replaceChildren` 里传条件节点时，
写成 `.append(...[ … ].filter(Boolean))`。扫描：

```bash
python3 - <<'PY'
import pathlib, re
def args_of(src, start):
    depth, i, args, cur = 0, start, [], ''
    while i < len(src):
        c = src[i]
        if c in '\'"`':
            q = c; cur += c; i += 1
            while i < len(src) and src[i] != q:
                if src[i] == '\\': cur += src[i]; i += 1
                cur += src[i]; i += 1
            cur += src[i] if i < len(src) else ''
        elif c in '([{': depth += 1; cur += c
        elif c in ')]}':
            depth -= 1
            if depth == 0: args.append(cur[1:] if cur.startswith('(') else cur); return args
            cur += c
        elif c == ',' and depth == 1:
            args.append(cur[1:] if cur.startswith('(') else cur); cur = ''
        else: cur += c
        i += 1
    return args
for f in sorted(list(pathlib.Path('.').glob('*.html')) + list(pathlib.Path('js').glob('*.js'))):
    src = f.read_text(encoding='utf-8')
    for m in re.finditer(r'\.(append|prepend|replaceChildren|before|after)\s*\(', src):
        for a in args_of(src, m.end() - 1):
            s = a.strip()
            if re.search(r':\s*null\s*$', s) or s == 'null':
                print(f'  ✗ {f}:{src[:m.start()].count(chr(10)) + 1} .{m.group(1)}() 实参会求值出 null')
PY
```

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

- **谱面包下载入口**：`chartPackageUrl` 就在响应里，但游戏那边根本没有导出谱面的入口
  （防二次分发），网页放裸下载会绕过它。不是安全控制，只是不去背书那条路径。
- **提交成绩、联机**：只能由游戏客户端调，网页能提交成绩等于开挂通道。
- **谱面详情页放开搜索引擎收录**：它需要登录，爬虫拿到的是空壳，收录了用户搜进来
  就被踢到登录页。等后端支持匿名浏览再说。
- **浏览器内转码视频**：ffmpeg.wasm 的核心是 GPL，而本仓库公开、客户端闭源；
  多线程版还要 COOP/COEP 响应头，GitHub Pages 设不了。现在的做法是验合规 + 给
  ffmpeg 命令让用户自己转。
- **B 站 UID 做成自动链接**：后端不验证归属，谁都能填别人的 UID。做成需要主动点击
  的按钮 + 「未验证」标记，责任归属才清楚。等有了归属验证再放开。
