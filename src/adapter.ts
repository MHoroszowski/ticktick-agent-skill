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
 *
 * ────── Nested subtasks (parentId) — naming and approach ──────
 *
 * TickTick has TWO unrelated "subtask" concepts:
 *   1. CHECKLIST ITEMS — lightweight bullets stored in `task.items[]`. The
 *      library exposes these via `client.tasks.createSubtask()` (misleading
 *      name — it patches `items[]`). The adapter wraps them with
 *      `addChecklistItem`/`completeChecklistItem`/`deleteChecklistItem`.
 *   2. NESTED SUBTASKS — real child tasks with their own due dates,
 *      priorities, tags, etc., linked to a parent via `task.parentId`.
 *      The library does NOT expose these at all.
 *
 * To avoid name collisions and confusion, the adapter:
 *   - Does NOT add a `createSubtaskTask()` method. Instead, `createTask()`
 *     accepts an optional `draft.parentId`. If set, the resulting task is
 *     a child of that parent. This is the only API path TickTick supports
 *     for creating a child — POST /api/v2/task with parentId in the body.
 *   - Adds three dedicated methods for the existing-task lifecycle:
 *       indentTask(taskId, projectId, newParentId)
 *       promoteTask(taskId, projectId)
 *       listSubtasks(parentTaskId)
 *   - Routes indent/promote/re-parent through POST /api/v2/batch/taskParent
 *     with body `[{taskId, parentId, projectId}]` (parentId: null = promote).
 *     This is the ONLY endpoint that mutates parentId on an existing task —
 *     POST /api/v2/task/{id} silently no-ops parentId changes.
 *   - Does NOT touch the library's `createSubtask()` method or the
 *     `addChecklistItem` adapter wrapper.
 *
 * Discovery notes for the parentId endpoints live in
 * scripts/probe-nested-subtasks*.ts (5 round-trip probes against live API).
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
  TickTickTaskDraft,
  TickTickTaskUpdate,
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

/**
 * A member of a shared project. Discovered via `GET /api/v2/project/{id}/users`.
 * Minimal shape — the raw API returns more fields (avatarUrl, userCode, etc.)
 * but we only surface what's useful for identification and assignment.
 */
export type Member = {
  readonly userId: number;
  readonly displayName: string | null;
  readonly username: string | null;
  readonly isOwner: boolean;
  readonly permission: 'read' | 'write' | 'comment' | string;
  readonly acceptedShare: boolean;
};

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
  /**
   * Shared-project assignment. Numeric TickTick userId. Present on tasks in
   * shared projects; null on unassigned tasks. The underlying library strips
   * this field from its typed response — we recover it via a raw cast.
   */
  readonly assignee: number | null;
  /**
   * Numeric TickTick userId of whoever originally created the task. Read-only;
   * surfaced for context ("who put this on the list?") in shared lists.
   */
  readonly creator: number | null;
  /**
   * Project section / kanban column. The library has `TickTickTaskItem`
   * references but strips columnId from its typed Task; we recover it via
   * a raw cast. Null when the task is unsectioned.
   */
  readonly columnId: string | null;
  /**
   * Nested-subtask parent id. Null/undefined for top-level tasks. The
   * library's TickTickTask type strips this field; we recover it via a
   * raw cast. To create a child task pass `parentId` in the create draft;
   * to re-parent or unparent an existing task use `indentTask()` or
   * `promoteTask()` (PATCH-style updates do NOT mutate parentId — see
   * the adapter header comment).
   */
  readonly parentId: string | null;
  /**
   * Child task ids when this task is a parent. Hydration mirror of the
   * `childIds[]` array on the raw API response. Often empty/null on
   * freshly-created relationships due to server-side eventual consistency
   * — the AUTHORITATIVE field for tree reconstruction is `child.parentId`,
   * not `parent.childIds`. Use `listSubtasks(parentId)` to get a clean
   * list of children regardless of mirror state.
   */
  readonly childIds: readonly string[];
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

/**
 * A section (kanban column) within a project. Fetched via
 * `GET /api/v2/column?from=0&projectId=X`. Note: the TickTick server-side
 * projectId filter is currently ignored (returns all columns across all
 * projects), so the adapter filters client-side. The underlying library's
 * `projects.listColumns()` also wraps the response as `{update: Column[]}`
 * instead of returning a bare array — the adapter unwraps both shapes.
 * Upstream fix tracked in PR #35 on jaeyeonling/ticktick-client.
 */
