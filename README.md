# MetingAPI-node

基于 Node.js 的 Meting API 服务，为 APlayer 和其他播放器提供网易云音乐、QQ 音乐的歌曲、歌单、封面、歌词和播放地址接口。项目兼容原 Meting API 的查询参数格式，并将 QQ 音乐会话续期放在常驻 Node.js 进程中处理。

## 功能

- 兼容 `server`、`type`、`id` 查询参数
- 支持网易云音乐和 QQ 音乐
- 返回 APlayer 兼容的歌曲与歌单 JSON
- 支持播放地址、封面、歌词、歌曲名和歌手查询
- 保留 `/qqcookie.php` 与 `/neteasecookie.php` Cookie 更新接口
- QQ 音乐会话自动续期、失败退避和重启恢复
- 提供 `/api/status` 状态接口与 APlayer 演示页
- 使用 HMAC-SHA1 保护资源地址和凭据管理接口

## 安全说明

Cookie、访问令牌、刷新令牌和 QQ 会话文件只应保存在运行环境的 `storage/` 目录中。仓库通过 `.gitignore` 忽略这些文件，公开提交只包含源码、文档和测试占位数据。

签名密钥不会写入源码。需要使用资源签名或 Cookie 更新接口时，请在运行环境中设置至少 32 个字符的 `AUTH_SECRET`。可以使用下面的命令生成随机密钥。

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`AUTH_SECRET` 不要提交到 Git、写入截图、放进前端代码或通过 URL 传递。若曾经把真实 Cookie 或密钥提交到任何远端，应立即在对应平台重新登录或撤销凭据。

## 运行要求

- Node.js 22 或更高版本
- 一个可写的 `storage/` 目录
- 网易云音乐 Cookie 可选，保存在 `storage/netease_cookie.txt`
- QQ 音乐 Cookie 可选，保存在 `storage/tencent_cookie.txt`
- QQ 自动续期需要 Cookie 中包含 `uin`、`qm_keyst` 或 `qqmusic_key`，以及可用的刷新字段

## 安装和启动

```bash
npm ci
npm run build
npm start
```

默认监听 `11446` 端口。开发时可以使用 `npm run dev`，测试使用 `npm test`。

PowerShell 中可以这样设置运行参数。

```powershell
$env:AUTH_SECRET = "替换为随机生成的至少 32 个字符密钥"
$env:AUTH = "true"
npm start
```

项目不会自动读取 `.env` 文件。`.env.example` 只作为配置模板，部署时请使用操作系统环境变量、容器 Secret 或平台 Secret 管理功能注入值。

## API

主入口保持 Meting API 的查询参数格式。

```text
GET /?server=netease&type=song&id=591321
GET /?server=tencent&type=song&id=<song-mid>
GET /?server=tencent&type=playlist&id=<playlist-id>
GET /?server=tencent&type=url&id=<song-mid>
GET /?server=tencent&type=pic&id=<album-mid>
GET /?server=tencent&type=lrc&id=<song-mid>
```

支持的 `type` 包括 `song`、`playlist`、`name`、`artist`、`url`、`pic` 和 `lrc`。`song` 与 `playlist` 返回 APlayer 兼容 JSON，`url` 与 `pic` 返回 302 重定向，`lrc`、`name` 和 `artist` 返回纯文本。

启用 `AUTH=true` 后，`url`、`pic` 和 `lrc` 资源必须带有签名。签名计算方式为 `HMAC-SHA1(平台名称 + 类型 + ID, AUTH_SECRET)`，结果使用十六进制编码。

Cookie 更新接口继续兼容旧版路径。

```text
POST /qqcookie.php
POST /neteasecookie.php
```

请求体中的 `auth` 使用 `HMAC-SHA1("cookie_update", AUTH_SECRET)`，`cookie` 使用对应平台的完整 Cookie 字符串。

```json
{
  "auth": "签名",
  "cookie": "平台 Cookie"
}
```

QQ 续期测试接口使用 `POST /api/qq/refresh-test`，请求体中的 `auth` 使用 `HMAC-SHA1("qq_refresh_test", AUTH_SECRET)`。接口只返回续期结果和调度状态，不返回 Cookie 或令牌。

`GET /api/status` 只返回平台登录状态、文件更新时间和 QQ 续期状态，不返回凭据内容。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `11446` | HTTP 监听端口 |
| `STORAGE_DIR` | `./storage` | Cookie 和 QQ 会话目录 |
| `CACHE_DIR` | `../cache` | 歌单缓存目录 |
| `PUBLIC_BASE_URL` | 空 | 反向代理对外 API 基地址 |
| `AUTH` | `false` | 是否启用资源签名 |
| `AUTH_SECRET` | 未设置 | HMAC-SHA1 密钥，至少 32 个字符 |
| `CACHE` | `false` | 是否启用歌单文件缓存 |
| `CACHE_TIME` | `86400` | 歌单缓存秒数 |
| `QQ_MUSIC_RENEWAL` | `true` | 是否启用 QQ 后台续期 |

未配置 `AUTH_SECRET` 时，服务仍可提供不需要签名的查询接口，但资源签名、Cookie 更新和 QQ 续期测试接口会拒绝请求。启用 `AUTH=true` 时，服务启动会校验密钥长度。

## QQ 音乐自动续期

服务启动时会从 `storage/tencent_cookie.txt` 解析刷新凭据。默认每 24 小时续期一次，短有效期凭据会提前续期。限流和网络错误会按退避时间重试，QQ 明确拒绝刷新时会保留当前播放 Cookie 并暂停自动重试。

续期成功后会原子更新 Cookie 和会话状态。服务重启后会从 `storage/tencent_session.json` 恢复调度。设置 `QQ_MUSIC_RENEWAL=false` 可以关闭后台续期，但 QQ API 仍会读取和使用当前播放 Cookie。

## 项目目录

```text
MetingAPI-node/
├── src/                 Node.js 服务、Meting API 和 QQ 会话管理
├── public/              服务首页和状态面板
├── docs/                APlayer 演示页
├── storage/             本地凭据目录说明，运行时文件不会提交
├── package.json
├── .env.example         环境变量模板
└── tsconfig.json
```

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
