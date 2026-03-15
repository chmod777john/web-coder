import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { PaneDefinition, PaneId } from "../../shared/protocol";

export type TerminalHandle = {
  dispose: () => void;
  fit: () => void;
  focus: () => void;
  getSize: () => { cols: number; rows: number };
  getText: () => string;
  reset: () => void;
  write: (data: string) => void;
};

type PaneRuntime = {
  exitCode: number | null;
  signal: number | null;
  state: "booting" | "live" | "exited";
};

type TerminalPaneProps = {
  active: boolean;
  onFocus: (paneId: PaneId) => void;
  onInput: (paneId: PaneId, data: string) => void;
  onReady: (paneId: PaneId, terminal: TerminalHandle) => void;
  onResize: (paneId: PaneId, cols: number, rows: number) => void;
  onRestart: (paneId: PaneId) => void;
  pane: PaneDefinition;
  runtime: PaneRuntime;
};

const terminalTheme = {
  background: "#08110d",
  foreground: "#ecf7eb",
  cursor: "#90df62",
  cursorAccent: "#08110d",
  selectionBackground: "rgba(144, 223, 98, 0.22)",
  black: "#11201a",
  red: "#ff8c7a",
  green: "#91d46a",
  yellow: "#e8cc73",
  blue: "#73beff",
  magenta: "#f0a8ff",
  cyan: "#6de4d9",
  white: "#f8fff6",
  brightBlack: "#3b5843",
  brightRed: "#ffab9c",
  brightGreen: "#b5ef8d",
  brightYellow: "#f8e49d",
  brightBlue: "#9dd2ff",
  brightMagenta: "#f7c6ff",
  brightCyan: "#97f7ed",
  brightWhite: "#ffffff",
};

export function TerminalPane({
  active,
  onFocus,
  onInput,
  onReady,
  onResize,
  onRestart,
  pane,
  runtime,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalHandleRef = useRef<TerminalHandle | null>(null);
  const onFocusRef = useRef(onFocus);
  const onInputRef = useRef(onInput);
  const onReadyRef = useRef(onReady);
  const onResizeRef = useRef(onResize);

  onFocusRef.current = onFocus;
  onInputRef.current = onInput;
  onReadyRef.current = onReady;
  onResizeRef.current = onResize;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      drawBoldTextInBrightColors: true,
      fontFamily:
        '"Iosevka Term", "JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.16,
      scrollback: 2000,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const fit = () => {
      fitAddon.fit();
      onResizeRef.current(pane.id, terminal.cols, terminal.rows);
    };

    const controller: TerminalHandle = {
      dispose: () => terminal.dispose(),
      fit,
      focus: () => terminal.focus(),
      getSize: () => ({
        cols: terminal.cols,
        rows: terminal.rows,
      }),
      getText: () => {
        const lines: string[] = [];

        for (let index = 0; index < terminal.buffer.active.length; index += 1) {
          const line = terminal.buffer.active.getLine(index);
          lines.push(line?.translateToString(true) ?? "");
        }

        return lines.join("\n");
      },
      reset: () => terminal.reset(),
      write: (data: string) => terminal.write(data),
    };
    terminalHandleRef.current = controller;

    const resizeObserver = new ResizeObserver(() => {
      fit();
    });

    resizeObserver.observe(container);

    const disposeData = terminal.onData((data) => {
      onInputRef.current(pane.id, data);
    });
    const handleFocus = () => {
      onFocusRef.current(pane.id);
    };

    container.addEventListener("click", controller.focus);
    container.addEventListener("focusin", handleFocus);
    onReadyRef.current(pane.id, controller);
    requestAnimationFrame(() => {
      fit();
      if (active) {
        terminal.focus();
      }
    });

    return () => {
      if (terminalHandleRef.current === controller) {
        terminalHandleRef.current = null;
      }
      container.removeEventListener("click", controller.focus);
      container.removeEventListener("focusin", handleFocus);
      disposeData.dispose();
      resizeObserver.disconnect();
      controller.dispose();
    };
  }, [pane.id]);

  useEffect(() => {
    if (!active) {
      return;
    }

    terminalHandleRef.current?.focus();
  }, [active]);

  const statusLabel =
    runtime.state === "live"
      ? "live"
      : runtime.state === "booting"
        ? "booting"
        : `exit ${runtime.exitCode ?? "?"}`;

  return (
    <section className={`pane ${active ? "pane--active" : ""}`} data-pane-id={pane.id}>
      <header className="pane__header">
        <div>
          <p className="pane__title">{pane.title}</p>
          <p className="pane__subtitle">{pane.subtitle}</p>
        </div>
        <div className="pane__actions">
          <span className={`pane__badge pane__badge--${runtime.state}`}>{statusLabel}</span>
          <button
            className="pane__button"
            onClick={(event) => {
              event.stopPropagation();
              onRestart(pane.id);
            }}
            type="button"
          >
            restart
          </button>
        </div>
      </header>
      <div className="pane__terminal-shell">
        <div className="pane__terminal" ref={containerRef} />
      </div>
    </section>
  );
}
