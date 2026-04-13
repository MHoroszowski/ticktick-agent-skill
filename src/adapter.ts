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

/**
 * Geofence reminder attached to a task. TickTick supports exactly one
 * location per task — there is no array, no polygon, no multi-zone. The
 * mobile app fires a push notification when the user's phone crosses the
 * boundary, in the direction specified by `transitionType`.
 *
 * Wire shape verified via PLAN_05 round-trip writes and re-confirmed in
 * PLAN_06 phase-A probe (2026-04-13). Note specifically:
 *   - `loc.longitude` and `loc.latitude` use the LONG-FORM keys. Sending
 *     `loc.lng/lat` causes the server to silently coerce both to null,
 *     producing an unfireable geofence.
 *   - `transitionType` is 1 (arrive) or 2 (leave). Other integers may be
 *     accepted but only 1/2 are documented to fire reminders.
 *   - `removed: true` is the only shape that clears the field server-side
 *     when sent through `/api/v2/batch/task` with a full task body. The
 *     library's patch endpoint silently no-ops every clear shape we tried
 *     (location:null, location:{}, location:{loc:null}, omission). See
 *     `clearLocation` below for the implementation.
 *   - iPhone push delivery for API-set geofences is verified end-to-end
 *     (manual QA on 2026-04-13). No mobile-permission caveat needed.
 */
