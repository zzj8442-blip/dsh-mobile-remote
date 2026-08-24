# 📡 dsh-mobile-remote — 手机远程遥控 DeepSeek Harness

> 离开电脑时，用手机浏览器远程查看 DeepSeek Harness 的工作进度、审批请求与对话 —— 无论你在家、在公司，还是走在路上（配合 Tailscale）。

## 功能特性

- **👀 实时进度**：手机上看到每个会话的运行状态（绿点 = 正在运行）、流式回复、工具调用（⏳ 进行中 / ✅ 成功 / ❌ 失败）、任务轮次（turn）起止、后台任务、排队消息
- **🔐 手机审批**：DSH 的审批请求（approval）与问题提问（ask_user_question）实时推送到手机，直接「允许一次 / 拒绝」、选择选项并提交 —— 人不在电脑前也能把关
- **💬 远程对话**：向任意会话发消息（排队发送，或勾选「打断当前任务并发送」立即插队），取消正在运行的任务，新建会话
- **🖥️ 电脑端管理面板**：Web GUI 的「设置 → 插件 → 手机远程」页面 —— 局域网/Tailscale 地址、配对码（含倒计时）、已配对设备数、一键撤销全部令牌、服务开关
- **🔒 安全设计**：PIN 配对 + 32 字节随机令牌（服务端只存 SHA-256 哈希）、5 次错误锁定、令牌一键撤销；手机端仅开放 `session.*` 白名单，`settings/credentials/host.*` 等特权 API 一律拒绝
- **🚀 慢链路优化**：响应 gzip 压缩（9MB → 0.8MB，压缩 91%）、增量渲染、流式帧合并 —— Tailscale 中继等慢网络下也能流畅使用

## 工作原理

```
┌──────────────────────────── 电脑 ────────────────────────────┐
│  DeepSeek Harness (DSH)                                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ dsh-mobile-remote (本插件)                               │ │
│  │  · 独立 HTTP 服务器 0.0.0.0:3580（可选 TLS 双协议嗅探）    │ │
│  │  · PIN 配对 + Bearer token 认证                          │ │
│  │  · 白名单桥接 ctx.apiProxy（sessions/respond/events）     │ │
│  │  · SSE 事件流（events.mux / events.host）                │ │
│  │  · loopback 管理端点 /dsh-mobile-remote/panel*           │ │
│  └─────────────────────────────────────────────────────────┘ │
│  · Web GUI（127.0.0.1:3080，不暴露局域网）                    │
└──────────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
   局域网 Wi-Fi          Tailscale 隧道         （可选）内网穿透
         │                    │                    │
┌────────┴────────┐  ┌────────┴────────┐   ┌───────┴───────┐
│ 手机浏览器 PWA   │  │ 手机浏览器 PWA   │   │ 手机浏览器 PWA │
│ http://192.168  │  │ http://100.x.x  │   │ https://xx.xx │
└─────────────────┘  └─────────────────┘   └───────────────┘
```

- **手机端**与桌面 Web GUI 使用**同一套 `/api` 信封协议**（`client-request` / `server-response` / SSE `events.mux`），桥接层直接调用 DSH 官方的 `ctx.apiProxy`（dsh-host-apiproxy），业务逻辑零重复实现
- 电脑 Web GUI 仍只绑定 127.0.0.1，**不暴露到局域网**；手机只能访问插件的独立端口与白名单 API
- 事件流：`GET /api/events.mux?token=…`（SSE，自动重连 + 重放未决审批/问题）
- 发消息：`POST /api/session.prompt`（`mode: queue` 排队 / `steer` 打断）

## 安装

### 方式一：dsh-super-injector 注入（本机开发，推荐）

```jsonc
// DSH Web GUI 中调用（需要 dsh-super-injector 插件）
dev_inject_plugin {"dir": "C:\\path\\to\\dsh-mobile-remote"}
```

### 方式二：bundle 安装（发布形态）

