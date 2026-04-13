/**
 * scripts/probe-nested-subtasks-v4.ts — round 4 (final-attempt) discovery for PLAN_04.
 *
 * State after rounds 1-3:
 *   ✅ CREATE: POST /api/v2/task with `parentId` in body persists parentId.
 *      This is THE create-as-child path. Verified round-trip via /api/v3/batch/check/0.
 *   ✅ READ:  /api/v3/batch/check/0 returns parentId on the child as a stripped field
 *      (library type doesn't expose it but raw response carries it). childIds[]
 *      appears on the parent in long-lived production data but our test parents
 *      never showed it — possibly server-side eventual-consistency for newly-created
 *      relationships, or possibly only populated for tasks created before a certain
 *      schema migration. Either way, the AUTHORITATIVE field is child.parentId, NOT
 *      parent.childIds — the latter is a hydration mirror.
 *   ❌ INDENT (existing-task PATCH to set parentId): no patch shape against
 *      /api/v2/task/{id} or /api/v2/batch/task with update[] mutates the parentId
 *      of an existing task. Server silently no-ops, etag unchanged.
 *   ❌ PROMOTE (existing-task PATCH to clear parentId): same. Sending null,
 *      empty string, or omitting parentId from the full body all leave the
 *      original parentId in place.
 *   ❓ /api/v2/task/parent: returned 200 in some shapes but creates a new empty
 *      ghost task instead of mutating the existing target. Likely the
 *      "Add Subtask" endpoint behind the web UI's "+" inside a task.
 *   ❓ /api/v2/batch/taskParent: returned 500 for most body shapes, 200 for
 *      bare array `[{taskId, parentTaskId, projectId}]`, but the response
 *      indicated parentId remained null. Inconclusive — needs deeper probe.
 *   ❌ /api/v2/task/{id}/children, /api/v2/task/{id}/subtasks: 404.
 *
 * Round 4 questions:
 *   1. Confirm /api/v2/batch/taskParent is the right endpoint by trying every
 *      plausible body shape and verifying via re-fetch whether orphan.parentId
 *      changes.
 *   2. Try sending parent + child as separate fields: parentId / childId.
 *   3. Try the move() copy-and-delete pattern but for in-place re-parent:
 *      copy the task with a new id and parentId set, then delete the original.
 *      This is the "give up on PATCH, use copy+delete like move() does" fallback.
 *   4. Verify PROMOTE via copy+delete: copy the task with a new id and NO
 *      parentId, then delete the original.
 *
 * Run:   bun run scripts/probe-nested-subtasks-v4.ts > /tmp/nested-probe-v4.log 2>&1
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

const TEST_PROJECT_ID = '69dc26bab1ef24d9b50e5775';
const TITLE_PREFIX = 'PROBE NS V4';

sanitizeSessionFile();
const creds = loadCredentials();
if (!creds) throw new Error('no creds in env');

const client = new TickTickClient({
  credentials: { username: creds.email, password: creds.password },
  sessionStore: new FileSessionStore(resolveSessionPath()),
});
await client.login();

const raw = client as unknown as {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

const createdTaskIds: Array<{ id: string; projectId: string }> = [];

function generateObjectId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 24; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

function header(label: string): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(label);
  console.log('═══════════════════════════════════════════════════════════════');
}

function dump(label: string, value: unknown): void {
  console.log(`── ${label} ──`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function listAllTasks(): Promise<readonly Record<string, unknown>[]> {
  const response = await raw.request<{
    syncTaskBean?: { update?: readonly Record<string, unknown>[] };
  }>('GET', '/api/v3/batch/check/0');
  return response.syncTaskBean?.update ?? [];
}

async function findTask(taskId: string): Promise<Record<string, unknown> | null> {
  const all = await listAllTasks();
  return all.find((t) => t.id === taskId) ?? null;
}

async function safeDelete(id: string, projectId: string): Promise<void> {
  try {
    await raw.request('POST', `/api/v2/task/${id}`, { id, projectId, status: -1 });
  } catch {
    /* ignore */
  }
}

async function fresh(label: string): Promise<{ parent: string; orphan: string }> {
  const parent = generateObjectId();
  const orphan = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: parent,
    title: `${TITLE_PREFIX} ${label} parent`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: parent, projectId: TEST_PROJECT_ID });
  await raw.request('POST', '/api/v2/task', {
    id: orphan,
    title: `${TITLE_PREFIX} ${label} orphan`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: orphan, projectId: TEST_PROJECT_ID });
  return { parent, orphan };
}

