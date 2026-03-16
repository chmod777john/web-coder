import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { spawn, type IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";

import {
  createProjectWithSession,
  createSessionForProject,
  getBuildSessionRecord,
  getDatabaseUrl,
  getProject,
  initDatabase,
  listProjects,
  type PersistedSessionState,
  updateBuildSessionPreview,
  updateBuildSessionSnapshot,
} from "./db";
import { PANES, type ClientMessage, type PaneId, type ServerMessage } from "../shared/protocol";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = resolve(ROOT_DIR, "dist");
const DIST_INDEX = join(DIST_DIR, "index.html");
const PORT = Number(process.env.PORT ?? 3001);
const RUNS_ROOT = resolve("/workspaces", "codex-runs");
const HISTORY_LIMIT = 250_000;
const SESSION_TTL_MS = 30 * 60 * 1_000;
const PREVIEW_PORT_START = 4100;
const PREVIEW_PORT_END = 4899;
const CODEX_HOME = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");

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

type BuildSessionConfig = {
  id: string;
  projectId: string;
  previewPort: number;
  previewToken: string;
  previewUrl: string | null;
  userPrompt: string;
  workspaceDir: string;
};

let projectTrustWriteQueue = Promise.resolve();

function resolveShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }

  if (process.env.SHELL && existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }

  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function tomlEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toProjectTitle(prompt: string) {
  const collapsed = prompt.replace(/\s+/g, " ").trim();

  if (collapsed.length <= 72) {
    return collapsed;
  }

  return `${collapsed.slice(0, 69).trimEnd()}...`;
}

function buildPreviewUpdateEndpoint(sessionId: string) {
  return `http://127.0.0.1:${PORT}/api/build-sessions/${sessionId}/preview-url`;
}

function normalizePreviewUrl(input: string | null) {
  if (input === null) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("local://")) {
    const portValue = trimmed.slice("local://".length);
    const port = Number(portValue);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Invalid local preview port.");
    }

    return `local://${port}`;
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Preview URL must use http or https.");
  }

  if (["127.0.0.1", "localhost", "0.0.0.0"].includes(parsed.hostname)) {
    const port = Number(parsed.port);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Loopback preview URLs must include a valid port.");
    }

    return `local://${port}`;
  }

  return parsed.toString();
}

