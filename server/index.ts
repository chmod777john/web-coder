import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { spawn, type IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";

import { PANES, type ClientMessage, type PaneId, type ServerMessage } from "../shared/protocol";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = resolve(ROOT_DIR, "dist");
const DIST_INDEX = join(DIST_DIR, "index.html");
const PORT = Number(process.env.PORT ?? 3001);

function resolveShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }

  if (process.env.SHELL && existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }

  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

function isPaneId(value: unknown): value is PaneId {
  return PANES.some((pane) => pane.id === value);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ClientMessage>;

  if (candidate.type === "input") {
    return isPaneId(candidate.paneId) && typeof candidate.data === "string";
  }

  if (candidate.type === "resize") {
    return (
      isPaneId(candidate.paneId) &&
      typeof candidate.cols === "number" &&
      typeof candidate.rows === "number"
    );
  }

  return candidate.type === "restart" && isPaneId(candidate.paneId);
}

class BrowserTmuxSession {
  readonly #panes = new Map<PaneId, IPty>();
  readonly #shell = resolveShell();

  constructor(private readonly socket: WebSocket) {}

  start() {
    this.send({
      type: "session",
      panes: PANES,
      cwd: ROOT_DIR,
      shell: this.#shell,
    });

    for (const pane of PANES) {
      this.spawnPane(pane.id);
    }
  }

  handleMessage(raw: string) {
    let payload: unknown;

    try {
      payload = JSON.parse(raw);
    } catch {
      this.send({
        type: "error",
        message: "Invalid JSON payload.",
      });
      return;
    }

    if (!isClientMessage(payload)) {
      this.send({
        type: "error",
        message: "Unsupported client message.",
      });
      return;
    }

    switch (payload.type) {
      case "input": {
        this.#panes.get(payload.paneId)?.write(payload.data);
        return;
      }
      case "resize": {
        const cols = Math.max(40, Math.floor(payload.cols));
        const rows = Math.max(10, Math.floor(payload.rows));
        this.#panes.get(payload.paneId)?.resize(cols, rows);
        return;
      }
      case "restart": {
        this.restartPane(payload.paneId);
      }
    }
  }

  dispose() {
    for (const pane of this.#panes.values()) {
      pane.kill();
    }

    this.#panes.clear();
  }

  private restartPane(paneId: PaneId) {
    this.#panes.get(paneId)?.kill();
    this.#panes.delete(paneId);
    this.spawnPane(paneId);
  }

  private spawnPane(paneId: PaneId) {
    const shellArgs = process.platform === "win32" ? [] : ["-i"];
    const pane = spawn(this.#shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      },
    });

    this.#panes.set(paneId, pane);
    this.send({
      type: "status",
      paneId,
      state: "live",
      exitCode: null,
      signal: null,
    });

    pane.onData((data) => {
      if (this.#panes.get(paneId) !== pane) {
        return;
      }

      this.send({
        type: "output",
        paneId,
        data,
      });
    });

    pane.onExit(({ exitCode, signal }) => {
      if (this.#panes.get(paneId) !== pane) {
        return;
      }

      this.#panes.delete(paneId);
      this.send({
        type: "status",
        paneId,
        state: "exited",
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      });
    });
  }

  private send(message: ServerMessage) {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cwd: ROOT_DIR,
    panes: PANES.length,
  });
});

if (existsSync(DIST_INDEX)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(DIST_INDEX);
  });
}

wss.on("connection", (socket) => {
  const session = new BrowserTmuxSession(socket);
  session.start();

  socket.on("message", (value, isBinary) => {
    if (isBinary) {
      return;
    }

    session.handleMessage(value.toString());
  });

  socket.on("close", () => {
    session.dispose();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`browser-tmux server listening on http://localhost:${PORT}`);
});