try {
  // ────── Q1 — exhaustive body shapes for /api/v2/batch/taskParent ──────
  header('Q1 — /api/v2/batch/taskParent body shape exhaust');

  const q1Shapes: Array<{ label: string; body: unknown }> = [
    { label: '1a [{taskId,parentId,projectId}]', body: 'PLACEHOLDER' },
    { label: '1b [{taskId,parentTaskId,projectId}]', body: 'PLACEHOLDER' },
    { label: '1c {taskId,parentId,projectId}', body: 'PLACEHOLDER' },
    { label: '1d [{id,parentId,projectId}]', body: 'PLACEHOLDER' },
    { label: '1e {add:[{taskId,parentId,projectId}]}', body: 'PLACEHOLDER' },
  ];

  for (const shape of q1Shapes) {
    // Need fresh tasks per probe so we can detect mutation cleanly.
    const { parent, orphan } = await fresh(shape.label);
    let body: unknown;
    switch (shape.label) {
      case '1a [{taskId,parentId,projectId}]':
        body = [{ taskId: orphan, parentId: parent, projectId: TEST_PROJECT_ID }];
        break;
      case '1b [{taskId,parentTaskId,projectId}]':
        body = [{ taskId: orphan, parentTaskId: parent, projectId: TEST_PROJECT_ID }];
        break;
      case '1c {taskId,parentId,projectId}':
        body = { taskId: orphan, parentId: parent, projectId: TEST_PROJECT_ID };
        break;
      case '1d [{id,parentId,projectId}]':
        body = [{ id: orphan, parentId: parent, projectId: TEST_PROJECT_ID }];
        break;
      case '1e {add:[{taskId,parentId,projectId}]}':
        body = { add: [{ taskId: orphan, parentId: parent, projectId: TEST_PROJECT_ID }] };
        break;
    }
    try {
      const result = await raw.request<unknown>('POST', '/api/v2/batch/taskParent', body);
      console.log(`[${shape.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`[${shape.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 150)}`);
    }
    const orphanAfter = await findTask(orphan);
    console.log(
      `  orphan parentId AFTER ${shape.label}: ${JSON.stringify((orphanAfter as { parentId?: unknown } | null)?.parentId)} (expected: ${parent})`,
    );
  }

  // ────── Q2 — `/api/v2/batch/check/{N}` with `parentTaskId` move ──────
  // The library's tasks.list() goes to /api/v3/batch/check/0. Maybe the v2
  // counterpart is the sync receiver and accepts mutations.
  header('Q2 — /api/v3/batch/check/0 doesn\'t take POST; try /api/v3/batch/task with various ops');
  const { parent: q2Parent, orphan: q2Orphan } = await fresh('q2');
  const q2Shapes: Array<{ label: string; path: string; body: unknown }> = [
    {
      label: '2a /api/v3/batch/task',
      path: '/api/v3/batch/task',
      body: { update: [{ id: q2Orphan, projectId: TEST_PROJECT_ID, parentId: q2Parent }] },
    },
    {
      label: '2b /api/v3/batch/task with full body',
      path: '/api/v3/batch/task',
      body: {
        update: [
          {
            ...(await findTask(q2Orphan)),
            parentId: q2Parent,
          },
        ],
      },
    },
    {
      label: '2c /api/v2/batch/taskOrder',
      path: '/api/v2/batch/taskOrder',
      body: [{ taskId: q2Orphan, parentId: q2Parent, projectId: TEST_PROJECT_ID }],
    },
    {
      label: '2d /api/v2/batch/taskMove with parentId',
      path: '/api/v2/batch/taskMove',
      body: [{ taskId: q2Orphan, parentId: q2Parent, projectId: TEST_PROJECT_ID }],
    },
  ];
  for (const s of q2Shapes) {
    try {
      const result = await raw.request<unknown>('POST', s.path, s.body);
      console.log(`[${s.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`[${s.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 150)}`);
    }
  }
  const q2OrphanAfter = await findTask(q2Orphan);
  console.log(
    `q2 orphan parentId after probes: ${JSON.stringify((q2OrphanAfter as { parentId?: unknown } | null)?.parentId)}`,
  );

  // ────── Q3 — copy+delete pattern (the "move" workaround) for INDENT ──────
  header('Q3 — copy+delete pattern: indent existing task by re-creating with new id and parentId');
  const { parent: q3Parent, orphan: q3Orphan } = await fresh('q3');
  const q3OrphanFull = await findTask(q3Orphan);
  if (!q3OrphanFull) throw new Error('q3 orphan vanished');

  // Step 1: create a new task with new id, copying ALL fields and adding parentId.
  const q3NewChildId = generateObjectId();
  const copyResp = await raw.request('POST', '/api/v2/task', {
    ...q3OrphanFull,
    id: q3NewChildId,
    parentId: q3Parent,
  });
  createdTaskIds.push({ id: q3NewChildId, projectId: TEST_PROJECT_ID });
  dump('copy with parentId response', copyResp);

  // Verify the copy has parentId set.
  const copyRefetch = await findTask(q3NewChildId);
  const copyParentId = (copyRefetch as { parentId?: unknown } | null)?.parentId;
  console.log(`copy parentId: ${JSON.stringify(copyParentId)} (expect ${q3Parent})`);

  // Step 2: delete the original orphan.
  await raw.request('POST', `/api/v2/task/${q3Orphan}`, {
    id: q3Orphan,
    projectId: TEST_PROJECT_ID,
    status: -1,
  });
  // Mark orphan as deleted-by-us so finally cleanup doesn't double-delete.
  const ix = createdTaskIds.findIndex((c) => c.id === q3Orphan);
  if (ix >= 0) createdTaskIds.splice(ix, 1);

  // Verify original is gone.
  const orphanGone = await findTask(q3Orphan);
  console.log(`original orphan after delete: ${orphanGone === null ? 'GONE ✓' : 'STILL HERE'}`);
  console.log(`copy still here: ${(await findTask(q3NewChildId)) ? 'YES ✓' : 'NO'}`);

  // ────── Q4 — copy+delete pattern for PROMOTE ──────
  header('Q4 — copy+delete pattern: promote existing child by re-creating without parentId');
  const { parent: q4Parent } = await fresh('q4');
  const q4ChildId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: q4ChildId,
    title: `${TITLE_PREFIX} q4 child`,
    projectId: TEST_PROJECT_ID,
    parentId: q4Parent,
  });
  createdTaskIds.push({ id: q4ChildId, projectId: TEST_PROJECT_ID });
  const q4ChildFull = await findTask(q4ChildId);
  console.log(
    `q4 child created with parentId: ${JSON.stringify((q4ChildFull as { parentId?: unknown } | null)?.parentId)}`,
  );

  const q4PromotedId = generateObjectId();
  // Build a body that omits parentId entirely.
  const q4Body: Record<string, unknown> = { ...(q4ChildFull ?? {}), id: q4PromotedId };
  delete q4Body.parentId;
  const promotedResp = await raw.request('POST', '/api/v2/task', q4Body);
  createdTaskIds.push({ id: q4PromotedId, projectId: TEST_PROJECT_ID });
  dump('promoted copy response', promotedResp);
  const promotedRefetch = await findTask(q4PromotedId);
  console.log(
    `promoted copy parentId: ${JSON.stringify((promotedRefetch as { parentId?: unknown } | null)?.parentId)} (expect undefined)`,
  );

  // Delete the original child.
  await raw.request('POST', `/api/v2/task/${q4ChildId}`, {
    id: q4ChildId,
    projectId: TEST_PROJECT_ID,
    status: -1,
  });
  const ixc = createdTaskIds.findIndex((c) => c.id === q4ChildId);
  if (ixc >= 0) createdTaskIds.splice(ixc, 1);
  const childGone = await findTask(q4ChildId);
  console.log(`original child after delete: ${childGone === null ? 'GONE ✓' : 'STILL HERE'}`);
  console.log(`promoted copy still here: ${(await findTask(q4PromotedId)) ? 'YES ✓' : 'NO'}`);
} catch (err) {
  console.log('PROBE V4 FAILED:');
  console.log(err);
} finally {
  header('CLEANUP');
  for (const c of createdTaskIds) {
    await safeDelete(c.id, c.projectId);
  }
  console.log(`cleanup deleted ${createdTaskIds.length} tasks`);
}
