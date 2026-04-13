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

export function formatTasksTable(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '(no tasks)';
  const knownUsers = getCachedUsers();
  const anyAssigned = tasks.some((t) => t.assignee !== null);
  const anyPinned = tasks.some((t) => t.pinnedAt !== null);

  const rows = tasks.map((t) => ({
    id: shortenId(t.id),
    status: t.status.padEnd(10),
    pri: priorityGlyph(t.priority),
    pin: t.pinnedAt !== null ? '📌' : '  ',
    due: formatDue(t.dueDate),
    assignee: anyAssigned ? resolveAssigneeName(t.assignee, knownUsers) : null,
    title: truncate(t.title, 50),
    project: shortenId(t.projectId),
  }));

  // PIN column is only emitted when at least one task is pinned — keeps
  // the table narrow for the common case.
  const pinHeader = anyPinned ? '📌 ' : '';
  const pinCell = (r: { pin: string }): string => (anyPinned ? `${r.pin} ` : '');

  if (anyAssigned) {
    const header = `${'ID'.padEnd(9)} ${'STATUS'.padEnd(10)} ${'PRI'} ${pinHeader}${'DUE'.padEnd(16)} ${'ASSIGN'.padEnd(10)} ${'TITLE'.padEnd(45)} ${'PROJECT'}`;
    const divider = '─'.repeat(Math.min(115, header.length));
    const body = rows
      .map(
        (r) =>
          `${r.id.padEnd(9)} ${r.status} ${r.pri.padEnd(3)} ${pinCell(r)}${r.due.padEnd(16)} ${(r.assignee ?? '—').padEnd(10)} ${truncate(r.title, 45).padEnd(45)} ${r.project}`,
      )
      .join('\n');
    return `${header}\n${divider}\n${body}`;
  }

  const header = `${'ID'.padEnd(9)} ${'STATUS'.padEnd(10)} ${'PRI'} ${pinHeader}${'DUE'.padEnd(16)} ${'TITLE'.padEnd(50)} ${'PROJECT'}`;
  const divider = '─'.repeat(Math.min(105, header.length));
  const body = rows
    .map(
      (r) =>
        `${r.id.padEnd(9)} ${r.status} ${r.pri.padEnd(3)} ${pinCell(r)}${r.due.padEnd(16)} ${r.title.padEnd(50)} ${r.project}`,
    )
    .join('\n');
  return `${header}\n${divider}\n${body}`;
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
