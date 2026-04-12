/**
 * TickTick adapter — the ONLY file that imports from ticktick-client.
 *
 * If the upstream library ever dies, is compromised, or a better library
 * appears, rewriting this file is the only code change needed. Everything
 * else in the CLI talks to the `TickTickAdapter` interface below, not to
 * the library directly.
 *
 * Normalized types (Task, Project, Tag, ChecklistItem) insulate callers
 * from upstream field renames.
 */

import {
  TickTickClient,
  FileSessionStore,
  TickTickAuthError,
  TickTickApiError,
  TickTickError,
} from 'ticktick-client';
import type {
  TickTickTask,
  TickTickProject,
  TickTickTag,
  TickTickTaskItem,
  TickTickUserProfile,
  TickTickTaskPriority,
} from 'ticktick-client';

// ──────────────────────────────────────────────────────────────────
// Normalized types — the public surface of the adapter.
// ──────────────────────────────────────────────────────────────────

export type TaskStatus = 'open' | 'completed' | 'abandoned';
export type TaskPriorityName = 'none' | 'low' | 'medium' | 'high';

export type ChecklistItem = {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
  readonly completedAt: string | null;
  readonly sortOrder: number | null;
};

export type Task = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriorityName;
  readonly content: string | null;
  readonly tags: readonly string[];
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly isAllDay: boolean | null;
  readonly completedAt: string | null;
  readonly pinnedAt: string | null;
  readonly repeatFlag: string | null;
  readonly items: readonly ChecklistItem[];
};

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly kind: string | null;
  readonly closed: boolean;
};

export type Tag = {
  readonly name: string;
  readonly label: string | null;
  readonly color: string | null;
  readonly parent: string | null;
};

export type User = {
  readonly userId: string | null;
  readonly username: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
};

export type TaskDraft = {
  readonly title: string;
  readonly projectId?: string;
  readonly content?: string;
  readonly priority?: TaskPriorityName;
  readonly startDate?: string | null;
  readonly dueDate?: string | null;
  readonly isAllDay?: boolean;
  readonly tags?: readonly string[];
  readonly repeatFlag?: string | null;
};

export type TaskPatch = TaskDraft & {
  readonly id: string;
  readonly projectId: string;
};

export type TaskListFilters = {
  readonly projectId?: string;
  readonly status?: TaskStatus | 'all';
  readonly tag?: string;
  readonly due?: 'today' | 'overdue' | 'week';
  readonly limit?: number;
};

export type MoveResult = {
  readonly task: Task;
  readonly previousId: string;
};

export type ChecklistItemDraft = {
  readonly title: string;
  readonly sortOrder?: number;
};

// ──────────────────────────────────────────────────────────────────
// Adapter interface — what the rest of the CLI talks to.
// ──────────────────────────────────────────────────────────────────

export interface TickTickAdapter {
  // Auth / session
  authenticate(): Promise<User>;
  isAuthenticated(): Promise<boolean>;
  logout(): Promise<void>;
  getUser(): Promise<User>;

  // Tasks
  listTasks(filters?: TaskListFilters): Promise<readonly Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  createTask(draft: TaskDraft): Promise<Task>;
  updateTask(patch: TaskPatch): Promise<Task>;
  completeTask(taskId: string, projectId: string): Promise<void>;
  deleteTask(taskId: string, projectId: string): Promise<void>;
  moveTask(taskId: string, fromProjectId: string, toProjectId: string): Promise<MoveResult>;

  // Projects (lists)
  listProjects(): Promise<readonly Project[]>;
  getProject(idOrName: string): Promise<Project | null>;

  // Tags
  listTags(): Promise<readonly Tag[]>;

  // Checklist items (v1: what jaeyeonling/ticktick-client supports).
  // NOTE: Nested subtasks (parentId-based child tasks) are NOT yet supported.
  // Tracked as follow-up — see README.
  listChecklistItems(taskId: string): Promise<readonly ChecklistItem[]>;
  addChecklistItem(taskId: string, projectId: string, draft: ChecklistItemDraft): Promise<Task>;
  completeChecklistItem(taskId: string, projectId: string, itemId: string): Promise<Task>;
  deleteChecklistItem(taskId: string, projectId: string, itemId: string): Promise<Task>;
}

