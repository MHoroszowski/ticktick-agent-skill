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

import { randomBytes } from 'node:crypto';
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
  TickTickProjectDraft,
  TickTickTag,
  TickTickTagDraft,
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
   * End date for a recurring task, ISO 8601. The library's TickTickTaskDraft
   * type already includes this field — we pass it straight through.
   */
  readonly repeatEndDate?: string | null;
  /**
   * Assign to a specific shared-project member by userId. Pass null to
   * explicitly clear assignment. Omit to leave untouched (on update) or
   * default to unassigned (on create).
   */
  readonly assignee?: number | null;
  /** Section / kanban column id within the parent project. */
  readonly columnId?: string | null;
};

export type TaskPatch = TaskDraft & {
  readonly id: string;
  readonly projectId: string;
};

/**
 * Smart-list due-date filters. Server has no such concept — every value
 * here is implemented client-side over `client.tasks.list()`.
 *
 * - `today`     dueDate falls within the current local day
 * - `tomorrow`  dueDate falls within the next local day
 * - `overdue`   dueDate is strictly before now
 * - `week`      dueDate is within the next 7 days from now (legacy alias)
 * - `next7days` synonym for `week`, matches the natural-language workflow
 * - `none`      task has no dueDate at all
 */
export type DueFilter = 'today' | 'tomorrow' | 'overdue' | 'week' | 'next7days' | 'none';

export type TaskListFilters = {
  readonly projectId?: string;
  readonly status?: TaskStatus | 'all';
  readonly tag?: string;
  readonly due?: DueFilter;
  readonly pinned?: boolean;
  readonly limit?: number;
  /** Filter to tasks whose `columnId` matches this section id. */
  readonly sectionId?: string;
  /**
   * Filter to tasks whose numeric `assignee` matches. Null means "unassigned
   * only" (tasks with no assignee). Omit to not filter by assignee.
   */
  readonly assignee?: number | null;
};

/**
 * Options for the unified completed-task lookup. Two mutually-exclusive
 * shapes:
 *   - `{ projectId?, limit? }`  → uses `tasks.iterateCompleted` (paginated
 *     iterator, optionally scoped to a single project)
 *   - `{ from, to, limit? }`    → uses `statistics.listCompleted` (closed
 *     date range across all projects)
 */
export type CompletedTaskOptions = {
  readonly projectId?: string;
  readonly limit?: number;
  readonly from?: string;
  readonly to?: string;
};

export type TagDraft = {
  /** Unique slug, lowercase. Used as the stable identifier in the API. */
  readonly name: string;
  /** Display label. Defaults to `name` if omitted. */
  readonly label?: string;
  /** `#RRGGBB` hex color. */
  readonly color?: string;
  /** Parent tag name, for hierarchical tags. Pass null to clear on update. */
  readonly parent?: string | null;
  readonly sortOrder?: number;
};

export type ProjectDraft = {
  readonly name: string;
  readonly color?: string;
  readonly kind?: 'TASK' | 'NOTE';
  readonly viewMode?: 'list' | 'kanban' | 'timeline';
};

