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

  const filters: TaskListFilters = {
    ...(projectId !== undefined && { projectId }),
    ...(flags.status !== undefined && { status: parseStatusFilter(flags.status) }),
    ...(flags.due !== undefined && { due: parseDueFilter(flags.due) }),
    ...(flags.tag !== undefined && { tag: flags.tag }),
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

function parseDueFilter(value: string): 'today' | 'overdue' | 'week' {
  const v = value.toLowerCase();
  if (v === 'today' || v === 'overdue' || v === 'week') return v;
  throw new UsageError(`--due must be one of: today, overdue, week. Got: ${value}`);
}

function parseTagList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