// ──────────────────────────────────────────────────────────────────
// Implementation over ticktick-client.
// ──────────────────────────────────────────────────────────────────

export type AdapterOptions = {
  readonly username: string;
  readonly password: string;
  readonly sessionFilePath: string;
  readonly timeZone?: string;
};

export class TickTickClientAdapter implements TickTickAdapter {
  readonly #client: TickTickClient;

  constructor(options: AdapterOptions) {
    this.#client = new TickTickClient({
      credentials: { username: options.username, password: options.password },
      sessionStore: new FileSessionStore(options.sessionFilePath),
      ...(options.timeZone && { timeZone: options.timeZone }),
    });
  }

  // ── Auth ──
  async authenticate(): Promise<User> {
    await this.#client.login();
    return this.getUser();
  }

  async isAuthenticated(): Promise<boolean> {
    return this.#client.isAuthenticated();
  }

  async logout(): Promise<void> {
    await this.#client.logout();
  }

  async getUser(): Promise<User> {
    const profile = await this.#client.user.getProfile();
    return normalizeUser(profile);
  }

  // ── Tasks ──
  async listTasks(filters?: TaskListFilters): Promise<readonly Task[]> {
    const all = await this.#client.tasks.list();
    let tasks = all.map(normalizeTask);

    if (filters?.projectId !== undefined) {
      tasks = tasks.filter((t) => t.projectId === filters.projectId);
    }

    const wanted = filters?.status ?? 'open';
    if (wanted !== 'all') {
      tasks = tasks.filter((t) => t.status === wanted);
    }

    if (filters?.tag !== undefined) {
      const tag = filters.tag.toLowerCase();
      tasks = tasks.filter((t) => t.tags.some((x) => x.toLowerCase() === tag));
    }

    if (filters?.due !== undefined) {
      tasks = tasks.filter((t) => matchesDueFilter(t, filters.due!));
    }

    if (filters?.limit !== undefined && filters.limit >= 0) {
      tasks = tasks.slice(0, filters.limit);
    }

    return tasks;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const all = await this.#client.tasks.list();
    const match = all.find((t) => t.id === taskId);
    return match ? normalizeTask(match) : null;
  }

  async createTask(draft: TaskDraft): Promise<Task> {
    const created = await this.#client.tasks.create({
      title: draft.title,
      ...(draft.projectId !== undefined && { projectId: draft.projectId }),
      ...(draft.content !== undefined && { content: draft.content }),
      ...(draft.priority !== undefined && { priority: denormalizePriority(draft.priority) }),
      ...(draft.startDate !== undefined && { startDate: draft.startDate }),
      ...(draft.dueDate !== undefined && { dueDate: draft.dueDate }),
      ...(draft.isAllDay !== undefined && { isAllDay: draft.isAllDay }),
      ...(draft.tags !== undefined && { tags: draft.tags }),
      ...(draft.repeatFlag !== undefined && { repeatFlag: draft.repeatFlag }),
    });
    return normalizeTask(created);
  }

  async updateTask(patch: TaskPatch): Promise<Task> {
    const updated = await this.#client.tasks.update({
      id: patch.id,
      projectId: patch.projectId,
      title: patch.title,
      ...(patch.content !== undefined && { content: patch.content }),
      ...(patch.priority !== undefined && { priority: denormalizePriority(patch.priority) }),
      ...(patch.startDate !== undefined && { startDate: patch.startDate }),
      ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
      ...(patch.isAllDay !== undefined && { isAllDay: patch.isAllDay }),
      ...(patch.tags !== undefined && { tags: patch.tags }),
      ...(patch.repeatFlag !== undefined && { repeatFlag: patch.repeatFlag }),
    });
    return normalizeTask(updated);
  }

  async completeTask(taskId: string, projectId: string): Promise<void> {
    await this.#client.tasks.complete(projectId, taskId);
  }

  async deleteTask(taskId: string, projectId: string): Promise<void> {
    await this.#client.tasks.delete(projectId, taskId);
  }

  async moveTask(
    taskId: string,
    fromProjectId: string,
    toProjectId: string,
  ): Promise<MoveResult> {
    const result = await this.#client.tasks.move({ taskId, fromProjectId, toProjectId });
    return { task: normalizeTask(result.task), previousId: result.previousId };
  }

  // ── Projects ──
  async listProjects(): Promise<readonly Project[]> {
    const projects = await this.#client.projects.list();
    return projects.map(normalizeProject);
  }

  async getProject(idOrName: string): Promise<Project | null> {
    const projects = await this.listProjects();
    const byId = projects.find((p) => p.id === idOrName);
    if (byId) return byId;
    const lc = idOrName.toLowerCase();
    return projects.find((p) => p.name.toLowerCase() === lc) ?? null;
  }

  // ── Tags ──
  async listTags(): Promise<readonly Tag[]> {
    const tags = await this.#client.tags.list();
    return tags.map(normalizeTag);
  }

  // ── Checklist items ──
  async listChecklistItems(taskId: string): Promise<readonly ChecklistItem[]> {
    const task = await this.getTask(taskId);
    return task?.items ?? [];
  }

  async addChecklistItem(
    taskId: string,
    projectId: string,
    draft: ChecklistItemDraft,
  ): Promise<Task> {
    void projectId; // library currently infers projectId from the task itself
    const updated = await this.#client.tasks.createSubtask(taskId, projectId, {
      title: draft.title,
      ...(draft.sortOrder !== undefined && { sortOrder: draft.sortOrder }),
    });
    return normalizeTask(updated);
  }

  async completeChecklistItem(
    taskId: string,
    projectId: string,
    itemId: string,
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
    const items = task.items.map((item) =>
      item.id === itemId
        ? {
            id: item.id,
            title: item.title,
            status: 2 as const,
            completedTime: new Date().toISOString(),
            sortOrder: item.sortOrder ?? undefined,
          }
        : {
            id: item.id,
            title: item.title,
            status: (item.completed ? 2 : 0) as 0 | 2,
            completedTime: item.completedAt ?? undefined,
            sortOrder: item.sortOrder ?? undefined,
          },
    );
    return this.#patchItems(task, projectId, items);
  }

  async deleteChecklistItem(
    taskId: string,
    projectId: string,
    itemId: string,
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
    const items = task.items
      .filter((item) => item.id !== itemId)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: (item.completed ? 2 : 0) as 0 | 2,
        completedTime: item.completedAt ?? undefined,
        sortOrder: item.sortOrder ?? undefined,
      }));
    return this.#patchItems(task, projectId, items);
  }

  async #patchItems(
    task: Task,
    projectId: string,
    items: ReadonlyArray<{
      id: string;
      title: string;
      status: 0 | 2;
      completedTime?: string;
      sortOrder?: number;
    }>,
  ): Promise<Task> {
    // The library patches a task by POSTing the task doc back. We construct
    // the minimal update here and drop through `client.request` indirectly
    // by going through update() with a passthrough `items` field.
    const updated = await this.#client['client' as never] as never;
    void updated;
    // Fallback: use TickTickClient.request directly via a cast — update()
    // only accepts TaskDraft fields, not `items`. This is an adapter-level
    // escape hatch needed until the library exposes a checklist-only patch.
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    const patched = await client.request<TickTickTask>(
      'POST',
      `/api/v2/task/${task.id}`,
      {
        id: task.id,
        projectId,
        items,
      },
    );
    return normalizeTask(patched);
  }
}

