# Anoawa

Anoawa 社区音乐游戏的网站，同一个站点承载两部分。

## 结构

```
/                  社区应用（谱面库、详情、上传、账号）
├── index.html     谱面库 — 站点入口，未登录会跳到登录页
├── login.html     注册 / 登录 / 改密码
├── level.html     谱面详情：试听、排行榜、拉起客户端
├── upload.html    上传谱面
├── app.css        应用共用样式（暗色，与游戏内视觉一致）
├── js/            应用脚本，原生 ES module
└── vendor/        随仓库提交的 WASM 依赖，见下

/docs/             文档站（原本在站点根目录）
├── index.html     使用指南
├── reference.html 功能参考
└── assets/        教程截图
```

访问域名直接进社区；文档在 `/docs/`，两边顶栏互相有入口。根目录的
`reference.html` 是给老链接兜底的重定向页。

## 两套视觉

文档站是浅色、朴素的参考资料；社区应用是暗色，色板取自客户端
`Assets/Resources/UI/Global.uss`，是游戏体验的延伸。两者刻意不共用样式。

## vendor 里的东西

都随仓库提交，**不从 CDN 拉**——这些库默认从 unpkg 取 wasm，国内大概率不通。

| 文件 | 用途 |
|------|------|
| `ogg-vorbis-decoder.min.js` | 解码 Ogg Vorbis。Safari 不支持 Vorbis，试听和上传都要靠它 |
| `WasmMediaEncoder.min.js` + `ogg.wasm` | 编码 Ogg Vorbis。上传时转码音频和生成预览片段 |

## 后端

社区应用调 `https://bnoawa.phi.zone`（Bnoawa）。该域名的 CORS 白名单里必须有
本站的源，否则浏览器一个请求都发不出去。

## 本地预览

原生 HTML/CSS/JS，无依赖无构建，起个静态服务器即可：

```bash
python3 -m http.server 4173
```

然后访问 `http://127.0.0.1:4173/`。

注意生产后端的 CORS **不放行 localhost**，本地联调要自己起一份后端，再用
`?api=` 把地址切过去（该参数只在页面来自 localhost 时生效）：

```
http://127.0.0.1:4173/login.html?api=http://localhost:58271
```
