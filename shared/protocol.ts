export const PANES = [
  {
    id: "agent",
    title: "codex",
    subtitle: "interactive build session",
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
      projectId: string;
      panes: readonly PaneDefinition[];
      cwd: string;
      previewPort: number;
      previewUrl: string | null;
      shell: string;
      workspaceDir: string;
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
      type: "preview";
      previewUrl: string | null;
    }
  | {
      type: "error";
      message: string;
    };