// ──────────────────────────────────────────────────────────────────
// Normalizers
// ──────────────────────────────────────────────────────────────────

function normalizeTask(raw: TickTickTask): Task {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    status: normalizeTaskStatus(raw.status),
    priority: normalizePriority(raw.priority ?? 0),
    content: raw.content ?? null,
    tags: raw.tags ?? [],
    startDate: raw.startDate ?? null,
    dueDate: raw.dueDate ?? null,
    isAllDay: raw.isAllDay ?? null,
    completedAt: raw.completedTime ?? null,
    pinnedAt: raw.pinnedTime ?? null,
    repeatFlag: raw.repeatFlag ?? null,
    items: (raw.items ?? []).map(normalizeItem),
  };
}

function normalizeItem(raw: TickTickTaskItem): ChecklistItem {
  return {
    id: raw.id,
    title: raw.title,
    completed: raw.status === 2,
    completedAt: raw.completedTime ?? null,
    sortOrder: raw.sortOrder ?? null,
  };
}

function normalizeProject(raw: TickTickProject): Project {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color ?? null,
    kind: raw.kind ?? null,
    closed: raw.closed === true,
  };
}

function normalizeTag(raw: TickTickTag): Tag {
  return {
    name: raw.name,
    label: raw.label ?? null,
    color: raw.color ?? null,
    parent: raw.parent ?? null,
  };
}

