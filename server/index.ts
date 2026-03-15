import { randomUUID } from "node:crypto";
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
const HISTORY_LIMIT = 200_000;
const SESSION_TTL_MS = 30 * 60 * 1_000;

type PaneStatus = {
  state: "live" | "exited";
  exitCode: number | null;
  signal: number | null;
};

type PaneRuntime = {
  cols: number;
  history: string;
  pty: IPty | null;
  rows: number;
  status: PaneStatus;
};

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

function createPaneRuntime(): PaneRuntime {
  return {
    cols: 120,
    history: "",
    pty: null,
    rows: 32,
    status: {
      state: "exited",
      exitCode: null,
      signal: null,
    },
  };
}

function appendHistory(history: string, chunk: string) {
  const next = history + chunk;

  if (next.length <= HISTORY_LIMIT) {
    return next;
  }

  return next.slice(next.length - HISTORY_LIMIT);
}

const sessions = new Map<string, PersistentBrowserTmuxSession>();

class PersistentBrowserTmuxSession {
  readonly #panes: Record<PaneId, PaneRuntime>;
  readonly #shell = resolveShell();
  readonly #sockets = new Set<WebSocket>();
  #cleanupTimer: NodeJS.Timeout | null = null;

  constructor(readonly id: string) {
    this.#panes = {
      workspace: createPaneRuntime(),
      server: createPaneRuntime(),
      scratch: createPaneRuntime(),
    };

    for (const pane of PANES) {
      this.spawnPane(pane.id);
    }
  }

  attach(socket: WebSocket) {
    this.clearCleanupTimer();

    this.sendTo(socket, {
      type: "session",
      sessionId: this.id,
      panes: PANES,
      cwd: ROOT_DIR,
      shell: this.#shell,
    });

    for (const pane of PANES) {
      this.sendSnapshotTo(socket, pane.id);
    }

    this.#sockets.add(socket);
  }

  detach(socket: WebSocket) {
    this.#sockets.delete(socket);

    if (this.#sockets.size === 0) {
      this.scheduleCleanup();
    }
  }

  handleMessage(raw: string) {
    let payload: unknown;

    try {
      payload = JSON.parse(raw);
    } catch {
      this.broadcast({
        type: "error",
        message: "Invalid JSON payload.",
      });
      return;
    }

    if (!isClientMessage(payload)) {
      this.broadcast({
        type: "error",
        message: "Unsupported client message.",
      });
      return;
    }

    switch (payload.type) {
      case "input": {
        this.#panes[payload.paneId].pty?.write(payload.data);
        return;
      }
      case "resize": {
        const pane = this.#panes[payload.paneId];
        pane.cols = Math.max(40, Math.floor(payload.cols));
        pane.rows = Math.max(10, Math.floor(payload.rows));
        pane.pty?.resize(pane.cols, pane.rows);
        return;
      }
      case "restart": {
        this.restartPane(payload.paneId);
      }
    }
  }

  dispose() {
    this.clearCleanupTimer();

    for (const pane of Object.values(this.#panes)) {
      pane.pty?.kill();
      pane.pty = null;
    }

    this.#sockets.clear();
  }

  private restartPane(paneId: PaneId) {
    const pane = this.#panes[paneId];
    const current = pane.pty;

    if (current) {
      pane.pty = null;
      current.kill();
    }

    this.spawnPane(paneId);
  }

  private spawnPane(paneId: PaneId) {
    const pane = this.#panes[paneId];
    const shellArgs = process.platform === "win32" ? [] : ["-i"];

    try {
      const pty = spawn(this.#shell, shellArgs, {
        name: "xterm-256color",
        cols: pane.cols,
        rows: pane.rows,
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
      });

      pane.pty = pty;
      pane.status = {
        state: "live",
        exitCode: null,
        signal: null,
      };

      this.broadcast({
        type: "status",
        paneId,
        state: "live",
        exitCode: null,
        signal: null,
      });

      pty.onData((data) => {
        if (this.#panes[paneId].pty !== pty) {
          return;
        }

        pane.history = appendHistory(pane.history, data);
        this.broadcast({
          type: "output",
          paneId,
          data,
        });
      });

      pty.onExit(({ exitCode, signal }) => {
        if (this.#panes[paneId].pty !== pty) {
          return;
        }

        pane.pty = null;
        pane.status = {
          state: "exited",
          exitCode: exitCode ?? null,
          signal: signal ?? null,
        };

        this.broadcast({
          type: "status",
          paneId,
          state: "exited",
          exitCode: exitCode ?? null,
          signal: signal ?? null,
        });
      });
    } catch (error) {
      pane.pty = null;
      pane.status = {
        state: "exited",
        exitCode: 1,
        signal: null,
      };

      this.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to spawn shell.",
      });
    }
  }

  private scheduleCleanup() {
    if (this.#cleanupTimer) {
      return;
    }

    this.#cleanupTimer = setTimeout(() => {
      if (this.#sockets.size > 0) {
        this.clearCleanupTimer();
        return;
      }

      this.dispose();
      sessions.delete(this.id);
    }, SESSION_TTL_MS);
  }

  private clearCleanupTimer() {
    if (!this.#cleanupTimer) {
      return;
    }

    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = null;
  }

  private sendSnapshotTo(socket: WebSocket, paneId: PaneId) {
    const pane = this.#panes[paneId];

    this.sendTo(socket, {
      type: "snapshot",
      paneId,
      data: pane.history,
      state: pane.status.state,
      exitCode: pane.status.exitCode,
      signal: pane.status.signal,
    });
  }

  private broadcast(message: ServerMessage) {
    for (const socket of this.#sockets) {
      this.sendTo(socket, message);
    }
  }

  private sendTo(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(message));
  }
}

function resolveSessionId(rawUrl: string | undefined) {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");

  if (sessionId && /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return sessionId;
  }

  return randomUUID();
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
    sessions: sessions.size,
  });
});

if (existsSync(DIST_INDEX)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(DIST_INDEX);
  });
}

wss.on("connection", (socket, request) => {
  const sessionId = resolveSessionId(request.url);
  let session = sessions.get(sessionId);

  if (!session) {
    session = new PersistentBrowserTmuxSession(sessionId);
    sessions.set(sessionId, session);
  }

  session.attach(socket);

  socket.on("message", (value, isBinary) => {
    if (isBinary) {
      return;
    }

    session.handleMessage(value.toString());
  });

  socket.on("close", () => {
    session.detach(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`browser-tmux server listening on http://localhost:${PORT}`);
});
