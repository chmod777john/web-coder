import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

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

type BuildSessionPayload = {
  projectId: string;
  previewPort: number;
  previewUrl: string | null;
  sessionId: string;
  workspaceDir: string;
};

type BrowserTmuxDebugApi = {
  clearSession: () => void;
  getPaneText: (paneId: PaneId) => string;
  getState: () => {
    connectionState: ConnectionState;
    cwd: string;
    previewTarget: string | null;
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

function getSocketUrl(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  url.searchParams.set("sessionId", sessionId);
  return url.toString();
}

function resolvePreviewUrl(previewTarget: string | null) {
  if (!previewTarget) {
    return "";
  }

  if (previewTarget.startsWith("local://")) {
    const port = previewTarget.slice("local://".length);
    return `${window.location.protocol}//${window.location.hostname}:${port}`;
  }

  return previewTarget;
}

function formatPreviewTarget(previewTarget: string | null) {
  if (!previewTarget) {
    return "preview target not reported yet";
  }

  if (previewTarget.startsWith("local://")) {
    return `local app on ${previewTarget.slice("local://".length)}`;
  }

  return previewTarget;
}

function getPreviewStatusText(previewTarget: string | null, isPreviewReady: boolean) {
  if (!previewTarget) {
    return "waiting for codex to report a preview target";
  }

  if (isPreviewReady) {
    return formatPreviewTarget(previewTarget);
  }

  return `probing ${formatPreviewTarget(previewTarget)}`;
}

function formatProjectTime(value: string | null) {
  if (!value) {
    return "unknown";
  }

  return new Date(value).toLocaleString();
}

function buildWorkspacePath(projectId: string, sessionId: string) {
  return `/projects/${projectId}/sessions/${sessionId}`;
}

function LauncherPage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsError, setProjectsError] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectActionId, setProjectActionId] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  const openWorkspace = (payload: BuildSessionPayload) => {
    navigate(buildWorkspacePath(payload.projectId, payload.sessionId));
  };

  const handleCreateSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!prompt.trim()) {
      setCreateError("先写下你想让 codex 做什么。");
      return;
    }

    setIsCreating(true);
    setProjectActionId("__new__");
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

      openWorkspace((await response.json()) as BuildSessionPayload);
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
        navigate(buildWorkspacePath(project.id, project.activeSessionId));
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

      openWorkspace((await response.json()) as BuildSessionPayload);
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "Failed to continue project.");
    } finally {
      setProjectActionId(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="app-shell__backdrop" />
      <div className="app-shell__inner app-shell__inner--centered">
        <section className="launcher">
          <div className="launcher__copy">
            <p className="eyebrow">codex builder</p>
            <h1>说出需求，直接生成一个可预览的应用工作台。</h1>
            <p className="launcher__lede">
              根路径现在只负责项目页。工作台会进入独立路由，所以直接访问 `/`
              不会再自动跳进上一个项目。
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
                <button className="launcher__button" disabled={isCreating} type="submit">
                  {isCreating ? "starting codex..." : "开始新项目"}
                </button>
                <p className="launcher__hint">
                  创建后会跳到独立工作台路由，并自动连接对应 session。
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

function WorkspacePage() {
  const navigate = useNavigate();
  const { projectId: routeProjectId, sessionId: routeSessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  const pane = PANES[0];
  const terminalsRef = useRef(new Map<PaneId, TerminalHandle>());
  const pendingOutputRef = useRef(createPendingOutputBuffer());
  const pendingSnapshotRef = useRef(createPendingSnapshotBuffer());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(routeSessionId ?? null);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    routeSessionId ? "connecting" : "idle",
  );
  const [cwd, setCwd] = useState("");
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(routeProjectId ?? null);
  const [sessionId, setSessionId] = useState<string | null>(routeSessionId ?? null);
  const [shell, setShell] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [isPreviewReady, setIsPreviewReady] = useState(false);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [runtime, setRuntime] = useState<Record<PaneId, PaneRuntime>>(createInitialRuntime);

  const previewUrl = useMemo(() => resolvePreviewUrl(previewTarget), [previewTarget]);
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

  const leaveWorkspace = () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }

    socketRef.current?.close();
    socketRef.current = null;
    sessionIdRef.current = null;
    navigate("/", { replace: true });
  };

  const resetClientSessionState = () => {
    pendingOutputRef.current = createPendingOutputBuffer();
    pendingSnapshotRef.current = createPendingSnapshotBuffer();
    setCwd("");
    setPreviewPort(null);
    setPreviewTarget(null);
    setShell("");
    setWorkspaceDir("");
    setRuntime(createInitialRuntime());

    for (const terminal of terminalsRef.current.values()) {
      terminal.reset();
    }
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
    if (!routeSessionId || !routeProjectId) {
      return;
    }

    sessionIdRef.current = routeSessionId;
    setSessionId(routeSessionId);
    setProjectId(routeProjectId);
    setConnectionState("connecting");
    setPreviewRefreshKey(0);
    setIsPreviewReady(false);
    resetClientSessionState();
  }, [routeProjectId, routeSessionId]);

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
          setSessionId(message.sessionId);
          setProjectId(message.projectId);
          setCwd(message.cwd);
          setPreviewPort(message.previewPort);
          setPreviewTarget(message.previewUrl);
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
        case "preview": {
          setPreviewTarget(message.previewUrl);
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
          leaveWorkspace();
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
    window.__browserTmux = {
      clearSession: leaveWorkspace,
      getPaneText: (paneId) => terminalsRef.current.get(paneId)?.getText() ?? "",
      getState: () => ({
        connectionState,
        cwd,
        previewTarget,
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
  }, [connectionState, cwd, previewPort, previewTarget, projectId, runtime, sessionId, shell, workspaceDir]);

  if (!routeSessionId || !routeProjectId) {
    return <Navigate replace to="/" />;
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
              <span>target</span>
              <strong>{formatPreviewTarget(previewTarget)}</strong>
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
                  {getPreviewStatusText(previewTarget, isPreviewReady)}
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
                    leaveWorkspace();
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
                  <strong>
                    {previewTarget ? "Waiting for preview target to respond" : "Waiting for preview target"}
                  </strong>
                  <p>
                    {previewTarget
                      ? `Current target: ${formatPreviewTarget(previewTarget)}`
                      : "Codex must call the preview API with either local://<port> or a remote https:// URL."}
                  </p>
                </div>
              )}
            </div>
          </section>
        </main>

        <footer className="statusbar">
          <div className="statusbar__pill">
            <span>assigned port</span>
            <strong>{previewPort ? `:${previewPort}` : "pending"}</strong>
          </div>
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

export function App() {
  return (
    <Routes>
      <Route element={<LauncherPage />} path="/" />
      <Route element={<WorkspacePage />} path="/projects/:projectId/sessions/:sessionId" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