function getBearerToken(headerValue: string | undefined) {
  if (!headerValue) {
    return "";
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function createContinuationPrompt(initialPrompt: string, workspaceDir: string) {
  return [
    "Continue working on the existing project in this workspace.",
    "",
    "Original user request:",
    initialPrompt,
    "",
    `Current workspace: ${workspaceDir}`,
    "",
    "Start by reviewing the existing files, then continue building pragmatically.",
  ].join("\n");
}

function upsertProjectTrust(config: string, projectPath: string) {
  const header = `[projects."${tomlEscape(projectPath)}"]`;
  const trustLine = 'trust_level = "trusted"';
  const sectionPattern = new RegExp(
    `(^|\\n)${escapeRegExp(header)}\\n([\\s\\S]*?)(?=\\n\\[[^\\n]+\\]|$)`,
  );
  const match = config.match(sectionPattern);

  if (!match) {
    const prefix = config.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${header}\n${trustLine}\n`;
  }

  const sectionPrefix = match[1] ?? "";
  const sectionBody = match[2] ?? "";
  const nextBody = /(^|\n)trust_level\s*=\s*".*?"(?=\n|$)/.test(sectionBody)
    ? sectionBody.replace(/(^|\n)trust_level\s*=\s*".*?"(?=\n|$)/, `$1${trustLine}`)
    : `${trustLine}\n${sectionBody.replace(/^\n+/, "")}`;

  return config.replace(sectionPattern, `${sectionPrefix}${header}\n${nextBody}`);
}

async function markProjectTrusted(projectPath: string) {
  const work = async () => {
    mkdirSync(CODEX_HOME, { recursive: true });

    let currentConfig = "";
    try {
      currentConfig = await readFile(CODEX_CONFIG_PATH, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    const nextConfig = upsertProjectTrust(currentConfig, projectPath);
    if (nextConfig !== currentConfig) {
      await writeFile(CODEX_CONFIG_PATH, nextConfig, "utf8");
    }
  };

  const pending = projectTrustWriteQueue.then(work, work);
  projectTrustWriteQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  await pending;
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

function composeAgentPrompt(
  userPrompt: string,
  workspaceDir: string,
  previewPort: number,
  previewEndpoint: string,
  previewToken: string,
) {
  return [
    "Build a runnable web app for the user.",
    "",
    "User request:",
    userPrompt,
    "",
    "Technical constraints:",
    `- Work only inside ${workspaceDir}.`,
    "- Create the project from scratch if needed.",
    "- Use Bun for package management.",
    "- Use Vite + React + TypeScript unless the request strongly requires something else.",
    "- Prefer deploying to Vercel when the app can reasonably be hosted there.",
    "- If Vercel deployment is blocked or clearly inappropriate, fall back to a local dev server.",
    `- If you run a local dev server, use port ${previewPort}.`,
    "- Bind any local dev server to 0.0.0.0.",
    "- You must explicitly report the preview target to the preview API whenever it changes.",
    "",
    "Preview API:",
    `- Endpoint: ${previewEndpoint}`,
    `- Bearer token: ${previewToken}`,
    '- For Vercel or other remote deployments, send {"url":"https://your-app.example.com"}.',
    `- For local previews on the assigned port, send {"url":"local://${previewPort}"}.`,
    "- The web UI will not guess the preview target for you. If you do not call the API, the preview iframe will stay blank.",
    '- Example command: curl -X POST "$CODEX_PREVIEW_URL_ENDPOINT" -H "Authorization: Bearer $CODEX_PREVIEW_BEARER_TOKEN" -H "Content-Type: application/json" -d \'{"url":"https://example.vercel.app"}\'',
    "- Prefer reporting the deployed Vercel URL as soon as it exists.",
    "- Call the same API again if you switch between local preview and a deployed URL later.",
    "- Keep the dev server running once the first working version is ready.",
    "- Make practical implementation choices and move forward without asking unnecessary questions.",
    "",
    "Start now.",
  ].join("\n");
}

async function canListenOnPort(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = createNetServer();

    probe.once("error", () => {
      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => {
        resolve(true);
      });
    });

    probe.listen(port, "0.0.0.0");
  });
}

async function allocatePreviewPort() {
  for (let port = PREVIEW_PORT_START; port <= PREVIEW_PORT_END; port += 1) {
    const free = await canListenOnPort(port);

    if (!free) {
      continue;
    }

    const inUse = Array.from(sessions.values()).some((session) => session.previewPort === port);
    if (!inUse) {
      return port;
    }
  }

  throw new Error("No preview port available.");
}

const sessions = new Map<string, BuildSession>();

class BuildSession {
  readonly #pane = createPaneRuntime();
  #previewUrl: string | null;
  readonly #shell = resolveShell();
  readonly #sockets = new Set<WebSocket>();
  #cleanupTimer: NodeJS.Timeout | null = null;
  #persistTimer: NodeJS.Timeout | null = null;

  constructor(readonly config: BuildSessionConfig) {
    this.#previewUrl = config.previewUrl;
    mkdirSync(config.workspaceDir, { recursive: true });
    this.spawnPane("agent");
  }

  get id() {
    return this.config.id;
  }

  get projectId() {
    return this.config.projectId;
  }

  get previewPort() {
    return this.config.previewPort;
  }

  get previewUrl() {
    return this.#previewUrl;
  }

  get shell() {
    return this.#shell;
  }

  get workspaceDir() {
    return this.config.workspaceDir;
  }

  attach(socket: WebSocket) {
    this.clearCleanupTimer();
    this.#sockets.add(socket);

    this.sendTo(socket, {
      type: "session",
      sessionId: this.config.id,
      projectId: this.config.projectId,
      panes: PANES,
      cwd: this.config.workspaceDir,
      previewPort: this.config.previewPort,
      previewUrl: this.#previewUrl,
      shell: this.#shell,
      workspaceDir: this.config.workspaceDir,
    });

    this.sendSnapshotTo(socket);
  }

  detach(socket: WebSocket) {
    this.#sockets.delete(socket);

    if (this.#sockets.size === 0) {
      this.scheduleCleanup();
    }
  }

  dispose() {
    this.clearCleanupTimer();
    this.clearPersistTimer();
    this.#pane.pty?.kill();
    this.#pane.pty = null;
    this.#sockets.clear();
    void this.persistSnapshot();
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
        this.#pane.pty?.write(payload.data);
        return;
      }
      case "resize": {
        this.#pane.cols = Math.max(40, Math.floor(payload.cols));
        this.#pane.rows = Math.max(10, Math.floor(payload.rows));
        this.#pane.pty?.resize(this.#pane.cols, this.#pane.rows);
        return;
      }
      case "restart": {
        this.restartPane();
      }
    }
  }

  async updatePreviewUrl(nextPreviewUrl: string | null) {
    this.#previewUrl = nextPreviewUrl;

    this.broadcast({
      type: "preview",
      previewUrl: nextPreviewUrl,
    });

    await updateBuildSessionPreview({
      previewUrl: nextPreviewUrl,
      sessionId: this.config.id,
    });
  }

  private restartPane() {
    const current = this.#pane.pty;

    if (current) {
      this.#pane.pty = null;
      current.kill();
    }

    this.spawnPane("agent");
  }

  private spawnPane(paneId: PaneId) {
    const shellArgs = process.platform === "win32" ? [] : ["-i"];

    try {
      const pty = spawn(this.#shell, shellArgs, {
        name: "xterm-256color",
        cols: this.#pane.cols,
        rows: this.#pane.rows,
        cwd: this.config.workspaceDir,
        env: {
          ...process.env,
          CODEX_LOCAL_PREVIEW_PORT: String(this.config.previewPort),
          CODEX_PREVIEW_BEARER_TOKEN: this.config.previewToken,
          CODEX_PREVIEW_URL_ENDPOINT: buildPreviewUpdateEndpoint(this.config.id),
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
      });

      this.#pane.pty = pty;
      this.#pane.status = {
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
      this.schedulePersistSnapshot();

      setTimeout(() => {
        if (this.#pane.pty !== pty) {
          return;
        }

        pty.write(`${this.createBootstrapCommand()}\r`);
      }, 250);

      pty.onData((data) => {
        if (this.#pane.pty !== pty) {
          return;
        }

        this.#pane.history = appendHistory(this.#pane.history, data);
        this.broadcast({
          type: "output",
          paneId,
          data,
        });
        this.schedulePersistSnapshot();
      });

      pty.onExit(({ exitCode, signal }) => {
        if (this.#pane.pty !== pty) {
          return;
        }

        this.#pane.pty = null;
        this.#pane.status = {
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
        this.schedulePersistSnapshot();
      });
    } catch (error) {
      this.#pane.pty = null;
      this.#pane.status = {
        state: "exited",
        exitCode: 1,
        signal: null,
      };

      this.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to spawn shell.",
      });
      this.schedulePersistSnapshot();
    }
  }

  private createBootstrapCommand() {
    const prompt = composeAgentPrompt(
      this.config.userPrompt,
      this.config.workspaceDir,
      this.config.previewPort,
      buildPreviewUpdateEndpoint(this.config.id),
      this.config.previewToken,
    );

    return [
      `cd ${shellEscape(this.config.workspaceDir)}`,
      `codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C ${shellEscape(this.config.workspaceDir)} ${shellEscape(prompt)}`,
    ].join(" && ");
  }

  private sendSnapshotTo(socket: WebSocket) {
    this.sendTo(socket, {
      type: "snapshot",
      paneId: "agent",
      data: this.#pane.history,
      state: this.#pane.status.state,
      exitCode: this.#pane.status.exitCode,
      signal: this.#pane.status.signal,
    });
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
      sessions.delete(this.config.id);
    }, SESSION_TTL_MS);
  }

  private clearCleanupTimer() {
    if (!this.#cleanupTimer) {
      return;
    }

    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = null;
  }

  private schedulePersistSnapshot() {
    if (this.#persistTimer) {
      return;
    }

    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      void this.persistSnapshot();
    }, 700);
  }

  private clearPersistTimer() {
    if (!this.#persistTimer) {
      return;
    }

    clearTimeout(this.#persistTimer);
    this.#persistTimer = null;
  }

  private async persistSnapshot() {
    const state: PersistedSessionState = this.#pane.status.state;

    try {
      await updateBuildSessionSnapshot({
        sessionId: this.config.id,
        terminalHistory: this.#pane.history,
        state,
        exitCode: this.#pane.status.exitCode,
        signal: this.#pane.status.signal,
      });
    } catch (error) {
      console.error("failed to persist session snapshot", error);
    }
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

async function createNewProjectSession(userPrompt: string) {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const previewPort = await allocatePreviewPort();
  const previewToken = randomUUID();
  const workspaceDir = resolve(RUNS_ROOT, projectId);
  const shell = resolveShell();

  await markProjectTrusted(workspaceDir);
  await createProjectWithSession({
    projectId,
    sessionId,
    title: toProjectTitle(userPrompt),
    prompt: userPrompt,
    previewToken,
    previewUrl: null,
    workspaceDir,
    previewPort,
    shell,
  });

  const session = new BuildSession({
    id: sessionId,
    projectId,
    previewPort,
    previewToken,
    previewUrl: null,
    userPrompt,
    workspaceDir,
  });

  sessions.set(sessionId, session);
  return session;
}

async function createProjectContinuationSession(projectId: string, promptOverride?: string) {
  const project = await getProject(projectId);

  if (!project) {
    return null;
  }

  const sessionId = randomUUID();
  const previewPort = await allocatePreviewPort();
  const previewToken = randomUUID();
  const shell = resolveShell();
  const previousSession =
    project.latestSessionId ? await getBuildSessionRecord(project.latestSessionId) : null;
  const userPrompt =
    promptOverride?.trim() || createContinuationPrompt(project.initialPrompt, project.workspaceDir);

  await markProjectTrusted(project.workspaceDir);
  await createSessionForProject({
    projectId,
    sessionId,
    prompt: userPrompt,
    previewToken,
    previewUrl: previousSession?.previewUrl ?? null,
    workspaceDir: project.workspaceDir,
    previewPort,
    shell,
  });

  const session = new BuildSession({
    id: sessionId,
    projectId,
    previewPort,
    previewToken,
    previewUrl: previousSession?.previewUrl ?? null,
    userPrompt,
    workspaceDir: project.workspaceDir,
  });

  sessions.set(sessionId, session);
  return session;
}

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
});

app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects();

    res.json({
      ok: true,
      projects: projects.map((project) => ({
        ...project,
        activeSessionId:
          project.latestSessionId && sessions.has(project.latestSessionId)
            ? project.latestSessionId
            : null,
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load projects.",
    });
  }
});

app.post("/api/build-sessions", async (req, res) => {
  try {
    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";
    const projectId =
      typeof req.body?.projectId === "string"
        ? req.body.projectId.trim()
        : "";

    if (!projectId && !prompt) {
      res.status(400).json({
        error: "Prompt is required for a new project.",
      });
      return;
    }

    const session = projectId
      ? await createProjectContinuationSession(projectId, prompt)
      : await createNewProjectSession(prompt);

    if (!session) {
      res.status(404).json({
        error: "Project not found.",
      });
      return;
    }

    res.status(201).json({
      ok: true,
      projectId: session.projectId,
      previewPort: session.previewPort,
      previewUrl: session.previewUrl,
      sessionId: session.id,
      workspaceDir: session.workspaceDir,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create build session.",
    });
  }
});

app.get("/api/build-sessions/:sessionId", async (req, res) => {
  try {
    const liveSession = sessions.get(req.params.sessionId);

    if (liveSession) {
      res.json({
        ok: true,
        active: true,
        projectId: liveSession.projectId,
        previewPort: liveSession.previewPort,
        previewUrl: liveSession.previewUrl,
        sessionId: liveSession.id,
        shell: liveSession.shell,
        workspaceDir: liveSession.workspaceDir,
      });
      return;
    }

    const session = await getBuildSessionRecord(req.params.sessionId);

    if (!session) {
      res.status(404).json({
        error: "Session not found.",
      });
      return;
    }

    res.json({
      ok: true,
      active: false,
      projectId: session.projectId,
      previewPort: session.previewPort,
      previewUrl: session.previewUrl,
      sessionId: session.id,
      shell: session.shell,
      state: session.state,
      updatedAt: session.updatedAt,
      workspaceDir: session.workspaceDir,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load build session.",
    });
  }
});

app.post("/api/build-sessions/:sessionId/preview-url", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const bearerToken = getBearerToken(req.header("authorization"));
    const session = sessions.get(sessionId);

    const persistedSession = session ? null : await getBuildSessionRecord(sessionId);
    const expectedToken = session?.config.previewToken ?? persistedSession?.previewToken ?? "";

    if (!expectedToken || bearerToken !== expectedToken) {
      res.status(401).json({
        error: "Invalid preview token.",
      });
      return;
    }

    const rawUrl =
      req.body?.url === null
        ? null
        : typeof req.body?.url === "string"
          ? req.body.url
          : "";
    const previewUrl = normalizePreviewUrl(rawUrl);

    if (session) {
      await session.updatePreviewUrl(previewUrl);
    } else {
      await updateBuildSessionPreview({
        previewUrl,
        sessionId,
      });
    }

    res.json({
      ok: true,
      previewUrl,
      sessionId,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to update preview URL.",
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    database: "connected",
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
  const url = new URL(request.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    socket.close(4400, "Missing sessionId");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    socket.close(4404, "Session not found");
    return;
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

async function bootstrap() {
  await initDatabase();
  const databaseUrl = new URL(getDatabaseUrl());
  const databaseLabel = `${databaseUrl.protocol}//${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`;

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`browser-tmux server listening on http://localhost:${PORT}`);
    console.log(`postgres connected at ${databaseLabel}`);
  });
}

bootstrap().catch((error) => {
  console.error("failed to start server", error);
  process.exit(1);
});