export type ProjectPatch = ProjectDraft & { readonly id: string };

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

  // Tasks — pin / unpin / restore
  pinTask(taskId: string, projectId: string, date?: Date): Promise<void>;
  unpinTask(taskId: string, projectId: string): Promise<void>;
  restoreTask(taskId: string, projectId: string): Promise<void>;

  // Tasks — bulk operations
  createTasksBatch(drafts: readonly TaskDraft[]): Promise<void>;
  updateTasksBatch(patches: readonly TaskPatch[]): Promise<void>;
  deleteTasksBatch(items: readonly { taskId: string; projectId: string }[]): Promise<void>;
  completeTasksBatch(items: readonly { taskId: string; projectId: string }[]): Promise<void>;

  // Tasks — completed lookup (paginated iterator OR statistics range)
  listCompletedTasks(opts: CompletedTaskOptions): Promise<readonly Task[]>;

  // Projects (lists)
  listProjects(): Promise<readonly Project[]>;
  getProject(idOrName: string): Promise<Project | null>;
  createProject(draft: ProjectDraft): Promise<Project>;
  updateProject(patch: ProjectPatch): Promise<void>;
  deleteProject(projectId: string): Promise<void>;

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
  createTag(draft: TagDraft): Promise<void>;
  updateTag(draft: TagDraft): Promise<void>;
  deleteTag(name: string): Promise<void>;
  renameTag(name: string, newLabel: string): Promise<void>;
  mergeTags(source: string, target: string): Promise<void>;

  // Sections (kanban columns) within a project. Bypasses the library's
  // buggy listColumns() method which wraps responses and doesn't filter
  // by projectId server-side — we hit /api/v2/column directly and filter
  // client-side.
  listSections(projectId: string): Promise<readonly Section[]>;

  /**
   * Create a new section (kanban column) in the given project. Uses the
   * batch-envelope `POST /api/v2/column` endpoint with `add[]`. The client
   * supplies the 24-char hex id — the server echoes it back as the
   * canonical id via `id2etag`. If `sortOrder` is omitted, a large value is
   * picked that sorts the new section at the end.
   *
   * Discovered April 2026 via API probing; not exposed by ticktick-client.
   * See PLAN_02 discovery results in MEMORY/WORK/...
   */
  createSection(projectId: string, name: string, sortOrder?: number): Promise<Section>;

  /**
   * Rename an existing section. Uses the batch-envelope `update[]` path.
   * Update is a full-record REPLACE, not a patch — the adapter fetches the
   * current sortOrder first so it is preserved across the rename.
   */
  renameSection(projectId: string, sectionId: string, newName: string): Promise<Section>;

  /**
   * Delete a section. Uses the batch-envelope `delete[]` path with
   * `{projectId, columnId}` entries (NOT bare ids — wrong shape returns 500).
   *
   * TickTick orphans tasks in the deleted section: they remain in the
   * project with `columnId` cleared. No server-side "reassign" parameter
   * exists — callers that want tasks moved to another section should update
   * those tasks FIRST, then call this method.
   */
  deleteSection(projectId: string, sectionId: string): Promise<void>;

  /**
   * Change a section's sortOrder in place. Uses the same `update[]`
   * envelope as rename — name is preserved. TickTick uses large integer
   * gaps (often 2^16 multiples) for insertion; callers should pick a
   * midpoint between neighbors rather than sequential integers.
   */
  reorderSection(projectId: string, sectionId: string, sortOrder: number): Promise<Section>;

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

    if (filters?.pinned !== undefined) {
      tasks = tasks.filter((t) =>
        filters.pinned ? t.pinnedAt !== null : t.pinnedAt === null,
      );
    }

    if (filters?.sectionId !== undefined) {
      tasks = tasks.filter((t) => t.columnId === filters.sectionId);
    }

    if (filters?.assignee !== undefined) {
      const wanted = filters.assignee;
      tasks = tasks.filter((t) => t.assignee === wanted);
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
      ...(draft.repeatEndDate !== undefined && { repeatEndDate: draft.repeatEndDate }),
      ...(draft.assignee !== undefined && { assignee: draft.assignee }),
      ...(draft.columnId !== undefined && { columnId: draft.columnId }),
    };
    // Cast through unknown because the library's TickTickTaskDraft type
    // doesn't include assignee/columnId — we're intentionally bypassing.
    const created = await this.#client.tasks.create(rawDraft as unknown as TickTickTaskDraft);
    return normalizeTask(created);
  }

  async updateTask(patch: TaskPatch): Promise<Task> {
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
      ...(patch.repeatEndDate !== undefined && { repeatEndDate: patch.repeatEndDate }),
      ...(patch.assignee !== undefined && { assignee: patch.assignee }),
      ...(patch.columnId !== undefined && { columnId: patch.columnId }),
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

  // ── Tasks: pin / unpin / restore ──
  async pinTask(taskId: string, projectId: string, date?: Date): Promise<void> {
    // Library signature: pin(taskId, projectId, date?: Date). The third arg
    // is the pinnedTime. Default is "now" inside the library when omitted.
    if (date !== undefined) {
      await this.#client.tasks.pin(taskId, projectId, date);
    } else {
      await this.#client.tasks.pin(taskId, projectId);
    }
  }

  async unpinTask(taskId: string, projectId: string): Promise<void> {
    // The library's tasks.unpin() POSTs pinnedTime: null to /api/v2/task/{id},
    // which TickTick silently no-ops. Reverse-engineered the actual web UI
    // call via Playwright XHR capture on 2026-04-13: TickTick uses the
    // sentinel string "-1" (NOT null, NOT 0, NOT omitted) as the unpin marker,
    // sent via /api/v2/batch/task with the FULL task object in update[].
    // See: probe-unpin-shapes.ts (since deleted) which confirmed 7 other
    // shapes silently no-op against this field.
    const all = await this.#client.tasks.list();
    const task = all.find((t) => t.id === taskId);
    if (!task) {
      throw new AdapterError('NOT_FOUND', `Task ${taskId} not found for unpin`);
    }
    const fullTask = task as unknown as Record<string, unknown>;
    const updateBody = {
      ...fullTask,
      pinnedTime: '-1',
      modifiedTime: new Date().toISOString(),
    };
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    await client.request<unknown>('POST', '/api/v2/batch/task', {
      add: [],
      update: [updateBody],
      delete: [],
      addAttachments: [],
      updateAttachments: [],
      deleteAttachments: [],
    });
  }

  async restoreTask(taskId: string, projectId: string): Promise<void> {
    // Note: TickTick's trash listing is broken (status=-1 query is ignored
    // server-side), so callers must already know the taskId from prior
    // state. The library docs this on tasks.restore() too.
    await this.#client.tasks.restore(taskId, projectId);
  }

  // ── Tasks: bulk operations ──
  async createTasksBatch(drafts: readonly TaskDraft[]): Promise<void> {
    if (drafts.length === 0) return;
    const raw = drafts.map((d) => this.#draftToRaw(d));
    await this.#client.tasks.createMany(raw as unknown as readonly TickTickTaskDraft[]);
  }

  async updateTasksBatch(patches: readonly TaskPatch[]): Promise<void> {
    if (patches.length === 0) return;
    const raw = patches.map((p) => ({
      ...this.#draftToRaw(p),
      id: p.id,
      projectId: p.projectId,
    }));
    await this.#client.tasks.updateMany(raw as unknown as readonly TickTickTaskUpdate[]);
  }

  async deleteTasksBatch(
    items: readonly { taskId: string; projectId: string }[],
  ): Promise<void> {
    if (items.length === 0) return;
    await this.#client.tasks.deleteMany(items);
  }

  async completeTasksBatch(
    items: readonly { taskId: string; projectId: string }[],
  ): Promise<void> {
    if (items.length === 0) return;
    // Synthesize bulk-complete via updateMany with status=2. The library's
    // TickTickTaskUpdate type doesn't list `status` (it's a TaskDraft-shape
    // intersection), but the underlying POST /api/v2/batch/task accepts it.
    const updates = items.map((i) => ({
      id: i.taskId,
      projectId: i.projectId,
      status: 2,
    }));
    await this.#client.tasks.updateMany(updates as unknown as readonly TickTickTaskUpdate[]);
  }

  // ── Tasks: completed lookup ──
  async listCompletedTasks(opts: CompletedTaskOptions): Promise<readonly Task[]> {
    // Two surface modes, ONE backend:
    //   • from+to  → iterator + client-side date filter on completedTime
    //   • otherwise → iterator with optional project + limit
    //
    // Originally the from+to branch called `statistics.listCompleted` which
    // hits `/api/v2/project/all/completed/` — that endpoint returns HTTP 500
    // for any date window (confirmed 2026-04-13 against three date formats).
    // The `tasks.iterateCompleted` endpoint `/api/v2/project/all/closed` is
    // the known-good path; we post-filter to the requested window.
    const limit = opts.limit ?? (opts.from && opts.to ? 100 : 50);
    const fromMs = opts.from !== undefined ? Date.parse(opts.from) : undefined;
    const toMs = opts.to !== undefined ? Date.parse(opts.to) : undefined;

    const collected: Task[] = [];
    const iter = this.#client.tasks.iterateCompleted({
      ...(opts.projectId !== undefined && { projectId: opts.projectId }),
    });
    for await (const page of iter) {
      let sawOlderThanWindow = false;
      for (const raw of page) {
        const task = normalizeTask(raw);
        // Date-window filter (only when from/to are set). Tasks are
        // returned newest-first by the closed endpoint, so once we see
        // a task older than `from` we can stop iterating pages entirely.
        if (fromMs !== undefined || toMs !== undefined) {
          const completedAt = task.completedAt;
          if (completedAt === null) continue;
          const tMs = Date.parse(completedAt);
          if (toMs !== undefined && tMs > toMs) continue;
          if (fromMs !== undefined && tMs < fromMs) {
            sawOlderThanWindow = true;
            continue;
          }
        }
        collected.push(task);
        if (collected.length >= limit) return collected;
      }
      if (sawOlderThanWindow) break;
    }
    return collected;
  }

  /**
   * Convert a normalized {@link TaskDraft} to the raw shape the library
   * expects. Centralized so create / update / createMany / updateMany all
   * stay in lock-step on field handling. Returns a plain object — callers
   * cast to the library type at the call site.
   */
  #draftToRaw(draft: TaskDraft): Record<string, unknown> {
    return {
      title: draft.title,
      ...(draft.projectId !== undefined && { projectId: draft.projectId }),
      ...(draft.content !== undefined && { content: draft.content }),
      ...(draft.priority !== undefined && { priority: denormalizePriority(draft.priority) }),
      ...(draft.startDate !== undefined && { startDate: draft.startDate }),
      ...(draft.dueDate !== undefined && { dueDate: draft.dueDate }),
      ...(draft.isAllDay !== undefined && { isAllDay: draft.isAllDay }),
      ...(draft.tags !== undefined && { tags: draft.tags }),
      ...(draft.repeatFlag !== undefined && { repeatFlag: draft.repeatFlag }),
      ...(draft.repeatEndDate !== undefined && { repeatEndDate: draft.repeatEndDate }),
      ...(draft.assignee !== undefined && { assignee: draft.assignee }),
      ...(draft.columnId !== undefined && { columnId: draft.columnId }),
    };
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

  async createProject(draft: ProjectDraft): Promise<Project> {
    const created = await this.#client.projects.create(draft as TickTickProjectDraft);
    return normalizeProject(created);
  }

  async updateProject(patch: ProjectPatch): Promise<void> {
    await this.#client.projects.update(patch as TickTickProjectDraft & { id: string });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.#client.projects.delete(projectId);
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

  async createTag(draft: TagDraft): Promise<void> {
    await this.#client.tags.create(draft as TickTickTagDraft);
  }

  async updateTag(draft: TagDraft): Promise<void> {
    await this.#client.tags.update(draft as TickTickTagDraft);
  }

  async deleteTag(name: string): Promise<void> {
    await this.#client.tags.delete(name);
  }

  async renameTag(name: string, newLabel: string): Promise<void> {
    // Library's `rename(name, label)` semantics: pass the slug + the new
    // display label. Despite the name, the underlying endpoint actually
    // does a slug→slug rename on the server side; the library normalizes
    // the second arg into both `name` and `label` of the new tag.
    await this.#client.tags.rename(name, newLabel);
  }

  async mergeTags(source: string, target: string): Promise<void> {
    await this.#client.tags.merge(source, target);
  }

  // ── Sections (kanban columns) ──
  //
  // The four mutating methods below all hit `POST /api/v2/column` with the
  // same batch-envelope body shape `{add, update, delete}` — the same
  // envelope TickTick uses for `/api/v2/batch/task`. No `/api/v2/batch/column`
  // endpoint exists (returns 404). Discovered April 2026 by API probing
  // against the live account. See PLAN_02 discovery results for the raw
  // captures and surprises.
  //
  // Critical gotchas burned in:
  //   * Create: client supplies the 24-char hex id; server echoes it via
  //     id2etag. No server-side id substitution.
  //   * Update/rename/reorder: full-record REPLACE, not a patch. Must send
  //     name + projectId + sortOrder together or omitted fields clobber to
  //     defaults.
  //   * Delete entries are `{projectId, columnId}` objects — NOT bare ids,
  //     NOT `{id, projectId}`. Wrong shape → HTTP 500 (server crashes,
  //     doesn't validate).
  //   * Delete orphans tasks in the column (columnId cleared, tasks remain).
  //     No `--reassign` server-side — callers implement two-step.

  async createSection(
    projectId: string,
    name: string,
    sortOrder?: number,
  ): Promise<Section> {
    const id = generateColumnId();
    // Default sortOrder: pick a value larger than any existing section so
    // the new one lands at the end. TickTick uses huge gaps (2^16 multiples)
    // so we use a similar shape. If the project has no sections, start at 0.
    let effectiveSort: number;
    if (typeof sortOrder === 'number') {
      effectiveSort = sortOrder;
    } else {
      const existing = await this.listSections(projectId);
      if (existing.length === 0) {
        effectiveSort = 0;
      } else {
        const max = existing.reduce<number>(
          (m, s) => (typeof s.sortOrder === 'number' && s.sortOrder > m ? s.sortOrder : m),
          Number.NEGATIVE_INFINITY,
        );
        effectiveSort = (Number.isFinite(max) ? max : 0) + (1 << 16);
      }
    }

    const body = {
      add: [{ id, name, projectId, sortOrder: effectiveSort }],
      update: [],
      delete: [],
    };
    const resp = await this.#columnBatch(body);
    this.#throwIfBatchError(resp, `createSection(${name})`);

    return { id, projectId, name, sortOrder: effectiveSort };
  }

  async renameSection(
    projectId: string,
    sectionId: string,
    newName: string,
  ): Promise<Section> {
    // Update is a full-record replace — fetch current sortOrder so it is
    // preserved across the rename (omitted fields get clobbered to defaults).
    const current = await this.#getSectionOrThrow(projectId, sectionId);

    const body = {
      add: [],
      update: [
        {
          id: sectionId,
          name: newName,
          projectId,
          sortOrder: current.sortOrder ?? 0,
        },
      ],
      delete: [],
    };
    const resp = await this.#columnBatch(body);
    this.#throwIfBatchError(resp, `renameSection(${sectionId})`);

    return {
      id: sectionId,
      projectId,
      name: newName,
      sortOrder: current.sortOrder,
    };
  }

  async deleteSection(projectId: string, sectionId: string): Promise<void> {
    const body = {
      add: [],
      update: [],
      // ⚠️ The delete entry is {projectId, columnId} — NOT a bare id string,
      // NOT {id, projectId}. Both wrong shapes return HTTP 500 (the server
      // crashes rather than validates). Discovered April 2026 the hard way.
      delete: [{ projectId, columnId: sectionId }],
    };
    const resp = await this.#columnBatch(body);
    this.#throwIfBatchError(resp, `deleteSection(${sectionId})`);
  }

  async reorderSection(
    projectId: string,
    sectionId: string,
    sortOrder: number,
  ): Promise<Section> {
    // Reorder uses the same update[] path as rename. Full-record replace —
    // fetch the current name so it survives the update.
    const current = await this.#getSectionOrThrow(projectId, sectionId);

    const body = {
      add: [],
      update: [
        {
          id: sectionId,
          name: current.name,
          projectId,
          sortOrder,
        },
      ],
      delete: [],
    };
    const resp = await this.#columnBatch(body);
    this.#throwIfBatchError(resp, `reorderSection(${sectionId})`);

    return { id: sectionId, projectId, name: current.name, sortOrder };
  }

  // ── Section batch helpers (private) ──

  async #columnBatch(body: unknown): Promise<ColumnBatchResponse> {
    const client = this.#client as unknown as {
      request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    };
    const raw = await client.request<unknown>('POST', '/api/v2/column', body);
    // Defensive normalization — on success the shape is
    // `{id2etag: {...}, id2error: {}}`.
    const r = (raw ?? {}) as Partial<ColumnBatchResponse>;
    return {
      id2etag: (r.id2etag ?? {}) as Record<string, string>,
      id2error: (r.id2error ?? {}) as Record<string, string>,
    };
  }

  #throwIfBatchError(resp: ColumnBatchResponse, context: string): void {
    const errors = Object.entries(resp.id2error);
    if (errors.length === 0) return;
    const summary = errors.map(([id, msg]) => `${id}: ${msg}`).join('; ');
    throw new AdapterError(
      'NETWORK',
      `${context} reported errors from TickTick batch endpoint: ${summary}`,
    );
  }

  async #getSectionOrThrow(
    projectId: string,
    sectionId: string,
  ): Promise<Section> {
    const sections = await this.listSections(projectId);
    const match = sections.find((s) => s.id === sectionId);
    if (!match) {
      throw new AdapterError(
        'NOT_FOUND',
        `Section ${sectionId} not found in project ${projectId}.`,
      );
    }
    return match;
  }

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
  };
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