```bash
dsh plugin --profile web add /path/to/dsh-mobile-remote --ignore-workspace-root-check
```

> 本插件采用**手写产物模式**：`lib/` 即最终交付物（Host 为纯 ESM，Client 为手写 ModuleLoader bundle，PWA 为原生 JS），**无需 tsc/tsdown 构建链**，零外部运行时依赖。

## 快速开始

### 第 1 步：电脑端查看连接信息

1. 打开 DeepSeek Harness Web GUI（`127.0.0.1:3080`）
2. 左下角「设置」→「插件」→ 点 **「手机远程」** 标签页（或点侧边栏底部 📡 快捷按钮）
3. 记下：
   - **手机访问地址**（如 `http://192.168.31.49:3580`，自动检测局域网 IP；装有 Tailscale 时会额外显示绿色的「🌐 外网（Tailscale）」地址）
   - **配对码**（6 位数字，10 分钟有效，过期自动刷新）

### 第 2 步：手机连接

1. 手机连**和电脑同一个 Wi-Fi**
2. 浏览器打开电脑面板上的地址（如 `http://192.168.31.49:3580`）
3. 输入 6 位配对码 → 点「连接」
4. 建议「添加到主屏幕」获得全屏 App 体验

### 第 3 步：日常使用

| 想做什么 | 怎么操作 |
| --- | --- |
| 看 DSH 在干什么 | 会话列表看运行状态（绿点）；点进会话实时看流式回复、工具调用、任务轮次 |
| 远程批准操作 | 有审批时会话顶部弹出黄色卡片「🔐 需要审批」→ 点「允许一次」或「拒绝」 |
| 远程对话 | 底部输入框发消息（默认排队）；勾选「打断当前任务并发送」立即插队 |
| 取消正在跑的任务 | 聊天页右上角红色 ■ 按钮 |
| 新建会话 | 会话列表右上角 ＋ |

## 出门在外怎么连（Tailscale，推荐）

局域网地址只在同一 Wi-Fi 下有效。出门（4G/5G/其他网络）需要让电脑有一个公网可达的通道：

