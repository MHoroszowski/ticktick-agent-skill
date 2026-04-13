/**
 * scripts/probe-nested-subtasks-v2.ts — round 2 discovery for PLAN_04.
 *
 * Round 1 (probe-nested-subtasks.ts) found:
 *   - parentId IS persisted when set at task-CREATE time (POST /api/v2/task)
 *   - parentId is NOT persisted when set via PATCH (POST /api/v2/task/{id})
 *     against an existing task with just {id, projectId, parentId} body
 *   - The API maintains childIds[] on the PARENT as the canonical hydration
 *     mirror; child carries parentId; both are stripped by the library type.
 *
 * Round 2 questions:
 *   1. Does PATCH actually mutate parentId if we send the FULL task body
 *      (mimicking how the library's move() uses the existing task as base)?
 *   2. Is there a dedicated /api/v2/batch endpoint for parent reassignment?
 *   3. What does a real indent-then-list cycle look like for childIds on
 *      the parent — does TickTick auto-update it, or does the client
 *      need to PATCH the parent's childIds explicitly?
 *   4. Does explicit null vs missing differ for promote semantics?
 *
 * Run:   bun run scripts/probe-nested-subtasks-v2.ts > /tmp/nested-probe-v2.log 2>&1
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

const TEST_PROJECT_ID = '69dc26bab1ef24d9b50e5775';
const TITLE_PREFIX = 'PROBE NS V2';

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
  } catch (err) {
    console.log(`cleanup: failed to delete ${id}: ${(err as Error).message}`);
  }
}

try {
  // ────── Setup: parent + child ──────
  header('SETUP — create parent and a top-level "to indent" task');
  const parentId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: parentId,
    title: `${TITLE_PREFIX} parent`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: parentId, projectId: TEST_PROJECT_ID });
  console.log(`parent id: ${parentId}`);

  const orphanId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: orphanId,
    title: `${TITLE_PREFIX} orphan to indent`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: orphanId, projectId: TEST_PROJECT_ID });
  console.log(`orphan id: ${orphanId}`);

  // ────── Q1a — PATCH with full task body, including parentId ──────
  header('Q1a — PATCH full task body with parentId added');
  const orphanFetched = await findTask(orphanId);
  dump('orphan before indent', orphanFetched);
  const fullBodyIndent = { ...orphanFetched, parentId };
  const fullBodyResp = await raw.request('POST', `/api/v2/task/${orphanId}`, fullBodyIndent);
  dump('full-body indent POST response', fullBodyResp);
  const refetched = await findTask(orphanId);
  dump('refetch after full-body indent', refetched);
  console.log(
    `parentId persisted? ${(refetched as { parentId?: unknown } | null)?.parentId === parentId}`,
  );

  // ────── Q3 — does childIds get auto-updated on the parent? ──────
  header('Q3 — does the parent show childIds after indent?');
  const parentRefetched = await findTask(parentId);
  dump('parent after indent', parentRefetched);
  const parentChildIds = (parentRefetched as { childIds?: unknown } | null)?.childIds;
  console.log(`parent.childIds: ${JSON.stringify(parentChildIds)}`);

  // ────── Q2 — try /api/v2/batch/taskParent (guess) ──────
  header('Q2 — probe candidate dedicated parent endpoints');
  const batchProbes: Array<{
    label: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
  }> = [
    {
      label: 'A',
      method: 'POST',
      path: '/api/v2/batch/taskParent',
      body: { add: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }] },
    },
    {
      label: 'B',
      method: 'POST',
      path: '/api/v2/batch/parent',
      body: { taskId: orphanId, parentId, projectId: TEST_PROJECT_ID },
    },
    {
      label: 'C',
      method: 'POST',
      path: '/api/v2/task/parent',
      body: { taskId: orphanId, parentId, projectId: TEST_PROJECT_ID },
    },
    {
      label: 'D',
      method: 'POST',
      path: `/api/v2/task/${orphanId}/parent`,
      body: { parentId, projectId: TEST_PROJECT_ID },
    },
    {
      label: 'E',
      method: 'POST',
      path: '/api/v2/parentTask',
      body: { taskId: orphanId, parentId, projectId: TEST_PROJECT_ID },
    },
  ];
  for (const p of batchProbes) {
    const tag = `[${p.label}] ${p.method} ${p.path}`;
    try {
      const result = await raw.request<unknown>(p.method, p.path, p.body);
      console.log(`${tag} OK →`, JSON.stringify(result));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`${tag} ERR status=${e.status ?? '?'} msg=${(e.message ?? String(err)).slice(0, 200)}`);
    }
  }

  // ────── Q4 — promote: full body without parentId vs explicit null ──────
  header('Q4 — promote semantics: omit parentId vs explicit null vs explicit ""');

  // First, set up a known child: create with parentId at create time.
  const childId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: childId,
    title: `${TITLE_PREFIX} child for promote test`,
    projectId: TEST_PROJECT_ID,
    parentId,
  });
  createdTaskIds.push({ id: childId, projectId: TEST_PROJECT_ID });
  const childInitial = await findTask(childId);
  dump('child after create-with-parentId', childInitial);
  console.log(
    `initial parentId on child: ${JSON.stringify((childInitial as { parentId?: unknown }).parentId)}`,
  );

  // Approach 1: PATCH full body, omit parentId entirely.
  console.log('\n--- approach 1: PATCH full body, omit parentId ---');
  const omitBody: Record<string, unknown> = { ...(childInitial ?? {}) };
  delete omitBody.parentId;
  await raw.request('POST', `/api/v2/task/${childId}`, omitBody);
  const afterOmit = await findTask(childId);
  console.log(
    `parentId after omit: ${JSON.stringify((afterOmit as { parentId?: unknown } | null)?.parentId)}`,
  );

  // Re-establish parent for next test.
  await raw.request('POST', `/api/v2/task/${childId}`, { ...(afterOmit ?? {}), parentId });
  const reEstablished = await findTask(childId);
  console.log(
    `parentId after re-establish via full body: ${JSON.stringify((reEstablished as { parentId?: unknown } | null)?.parentId)}`,
  );

  // Approach 2: PATCH with parentId: null.
  console.log('\n--- approach 2: PATCH full body with parentId: null ---');
  await raw.request('POST', `/api/v2/task/${childId}`, { ...(reEstablished ?? {}), parentId: null });
  const afterNull = await findTask(childId);
  console.log(
    `parentId after explicit null: ${JSON.stringify((afterNull as { parentId?: unknown } | null)?.parentId)}`,
  );

  // Approach 3: PATCH with parentId: "" (empty string).
  console.log('\n--- approach 3: PATCH full body with parentId: "" ---');
  // Re-establish first.
  await raw.request('POST', `/api/v2/task/${childId}`, { ...(afterNull ?? {}), parentId });
  await raw.request('POST', `/api/v2/task/${childId}`, { ...(afterNull ?? {}), parentId: '' });
  const afterEmpty = await findTask(childId);
  console.log(
    `parentId after explicit "": ${JSON.stringify((afterEmpty as { parentId?: unknown } | null)?.parentId)}`,
  );

  // ────── Q5 — what about the "v2/batch/task" sync-style endpoint? ──────
  header('Q5 — try /api/v2/batch/task with update[] containing parentId');
  // This is the sync delta endpoint — POST to it with an "update" array
  // containing a task object including parentId might be the canonical
  // way the web app does mutations.
  try {
    const syncUpdate = await raw.request('POST', '/api/v2/batch/task', {
      update: [{ ...childInitial, parentId }],
    });
    dump('batch/task update[] response', syncUpdate);
    const afterSync = await findTask(childId);
    console.log(
      `parentId after batch/task update: ${JSON.stringify((afterSync as { parentId?: unknown } | null)?.parentId)}`,
    );
  } catch (err) {
    console.log(`batch/task ERR: ${(err as Error).message}`);
  }

  // ────── Q6 — sortOrder semantics: maybe parentId only sticks if sortOrder is right ──────
  header('Q6 — does sortOrder matter? Try indent with sortOrder copied from parent');
  const sortOrderCandidate = (parentRefetched as { sortOrder?: number } | null)?.sortOrder ?? 0;
  console.log(`parent sortOrder: ${sortOrderCandidate}`);

  const o2Id = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: o2Id,
    title: `${TITLE_PREFIX} sortOrder test`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: o2Id, projectId: TEST_PROJECT_ID });
  const o2Initial = await findTask(o2Id);
  await raw.request('POST', `/api/v2/task/${o2Id}`, {
    ...o2Initial,
    parentId,
    sortOrder: sortOrderCandidate - 1,
  });
  const o2After = await findTask(o2Id);
  console.log(
    `parentId after sortOrder-aware PATCH: ${JSON.stringify((o2After as { parentId?: unknown } | null)?.parentId)}`,
  );
} catch (err) {
  console.log('PROBE V2 FAILED:');
  console.log(err);
} finally {
  header('CLEANUP');
  for (const c of createdTaskIds) {
    await safeDelete(c.id, c.projectId);
    console.log(`deleted ${c.id}`);
  }
}
