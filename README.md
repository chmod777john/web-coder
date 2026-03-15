# Browser Tmux

一个在浏览器里展示三窗格 tmux 风格界面的 Web 应用。每个窗格都连接到真实的本地 PTY，会在项目目录里启动交互式 shell，不是静态文本模拟。

## 开发

```bash
bun install
bun run dev
```

前端默认跑在 `http://localhost:5173`，后端 PTY/WebSocket 服务跑在 `http://localhost:3001`。

## 生产构建

```bash
bun run build
bun run start
```

## 说明

- 三个窗格分别提供独立 shell，会话目录都是当前项目根目录。
- 如果某个 shell 退出，可以在对应窗格右上角点击 `restart` 重新拉起。
- 当前实现是“tmux 风格 UI + 真实 PTY 后端”。如果你后面要改成直接桥接真实 `tmux` 会话，可以在现有 WebSocket 协议上继续扩展。
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

This project was created using `bun init` in bun v1.3.9. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