1. **电脑**：[下载安装 Tailscale](https://tailscale.com/download)（Windows），用 GitHub / Google / 微软账号登录
2. **手机**：应用商店安装 Tailscale App，登录**同一个账号**
3. 电脑获得 `100.x.x.x` 的 Tailscale IP，电脑面板会自动显示「🌐 外网（Tailscale）」地址
4. 手机浏览器打开 `http://<你的100.x.x.x>:3580` —— **任何网络都能连**（端到端加密，免费）

> 替代方案：cpolar / ngrok 等内网穿透转发 3580 端口（免费版地址随机变化）。

## 安全模型

- **PIN 配对**：6 位随机码，默认 10 分钟有效、5 次错误锁定 5 分钟；配对成功签发 32 字节随机令牌（服务端只存 SHA-256 哈希，`~/.dsh/plugins/dsh-mobile-remote/state.json`）
- **令牌认证**：所有 `/api/*` 请求需 `Authorization: Bearer <token>`；事件流经 query token（EventSource 限制）
- **最小权限**：手机端只开放 `session.list/history/prompt/cancel/create/rename/fork/attachment/updateQueue/models/selectModel/search` 白名单；`settings.*`、`credentials.*`、`host.openPath`、`agentPreset.*`、`llm.discoverModels` 等特权方法一律 403 —— 与桌面 GUI 的 loopback 特权边界一致
- **撤销**：电脑面板「🗑 撤销全部令牌」→ 所有手机立即 401 失效，配对码轮换
- **管理端点**：`/dsh-mobile-remote/panel*` 仅接受 loopback + Origin 同源 POST（防跨站读取/CSRF）
- **桌面 GUI 不暴露**：DSH Web GUI 仍绑定 127.0.0.1

⚠️ 请勿在不可信网络开放此端口；局域网内他人拿到配对码即可配对（配对码在电脑面板可见，可随时撤销轮换）。

## 配置

插件 `Config`（profile patch 可覆盖，如 `cordis.patch.yml`）：

```yaml
- id: dsh-mobile-remote
  config:
    port: 3580            # 手机访问端口
    host: 0.0.0.0         # 监听地址
    pinLifetimeMs: 600000 # 配对码有效期（毫秒）
    maxPinAttempts: 5     # 错误尝试上限
    lockoutMs: 300000     # 错误锁定时间（毫秒）
```

> 代码内默认值兜底，未配置也可运行。修改后需重载插件生效。

## 常见问题排查

| 问题 | 原因与解决 |
| --- | --- |
| 手机打不开局域网地址 | ① Windows 防火墙：首次监听会弹「允许访问」提示需允许；已放行规则可跳过 ② 路由器「AP 隔离/客户端隔离」：登录路由器（如 `192.168.31.1`）→ 无线设置 → 关闭 ③ 手机与电脑不在同一 Wi-Fi/子网 |
| 出门用 Tailscale 打不开 | 手机必须安装 Tailscale App 并登录**与电脑同一个账号**且已连接（App 首页显示 Connected）；电脑 Tailscale 服务需运行（`sc query Tailscale`） |
| 配对码失效 | 配对码 10 分钟过期；插件热重载/撤销后轮换 —— 回电脑面板看当前配对码 |
| 令牌失效（手机被踢） | 电脑面板「撤销全部令牌」后需重新配对 |
| 打开会话看不到记录 / 很慢 | 大会话历史响应可达数 MB —— 已内置 gzip 压缩 + 60 条截断 + 超时提示（20 秒）；检查手机网络 |
| 界面报 `EADDRINUSE: 0.0.0.0:3580` | 端口被残留实例占用 —— 已内置强制断开 + 自动重试接管；如持续出现，重启 DSH 进程（旧版插件有端口泄漏问题，升级到当前版本即可） |
| 手机发消息没反应 | 新版会显示「已发送 ✓（排队/打断）」或明确错误提示；确认配对有效（未 401） |
| 想彻底停用 | `dev_uninject_plugin {"match": "dsh-mobile-remote"}` |

## 开发指南

```
dsh-mobile-remote/
├── lib/
│   ├── index.js        # Host 半区：服务器/认证/桥接/管理端点（纯 ESM，零依赖）
│   ├── client.js       # 电脑端面板：sidebar.footer.action + settings.plugins.tab（手写 ModuleLoader bundle，React）
│   └── assets/         # 手机 PWA：index.html + app.js + style.css + manifest（原生 JS，零构建链）
├── package.json        # 插件清单（dsh.bundle / exports / peerDeps）
└── README.md
```

- **协议层**（`lib/index.js`）：`ALLOWED_METHODS` 白名单、信封解析、`routeInvoke` 方法映射、`handleEventStream` SSE 转发 —— 与桌面 GUI 的 `/api` 协议 wire 兼容
- **认证**：`/pair`（PIN）→ 签发 token；`verifyToken` 支持 Bearer 头与 query（EventSource）；token 哈希持久化到 `~/.dsh/plugins/dsh-mobile-remote/state.json`
- **热重载**：`dev_reload_package {"packageName": "dsh-mobile-remote"}`；修改 client 后需**刷新浏览器页面**重新挂载
- **版本号**：修改 PWA 资源后记得提升 `index.html` 中 `app.js?v=N` / `style.css?v=N`，强制手机端刷新缓存

## 致谢与兼容性

- 基于 DeepSeek Harness 的 `ctx.apiProxy`（`@deepseek-ai/dsh-host-apiproxy`）官方 API 协议，与桌面 Web GUI 同源
- 依赖：仅 DSH 运行时（`apiProxy` 服务）；无第三方 npm 依赖
- 适用 DSH 版本：rc 期间 API 可能演进，白名单与信封集中在 `lib/index.js` 单文件维护

## License

BSD-3-Clause
