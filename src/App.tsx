import { useEffect, useMemo, useRef, useState } from "react";

import { TerminalPane, type TerminalHandle } from "./components/TerminalPane";
import { PANES, type PaneId, type ServerMessage } from "../shared/protocol";

type ConnectionState = "connecting" | "connected" | "disconnected";

type PaneRuntime = {
  exitCode: number | null;
  signal: number | null;
  state: "booting" | "live" | "exited";
};

type BrowserTmuxDebugApi = {
  getPaneText: (paneId: PaneId) => string;
  getState: () => {
    activePane: PaneId;
    connectionState: ConnectionState;
    cwd: string;
    runtime: Record<PaneId, PaneRuntime>;
    sessionId: string;
    shell: string;
  };
  restartPane: (paneId: PaneId) => void;
  sendInput: (paneId: PaneId, data: string) => void;
};

declare global {
  interface Window {
    __browserTmux?: BrowserTmuxDebugApi;
  }
}

const SESSION_STORAGE_KEY = "browser-tmux/session-id";

function createInitialRuntime(): Record<PaneId, PaneRuntime> {
  return {
    workspace: {
      state: "booting",
      exitCode: null,
      signal: null,
    },
    server: {
      state: "booting",
      exitCode: null,
      signal: null,
    },
    scratch: {
      state: "booting",
      exitCode: null,
      signal: null,
    },
  };
}

function createPendingOutputBuffer(): Record<PaneId, string[]> {
  return {
    workspace: [],
    server: [],
    scratch: [],
  };
}

function createPendingSnapshotBuffer(): Record<PaneId, string | null> {
  return {
    workspace: null,
    server: null,
    scratch: null,
  };
}

function createSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateSessionId() {
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);

    if (stored) {
      return stored;
    }

    const next = createSessionId();
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createSessionId();
  }
}

function persistSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Ignore storage failures and keep the in-memory session id.
  }
}

function getSocketUrl(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${protocol}://${window.location.host}/ws`);
  url.searchParams.set("sessionId", sessionId);
  return url.toString();
}

export function App() {
  const sessionIdRef = useRef(getOrCreateSessionId());
  const terminalsRef = useRef(new Map<PaneId, TerminalHandle>());
  const pendingOutputRef = useRef(createPendingOutputBuffer());
  const pendingSnapshotRef = useRef(createPendingSnapshotBuffer());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const [activePane, setActivePane] = useState<PaneId>("workspace");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [cwd, setCwd] = useState("");
  const [shell, setShell] = useState("");
  const [sessionId, setSessionId] = useState(sessionIdRef.current);
  const [runtime, setRuntime] = useState<Record<PaneId, PaneRuntime>>(createInitialRuntime);

  const connectionLabel = useMemo(() => {
    switch (connectionState) {
      case "connected":
        return "connected";
      case "disconnected":
        return "reconnecting";
      default:
        return "connecting";
    }
  }, [connectionState]);

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
    let stopped = false;

    const writeToPane = (paneId: PaneId, data: string) => {
      const terminal = terminalsRef.current.get(paneId);

      if (!terminal) {
        pendingOutputRef.current[paneId].push(data);
        return;
      }

      terminal.write(data);
    };

    const syncTerminalSizes = () => {
      for (const pane of PANES) {
        const terminal = terminalsRef.current.get(pane.id);

        if (!terminal) {
          continue;
        }

        terminal.fit();

        const { cols, rows } = terminal.getSize();
        sendMessage({
          type: "resize",
          paneId: pane.id,
          cols,
          rows,
        });
      }
    };

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case "session": {
          sessionIdRef.current = message.sessionId;
          persistSessionId(message.sessionId);
          setSessionId(message.sessionId);
          setCwd(message.cwd);
          setShell(message.shell);
          setRuntime(createInitialRuntime());
          pendingOutputRef.current = createPendingOutputBuffer();
          pendingSnapshotRef.current = createPendingSnapshotBuffer();

          for (const pane of PANES) {
            terminalsRef.current.get(pane.id)?.reset();
          }

          requestAnimationFrame(syncTerminalSizes);
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
              `\r\n\x1b[31m[process exited: code=${message.exitCode ?? "?"}, signal=${message.signal ?? "none"}]\x1b[0m\r\n`,
            );
          }

          return;
        }
        case "error": {
          for (const pane of PANES) {
            writeToPane(pane.id, `\r\n\x1b[33m${message.message}\x1b[0m\r\n`);
          }
        }
      }
    };

    const connect = () => {
      setConnectionState("connecting");

      const socket = new WebSocket(getSocketUrl(sessionIdRef.current));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnectionState("connected");
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        handleMessage(message);
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (stopped) {
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
  }, []);

  useEffect(() => {
    window.__browserTmux = {
      getPaneText: (paneId) => terminalsRef.current.get(paneId)?.getText() ?? "",
      getState: () => ({
        activePane,
        connectionState,
        cwd,
        runtime,
        sessionId,
        shell,
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
  }, [activePane, connectionState, cwd, runtime, sessionId, shell]);

  const activePaneMeta = PANES.find((pane) => pane.id === activePane) ?? PANES[0];

  return (
    <div className="app-shell">
      <div className="app-shell__backdrop" />
      <div className="app-shell__inner">
        <header className="topbar">
          <div>
            <p className="eyebrow">browser tmux</p>
            <h1>Three live terminals, one tmux-style dashboard.</h1>
          </div>
          <div className="topbar__meta">
            <div className="metric">
              <span>status</span>
              <strong>{connectionLabel}</strong>
            </div>
            <div className="metric">
              <span>active</span>
              <strong>{activePaneMeta.title}</strong>
            </div>
            <div className="metric">
              <span>shell</span>
              <strong>{shell || "resolving"}</strong>
            </div>
          </div>
        </header>

        <main className="layout">
          <div className="layout__primary">
            <TerminalPane
              active={activePane === "workspace"}
              onFocus={setActivePane}
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
              pane={PANES[0]}
              runtime={runtime.workspace}
            />
          </div>

          <div className="layout__stack">
            <TerminalPane
              active={activePane === "server"}
              onFocus={setActivePane}
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
              pane={PANES[1]}
              runtime={runtime.server}
            />
            <TerminalPane
              active={activePane === "scratch"}
              onFocus={setActivePane}
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
              pane={PANES[2]}
              runtime={runtime.scratch}
            />
          </div>
        </main>

        <footer className="statusbar">
          <div className="statusbar__pill">
            <span>session</span>
            <strong>{sessionId}</strong>
          </div>
          <div className="statusbar__pill">
            <span>cwd</span>
            <strong>{cwd || "waiting for server"}</strong>
          </div>
          <div className="statusbar__pill">
            <span>tip</span>
            <strong>refresh keeps the same shell session</strong>
          </div>
        </footer>
      </div>
    </div>
  );
}
