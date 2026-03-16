import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { TerminalPane, type TerminalHandle } from "./components/TerminalPane";
import { PANES, type PaneId, type ServerMessage } from "../shared/protocol";

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected";

type PaneRuntime = {
  exitCode: number | null;
  signal: number | null;
  state: "booting" | "live" | "exited";
};

type ProjectSummary = {
  activeSessionId: string | null;
  createdAt: string;
  id: string;
  initialPrompt: string;
  lastOpenedAt: string;
  lastSessionState: "booting" | "live" | "exited" | null;
  lastSessionUpdatedAt: string | null;
  latestSessionId: string | null;
  title: string;
  updatedAt: string;
  workspaceDir: string;
};

type BrowserTmuxDebugApi = {
  clearSession: () => void;
  getPaneText: (paneId: PaneId) => string;
  getState: () => {
    connectionState: ConnectionState;
    cwd: string;
    previewPort: number | null;
    projectId: string | null;
    runtime: Record<PaneId, PaneRuntime>;
    sessionId: string | null;
    shell: string;
    workspaceDir: string;
  };
  restartPane: (paneId: PaneId) => void;
  sendInput: (paneId: PaneId, data: string) => void;
};

declare global {
  interface Window {
    __browserTmux?: BrowserTmuxDebugApi;
  }
}

const SESSION_STORAGE_KEY = "browser-tmux/build-session-id";
const NEW_PROJECT_ACTION_ID = "__new__";

function createInitialRuntime(): Record<PaneId, PaneRuntime> {
  return {
    agent: {
      state: "booting",
      exitCode: null,
      signal: null,
    },
  };
}

function createPendingOutputBuffer(): Record<PaneId, string[]> {
  return {
    agent: [],
  };
}

function createPendingSnapshotBuffer(): Record<PaneId, string | null> {
  return {
    agent: null,
  };
}

