/**
 * commands/tasks.ts — task CRUD and move.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman, formatTasksTable } from '../output.ts';
import { resolveUser } from '../users.ts';
import type { GlobalOpts } from '../cli.ts';
import type {
  TickTickAdapter,
  TaskDraft,
  TaskPatch,
  TaskPriorityName,
  TaskStatus,
  TaskListFilters,
  DueFilter,
} from '../adapter.ts';

// ──────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────

export async function list(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const adapter = createAdapter();

  const projectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number.parseInt(flags.limit, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageError(`--limit must be a non-negative integer, got: ${flags.limit}`);
    }
    limit = n;
  }

  // --section filter: must know the project so the section name resolves
  // within the right column list. Section ids are globally scoped but
  // name-based lookup needs the project context.
  if (flags.section !== undefined && projectId === undefined) {
    throw new UsageError(
      '--section requires --project so the section can be resolved within that project.',
    );
  }
  const sectionId =
    flags.section !== undefined && projectId !== undefined
      ? await resolveSectionId(adapter, projectId, flags.section)
      : undefined;

  // --assignee filter: resolve via users.ts. 'me'/'self' → cached self,
  // 'unassign'/'none'/'null' → filter to unassigned tasks only.
  let assigneeFilter: number | null | undefined;
  if (flags.assignee !== undefined) {
    assigneeFilter = resolveUser(flags.assignee);
  }

  const filters: TaskListFilters = {
    ...(projectId !== undefined && { projectId }),
    ...(flags.status !== undefined && { status: parseStatusFilter(flags.status) }),
    ...(flags.due !== undefined && { due: parseDueFilter(flags.due) }),
    ...(flags.tag !== undefined && { tag: flags.tag }),
    ...(flags.pinned === 'true' && { pinned: true }),
    ...(sectionId !== undefined && { sectionId }),
    ...(assigneeFilter !== undefined && { assignee: assigneeFilter }),
    ...(limit !== undefined && { limit }),
  };

  const result = await adapter.listTasks(filters);

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// get
// ──────────────────────────────────────────────────────────────────

export async function get(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const task = await adapter.getTask(id);
  if (task === null) {
    throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  }
  if (opts.human) {
    writeHuman(formatTasksTable([task]));
    return;
  }
  writeOk({ task });
}

// ──────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────

export async function create(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const title = requireFlag(flags, 'title', 'task title');

  const adapter = createAdapter();
  const projectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;

  const assignee = flags.assignee !== undefined ? resolveUser(flags.assignee) : undefined;

  if (flags.section !== undefined && projectId === undefined) {
    throw new UsageError(
      '--section requires --project so the section can be resolved within that project.',
    );
  }
  const columnId =
    flags.section !== undefined && projectId !== undefined
      ? await resolveSectionId(adapter, projectId, flags.section)
      : undefined;

  const draft: TaskDraft = {
    title,
    ...(projectId !== undefined && { projectId }),
    ...(flags.content !== undefined && { content: flags.content }),
    ...(flags.priority !== undefined && { priority: parsePriority(flags.priority) }),
    ...(flags.due !== undefined && { dueDate: flags.due }),
    ...(flags.start !== undefined && { startDate: flags.start }),
    ...(flags['all-day'] === 'true' && { isAllDay: true }),
    ...(flags.tags !== undefined && { tags: parseTagList(flags.tags) }),
    ...(flags.repeat !== undefined && { repeatFlag: flags.repeat }),
    ...(flags['repeat-end'] !== undefined && { repeatEndDate: flags['repeat-end'] }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
  };

  const task = await adapter.createTask(draft);

  if (opts.human) {
    writeHuman(`Created task ${task.id}: ${task.title}`);
    return;
  }
  writeOk({ task });
}

// ──────────────────────────────────────────────────────────────────
// update
// ──────────────────────────────────────────────────────────────────

export async function update(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const projectId = requireFlag(
    flags,
    'project',
    'project id — fetch the task first with `tasks get --id <id>` if you need it',
  );
  const title = flags.title;
  if (title === undefined) {
    throw new UsageError(
      'Missing --title for tasks update. Pass the new (or existing) title explicitly.',
    );
  }

  const adapter = createAdapter();
  const assignee = flags.assignee !== undefined ? resolveUser(flags.assignee) : undefined;

  // For update, projectId is required as a flag, so resolve it first so
  // --section can be fuzzy-matched within the correct project.
  const resolvedProjectId = await resolveProjectId(adapter, projectId);
  const columnId =
    flags.section !== undefined
      ? await resolveSectionId(adapter, resolvedProjectId, flags.section)
      : undefined;

  const patch: TaskPatch = {
    id,
    projectId: resolvedProjectId,
    title,
    ...(flags.content !== undefined && { content: flags.content }),
    ...(flags.priority !== undefined && { priority: parsePriority(flags.priority) }),
    ...(flags.due !== undefined && { dueDate: flags.due }),
    ...(flags.start !== undefined && { startDate: flags.start }),
    ...(flags['all-day'] === 'true' && { isAllDay: true }),
    ...(flags.tags !== undefined && { tags: parseTagList(flags.tags) }),
    ...(flags.repeat !== undefined && { repeatFlag: flags.repeat }),
    ...(flags['repeat-end'] !== undefined && { repeatEndDate: flags['repeat-end'] }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
  };

  const task = await adapter.updateTask(patch);

  if (opts.human) {
    writeHuman(`Updated task ${task.id}: ${task.title}`);
    return;
  }
  writeOk({ task });
}

// ──────────────────────────────────────────────────────────────────
// complete
// ──────────────────────────────────────────────────────────────────

export async function complete(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.completeTask(id, projectId);

  if (opts.human) {
    writeHuman(`Completed task ${id}`);
    return;
  }
  writeOk({ taskId: id });
}

// ──────────────────────────────────────────────────────────────────
// delete
// ──────────────────────────────────────────────────────────────────

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.deleteTask(id, projectId);

  if (opts.human) {
    writeHuman(`Deleted task ${id}`);
    return;
  }
  writeOk({ deleted: id });
}

// ──────────────────────────────────────────────────────────────────
// move
// ──────────────────────────────────────────────────────────────────

export async function move(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const toRaw = requireFlag(flags, 'to', 'destination project id or name');

  const adapter = createAdapter();
  const fromProjectId = await resolveTaskProjectId(adapter, id, flags.from);
  const toProjectId = await resolveProjectId(adapter, toRaw);

  const result = await adapter.moveTask(id, fromProjectId, toProjectId);

  if (opts.human) {
    writeHuman(
      `Moved task (previousId=${result.previousId}) → newId=${result.task.id} in project ${result.task.projectId}`,
    );
    return;
  }
  writeOk({
    task: result.task,
    previousId: result.previousId,
    note:
      'TickTick implements moves as copy+delete. The task has a NEW id. Update any references to the old id.',
  });
}

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

async function resolveProjectId(adapter: TickTickAdapter, idOrName: string): Promise<string> {
  // Fast path: if it looks like an ObjectId (24 hex chars), treat as ID.
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;
  const project = await adapter.getProject(idOrName);
  if (!project) {
    throw new UsageError(
      `No project found matching '${idOrName}'. Run \`ticktick projects list\` to see available projects.`,
    );
  }
  return project.id;
}

async function resolveSectionId(
  adapter: TickTickAdapter,
  projectId: string,
  idOrName: string,
): Promise<string> {
  // Fast path: if it looks like an ObjectId (24 hex chars), treat as ID.
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;

  const sections = await adapter.listSections(projectId);
  const query = idOrName.toLowerCase();

  // Exact (case-insensitive) name match wins outright.
  const exact = sections.filter((s) => s.name.toLowerCase() === query);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) {
    const names = exact.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Multiple sections named '${idOrName}' in project ${projectId}: ${names}. Pass --section <id> to disambiguate.`,
    );
  }

  // Prefix match (case-insensitive) as a fallback.
  const prefix = sections.filter((s) => s.name.toLowerCase().startsWith(query));
  if (prefix.length === 1) return prefix[0]!.id;
  if (prefix.length > 1) {
    const names = prefix.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Ambiguous --section '${idOrName}' in project ${projectId}: ${names}. Pass --section <id> to disambiguate.`,
    );
  }

  throw new AdapterError(
    'NOT_FOUND',
    `No section matching '${idOrName}' in project ${projectId}. Run \`ticktick sections list --project ${projectId}\` to see available sections.`,
  );
}

async function resolveTaskProjectId(
  adapter: TickTickAdapter,
  taskId: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined) return resolveProjectId(adapter, explicit);
  const task = await adapter.getTask(taskId);
  if (task === null) {
    throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
  }
  return task.projectId;
}

function parsePriority(value: string): TaskPriorityName {
  const v = value.toLowerCase();
  if (v === 'none' || v === 'low' || v === 'medium' || v === 'high') return v;
  throw new UsageError(`--priority must be one of: none, low, medium, high. Got: ${value}`);
}

function parseStatusFilter(value: string): TaskStatus | 'all' {
  const v = value.toLowerCase();
  if (v === 'open' || v === 'completed' || v === 'abandoned' || v === 'all') return v;
  throw new UsageError(`--status must be one of: open, completed, abandoned, all. Got: ${value}`);
}

function parseDueFilter(value: string): DueFilter {
  const v = value.toLowerCase();
  if (
    v === 'today' ||
    v === 'tomorrow' ||
    v === 'overdue' ||
    v === 'week' ||
    v === 'next7days' ||
    v === 'none'
  ) {
    return v;
  }
  throw new UsageError(
    `--due must be one of: today, tomorrow, overdue, week, next7days, none. Got: ${value}`,
  );
}

function parseTagList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ──────────────────────────────────────────────────────────────────
// pin / unpin
// ──────────────────────────────────────────────────────────────────

export async function pin(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.pinTask(id, projectId);

  if (opts.human) {
    writeHuman(`Pinned task ${id}`);
    return;
  }
  writeOk({ taskId: id, projectId, pinned: true });
}

export async function unpin(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.unpinTask(id, projectId);

  if (opts.human) {
    writeHuman(`Unpinned task ${id}`);
    return;
  }
  writeOk({ taskId: id, projectId, pinned: false });
}

// ──────────────────────────────────────────────────────────────────
// restore (out of trash — explicit id required)
// ──────────────────────────────────────────────────────────────────

export async function restore(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  // No auto-resolve: the task is in trash, getTask() can't find it.
  const projectIdFlag = requireFlag(
    flags,
    'project',
    'project id — required because trash listing is broken',
  );
  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectIdFlag);
  await adapter.restoreTask(id, projectId);

  if (opts.human) {
    writeHuman(`Restored task ${id} in project ${projectId}`);
    return;
  }
  writeOk({ taskId: id, projectId, restored: true });
}

// ──────────────────────────────────────────────────────────────────
// bulk: create-many / update-many / delete-many / complete-many
// ──────────────────────────────────────────────────────────────────

export async function createMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const file = requireFlag(flags, 'file', 'path to JSON file containing an array of TaskDraft objects');
  const drafts = await loadJsonFile<readonly Record<string, unknown>[]>(file);
  if (!Array.isArray(drafts)) {
    throw new UsageError(`--file must contain a JSON array of task drafts. Got: ${typeof drafts}`);
  }
  if (drafts.length === 0) {
    throw new UsageError(`--file ${file} is an empty array; nothing to create.`);
  }

  const adapter = createAdapter();
  const normalized: TaskDraft[] = [];
  for (const [i, raw] of drafts.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new UsageError(`drafts[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== 'string' || r.title.length === 0) {
      throw new UsageError(`drafts[${i}].title must be a non-empty string`);
    }
    // Resolve project name → id (one round-trip per unique name; ok for
    // small batches). Pre-resolved ids pass through untouched.
    const projectId =
      typeof r.projectId === 'string' && r.projectId.length > 0
        ? await resolveProjectId(adapter, r.projectId)
        : undefined;
    const draft: TaskDraft = {
      title: r.title,
      ...(projectId !== undefined && { projectId }),
      ...(typeof r.content === 'string' && { content: r.content }),
      ...(typeof r.priority === 'string' && { priority: parsePriority(r.priority) }),
      ...(typeof r.dueDate === 'string' && { dueDate: r.dueDate }),
      ...(typeof r.startDate === 'string' && { startDate: r.startDate }),
      ...(typeof r.isAllDay === 'boolean' && { isAllDay: r.isAllDay }),
      ...(Array.isArray(r.tags) && { tags: r.tags as readonly string[] }),
      ...(typeof r.repeatFlag === 'string' && { repeatFlag: r.repeatFlag }),
      ...(typeof r.repeatEndDate === 'string' && { repeatEndDate: r.repeatEndDate }),
    };
    normalized.push(draft);
  }

  await adapter.createTasksBatch(normalized);

  if (opts.human) {
    writeHuman(`Created ${normalized.length} task${normalized.length === 1 ? '' : 's'} from ${file}`);
    return;
  }
  writeOk({ count: normalized.length, source: file });
}

export async function updateMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const file = requireFlag(flags, 'file', 'path to JSON file containing an array of TaskPatch objects');
  const patches = await loadJsonFile<readonly Record<string, unknown>[]>(file);
  if (!Array.isArray(patches)) {
    throw new UsageError(`--file must contain a JSON array of task patches. Got: ${typeof patches}`);
  }
  if (patches.length === 0) {
    throw new UsageError(`--file ${file} is an empty array; nothing to update.`);
  }

  const adapter = createAdapter();
  const normalized: TaskPatch[] = [];
  for (const [i, raw] of patches.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new UsageError(`patches[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new UsageError(`patches[${i}].id is required`);
    }
    if (typeof r.projectId !== 'string' || r.projectId.length === 0) {
      throw new UsageError(`patches[${i}].projectId is required`);
    }
    if (typeof r.title !== 'string' || r.title.length === 0) {
      throw new UsageError(
        `patches[${i}].title is required (TickTick rejects updates with no title)`,
      );
    }
    const projectId = await resolveProjectId(adapter, r.projectId);
    const patch: TaskPatch = {
      id: r.id,
      projectId,
      title: r.title,
      ...(typeof r.content === 'string' && { content: r.content }),
      ...(typeof r.priority === 'string' && { priority: parsePriority(r.priority) }),
      ...(typeof r.dueDate === 'string' && { dueDate: r.dueDate }),
      ...(typeof r.startDate === 'string' && { startDate: r.startDate }),
      ...(typeof r.isAllDay === 'boolean' && { isAllDay: r.isAllDay }),
      ...(Array.isArray(r.tags) && { tags: r.tags as readonly string[] }),
      ...(typeof r.repeatFlag === 'string' && { repeatFlag: r.repeatFlag }),
      ...(typeof r.repeatEndDate === 'string' && { repeatEndDate: r.repeatEndDate }),
    };
    normalized.push(patch);
  }

  await adapter.updateTasksBatch(normalized);

  if (opts.human) {
    writeHuman(`Updated ${normalized.length} task${normalized.length === 1 ? '' : 's'} from ${file}`);
    return;
  }
  writeOk({ count: normalized.length, source: file });
}

export async function deleteMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idsRaw = requireFlag(flags, 'ids', 'comma-separated task ids');
  const ids = parseIdList(idsRaw);
  if (ids.length === 0) {
    throw new UsageError('--ids must contain at least one task id');
  }

  const adapter = createAdapter();
  // If --project is provided, every id is assumed to live there (no
  // round-trip resolution). Useful for bulk-deleting completed tasks,
  // which getTask() can't see because it reads the open-tasks index.
  const explicitProjectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;
  const items =
    explicitProjectId !== undefined
      ? ids.map((taskId) => ({ taskId, projectId: explicitProjectId }))
      : await resolveBatchItems(adapter, ids);

  await adapter.deleteTasksBatch(items);

  if (opts.human) {
    writeHuman(`Deleted ${items.length} task${items.length === 1 ? '' : 's'}`);
    return;
  }
  writeOk({ count: items.length, items });
}

export async function completeMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idsRaw = requireFlag(flags, 'ids', 'comma-separated task ids');
  const ids = parseIdList(idsRaw);
  if (ids.length === 0) {
    throw new UsageError('--ids must contain at least one task id');
  }

  const adapter = createAdapter();
  // Same --project shortcut as deleteMany — see comment there.
  const explicitProjectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;
  const items =
    explicitProjectId !== undefined
      ? ids.map((taskId) => ({ taskId, projectId: explicitProjectId }))
      : await resolveBatchItems(adapter, ids);

  await adapter.completeTasksBatch(items);

  if (opts.human) {
    writeHuman(`Completed ${items.length} task${items.length === 1 ? '' : 's'}`);
    return;
  }
  writeOk({ count: items.length, items });
}

// ──────────────────────────────────────────────────────────────────
// completed — paginated iterator OR statistics range
// ──────────────────────────────────────────────────────────────────

export async function completed(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);

  const hasFrom = flags.from !== undefined;
  const hasTo = flags.to !== undefined;
  const hasProject = flags.project !== undefined;

  if (hasFrom !== hasTo) {
    throw new UsageError('--from and --to must be passed together (closed range).');
  }
  if (hasFrom && hasProject) {
    throw new UsageError(
      '--from/--to (statistics range) and --project (paginated iterator) are mutually exclusive. Pick one mode.',
    );
  }

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number.parseInt(flags.limit, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageError(`--limit must be a non-negative integer, got: ${flags.limit}`);
    }
    limit = n;
  }

  const adapter = createAdapter();

  let result;
  let mode: 'iterator' | 'statistics';
  if (hasFrom && hasTo) {
    mode = 'statistics';
    result = await adapter.listCompletedTasks({
      from: flags.from!,
      to: flags.to!,
      ...(limit !== undefined && { limit }),
    });
  } else {
    mode = 'iterator';
    const projectId = hasProject ? await resolveProjectId(adapter, flags.project!) : undefined;
    result = await adapter.listCompletedTasks({
      ...(projectId !== undefined && { projectId }),
      ...(limit !== undefined && { limit }),
    });
  }

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ mode, count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// shared helpers (only used by the new bulk handlers above)
// ──────────────────────────────────────────────────────────────────

function parseIdList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function loadJsonFile<T>(path: string): Promise<T> {
  let text: string;
  try {
    const file = Bun.file(path);
    text = await file.text();
  } catch (err) {
    throw new UsageError(
      `--file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new UsageError(
      `--file ${path} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve a list of task ids into {taskId, projectId} pairs by fetching
 * each task. One round-trip per id — fine for the v1.3 batch sizes the
 * plan envisions; the FOLLOWUPS file should track caching this if batches
 * grow large. Throws NOT_FOUND on the first id that can't be resolved.
 */
async function resolveBatchItems(
  adapter: TickTickAdapter,
  ids: readonly string[],
): Promise<readonly { taskId: string; projectId: string }[]> {
  const items: { taskId: string; projectId: string }[] = [];
  for (const taskId of ids) {
    const task = await adapter.getTask(taskId);
    if (task === null) {
      throw new AdapterError('NOT_FOUND', `Task ${taskId} not found (cannot resolve project)`);
    }
    items.push({ taskId, projectId: task.projectId });
  }
  return items;
}