export type TaskLocation = {
  readonly alias: string | null;
  readonly loc: { readonly longitude: number; readonly latitude: number } | null;
  readonly radius: number;
  readonly transitionType: 1 | 2 | null;
  readonly shortAddress: string | null;
  readonly address: string | null;
  readonly removed: boolean | null;
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
   * Time-based reminders, as RFC-5545-style TRIGGER duration strings. The
   * underlying TickTick wire shape is an array of `{trigger}` objects (and
   * the library type strips the field entirely); we recover and flatten
   * via a raw cast. Sign convention: TickTick uses UNSIGNED durations to
   * mean "before the task's scheduled time", so `TRIGGER:PT15M` is "15
   * minutes before due". Verified empirically against the live API on
   * 2026-04-12 — see scripts/probe-reminders.ts.
   *
   * Empty array when the task has no reminders. Reminders only fire on
   * tasks that have a due date; setting reminders on a task without a due
   * date is allowed by the API but won't trigger anything.
   */
  readonly reminders: readonly string[];
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
  /**
   * Geofence reminder. Null when the task has no location attached. The
   * library's TickTickTask type strips this field; we recover it via a
   * raw cast in `normalizeTask`. To set/replace, pass `location` on a
   * draft or patch. To clear, use `clearLocation()` — the patch endpoint
   * silently no-ops every "null" shape we tried. See {@link TaskLocation}.
   */
  readonly location: TaskLocation | null;
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
  /**
   * Time-based reminders as TRIGGER duration strings (e.g. `TRIGGER:PT15M`,
   * `TRIGGER:P1D`). Pass `[]` to explicitly clear all reminders on update.
   * Omit to leave untouched. The adapter wraps each string in the
   * `{trigger}` object shape TickTick expects on the wire. Reminders only
   * fire on tasks with a due date — caller is responsible for that gate.
   */
  readonly reminders?: readonly string[];
  /**
   * Optional parent task id. When set on create, the new task becomes a
   * child (nested subtask) of the given parent. Project is inferred from
   * the parent if `projectId` is omitted, but callers should still pass
   * `projectId` explicitly — the resolution is the caller's job, not the
   * adapter's. Do NOT use this on `updateTask` — PATCH-style updates do
   * not mutate parentId; use `indentTask()` / `promoteTask()` instead.
   */
  readonly parentId?: string | null;
  /**
   * Geofence to attach. Tri-state semantics:
   *   - `undefined` (omitted) = leave the existing location untouched
   *   - `TaskLocation` object = set or replace the location
   *   - `null` = INTENT to clear, but the patch endpoint silently no-ops
   *     this. Callers MUST go through `clearLocation()` instead. Setting
   *     `null` here on `updateTask` is a no-op against the wire.
   *
   * On `createTask`, undefined and null both mean "no location."
   */
  readonly location?: TaskLocation | null;
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

  // Reminders. Time-based reminders are stored as a `reminders[]` array of
  // `{trigger}` objects on the raw task; we surface them as a flat string
  // array on the normalized Task. The library doesn't model the field at
  // all, so the cast-through-adapter pattern (same as assignee/columnId)
  // is the swap point.
  //
  // `setReminders` is the low-level primitive: caller supplies the already-
  // fetched current task plus the exact new reminder set, and we PUT the
  // hydrated full-task body. `addReminder`/`removeReminder`/`clearReminders`
  // are single-roundtrip convenience wrappers that fetch the current task
  // internally. Callers who already have the current task in hand should
  // prefer `setReminders` to avoid a redundant GET.
  setReminders(current: Task, projectId: string, reminders: readonly string[]): Promise<Task>;
  addReminder(taskId: string, projectId: string, trigger: string): Promise<Task>;
  removeReminder(taskId: string, projectId: string, trigger: string): Promise<Task>;
  clearReminders(taskId: string, projectId: string): Promise<Task>;

  // Location reminders (geofences). One per task. Set/replace via the
  // `location` field on a draft or patch — the patch endpoint honors
  // location field updates. Clear is the awkward case: every "null" shape
  // we tried via the patch endpoint silently no-ops, so `clearLocation`
  // routes through the batch-endpoint full-body-replace pattern with
  // `removed: true` on the existing location object. Same escape-hatch
  // pattern as `unpinTask`. See PLAN_06 phase-A probe results.
  clearLocation(taskId: string, projectId: string): Promise<Task>;

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
      ...(draft.repeatEndDate !== undefined && { repeatEndDate: draft.repeatEndDate }),
      ...(draft.assignee !== undefined && { assignee: draft.assignee }),
      ...(draft.columnId !== undefined && { columnId: draft.columnId }),
      ...(draft.reminders !== undefined && { reminders: draft.reminders.map(wrapReminder) }),
      // parentId is only persisted at CREATE time. Server silently no-ops
      // parentId mutations sent via PATCH (POST /api/v2/task/{id}). To
      // re-parent an existing task use indentTask()/promoteTask().
      ...(draft.parentId !== undefined && { parentId: draft.parentId }),
      // location: pass through verbatim. The library's typed draft strips
      // the field but the wire shape accepts it. The library's response
      // mapper ALSO strips location from the create response, so the
      // Task we return here will have location:null even though the
      // server stored it correctly — callers who need to read it back
      // immediately should re-fetch via getTask().
      ...(draft.location !== undefined && { location: draft.location }),
    };
    // Cast through unknown because the library's TickTickTaskDraft type
    // doesn't include assignee/columnId/reminders/parentId/location — we're
    // intentionally bypassing. The library's request layer passes the body
    // through verbatim, so TickTick receives the extra fields.
    const created = await this.#client.tasks.create(rawDraft as unknown as TickTickTaskDraft);
    // The library's create response mapper strips location, so the
    // immediate response won't have it. Re-fetch via tasks.list() if the
    // draft included a location, so the returned Task accurately
    // reflects what's stored. Cheap cost (one extra list) for correctness
    // on the create-with-location path; no overhead for create-without.
    if (draft.location !== undefined) {
      const refetched = await this.getTask(created.id);
      if (refetched) return refetched;
    }
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
      ...(patch.repeatEndDate !== undefined && { repeatEndDate: patch.repeatEndDate }),
      ...(patch.assignee !== undefined && { assignee: patch.assignee }),
      ...(patch.columnId !== undefined && { columnId: patch.columnId }),
      ...(patch.reminders !== undefined && { reminders: patch.reminders.map(wrapReminder) }),
      // Preserve parentId across update so callers that just want to
      // change a child's title don't accidentally promote it.
      ...(existingParentId !== null && { parentId: existingParentId }),
      // location: pass through verbatim. The patch endpoint honors
      // location field updates (verified PLAN_06 phase A). Callers MUST
      // use clearLocation() to actually clear — passing `null` here
      // silently no-ops at the server level.
      ...(patch.location !== undefined && { location: patch.location }),
    };
    const updated = await this.#client.tasks.update(rawPatch as unknown as TickTickTaskUpdate);
    // Same as createTask: the library's update response mapper strips
    // location from the returned object. Re-fetch when the patch carried
    // a location so the returned Task is accurate.
    if (patch.location !== undefined) {
      const refetched = await this.getTask(patch.id);
      if (refetched) return refetched;
    }
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
      ...(draft.reminders !== undefined && { reminders: draft.reminders.map(wrapReminder) }),
      // location: pass through verbatim. The library's typed draft strips
      // the field but the wire shape accepts it. Tri-state: undefined =
      // omit; object = set/replace; null = the patch endpoint silently
      // ignores this — callers must use clearLocation() to actually clear.
      ...(draft.location !== undefined && { location: draft.location }),
    };
  }

  // ── Reminders ──
  //
  // CRITICAL: TickTick's PUT /api/v2/task endpoint does NOT behave like a
  // partial PATCH. Sending a sparse body of `{id, projectId, title,
  // reminders}` causes the server to wipe other fields — verified
  // empirically via tests/smoke.sh step 18 on 2026-04-13: `dueDate` came
  // back null and reminders came back empty in the echo despite the
  // reminder array being non-empty in the request. The fix is to re-send
  // every field that was on the task before, overlaying only the
  // reminders delta. This mirrors what the TickTick web UI itself does
  // on every edit — it always POSTs the full task body. See
  // `hydratePatch` below.
  //
  // `setReminders` is the primitive: caller owns the current task fetch
  // and the diff. The three wrapper methods fetch internally for callers
  // that don't already have the task in hand.
  async setReminders(
    current: Task,
    projectId: string,
    reminders: readonly string[],
  ): Promise<Task> {
    return this.updateTask(hydratePatch(current, projectId, reminders));
  }

  async addReminder(taskId: string, projectId: string, trigger: string): Promise<Task> {
    const current = await this.getTask(taskId);
    if (current === null) throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
    const next = current.reminders.includes(trigger)
      ? current.reminders
      : [...current.reminders, trigger];
    return this.setReminders(current, projectId, next);
  }

  async removeReminder(taskId: string, projectId: string, trigger: string): Promise<Task> {
    const current = await this.getTask(taskId);
    if (current === null) throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
    const next = current.reminders.filter((t) => t !== trigger);
    return this.setReminders(current, projectId, next);
  }

  async clearReminders(taskId: string, projectId: string): Promise<Task> {
    const current = await this.getTask(taskId);
    if (current === null) throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
    return this.setReminders(current, projectId, []);
  }

  // ── Location reminders (geofences) ──
  //
  // CREATE/UPDATE: the patch endpoint (`POST /api/v2/task/{id}`, used by
  // library `tasks.update()`) honors `location` field updates. Pass
  // `location` on a TaskDraft/TaskPatch and `#draftToRaw` will route it
  // through the standard create/update path.
  //
  // CLEAR: the patch endpoint silently no-ops every "null" shape we
  // tried (location:null, location:{}, location:{loc:null}, omission).
  // The only shape that actually drops the field server-side is sending
  // the existing location object with `removed: true` via the batch
  // endpoint with a full task body. Same pattern as `unpinTask`.
  // Verified empirically via PLAN_06 phase-A probe on 2026-04-13.
  async clearLocation(taskId: string, projectId: string): Promise<Task> {
    void projectId; // accepted for parity with reminders methods; not used on the wire
    // Re-fetch the raw task via tasks.list() — we need the full body for
    // the batch endpoint and the ORIGINAL location object so we can flip
    // its `removed` flag. The normalized Task drops the `removed` field
    // (collapses to a sentinel) so we can't round-trip through it.
    const all = await this.#client.tasks.list();
    const rawTask = all.find((t) => t.id === taskId);
    if (!rawTask) {
      throw new AdapterError('NOT_FOUND', `Task ${taskId} not found for clearLocation`);
    }
    const fullTask = rawTask as unknown as Record<string, unknown>;
    const existingLocation = fullTask.location;
    if (existingLocation === null || existingLocation === undefined) {
      // Already cleared — nothing to do. Return the normalized task as-is.
      return normalizeTask(rawTask);
    }
    const updateBody = {
      ...fullTask,
      location: { ...(existingLocation as Record<string, unknown>), removed: true },
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
    // Re-fetch so the returned Task reflects the cleared state. The
    // server now omits `location` from the response entirely, so
    // normalizeTask will surface it as null.
    const after = await this.getTask(taskId);
    if (after === null) {
      throw new AdapterError('NOT_FOUND', `Task ${taskId} disappeared after clearLocation`);
    }
    return after;
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

/**
 * Wrap a TRIGGER string in the `{trigger}` object shape TickTick expects
 * on the wire. Verified against the live API: bare strings produce HTTP
 * 500 unknown_exception; objects round-trip cleanly.
 */
function wrapReminder(trigger: string): { trigger: string } {
  return { trigger };
}

/**
 * Build a full TaskPatch by copying every meaningful field off an
 * existing normalized Task. Used everywhere a caller needs to do a
 * full-body PUT instead of a partial PATCH — TickTick's /api/v2/task
 * endpoint wipes any field not re-sent, so the safe play is always to
 * start from the current task and overlay changes.
 *
 * Null-valued source fields are explicitly omitted so the call remains
 * a no-op for them (sending `null` for `dueDate` would clear the due
 * date — exactly what we're trying to avoid).
 *
 * The `reminders` parameter is required because every current caller
 * of this helper is modifying reminders. Callers that want to preserve
 * the existing reminder set pass `current.reminders` explicitly. The
 * optional `overlay` argument merges user-supplied field overrides on
 * top of the hydrated base — used by the commands layer when the user
 * passes other flags alongside `--remind` on update.
 */
export function hydratePatch(
  current: Task,
  projectId: string,
  reminders: readonly string[],
  overlay: Partial<TaskPatch> = {},
): TaskPatch {
  return {
    id: current.id,
    projectId,
    title: current.title,
    ...(current.content !== null && { content: current.content }),
    priority: current.priority,
    ...(current.startDate !== null && { startDate: current.startDate }),
    ...(current.dueDate !== null && { dueDate: current.dueDate }),
    ...(current.isAllDay !== null && { isAllDay: current.isAllDay }),
    tags: current.tags,
    ...(current.repeatFlag !== null && { repeatFlag: current.repeatFlag }),
    ...(current.assignee !== null && { assignee: current.assignee }),
    ...(current.columnId !== null && { columnId: current.columnId }),
    // Preserve the existing location across reminder hydration. Without
    // this, `tasks update --remind 15m` on a task that has a geofence
    // would wipe the geofence — the patch endpoint's full-body wipe
    // semantics affect location the same way they affect every other
    // unsent field. If the caller passed `--location-*` flags too, the
    // overlay below will replace this value.
    ...(current.location !== null && { location: current.location }),
    ...overlay,
    reminders,
  };
}

/**
 * Pull the flat string array out of the raw `reminders` field on a task.
 * The wire shape is an array of `{trigger, id?}` objects. We surface only
 * the trigger strings to the public Task type because the optional `id`
 * field is server-side-irrelevant — TickTick doesn't require it on writes
 * and doesn't auto-assign one. Defensive: returns [] if the field is
 * missing, null, malformed, or contains entries without a string trigger.
 */
function normalizeReminders(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      // Defensive — older API responses or third-party tooling might emit
      // bare strings even though the canonical shape is objects.
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && 'trigger' in entry) {
      const t = (entry as { trigger: unknown }).trigger;
      if (typeof t === 'string') out.push(t);
    }
  }
  return out;
}