function readStoredSessionId() {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistSessionId(sessionId: string | null) {
  try {
    if (sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function getSocketUrl(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  url.searchParams.set("sessionId", sessionId);
  return url.toString();
}

function buildPreviewUrl(previewPort: number | null) {
  if (!previewPort) {
    return "";
  }

  return `${window.location.protocol}//${window.location.hostname}:${previewPort}`;
}

function formatProjectTime(value: string | null) {
  if (!value) {
    return "unknown";
  }

  return new Date(value).toLocaleString();
}

export function App() {
  const pane = PANES[0];
  const sessionIdRef = useRef<string | null>(readStoredSessionId());
  const terminalsRef = useRef(new Map<PaneId, TerminalHandle>());
  const pendingOutputRef = useRef(createPendingOutputBuffer());
  const pendingSnapshotRef = useRef(createPendingSnapshotBuffer());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const [prompt, setPrompt] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isPreviewReady, setIsPreviewReady] = useState(false);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    sessionIdRef.current ? "connecting" : "idle",
  );
  const [cwd, setCwd] = useState("");
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsError, setProjectsError] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectActionId, setProjectActionId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(sessionIdRef.current);
  const [shell, setShell] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [runtime, setRuntime] = useState<Record<PaneId, PaneRuntime>>(createInitialRuntime);

  const previewUrl = useMemo(() => buildPreviewUrl(previewPort), [previewPort]);
  const connectionLabel = useMemo(() => {
    switch (connectionState) {
      case "connected":
        return "connected";
      case "disconnected":
        return "reconnecting";
      case "connecting":
        return "connecting";
      default:
        return "idle";
    }
  }, [connectionState]);

  const resetClientSessionState = () => {
    pendingOutputRef.current = createPendingOutputBuffer();
    pendingSnapshotRef.current = createPendingSnapshotBuffer();
    setCwd("");
    setPreviewPort(null);
    setProjectId(null);
    setShell("");
    setWorkspaceDir("");
    setRuntime(createInitialRuntime());

    for (const terminal of terminalsRef.current.values()) {
      terminal.reset();
    }
  };

  const connectToSession = (next: {
    projectId?: string | null;
    previewPort?: number | null;
    sessionId: string;
    workspaceDir?: string;
  }) => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }

    resetClientSessionState();
    sessionIdRef.current = next.sessionId;
    persistSessionId(next.sessionId);
    setSessionId(next.sessionId);
    setProjectId(next.projectId ?? null);
    setPreviewPort(next.previewPort ?? null);
    setWorkspaceDir(next.workspaceDir ?? "");
    setConnectionState("connecting");
    setPreviewRefreshKey(0);
    setIsPreviewReady(false);
    setCreateError("");
  };

  const clearCurrentSession = () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }

    socketRef.current?.close();
    socketRef.current = null;
    sessionIdRef.current = null;
    persistSessionId(null);
    setSessionId(null);
    setConnectionState("idle");
    setPrompt("");
    setProjectActionId(null);
    setCreateError("");
    resetClientSessionState();
    setPreviewRefreshKey(0);
  };

  const sendMessage = (message: unknown) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(JSON.stringify(message));
  };

  const handlePaneReady = (paneId: PaneId, terminal: TerminalHandle) => {
    terminalsRef.current.set(paneId, terminal);

    const snapshot = pendingSnapshotRef.current[paneId];
    if (snapshot !== null) {
      terminal.reset();

      if (snapshot) {
        terminal.write(snapshot);
      }

      pendingSnapshotRef.current[paneId] = null;
    }

    const pendingOutput = pendingOutputRef.current[paneId];
    if (pendingOutput.length > 0) {
      for (const chunk of pendingOutput) {
        terminal.write(chunk);
      }

      pendingOutputRef.current[paneId] = [];
    }
  };

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let stopped = false;

    const writeToPane = (paneId: PaneId, data: string) => {
      const terminal = terminalsRef.current.get(paneId);

      if (!terminal) {
        pendingOutputRef.current[paneId].push(data);
        return;
      }

      terminal.write(data);
    };

    const syncTerminalSize = () => {
      const terminal = terminalsRef.current.get("agent");

      if (!terminal) {
        return;
      }

      terminal.fit();

      const { cols, rows } = terminal.getSize();
      sendMessage({
        type: "resize",
        paneId: "agent",
        cols,
        rows,
      });
    };

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case "session": {
          sessionIdRef.current = message.sessionId;
          persistSessionId(message.sessionId);
          setSessionId(message.sessionId);
          setProjectId(message.projectId);
          setCwd(message.cwd);
          setPreviewPort(message.previewPort);
          setShell(message.shell);
          setWorkspaceDir(message.workspaceDir);
          setRuntime(createInitialRuntime());
          pendingOutputRef.current = createPendingOutputBuffer();
          pendingSnapshotRef.current = createPendingSnapshotBuffer();

          terminalsRef.current.get("agent")?.reset();

          requestAnimationFrame(syncTerminalSize);
          return;
        }
        case "snapshot": {
          pendingOutputRef.current[message.paneId] = [];

          const terminal = terminalsRef.current.get(message.paneId);
          if (terminal) {
            terminal.reset();

            if (message.data) {
              terminal.write(message.data);
            }
          } else {
            pendingSnapshotRef.current[message.paneId] = message.data;
          }

          setRuntime((current) => ({
            ...current,
            [message.paneId]: {
              state: message.state,
              exitCode: message.exitCode,
              signal: message.signal,
            },
          }));
          return;
        }
        case "output": {
          writeToPane(message.paneId, message.data);
          return;
        }
        case "status": {
          setRuntime((current) => ({
            ...current,
            [message.paneId]: {
              state: message.state,
              exitCode: message.exitCode,
              signal: message.signal,
            },
          }));

          if (message.state === "exited") {
            writeToPane(
              message.paneId,
              `\r\n\x1b[31m[codex session exited: code=${message.exitCode ?? "?"}, signal=${message.signal ?? "none"}]\x1b[0m\r\n`,
            );
          }

          return;
        }
        case "error": {
          writeToPane("agent", `\r\n\x1b[33m${message.message}\x1b[0m\r\n`);
        }
      }
    };

    const connect = () => {
      setConnectionState("connecting");

      const socket = new WebSocket(getSocketUrl(sessionId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnectionState("connected");
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        handleMessage(message);
      });

      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (stopped) {
          return;
        }

        if (sessionIdRef.current !== sessionId) {
          return;
        }

        if (event.code === 4400 || event.code === 4404) {
          clearCurrentSession();
          return;
        }

        setConnectionState("disconnected");
        reconnectTimerRef.current = window.setTimeout(connect, 1_400);
      });
    };

    connect();

    return () => {
      stopped = true;

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      socketRef.current?.close();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !previewUrl) {
      setIsPreviewReady(false);
      return;
    }

    let cancelled = false;
    let probeTimer: number | null = null;

    const probePreview = async () => {
      try {
        await fetch(previewUrl, {
          cache: "no-store",
          mode: "no-cors",
        });

        if (!cancelled) {
          setIsPreviewReady(true);
        }
      } catch {
        if (cancelled) {
          return;
        }

        setIsPreviewReady(false);
        probeTimer = window.setTimeout(probePreview, 1_500);
      }
    };

    setIsPreviewReady(false);
    probePreview();

    return () => {
      cancelled = true;

      if (probeTimer) {
        window.clearTimeout(probeTimer);
      }
    };
  }, [previewRefreshKey, previewUrl, sessionId]);

  useEffect(() => {
    if (sessionId) {
      return;
    }

    let cancelled = false;

    const loadProjects = async () => {
      setProjectsLoading(true);
      setProjectsError("");

      try {
        const response = await fetch("/api/projects");

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Failed to load projects.");
        }

        const payload = (await response.json()) as {
          projects: ProjectSummary[];
        };

        if (!cancelled) {
          setProjects(payload.projects);
        }
      } catch (error) {
        if (!cancelled) {
          setProjectsError(error instanceof Error ? error.message : "Failed to load projects.");
        }
      } finally {
        if (!cancelled) {
          setProjectsLoading(false);
        }
      }
    };

    void loadProjects();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    window.__browserTmux = {
      clearSession: clearCurrentSession,
      getPaneText: (paneId) => terminalsRef.current.get(paneId)?.getText() ?? "",
      getState: () => ({
        connectionState,
        cwd,
        previewPort,
        projectId,
        runtime,
        sessionId,
        shell,
        workspaceDir,
      }),
      restartPane: (paneId) => {
        sendMessage({
          type: "restart",
          paneId,
        });
      },
      sendInput: (paneId, data) => {
        sendMessage({
          type: "input",
          paneId,
          data,
        });
      },
    };

    return () => {
      delete window.__browserTmux;
    };
  }, [connectionState, cwd, previewPort, projectId, runtime, sessionId, shell, workspaceDir]);

  const handleCreateSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!prompt.trim()) {
      setCreateError("先写下你想让 codex 做什么。");
      return;
    }

    setIsCreating(true);
    setProjectActionId(NEW_PROJECT_ACTION_ID);
    setCreateError("");

    try {
      const response = await fetch("/api/build-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Failed to create build session.");
      }

      const payload = (await response.json()) as {
        projectId: string;
        previewPort: number;
        sessionId: string;
        workspaceDir: string;
      };

      connectToSession(payload);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Failed to create build session.");
    } finally {
      setIsCreating(false);
      setProjectActionId(null);
    }
  };

  const handleContinueProject = async (project: ProjectSummary) => {
    setProjectActionId(project.id);
    setProjectsError("");

    try {
      if (project.activeSessionId) {
        connectToSession({
          projectId: project.id,
          sessionId: project.activeSessionId,
          workspaceDir: project.workspaceDir,
        });
        return;
      }

      const response = await fetch("/api/build-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Failed to continue project.");
      }

      const payload = (await response.json()) as {
        projectId: string;
        previewPort: number;
        sessionId: string;
        workspaceDir: string;
      };

      connectToSession(payload);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "Failed to continue project.");
    } finally {
      setProjectActionId(null);
    }
  };

  if (!sessionId) {
    return (
      <div className="app-shell">
        <div className="app-shell__backdrop" />
        <div className="app-shell__inner app-shell__inner--centered">
          <section className="launcher">
            <div className="launcher__copy">
              <p className="eyebrow">codex builder</p>
              <h1>说出需求，直接生成一个可预览的应用工作台。</h1>
              <p className="launcher__lede">
                后端会为每个项目保留独立 workspace，并把项目元数据持久化到 Postgres。
                你可以新建任务，也可以回到已有项目继续构建。
              </p>
            </div>

            <div className="launcher__rail">
              <form className="launcher__form" onSubmit={handleCreateSession}>
                <label className="launcher__label" htmlFor="prompt">
                  新项目需求
                </label>
                <textarea
                  className="launcher__textarea"
                  id="prompt"
                  onChange={(event) => {
                    setPrompt(event.target.value);
                  }}
                  placeholder="例如：做一个面向健身工作室的预约网站，要有课程列表、教练介绍、移动端优先设计。"
                  rows={8}
                  value={prompt}
                />
                {createError ? <p className="launcher__error">{createError}</p> : null}
                <div className="launcher__actions">
                  <button
                    className="launcher__button"
                    disabled={isCreating}
                    type="submit"
                  >
                    {isCreating ? "starting codex..." : "开始新项目"}
                  </button>
                  <p className="launcher__hint">
                    创建后会进入工作台，并自动保留刷新后的终端会话。
                  </p>
                </div>
              </form>

              <section className="project-list">
                <header className="project-list__header">
                  <div>
                    <p className="launcher__label">已有项目</p>
                    <p className="project-list__lede">
                      服务重启后，这里仍然会保留你的项目入口。
                    </p>
                  </div>
                </header>

                {projectsError ? <p className="launcher__error">{projectsError}</p> : null}

                {projectsLoading ? (
                  <p className="project-list__empty">Loading projects...</p>
                ) : projects.length > 0 ? (
                  <div className="project-list__items">
                    {projects.map((project) => (
                      <article className="project-card" key={project.id}>
                        <div className="project-card__copy">
                          <div className="project-card__topline">
                            <p className="project-card__title">{project.title}</p>
                            <span
                              className={`project-card__status project-card__status--${project.activeSessionId ? "active" : (project.lastSessionState ?? "idle")}`}
                            >
                              {project.activeSessionId
                                ? "live"
                                : project.lastSessionState ?? "saved"}
                            </span>
                          </div>
                          <p className="project-card__prompt">{project.initialPrompt}</p>
                          <p className="project-card__meta">
                            last opened {formatProjectTime(project.lastOpenedAt)}
                          </p>
                          <p className="project-card__path">{project.workspaceDir}</p>
                        </div>

                        <button
                          className="launcher__button"
                          disabled={projectActionId === project.id}
                          onClick={() => {
                            void handleContinueProject(project);
                          }}
                          type="button"
                        >
                          {projectActionId === project.id
                            ? "opening..."
                            : project.activeSessionId
                              ? "继续会话"
                              : "重新进入"}
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="project-list__empty">
                    还没有持久化项目。先新建一个任务。
                  </p>
                )}
              </section>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-shell__backdrop" />
      <div className="app-shell__inner">
        <header className="topbar">
          <div>
            <p className="eyebrow">codex builder</p>
            <h1>单终端驱动，右侧实时预览。</h1>
          </div>
          <div className="topbar__meta">
            <div className="metric">
              <span>status</span>
              <strong>{connectionLabel}</strong>
            </div>
            <div className="metric">
              <span>preview</span>
              <strong>{previewPort ? `:${previewPort}` : "pending"}</strong>
            </div>
            <div className="metric">
              <span>session</span>
              <strong>{sessionId}</strong>
            </div>
          </div>
        </header>

        <main className="workspace">
          <div className="workspace__terminal">
            <TerminalPane
              active
              onFocus={() => {}}
              onInput={(paneId, data) => {
                sendMessage({
                  type: "input",
                  paneId,
                  data,
                });
              }}
              onReady={handlePaneReady}
              onResize={(paneId, cols, rows) => {
                sendMessage({
                  type: "resize",
                  paneId,
                  cols,
                  rows,
                });
              }}
              onRestart={(paneId) => {
                sendMessage({
                  type: "restart",
                  paneId,
                });
              }}
              pane={pane}
              runtime={runtime.agent}
            />
          </div>

          <section className="preview">
            <header className="preview__header">
              <div>
                <p className="pane__title">preview</p>
                <p className="pane__subtitle">
                  {previewUrl && isPreviewReady
                    ? previewUrl
                    : "waiting for the app dev server to come up"}
                </p>
              </div>
              <div className="pane__actions">
                <button
                  className="pane__button"
                  onClick={() => {
                    setPreviewRefreshKey((value) => value + 1);
                  }}
                  type="button"
                >
                  reload
                </button>
                <button
                  className="pane__button"
                  onClick={() => {
                    clearCurrentSession();
                  }}
                  type="button"
                >
                  projects
                </button>
              </div>
            </header>
            <div className="preview__frame-shell">
              {previewUrl && isPreviewReady ? (
                <iframe
                  className="preview__frame"
                  key={`${previewUrl}-${previewRefreshKey}`}
                  src={previewUrl}
                  title="app preview"
                />
              ) : (
                <div className="preview__placeholder">
                  <strong>Waiting for preview server</strong>
                  <p>
                    Codex will start the generated app on the assigned port when it is ready.
                  </p>
                </div>
              )}
            </div>
          </section>
        </main>

        <footer className="statusbar">
          <div className="statusbar__pill">
            <span>project</span>
            <strong>{projectId ?? "preparing"}</strong>
          </div>
          <div className="statusbar__pill">
            <span>workspace</span>
            <strong>{workspaceDir || "preparing"}</strong>
          </div>
          <div className="statusbar__pill">
            <span>shell</span>
            <strong>{shell || "resolving"}</strong>
          </div>
        </footer>
      </div>
    </div>
  );
}
