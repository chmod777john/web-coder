import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/web_coder";

export type PersistedSessionState = "booting" | "live" | "exited";

export type ProjectRecord = {
  id: string;
  title: string;
  initialPrompt: string;
  workspaceDir: string;
  latestSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date;
};

export type ProjectSummaryRecord = ProjectRecord & {
  lastSessionState: PersistedSessionState | null;
  lastSessionUpdatedAt: Date | null;
};

export type BuildSessionRecord = {
  id: string;
  projectId: string;
  prompt: string;
  previewToken: string;
  previewUrl: string | null;
  workspaceDir: string;
  previewPort: number;
  shell: string;
  terminalHistory: string;
  state: PersistedSessionState;
  exitCode: number | null;
  signal: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => undefined,
});

export function getDatabaseUrl() {
  return DATABASE_URL;
}

export async function initDatabase() {
  await sql`
    create table if not exists projects (
      id text primary key,
      title text not null,
      initial_prompt text not null,
      workspace_dir text not null unique,
      latest_session_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_opened_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists build_sessions (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      prompt text not null,
      preview_token text not null default '',
      preview_url text,
      workspace_dir text not null,
      preview_port integer not null,
      shell text not null,
      terminal_history text not null default '',
      state text not null,
      exit_code integer,
      signal integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists idx_projects_last_opened_at
    on projects (last_opened_at desc)
  `;

  await sql`
    create index if not exists idx_build_sessions_project_id_created_at
    on build_sessions (project_id, created_at desc)
  `;

  await sql`
    alter table build_sessions
    add column if not exists preview_token text not null default ''
  `;

  await sql`
    alter table build_sessions
    add column if not exists preview_url text
  `;
}

export async function createProjectWithSession(input: {
  projectId: string;
  sessionId: string;
  title: string;
  prompt: string;
  previewToken: string;
  previewUrl: string | null;
  workspaceDir: string;
  previewPort: number;
  shell: string;
}) {
  await sql`
    insert into projects (
      id,
      title,
      initial_prompt,
      workspace_dir,
      latest_session_id
    ) values (
      ${input.projectId},
      ${input.title},
      ${input.prompt},
      ${input.workspaceDir},
      ${input.sessionId}
    )
  `;

  await sql`
    insert into build_sessions (
      id,
      project_id,
      prompt,
      preview_token,
      preview_url,
      workspace_dir,
      preview_port,
      shell,
      state
    ) values (
      ${input.sessionId},
      ${input.projectId},
      ${input.prompt},
      ${input.previewToken},
      ${input.previewUrl},
      ${input.workspaceDir},
      ${input.previewPort},
      ${input.shell},
      ${"booting"}
    )
  `;
}

export async function createSessionForProject(input: {
  projectId: string;
  sessionId: string;
  prompt: string;
  previewToken: string;
  previewUrl: string | null;
  workspaceDir: string;
  previewPort: number;
  shell: string;
}) {
  await sql`
    insert into build_sessions (
      id,
      project_id,
      prompt,
      preview_token,
      preview_url,
      workspace_dir,
      preview_port,
      shell,
      state
    ) values (
      ${input.sessionId},
      ${input.projectId},
      ${input.prompt},
      ${input.previewToken},
      ${input.previewUrl},
      ${input.workspaceDir},
      ${input.previewPort},
      ${input.shell},
      ${"booting"}
    )
  `;

  await sql`
    update projects
    set
      latest_session_id = ${input.sessionId},
      updated_at = now(),
      last_opened_at = now()
    where id = ${input.projectId}
  `;
}

export async function getProject(projectId: string) {
  const rows = await sql<ProjectRecord[]>`
    select
      id,
      title,
      initial_prompt as "initialPrompt",
      workspace_dir as "workspaceDir",
      latest_session_id as "latestSessionId",
      created_at as "createdAt",
      updated_at as "updatedAt",
      last_opened_at as "lastOpenedAt"
    from projects
    where id = ${projectId}
    limit 1
  `;

  return rows[0] ?? null;
}

export async function listProjects() {
  return sql<ProjectSummaryRecord[]>`
    select
      p.id,
      p.title,
      p.initial_prompt as "initialPrompt",
      p.workspace_dir as "workspaceDir",
      p.latest_session_id as "latestSessionId",
      p.created_at as "createdAt",
      p.updated_at as "updatedAt",
      p.last_opened_at as "lastOpenedAt",
      s.state as "lastSessionState",
      s.updated_at as "lastSessionUpdatedAt"
    from projects p
    left join build_sessions s on s.id = p.latest_session_id
    order by p.last_opened_at desc, p.created_at desc
  `;
}

export async function getBuildSessionRecord(sessionId: string) {
  const rows = await sql<BuildSessionRecord[]>`
    select
      id,
      project_id as "projectId",
      prompt,
      preview_token as "previewToken",
      preview_url as "previewUrl",
      workspace_dir as "workspaceDir",
      preview_port as "previewPort",
      shell,
      terminal_history as "terminalHistory",
      state,
      exit_code as "exitCode",
      signal,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from build_sessions
    where id = ${sessionId}
    limit 1
  `;

  return rows[0] ?? null;
}

export async function updateBuildSessionSnapshot(input: {
  sessionId: string;
  terminalHistory: string;
  state: PersistedSessionState;
  exitCode: number | null;
  signal: number | null;
}) {
  await sql`
    update build_sessions
    set
      terminal_history = ${input.terminalHistory},
      state = ${input.state},
      exit_code = ${input.exitCode},
      signal = ${input.signal},
      updated_at = now()
    where id = ${input.sessionId}
  `;
}

export async function updateBuildSessionPreview(input: {
  previewUrl: string | null;
  sessionId: string;
}) {
  await sql`
    update build_sessions
    set
      preview_url = ${input.previewUrl},
      updated_at = now()
    where id = ${input.sessionId}
  `;
}

export async function touchProject(projectId: string) {
  await sql`
    update projects
    set
      updated_at = now(),
      last_opened_at = now()
    where id = ${projectId}
  `;
}

export async function closeDatabase() {
  await sql.end();
}
