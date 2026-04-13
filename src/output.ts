/**
 * output.ts — stdout/stderr writers + human table formatters.
 *
 * Default output is JSON. `--human` is opt-in. Error envelope is always
 * JSON on stdout: {"ok": false, "error": {"code", "message", "retryable"}}.
 *
 * Debug output goes to stderr and is gated by a module-level flag so the
 * CLI dispatcher can enable it via --debug without routing the flag
 * through every command.
 */

import { AdapterError, UsageError, mapLibraryError } from './errors.ts';
import { getCachedUsers } from './users.ts';
import { formatTriggerOffset } from './reminders.ts';
import type { Task, Project, Tag, ChecklistItem } from './adapter.ts';

let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

export function writeOk(data: object): void {
  process.stdout.write(JSON.stringify({ ok: true, ...data }) + '\n');
}

export function writeError(err: unknown): void {
  const envelope = buildErrorEnvelope(err);
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

export function writeHuman(text: string): void {
  process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
}

export function writeDebug(...parts: unknown[]): void {
  if (!debugEnabled) return;
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  process.stderr.write(`[debug] ${line}\n`);
}

// ──────────────────────────────────────────────────────────────────
// Error envelope
// ──────────────────────────────────────────────────────────────────

function buildErrorEnvelope(
  err: unknown,
): { ok: false; error: { code: string; message: string; retryable: boolean } } {
  if (err instanceof UsageError) {
    return {
      ok: false,
      error: { code: 'USAGE', message: err.message, retryable: false },
    };
  }
  const mapped = err instanceof AdapterError ? err : mapLibraryError(err);
  return {
    ok: false,
    error: {
      code: mapped.code,
      message: mapped.message,
      retryable: mapped.retryable,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Human table formatters (no external deps)
// ──────────────────────────────────────────────────────────────────

const REMINDERS_CELL_WIDTH = 12;

export function formatTasksTable(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '(no tasks)';
  const knownUsers = getCachedUsers();
  const anyAssigned = tasks.some((t) => t.assignee !== null);
  const anyPinned = tasks.some((t) => t.pinnedAt !== null);
  // Only show the 🔔 reminders column when at least one task actually
  // has a reminder — same conditional pattern as the assignee column.
  // Keeps the default narrow table uncluttered for the common case.
  const anyReminders = tasks.some((t) => t.reminders.length > 0);

  const rows = tasks.map((t) => ({
    id: shortenId(t.id),
    status: t.status.padEnd(10),
    pri: priorityGlyph(t.priority),
    pin: t.pinnedAt !== null ? '📌' : '  ',
    due: formatDue(t.dueDate),
    assignee: anyAssigned ? resolveAssigneeName(t.assignee, knownUsers) : null,
    reminders: anyReminders ? formatRemindersCompact(t.reminders) : null,
    title: t.title,
    project: shortenId(t.projectId),
  }));

  // Optional columns (pin, assignee, reminders) are rendered independently
  // via per-cell formatters that emit empty string when the flag is off.
  // This keeps the default narrow table uncluttered for the common case
  // and supports every combination without combinatoric branches.
  const REMIND_W = REMINDERS_CELL_WIDTH;
  const pinHeader = anyPinned ? '📌 ' : '';
  const pinCell = (r: { pin: string }): string => (anyPinned ? `${r.pin} ` : '');
  const assignHeader = anyAssigned ? `${'ASSIGN'.padEnd(10)} ` : '';
  const assignCell = (r: { assignee: string | null }): string =>
    anyAssigned ? `${(r.assignee ?? '—').padEnd(10)} ` : '';
  const remindHeader = anyReminders ? `${'🔔'.padEnd(REMIND_W)} ` : '';
  const remindCell = (r: { reminders: string | null }): string =>
    anyReminders ? `${(r.reminders ?? '').padEnd(REMIND_W)} ` : '';

  // Title width shrinks as optional columns are added so the table stays
  // within ~120 cols on a typical terminal.
  const titleW = 50 - (anyAssigned ? 5 : 0) - (anyReminders ? 5 : 0);

  const header = `${'ID'.padEnd(9)} ${'STATUS'.padEnd(10)} ${'PRI'} ${pinHeader}${'DUE'.padEnd(16)} ${assignHeader}${remindHeader}${'TITLE'.padEnd(titleW)} ${'PROJECT'}`;
  const divider = '─'.repeat(Math.min(130, header.length));
  const body = rows
    .map(
      (r) =>
        `${r.id.padEnd(9)} ${r.status} ${r.pri.padEnd(3)} ${pinCell(r)}${r.due.padEnd(16)} ${assignCell(r)}${remindCell(r)}${truncate(r.title, titleW).padEnd(titleW)} ${r.project}`,
    )
    .join('\n');
  return `${header}\n${divider}\n${body}`;
}

/**
 * Render a reminders[] array as a compact cell value for the table (e.g.
 * `15m,1d`). Gracefully truncates with a trailing `+N` if the cell would
 * exceed the cell width — keeps row alignment stable when a task has
 * many reminders.
 */
function formatRemindersCompact(reminders: readonly string[]): string {
  if (reminders.length === 0) return '';
  const parts = reminders.map(formatTriggerOffset);
  const out = parts.join(',');
  if (out.length <= REMINDERS_CELL_WIDTH) return out;
  let i = 0;
  let acc = '';
  while (i < parts.length) {
    const next = acc.length === 0 ? parts[i]! : `${acc},${parts[i]!}`;
    if (next.length + 3 > REMINDERS_CELL_WIDTH) break; // leave room for "+N"
    acc = next;
    i += 1;
  }
  const overflow = parts.length - i;
  return overflow > 0 ? `${acc}+${overflow}` : acc;
}

function resolveAssigneeName(
  assignee: number | null,
  known: readonly { userId: number; displayName: string | null }[],
): string {
  if (assignee === null) return '';
  const match = known.find((u) => u.userId === assignee);
  if (match?.displayName) return truncate(match.displayName, 10);
  return `#${String(assignee).slice(-6)}`;
}

export function formatProjectsTable(projects: readonly Project[]): string {
  if (projects.length === 0) return '(no projects)';
  const header = `${'ID'.padEnd(9)} ${'NAME'.padEnd(36)} ${'KIND'.padEnd(6)} ${'COLOR'.padEnd(8)} ${'CLOSED'}`;
  const divider = '─'.repeat(Math.min(85, header.length));
  const body = projects
    .map(
      (p) =>
        `${shortenId(p.id).padEnd(9)} ${truncate(p.name, 36).padEnd(36)} ${(p.kind ?? '').padEnd(6)} ${(p.color ?? '').padEnd(8)} ${p.closed ? 'yes' : 'no'}`,
    )
    .join('\n');
  return `${header}\n${divider}\n${body}`;
}

export function formatTagsTable(tags: readonly Tag[]): string {
  if (tags.length === 0) return '(no tags)';
  const header = `${'NAME'.padEnd(20)} ${'LABEL'.padEnd(20)} ${'COLOR'.padEnd(8)} ${'PARENT'}`;
  const divider = '─'.repeat(Math.min(70, header.length));
  const body = tags
    .map(
      (t) =>
        `${truncate(t.name, 20).padEnd(20)} ${truncate(t.label ?? '', 20).padEnd(20)} ${(t.color ?? '').padEnd(8)} ${t.parent ?? ''}`,
    )
    .join('\n');
  return `${header}\n${divider}\n${body}`;
}

/**
 * Compact human summary for a bulk operation. Used by `tasks create-many`,
 * `tasks update-many`, `tasks delete-many`, `tasks complete-many`. The JSON
 * shape is { count, ... } so this is just the human-mode line.
 */
export function formatBatchResult(verb: string, count: number, source?: string): string {
  const noun = count === 1 ? 'task' : 'tasks';
  return source ? `${verb} ${count} ${noun} from ${source}` : `${verb} ${count} ${noun}`;
}

export function formatChecklistItems(items: readonly ChecklistItem[]): string {
  if (items.length === 0) return '(no checklist items)';
  return items
    .map((i) => {
      const box = i.completed ? '[x]' : '[ ]';
      return `${box} ${shortenId(i.id).padEnd(9)} ${i.title}`;
    })
    .join('\n');
}

function shortenId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(-8);
}

function priorityGlyph(priority: string): string {
  switch (priority) {
    case 'high':
      return '!!!';
    case 'medium':
      return '!!';
    case 'low':
      return '!';
    default:
      return ' ';
  }
}

function formatDue(dueDate: string | null): string {
  if (!dueDate) return '';
  const ms = Date.parse(dueDate);
  if (Number.isNaN(ms)) return dueDate.slice(0, 16);
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
