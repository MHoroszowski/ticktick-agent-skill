/**
 * commands/checklist.ts — checklist items within a task.
 *
 * v1 scope: checklist items only (the `items[]` field on a task).
 * Nested subtasks (parentId-based child tasks) are NOT yet supported.
 * See README.md for the follow-up work.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { writeOk, writeHuman, formatChecklistItems } from '../output.ts';
import type { GlobalOpts } from '../cli.ts';

export async function list(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const taskId = requireFlag(flags, 'task', 'parent task id');

  const adapter = createAdapter();
  const items = await adapter.listChecklistItems(taskId);

  if (opts.human) {
    writeHuman(formatChecklistItems(items));
    return;
  }
  writeOk({ count: items.length, items });
}

export async function add(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const taskId = requireFlag(flags, 'task', 'parent task id');
  const projectId = requireFlag(flags, 'project', 'parent task\'s project id');
  const title = requireFlag(flags, 'title', 'checklist item text');

  const adapter = createAdapter();
  const task = await adapter.addChecklistItem(taskId, projectId, { title });

  if (opts.human) {
    writeHuman(`Added checklist item to task ${task.id}: ${title}`);
    return;
  }
  writeOk({ task });
}

export async function complete(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const taskId = requireFlag(flags, 'task', 'parent task id');
  const projectId = requireFlag(flags, 'project', 'parent task\'s project id');
  const itemId = requireFlag(flags, 'item', 'checklist item id');

  const adapter = createAdapter();

  // Verify item exists before mutating — gives a cleaner NOT_FOUND than letting
  // the API silently ignore it.
  const existing = await adapter.listChecklistItems(taskId);
  if (!existing.some((i) => i.id === itemId)) {
    throw new AdapterError('NOT_FOUND', `Checklist item ${itemId} not found on task ${taskId}`);
  }

  const task = await adapter.completeChecklistItem(taskId, projectId, itemId);

  if (opts.human) {
    writeHuman(`Completed checklist item ${itemId} on task ${task.id}`);
    return;
  }
  writeOk({ task });
}

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const taskId = requireFlag(flags, 'task', 'parent task id');
  const projectId = requireFlag(flags, 'project', 'parent task\'s project id');
  const itemId = requireFlag(flags, 'item', 'checklist item id');

  const adapter = createAdapter();

  const existing = await adapter.listChecklistItems(taskId);
  if (!existing.some((i) => i.id === itemId)) {
    throw new AdapterError('NOT_FOUND', `Checklist item ${itemId} not found on task ${taskId}`);
  }

  const task = await adapter.deleteChecklistItem(taskId, projectId, itemId);

  if (opts.human) {
    writeHuman(`Deleted checklist item ${itemId} from task ${task.id}`);
    return;
  }
  writeOk({ task });
}
