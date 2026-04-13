/**
 * commands/tasks.ts — task CRUD and move.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman, formatTasksTable, formatTaskTree } from '../output.ts';
import { resolveUser } from '../users.ts';
import type { GlobalOpts } from '../cli.ts';
import type {
  TickTickAdapter,
  Task,
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

  const wantParent = flags.parent;
  const wantTopLevel = flags['top-level'] === 'true';
  const wantTree = flags.tree === 'true';

  if (wantParent !== undefined && wantTopLevel) {
    throw new UsageError('--parent and --top-level are mutually exclusive.');
  }
  if (wantTree && wantParent === undefined) {
    throw new UsageError(
      '--tree requires --parent <id> so the recursion has a starting root.',
    );
  }

  const filters: TaskListFilters = {
    ...(projectId !== undefined && { projectId }),
    ...(flags.status !== undefined && { status: parseStatusFilter(flags.status) }),
    ...(flags.due !== undefined && { due: parseDueFilter(flags.due) }),
    ...(flags.tag !== undefined && { tag: flags.tag }),
    ...(limit !== undefined && { limit }),
    ...(wantParent !== undefined && { parentId: wantParent }),
    ...(wantTopLevel && { topLevelOnly: true }),
  };

  // Tree mode: fetch ALL tasks once, then walk the parent chain client-side.
  // The /api/v3/batch/check/0 endpoint returns the entire account list in
  // one call, so this is no more expensive than the flat path.
  if (wantTree) {
    const all = await adapter.listTasks({
      ...(projectId !== undefined && { projectId }),
      status: 'all',
    });
    const tree = buildSubtree(all, wantParent!);
    if (opts.human) {
      writeHuman(formatTaskTree(tree));
      return;
    }
    writeOk({ count: countNodes(tree), tree });
    return;
  }

  const result = await adapter.listTasks(filters);

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// Tree helpers — used by `tasks list --parent <id> --tree`
// ──────────────────────────────────────────────────────────────────

export type TaskNode = {
  readonly task: Task;
  readonly children: readonly TaskNode[];
};

function buildSubtree(all: readonly Task[], rootId: string): readonly TaskNode[] {
  // Group tasks by their parentId for O(N) lookup.
  const byParent = new Map<string, Task[]>();
  for (const t of all) {
    if (t.parentId === null) continue;
    const bucket = byParent.get(t.parentId);
    if (bucket) {
      bucket.push(t);
    } else {
      byParent.set(t.parentId, [t]);
    }
  }
  const walk = (parentId: string): readonly TaskNode[] => {
    const direct = byParent.get(parentId) ?? [];
    return direct.map((t) => ({ task: t, children: walk(t.id) }));
  };
  return walk(rootId);
}

function countNodes(nodes: readonly TaskNode[]): number {
  let total = 0;
  for (const n of nodes) {
    total += 1 + countNodes(n.children);
  }
  return total;
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

  // --parent makes this a nested subtask. We resolve the parent first so
  // we can auto-fill the project from the parent if the user didn't pass
  // --project explicitly. This matches the natural intent: "add a child
  // under <parent>" doesn't need to know which list the parent lives in.
  let parentId: string | undefined;
  let parentProjectId: string | undefined;
  if (flags.parent !== undefined) {
    const parent = await adapter.getTask(flags.parent);
    if (!parent) {
      throw new AdapterError(
        'NOT_FOUND',
        `--parent ${flags.parent}: parent task not found.`,
      );
    }
    parentId = parent.id;
    parentProjectId = parent.projectId;
  }

  let projectId: string | undefined;
  if (flags.project !== undefined) {
    projectId = await resolveProjectId(adapter, flags.project);
  } else if (parentProjectId !== undefined) {
    projectId = parentProjectId;
  }

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
    ...(parentId !== undefined && { parentId }),
  };

  const task = await adapter.createTask(draft);

  if (opts.human) {
    if (parentId !== undefined) {
      writeHuman(`Created subtask ${task.id} under ${parentId}: ${task.title}`);
    } else {
      writeHuman(`Created task ${task.id}: ${task.title}`);
    }
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

  // Look up children before delete so we can warn the caller — TickTick
  // ORPHANS children (does NOT cascade-delete). The children remain with
  // their parentId pointing at the now-deleted parent id, which the
  // TickTick UI typically renders as top-level. Surfacing this lets the
  // agent decide whether to follow up with promote/cascade-delete.
  const orphanedChildren = await adapter.listSubtasks(id);

  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.deleteTask(id, projectId);

  if (opts.human) {
    if (orphanedChildren.length > 0) {
      writeHuman(
        `Deleted task ${id}. Note: ${orphanedChildren.length} child task(s) were orphaned (not cascade-deleted) — they still exist with their parentId pointing at the deleted parent.`,
      );
    } else {
      writeHuman(`Deleted task ${id}`);
    }
    return;
  }
  writeOk({
    deleted: id,
    ...(orphanedChildren.length > 0 && {
      orphanedChildren: orphanedChildren.map((c) => c.id),
      orphanNote:
        'TickTick does not cascade-delete nested subtasks. The listed children still exist with parentId pointing at the deleted parent. Promote or delete them explicitly if you want them gone.',
    }),
  });
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
// indent — re-parent an existing task under a different parent
// ──────────────────────────────────────────────────────────────────

export async function indent(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id to indent');
  const under = requireFlag(flags, 'under', 'new parent task id');

  if (id === under) {
    throw new UsageError(
      `--id and --under cannot be the same task (${id}). A task cannot be its own parent.`,
    );
  }

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.indentTask(id, projectId, under);

  if (opts.human) {
    writeHuman(`Indented ${id} under ${under}`);
    return;
  }
  writeOk({ taskId: id, parentId: under });
}

// ──────────────────────────────────────────────────────────────────
// promote — clear a task's parentId, making it top-level
// ──────────────────────────────────────────────────────────────────

export async function promote(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id to promote');

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.promoteTask(id, projectId);

  if (opts.human) {
    writeHuman(`Promoted ${id} to top-level`);
    return;
  }
  writeOk({ taskId: id, parentId: null });
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

