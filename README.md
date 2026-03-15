# Browser Tmux

一个让用户用自然语言启动 `codex` 构建任务的 Web 应用。

- 首屏是需求输入框。
- 提交后，后端会在 `/workspaces/codex-runs/<sessionId>` 创建独立 workspace。
- 然后自动启动一个 `codex` 交互会话，并把它接到页面左侧终端。
- 右侧是预览窗口，目标是承载 `codex` 生成应用的 dev server。
- 浏览器刷新后会回到同一个构建会话，并恢复已有终端历史。

## 开发

```bash
bun install
bun run dev
```

前端默认跑在 `http://localhost:5173`，后端 PTY/WebSocket 服务跑在 `http://localhost:3001`。

## 当前架构

- 后端: `express + ws + node-pty`
- 前端: `react + vite + xterm.js`
- 构建会话接口:
  - `POST /api/build-sessions`
  - `GET /api/build-sessions/:sessionId`
  - `GET /api/health`
- WebSocket:
  - `GET /ws?sessionId=<id>`

创建构建会话时，服务端会：

- 分配一个预览端口，范围是 `4100..4899`
- 自动把该 workspace 写入 `~/.codex/config.toml` 的 trusted projects，避免首次 trust prompt 卡住流程
- 自动启动 `codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen`
- 给 `codex` 注入一段固定技术约束：
  - 仅在该 workspace 下工作
  - 使用 Bun
  - 优先使用 `Vite + React + TypeScript`
  - dev server 绑定 `0.0.0.0`
  - 使用分配到的预览端口

## 生产构建

```bash
bun run build
bun run start
```

## 说明

- 当前界面是「单个 codex 终端 + 右侧预览」而不是旧版三窗格。
- 点击终端右上角 `restart` 会重新拉起当前 `codex` 会话。
- 点击 `new task` 会清掉当前前端会话并回到需求输入页。
- 同一个浏览器里刷新页面时，会自动重连到同一个后端 PTY，并回放已有终端历史；前提是后端服务还在运行，且浏览器没有清掉 localStorage。
- 构建会话在没有浏览器连接后会保留 30 分钟，之后自动清理。
- 页面会暴露一个轻量调试桥 `window.__browserTmux`，便于在浏览器 DevTools 或自动化脚本里直接发送输入、读取窗格文本和触发重启。

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