/**
 * Response envelope from `POST /api/v2/column` (batch create/update/delete).
 * Mirrors the `/api/v2/batch/task` shape: `id2etag` maps the client-supplied
 * (or echoed) column id to an 8-char etag on success; `id2error` maps id to
 * a human-readable error string on per-entry failure. On total success both
 * are present; id2error is empty.
 */
type ColumnBatchResponse = {
  readonly id2etag: Record<string, string>;
  readonly id2error: Record<string, string>;
};

/**
 * Generate a 24-char hex id that TickTick will accept as a canonical column
 * id in a batch create request. The server echoes the client-supplied id
 * back in `id2etag` — no server-side substitution. Uses 12 random bytes
 * (96 bits of entropy) which is well clear of collision risk for the handful
 * of columns a user ever creates.
 */
function generateColumnId(): string {
  return randomBytes(12).toString('hex');
}

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

function matchesDueFilter(task: Task, due: DueFilter): boolean {
  // `none` is the only branch that includes tasks WITHOUT a dueDate.
  if (due === 'none') return task.dueDate === null;
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

  if (due === 'tomorrow') {
    const startOfTomorrow = new Date();
    startOfTomorrow.setHours(0, 0, 0, 0);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const endOfTomorrow = new Date(startOfTomorrow);
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    return dueMs >= startOfTomorrow.getTime() && dueMs < endOfTomorrow.getTime();
  }

  // `week` and `next7days` are synonyms — both mean "due within the next
  // 7 days from now". Future dates only; doesn't include overdue.
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
