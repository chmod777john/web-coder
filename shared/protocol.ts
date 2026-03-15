export const PANES = [
  {
    id: "workspace",
    title: "workspace",
    subtitle: "project root shell",
  },
  {
    id: "server",
    title: "server",
    subtitle: "run the app or watchers",
  },
  {
    id: "scratch",
    title: "scratch",
    subtitle: "one-off commands",
  },
] as const;

export type PaneDefinition = (typeof PANES)[number];
export type PaneId = PaneDefinition["id"];

export type ClientMessage =
  | {
      type: "input";
      paneId: PaneId;
      data: string;
    }
  | {
      type: "resize";
      paneId: PaneId;
      cols: number;
      rows: number;
    }
  | {
      type: "restart";
      paneId: PaneId;
    };

export type ServerMessage =
  | {
      type: "session";
      sessionId: string;
      panes: readonly PaneDefinition[];
      cwd: string;
      shell: string;
    }
  | {
      type: "snapshot";
      paneId: PaneId;
      data: string;
      state: "live" | "exited";
      exitCode: number | null;
      signal: number | null;
    }
  | {
      type: "output";
      paneId: PaneId;
      data: string;
    }
  | {
      type: "status";
      paneId: PaneId;
      state: "live" | "exited";
      exitCode: number | null;
      signal: number | null;
    }
  | {
      type: "error";
      message: string;
    };
