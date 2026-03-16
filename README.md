# Browser Tmux

一个让用户用自然语言启动 `codex` 构建任务的 Web 应用。

- 首屏是需求输入框。
- 首页也会列出已经持久化的项目，允许重新进入。
- 新项目提交后，后端会在 `/workspaces/codex-runs/<projectId>` 创建独立 workspace。
- 然后自动启动一个 `codex` 交互会话，并把它接到页面左侧终端。
- 右侧是预览窗口，但 iframe 渲染目标不再由前端猜测，而是由 `codex` 主动上报。
- 浏览器刷新后会回到同一个构建会话，并恢复已有终端历史。
- 服务重启后，项目元数据仍然会从 PostgreSQL 恢复，用户可以继续进入已有项目。

## 开发

```bash
bun install
bun run db:up
bun run dev
```

前端默认跑在 `http://localhost:5173`，后端 PTY/WebSocket 服务跑在 `http://localhost:3001`。

## 当前架构

- 持久化: `postgres` + Docker PostgreSQL
- 后端: `express + ws + node-pty`
- 前端: `react + vite + xterm.js`
- 项目接口:
  - `GET /api/projects`
- 构建会话接口:
  - `POST /api/build-sessions`
  - `GET /api/build-sessions/:sessionId`
  - `POST /api/build-sessions/:sessionId/preview-url`
  - `GET /api/health`
- WebSocket:
  - `GET /ws?sessionId=<id>`

创建构建会话时，服务端会：

- 分配一个预览端口，范围是 `4100..4899`
- 自动把该 workspace 写入 `~/.codex/config.toml` 的 trusted projects，避免首次 trust prompt 卡住流程
- 自动启动 `codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen`
- 把项目和会话元数据写入 PostgreSQL
- 给 `codex` 注入一段固定技术约束：
  - 仅在该 workspace 下工作
  - 使用 Bun
  - 优先使用 `Vite + React + TypeScript`
  - dev server 绑定 `0.0.0.0`
  - 使用分配到的预览端口作为本地预览优先选项
  - 通过 preview API 主动汇报当前要显示的预览目标

继续已有项目时，服务端会：

- 复用同一个 workspace
- 创建一个新的 `build_session` 记录
- 如果旧会话还活着，首页会直接显示“继续会话”
- 如果服务已经重启，首页会显示“重新进入”

## 生产构建

```bash
bun run build
bun run start
```

默认数据库连接串：

```bash
postgres://postgres:postgres@127.0.0.1:5432/web_coder
```

也可以通过 `DATABASE_URL` 覆盖。

## 说明

- 当前界面是「单个 codex 终端 + 右侧预览」而不是旧版三窗格。
- 右侧预览只认 `codex` 上报的 target，不会再自动去探测 `localhost:<port>`。
- 点击终端右上角 `restart` 会重新拉起当前 `codex` 会话。
- 点击工作台右上角 `projects` 会清掉当前前端会话并回到项目页。
- 同一个浏览器里刷新页面时，会自动重连到同一个后端 PTY，并回放已有终端历史；前提是后端服务还在运行，且浏览器没有清掉 localStorage。
- 构建会话在没有浏览器连接后会保留 30 分钟，之后自动清理。
- 项目列表和最近会话信息会持久化到 PostgreSQL，所以服务重启后不会丢。
- 页面会暴露一个轻量调试桥 `window.__browserTmux`，便于在浏览器 DevTools 或自动化脚本里直接发送输入、读取窗格文本和触发重启。

## Preview API

每个 `codex` 会话启动时，后端会注入这几个环境变量：

- `CODEX_PREVIEW_URL_ENDPOINT`
- `CODEX_PREVIEW_BEARER_TOKEN`
- `CODEX_LOCAL_PREVIEW_PORT`

`codex` 需要在预览目标发生变化时主动调用：

```bash
curl -X POST "$CODEX_PREVIEW_URL_ENDPOINT" \
  -H "Authorization: Bearer $CODEX_PREVIEW_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"local://4100"}'
```

远端部署同理，例如：

```bash
curl -X POST "$CODEX_PREVIEW_URL_ENDPOINT" \
  -H "Authorization: Bearer $CODEX_PREVIEW_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-app.vercel.app"}'
```

支持的值：

- `local://<port>`: 表示本机容器里跑着一个本地预览服务，前端会把它解析成当前宿主名上的对应端口
- `https://...` 或 `http://...`: 表示远端或其他明确地址
- `null`: 清空当前预览目标

## 本地 PostgreSQL

```bash
bun run db:up
```

停止数据库：

```bash
bun run db:down
```

## 本地隔离浏览器栈

仓库里还带了一套本地浏览器基础设施，满足下面这个组合:

- 浏览器跑在本地容器里，默认不挂载宿主机目录。
- `agent-browser` 通过 CDP 连进去做自动化。
- 你可以通过浏览器打开 noVNC 直接看画面，必要时手动接管。

### 启动

```bash
docker compose -f docker-compose.browser.yml up -d
./scripts/bootstrap-browser-session.sh
```

### 连接方式

- Selenium 状态接口: `http://localhost:4444/status`
- 浏览器 noVNC 画面: `http://localhost:7900/?autoconnect=1&resize=scale`
- 推荐的 CDP 入口: Selenium session 的 `ws://localhost:4444/session/<sessionId>/se/cdp`

### 用 agent-browser 控制

```bash
./scripts/agent-browser-cdp.sh open https://example.com
./scripts/agent-browser-cdp.sh snapshot
./scripts/agent-browser-cdp.sh click @e2
```

如果你也想开 `agent-browser` 自带的配对浏览流，把环境变量带上:

```bash
AGENT_BROWSER_STREAM_PORT=9223 ./scripts/agent-browser-cdp.sh open https://example.com
```

这会额外开一个 `ws://localhost:9223` 的流式预览端口；当前仓库没有内置 viewer，默认还是推荐直接用 noVNC。

### 说明

- 这套 Selenium 镜像里，Chromium 的真实 CDP 端口通常由 WebDriver 以随机调试端口拉起；最稳定的接入方式是走 Selenium 暴露的 `se:cdp` WebSocket，而不是假设固定 `9222`。