function normalizeUser(raw: TickTickUserProfile): User {
  return {
    userId: raw.userId ?? null,
    username: raw.username ?? null,
    email: raw.email ?? null,
    displayName: raw.displayName ?? raw.name ?? null,
  };
}

function normalizeTaskStatus(raw: number): TaskStatus {
  if (raw === 2) return 'completed';
  if (raw === -1) return 'abandoned';
  return 'open';
}

function normalizePriority(raw: TickTickTaskPriority | number | undefined): TaskPriorityName {
  switch (raw) {
    case 5:
      return 'high';
    case 3:
      return 'medium';
    case 1:
      return 'low';
    default:
      return 'none';
  }
}

function denormalizePriority(name: TaskPriorityName): TickTickTaskPriority {
  switch (name) {
    case 'high':
      return 5;
    case 'medium':
      return 3;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function matchesDueFilter(task: Task, due: 'today' | 'overdue' | 'week'): boolean {
  if (!task.dueDate) return false;
  const dueMs = Date.parse(task.dueDate);
  if (Number.isNaN(dueMs)) return false;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  if (due === 'overdue') return dueMs < now;
  if (due === 'today') {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    return dueMs >= startOfToday.getTime() && dueMs < endOfToday.getTime();
  }
  // week: next 7 days from now
  return dueMs >= now && dueMs <= now + 7 * dayMs;
}

// ──────────────────────────────────────────────────────────────────
// Adapter-level errors — a thin layer over the library's errors.
// ──────────────────────────────────────────────────────────────────

export type AdapterErrorCode =
  | 'AUTH_MISSING_CREDS'
  | 'AUTH_FAILED'
  | 'AUTH_EXPIRED'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'VALIDATION'
  | 'UNEXPECTED';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(code: AdapterErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Map a raw error from ticktick-client into our normalized AdapterError.
 * Used by commands when they catch errors from adapter method calls.
 */
export function mapLibraryError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;

  if (err instanceof TickTickAuthError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('no credentials') || msg.includes('no active session')) {
      return new AdapterError('AUTH_MISSING_CREDS', err.message, { cause: err });
    }
    if (msg.includes('re-authentication')) {
      return new AdapterError('AUTH_EXPIRED', err.message, { retryable: true, cause: err });
    }
    return new AdapterError('AUTH_FAILED', err.message, { cause: err });
  }

  if (err instanceof TickTickApiError) {
    if (err.status === 429) {
      return new AdapterError('RATE_LIMITED', err.message, { retryable: true, cause: err });
    }
    if (err.status === 404) {
      return new AdapterError('NOT_FOUND', err.message, { cause: err });
    }
    if (err.status >= 500 && err.status < 600) {
      return new AdapterError('NETWORK', err.message, { retryable: true, cause: err });
    }
    return new AdapterError('NETWORK', err.message, { cause: err });
  }

  if (err instanceof TickTickError) {
    return new AdapterError('UNEXPECTED', err.message, { cause: err });
  }

  if (err instanceof Error) {
    return new AdapterError('UNEXPECTED', err.message, { cause: err });
  }

  return new AdapterError('UNEXPECTED', String(err), { cause: err });
}