function normalizeTask(raw: TickTickTask): Task {
  // The library's typed TickTickTask strips several fields that exist in
  // the raw API response. Cast to any to recover them.
  const r = raw as TickTickTask & {
    assignee?: number | null;
    creator?: number | null;
    columnId?: string | null;
    reminders?: unknown;
    parentId?: string | null;
    childIds?: readonly string[] | null;
    location?: unknown;
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
    reminders: normalizeReminders(r.reminders),
    parentId: rawParentId,
    childIds: rawChildIds,
    location: normalizeLocation(r.location),
  };
}

/**
 * Pull the location field off a raw task and normalize it into the
 * adapter's {@link TaskLocation} shape (or null if there's no usable
 * location). Defensive: returns null for missing, null, non-object, or
 * for any object whose `loc.longitude/latitude` aren't both numbers — a
 * geofence with non-numeric coordinates can't fire and shouldn't be
 * surfaced as if it could.
 *
 * The clear-via-batch path leaves a "shell" object behind ({alias:null,
 * loc:null, ...}); we treat that as "no usable location" too because
 * `loc === null` means there's nothing for the phone to fence against.
 * The shell-vs-absent distinction is server-internal trash; the public
 * API doesn't need to expose it.
 */
function normalizeLocation(raw: unknown): TaskLocation | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const r = raw as {
    alias?: unknown;
    loc?: unknown;
    radius?: unknown;
    transitionType?: unknown;
    shortAddress?: unknown;
    address?: unknown;
    removed?: unknown;
  };
  // `loc` must be a non-null object with numeric longitude+latitude or
  // there's nothing to fence against. Treat as cleared.
  let loc: { longitude: number; latitude: number } | null = null;
  if (r.loc !== null && r.loc !== undefined && typeof r.loc === 'object') {
    const l = r.loc as { longitude?: unknown; latitude?: unknown };
    if (typeof l.longitude === 'number' && typeof l.latitude === 'number') {
      loc = { longitude: l.longitude, latitude: l.latitude };
    }
  }
  if (loc === null) return null;
  // transitionType: 1 = arrive, 2 = leave. Anything else collapses to null.
  let transitionType: 1 | 2 | null = null;
  if (r.transitionType === 1) transitionType = 1;
  else if (r.transitionType === 2) transitionType = 2;
  // radius: best-effort number; if missing or non-numeric, default to 0
  // so the type stays uniform. The CLI layer rejects radius<=0 on input
  // so we won't see garbage from our own writes; defensive for foreign data.
  const radius = typeof r.radius === 'number' ? r.radius : 0;
  return {
    alias: typeof r.alias === 'string' ? r.alias : null,
    loc,
    radius,
    transitionType,
    shortAddress: typeof r.shortAddress === 'string' ? r.shortAddress : null,
    address: typeof r.address === 'string' ? r.address : null,
    removed: typeof r.removed === 'boolean' ? r.removed : null,
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