export type Section = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder: number | null;
};

export type User = {
  /**
   * Numeric TickTick userId. Comes from `/api/v2/user/status` (not
   * `/user/profile`, which omits it). The status endpoint returns it as a
   * string like "115368611" which we parse into a number for easy comparison
   * with task.assignee / task.creator fields.
   */
  readonly userId: number | null;
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
  /**
   * Assign to a specific shared-project member by userId. Pass null to
   * explicitly clear assignment. Omit to leave untouched (on update) or
   * default to unassigned (on create).
   */
  readonly assignee?: number | null;
  /** Section / kanban column id within the parent project. */
  readonly columnId?: string | null;
  /**
   * Optional parent task id. When set, the created task becomes a child
   * (nested subtask) of the given parent. Project is inferred from the
   * parent if `projectId` is omitted, but callers should still pass
   * `projectId` explicitly — the resolution is the caller's job, not the
   * adapter's. Do NOT use this on `updateTask` — PATCH-style updates do
   * not mutate parentId; use `indentTask()` / `promoteTask()` instead.
   */
  readonly parentId?: string | null;
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
  /**
   * If set, only return tasks whose `parentId` matches this value. Useful
   * for listing the direct children of a parent task. Mutually exclusive
   * with `topLevelOnly`.
   */
  readonly parentId?: string;
  /**
   * If true, only return tasks with no parent (top-level tasks). Mutually
   * exclusive with `parentId`.
   */
  readonly topLevelOnly?: boolean;
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

  // Shared-project members. Hits the /api/v2/project/{id}/users endpoint
  // that the jaeyeonling library doesn't yet expose. Returns self only
  // for non-shared projects.
  listMembers(projectId: string): Promise<readonly Member[]>;
  /**
   * Revoke a user's access to a shared project.
   *
   * Hits `DELETE /api/v2/project/{projectId}/share/{userId}` — discovered
   * by probing in April 2026; jaeyeonling/ticktick-client doesn't expose
   * it. The endpoint is idempotent: removing a non-member, a bogus userId,
   * or even the project owner returns 2xx with no body. Callers that need
   * removal-happened confirmation should diff `listMembers` before/after.
   *
   * Note: the server accepts a DELETE on the project owner's userId
   * silently (no-op) rather than 400-ing. Don't rely on it to protect you
   * from removing yourself — validate in the caller if that matters.
   */
  removeMember(projectId: string, userId: number): Promise<void>;

  // Tags
  listTags(): Promise<readonly Tag[]>;

  // Sections (kanban columns) within a project. Bypasses the library's
  // buggy listColumns() method which wraps responses and doesn't filter
  // by projectId server-side — we hit /api/v2/column directly and filter
  // client-side.
  listSections(projectId: string): Promise<readonly Section[]>;

  // Nested subtasks (parentId-based child tasks). Distinct from checklist
  // items — see the adapter's header comment for the full naming policy.
  /**
   * Re-parent an existing task to a new parent (indent gesture). Hits
   * POST /api/v2/batch/taskParent which is the only endpoint that mutates
   * parentId on an existing task.
   */
  indentTask(taskId: string, projectId: string, newParentId: string): Promise<void>;
  /**
   * Promote an existing child task to top-level (clear its parentId).
   * Same endpoint as indentTask but with parentId: null.
   */
  promoteTask(taskId: string, projectId: string): Promise<void>;
  /**
   * List the direct children of a parent task. Implementation: full task
   * list filtered client-side by `task.parentId === parentTaskId`. The raw
   * `parent.childIds[]` mirror is unreliable on freshly-created
   * relationships (server-side eventual consistency), so we never depend
   * on it.
   */
  listSubtasks(parentTaskId: string): Promise<readonly Task[]>;

  // Checklist items (v1: what jaeyeonling/ticktick-client supports).
  // These are the lightweight `task.items[]` bullets, NOT nested subtasks.
  // For true nested subtasks (parentId-based) see indentTask/promoteTask
  // above and the `parentId` field on the Task and TaskDraft types.
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
    // Profile has displayName/email but lacks the numeric userId.
    // Status has the numeric userId but lacks displayName.
    // Call both in parallel and merge.
    const [profile, status] = await Promise.all([
      this.#client.user.getProfile(),
      this.#client.user.getStatus(),
    ]);
    return normalizeUser(profile, status);
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

    if (filters?.parentId !== undefined && filters.topLevelOnly === true) {
      throw new AdapterError(
        'VALIDATION',
        'listTasks: parentId and topLevelOnly are mutually exclusive — pass one or the other, not both.',
      );
    }

    if (filters?.parentId !== undefined) {
      const pid = filters.parentId;
      tasks = tasks.filter((t) => t.parentId === pid);
    } else if (filters?.topLevelOnly === true) {
      tasks = tasks.filter((t) => t.parentId === null);
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
    // The library's TickTickTaskDraft type doesn't include `assignee` or
    // `columnId`, but the underlying POST /api/v2/task endpoint accepts
    // both. We add them via a cast — the library passes the body through
    // verbatim so TickTick receives the extra fields.
    const rawDraft = {
      title: draft.title,
      ...(draft.projectId !== undefined && { projectId: draft.projectId }),
      ...(draft.content !== undefined && { content: draft.content }),
      ...(draft.priority !== undefined && { priority: denormalizePriority(draft.priority) }),
      ...(draft.startDate !== undefined && { startDate: draft.startDate }),
      ...(draft.dueDate !== undefined && { dueDate: draft.dueDate }),
      ...(draft.isAllDay !== undefined && { isAllDay: draft.isAllDay }),
      ...(draft.tags !== undefined && { tags: draft.tags }),
      ...(draft.repeatFlag !== undefined && { repeatFlag: draft.repeatFlag }),
      ...(draft.assignee !== undefined && { assignee: draft.assignee }),
      ...(draft.columnId !== undefined && { columnId: draft.columnId }),
      // parentId is only persisted at CREATE time. Server silently no-ops
      // parentId mutations sent via PATCH (POST /api/v2/task/{id}). To
      // re-parent an existing task use indentTask()/promoteTask().
      ...(draft.parentId !== undefined && { parentId: draft.parentId }),
    };
    // Cast through unknown because the library's TickTickTaskDraft type
    // doesn't include assignee/columnId/parentId — we're intentionally
    // bypassing the typed surface and forwarding the extra fields verbatim
    // to POST /api/v2/task, which accepts and persists them.
    const created = await this.#client.tasks.create(rawDraft as unknown as TickTickTaskDraft);
    return normalizeTask(created);
  }

  async updateTask(patch: TaskPatch): Promise<Task> {
    // The library's tasks.update() is REPLACE semantics for every field it
    // forwards — fields not in the body get cleared by the server. To
    // preserve parentId across an update (so updating a child task's title
    // doesn't accidentally orphan it), we look up the existing task and
    // forward its current parentId verbatim unless the caller explicitly
    // changed it. Note: the public TaskDraft type intentionally does NOT
    // expose parentId on update — re-parenting goes through indentTask /
    // promoteTask. This re-fetch is purely defensive.
    let existingParentId: string | null = null;
    try {
      const existing = await this.getTask(patch.id);
      if (existing) existingParentId = existing.parentId;
    } catch {
      // If the lookup fails (e.g. task list call errors), fall through —
      // the update still goes through with whatever fields the caller set.
    }

    const rawPatch = {
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
      ...(patch.assignee !== undefined && { assignee: patch.assignee }),
      ...(patch.columnId !== undefined && { columnId: patch.columnId }),
      // Preserve parentId across update so callers that just want to
      // change a child's title don't accidentally promote it.
      ...(existingParentId !== null && { parentId: existingParentId }),
    };
    const updated = await this.#client.tasks.update(rawPatch as unknown as TickTickTaskUpdate);
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

  // ── Nested subtasks (parentId) ──

  async indentTask(
    taskId: string,
    projectId: string,
    newParentId: string,
  ): Promise<void> {
    if (taskId === newParentId) {
      throw new AdapterError(
        'VALIDATION',
        `indentTask: cannot make a task its own parent (taskId === newParentId === ${taskId})`,
      );
    }
    // The server silently accepts non-existent parentIds (200 with id2error
    // {<bogus>: "NOT_EXISTED"} but still mutates the child to point at the
    // bogus id). Verify the parent exists client-side before issuing the
    // mutation.
    const all = await this.#client.tasks.list();
    const parent = all.find((t) => t.id === newParentId);
    if (!parent) {
      throw new AdapterError(
        'NOT_FOUND',
        `indentTask: parent task ${newParentId} not found. Cannot reparent ${taskId}.`,
      );
    }
    const child = all.find((t) => t.id === taskId);
    if (!child) {
      throw new AdapterError(
        'NOT_FOUND',
        `indentTask: task ${taskId} not found.`,
      );
    }
    await this.#mutateParent(taskId, projectId, newParentId);
  }

  async promoteTask(taskId: string, projectId: string): Promise<void> {
    const all = await this.#client.tasks.list();
    const child = all.find((t) => t.id === taskId);
    if (!child) {
      throw new AdapterError('NOT_FOUND', `promoteTask: task ${taskId} not found.`);
    }
    await this.#mutateParent(taskId, projectId, null);
  }

  async listSubtasks(parentTaskId: string): Promise<readonly Task[]> {
    // Reuse listTasks with status='all' so we surface child tasks regardless
    // of completion state — callers that only want open children can chain
    // their own .filter().
    return this.listTasks({ parentId: parentTaskId, status: 'all' });
  }

  /**
   * Internal: hits POST /api/v2/batch/taskParent. The ONLY endpoint the
   * TickTick v2 API exposes for mutating parentId on an existing task.
   *
   * Body shape (verified against live API, April 2026):
   *   [{taskId, parentId, projectId}]    ← bare array, not wrapped
   *
   * Notes:
   *   - `parentId: null` clears the parent (promote).
   *   - `projectId` MUST be the CHILD's project. Passing the parent's
   *     project for a cross-project relationship yields `id2error:
   *     {<childId>: "EXISTED"}` and the mutation is rejected.
   *   - The response shape is `{id2etag, id2error}`. We surface
   *     `id2error` as a thrown AdapterError so callers know about
   *     `NOT_EXISTED` parents that the server otherwise silently
   *     accepts. We pre-verify in indentTask, so this is defence in
   *     depth.
   */
  async #mutateParent(
    taskId: string,
    projectId: string,
    parentId: string | null,
  ): Promise<void> {
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    type ParentResponse = {
      readonly id2etag?: Readonly<Record<string, unknown>>;
      readonly id2error?: Readonly<Record<string, string>>;
    };
    const response = await client.request<ParentResponse>(
      'POST',
      '/api/v2/batch/taskParent',
      [{ taskId, parentId, projectId }],
    );
    const errors = response.id2error ?? {};
    const errorIds = Object.keys(errors);
    if (errorIds.length > 0) {
      const detail = errorIds.map((k) => `${k}: ${errors[k]}`).join('; ');
      throw new AdapterError(
        'VALIDATION',
        `taskParent endpoint returned errors: ${detail}`,
      );
    }
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

  // ── Members (shared projects) ──
  async listMembers(projectId: string): Promise<readonly Member[]> {
    // Hit /api/v2/project/{id}/users directly via the library's internal
    // request() method. The jaeyeonling library doesn't yet expose this
    // endpoint. Discovered April 2026 by probing candidate URL patterns.
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    const raw = await client.request<readonly RawMember[]>(
      'GET',
      `/api/v2/project/${projectId}/users`,
    );
    return raw.map(normalizeMember);
  }

  async removeMember(projectId: string, userId: number): Promise<void> {
    // DELETE /api/v2/project/{projectId}/share/{userId}
    //
    // Discovered April 2026 by probing 12 candidate URL patterns against
    // the /api/v2/project/{PID}/... namespace with a fake userId — this is
    // the only pattern that returned 2xx instead of 404/405. Verified as a
    // no-op (the member list is unchanged) when called with the owner's
    // userId, a bogus userId, or a bogus projectId — the server silently
    // accepts and returns an empty body in all idempotent cases.
    //
    // The library's request() helper throws TickTickApiError on non-2xx,
    // so we just let that bubble up — mapLibraryError will turn it into a
    // NOT_FOUND / NETWORK AdapterError downstream.
    if (!Number.isFinite(userId) || !Number.isInteger(userId)) {
      throw new AdapterError(
        'VALIDATION',
        `removeMember: userId must be a finite integer, got ${String(userId)}`,
      );
    }
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    await client.request<void>(
      'DELETE',
      `/api/v2/project/${projectId}/share/${userId}`,
    );
  }

  // ── Tags ──
  async listTags(): Promise<readonly Tag[]> {
    const tags = await this.#client.tags.list();
    return tags.map(normalizeTag);
  }

  // ── Sections (kanban columns) ──
  async listSections(projectId: string): Promise<readonly Section[]> {
    // The library's `client.projects.listColumns(projectId)` has two bugs:
    //   1. Returns `{update: Column[]}` wrapped instead of a bare array.
    //   2. Server-side `projectId` filter is ignored — returns every
    //      column across every project.
    // Until the upstream PR (jaeyeonling/ticktick-client#35) merges we hit
    // `/api/v2/column` directly and filter client-side.
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    const raw = await client.request<unknown>(
      'GET',
      `/api/v2/column?from=0&projectId=${projectId}`,
    );
    const columns: readonly RawColumn[] = Array.isArray(raw)
      ? (raw as readonly RawColumn[])
      : ((raw as { update?: readonly unknown[] }).update as readonly RawColumn[]) ?? [];
    return columns
      .filter((c) => c.projectId === projectId)
      .map(normalizeSection);
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
  // The library's typed TickTickTask strips several fields that exist in
  // the raw API response. Cast to any to recover them.
  const r = raw as TickTickTask & {
    assignee?: number | null;
    creator?: number | null;
    columnId?: string | null;
    parentId?: string | null;
    childIds?: readonly string[] | null;
  };
  // parentId comes back as either a string, null, or missing depending on
  // whether the task is a child. We normalize all three to either a
  // non-empty string or null.
  const rawParentId =
    typeof r.parentId === 'string' && r.parentId.length > 0 ? r.parentId : null;
  // childIds is a hydration mirror — often missing on freshly-created
  // relationships. We normalize missing/null to an empty array so callers
  // can iterate without checking.
  const rawChildIds = Array.isArray(r.childIds) ? r.childIds : [];
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    status: normalizeTaskStatus(r.status),
    priority: normalizePriority(r.priority ?? 0),
    content: r.content ?? null,
    tags: r.tags ?? [],
    startDate: r.startDate ?? null,
    dueDate: r.dueDate ?? null,
    isAllDay: r.isAllDay ?? null,
    completedAt: r.completedTime ?? null,
    pinnedAt: r.pinnedTime ?? null,
    repeatFlag: r.repeatFlag ?? null,
    items: (r.items ?? []).map(normalizeItem),
    assignee: typeof r.assignee === 'number' ? r.assignee : null,
    creator: typeof r.creator === 'number' ? r.creator : null,
    columnId: r.columnId ?? null,
    parentId: rawParentId,
    childIds: rawChildIds,
  };
}

// Raw shape returned by GET /api/v2/project/{id}/users. Only the fields
// we actually use; the endpoint returns more (avatarUrl, userCode, etc).
type RawMember = {
  readonly userId: number;
  readonly displayName?: string | null;
  readonly username?: string | null;
  readonly isOwner?: boolean;
  readonly permission?: string;
  readonly acceptStatus?: number;
};

function normalizeMember(raw: RawMember): Member {
  return {
    userId: raw.userId,
    displayName: raw.displayName ?? null,
    username: raw.username ?? null,
    isOwner: raw.isOwner === true,
    permission: raw.permission ?? 'read',
    acceptedShare: raw.acceptStatus === 1,
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

// Raw shape returned by GET /api/v2/column?from=0&projectId=X. Only the
// fields we consume — the endpoint returns more (etag, deleted, type, etc).
type RawColumn = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly sortOrder?: number;
};

function normalizeSection(raw: RawColumn): Section {
  return {
    id: raw.id,
    projectId: raw.projectId,
    name: raw.name,
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : null,
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

function normalizeUser(
  profile: TickTickUserProfile,
  status?: { readonly userId?: string | number; readonly username?: string } | undefined,
): User {
  const rawUserId = status?.userId ?? profile.userId;
  const userId =
    typeof rawUserId === 'number'
      ? rawUserId
      : typeof rawUserId === 'string' && /^\d+$/.test(rawUserId)
        ? Number.parseInt(rawUserId, 10)
        : null;
  return {
    userId,
    username: profile.username ?? status?.username ?? null,
    email: profile.email ?? null,
    displayName: profile.displayName ?? profile.name ?? null,
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
