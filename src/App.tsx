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

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

export function App() {
  const terminalsRef = useRef(new Map<PaneId, TerminalHandle>());
  const pendingOutputRef = useRef<Record<PaneId, string[]>>({
    workspace: [],
    server: [],
    scratch: [],
  });
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const seenSessionRef = useRef(false);

  const [activePane, setActivePane] = useState<PaneId>("workspace");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [cwd, setCwd] = useState("");
  const [shell, setShell] = useState("");
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

  useEffect(() => {
    let stopped = false;

    const send = (message: unknown) => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        return;
      }

      socketRef.current.send(JSON.stringify(message));
    };

    const flushPendingOutput = (paneId: PaneId) => {
      const terminal = terminalsRef.current.get(paneId);
      const buffer = pendingOutputRef.current[paneId];

      if (!terminal || buffer.length === 0) {
        return;
      }

      for (const chunk of buffer) {
        terminal.write(chunk);
      }

      pendingOutputRef.current[paneId] = [];
    };

    const writeToPane = (paneId: PaneId, data: string) => {
      const terminal = terminalsRef.current.get(paneId);

      if (!terminal) {
        pendingOutputRef.current[paneId].push(data);
        return;
      }

      terminal.write(data);
    };

    const pushSystemLine = (message: string) => {
      for (const pane of PANES) {
        writeToPane(pane.id, `\r\n\x1b[33m${message}\x1b[0m\r\n`);
      }
    };

    const syncTerminalSizes = () => {
      for (const pane of PANES) {
        const terminal = terminalsRef.current.get(pane.id);

        if (!terminal) {
          continue;
        }

        terminal.fit();

        const { cols, rows } = terminal.getSize();
        send({
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
          setCwd(message.cwd);
          setShell(message.shell);
          setRuntime(createInitialRuntime());

          for (const pane of PANES) {
            terminalsRef.current.get(pane.id)?.reset();
          }

          if (seenSessionRef.current) {
            pushSystemLine("Session restarted.");
          }

          seenSessionRef.current = true;
          requestAnimationFrame(syncTerminalSizes);
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
          pushSystemLine(message.message);
        }
      }
    };

    const connect = () => {
      setConnectionState("connecting");

      const socket = new WebSocket(getSocketUrl());
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
        pushSystemLine("Socket closed. Reconnecting...");
        reconnectTimerRef.current = window.setTimeout(connect, 1400);
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

  const sendMessage = (message: unknown) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(JSON.stringify(message));
  };

  useEffect(() => {
    window.__browserTmux = {
      getPaneText: (paneId) => terminalsRef.current.get(paneId)?.getText() ?? "",
      getState: () => ({
        activePane,
        connectionState,
        cwd,
        runtime,
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
  }, [activePane, connectionState, cwd, runtime, shell]);

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
              onReady={(paneId, terminal) => {
                terminalsRef.current.set(paneId, terminal);

                const pending = pendingOutputRef.current[paneId];
                if (pending.length > 0) {
                  for (const chunk of pending) {
                    terminal.write(chunk);
                  }

                  pendingOutputRef.current[paneId] = [];
                }
              }}
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
              onReady={(paneId, terminal) => {
                terminalsRef.current.set(paneId, terminal);

                const pending = pendingOutputRef.current[paneId];
                if (pending.length > 0) {
                  for (const chunk of pending) {
                    terminal.write(chunk);
                  }

                  pendingOutputRef.current[paneId] = [];
                }
              }}
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
              onReady={(paneId, terminal) => {
                terminalsRef.current.set(paneId, terminal);

                const pending = pendingOutputRef.current[paneId];
                if (pending.length > 0) {
                  for (const chunk of pending) {
                    terminal.write(chunk);
                  }

                  pendingOutputRef.current[paneId] = [];
                }
              }}
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
            <strong>browser-tmux</strong>
          </div>
          <div className="statusbar__pill">
            <span>cwd</span>
            <strong>{cwd || "waiting for server"}</strong>
          </div>
          <div className="statusbar__pill">
            <span>tip</span>
            <strong>click a pane and type directly</strong>
          </div>
        </footer>
      </div>
    </div>
  );
}
