/**
 * scripts/probe-nested-subtasks-v5.ts — round 5 confirmation for PLAN_04.
 *
 * Round 4 found the canonical re-parent endpoint:
 *   POST /api/v2/batch/taskParent
 *   body: [{ taskId: <child>, parentId: <parent>, projectId: <project> }]
 *   200 → {id2etag: {<child>: {parentId, etag, ...}, <parent>: {childIds, etag, ...}}, id2error: {}}
 *
 * Confirmation questions:
 *   A. Does parentId: null promote (clear parentId)?
 *   B. Does it support cross-project nesting? (parent in project P1, child in project P2)
 *   C. Does parent-delete cascade-delete real children created via this endpoint?
 *      (Round 1 saw orphans, but those children were the ones whose parentId
 *      never actually persisted — so the round-1 answer is invalid.)
 *   D. Multi-level: indent task C under task B, where B is already a child of A.
 *      Does the API allow a 2-deep tree, and does the response show the chain?
 *   E. What happens when you indent a task under itself, or under a non-existent parent?
 *
 * Run:   bun run scripts/probe-nested-subtasks-v5.ts > /tmp/nested-probe-v5.log 2>&1
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

const TEST_PROJECT_ID = '69dc26bab1ef24d9b50e5775';
const SECONDARY_PROJECT_ID = '683c9308e051515e036af622';
const TITLE_PREFIX = 'PROBE NS V5';

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

async function createTask(label: string, projectId: string, parentId?: string): Promise<string> {
  const id = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id,
    title: `${TITLE_PREFIX} ${label}`,
    projectId,
    ...(parentId !== undefined && { parentId }),
  });
  createdTaskIds.push({ id, projectId });
  return id;
}

async function reparent(
  taskId: string,
  projectId: string,
  parentId: string | null,
): Promise<unknown> {
  return raw.request('POST', '/api/v2/batch/taskParent', [
    { taskId, parentId, projectId },
  ]);
}

try {
  // ────── A: parentId: null clears parent (promote) ──────
  header('A — promote via /api/v2/batch/taskParent with parentId: null');
  const aParent = await createTask('A parent', TEST_PROJECT_ID);
  const aChild = await createTask('A child', TEST_PROJECT_ID, aParent);
  const aChildBefore = await findTask(aChild);
  console.log(
    `child parentId before promote: ${JSON.stringify((aChildBefore as { parentId?: unknown } | null)?.parentId)}`,
  );
  const aPromoteResp = await reparent(aChild, TEST_PROJECT_ID, null);
  dump('promote response', aPromoteResp);
  const aChildAfter = await findTask(aChild);
  console.log(
    `child parentId after promote: ${JSON.stringify((aChildAfter as { parentId?: unknown } | null)?.parentId)}`,
  );
  const aParentAfter = await findTask(aParent);
  console.log(
    `parent childIds after promote: ${JSON.stringify((aParentAfter as { childIds?: unknown } | null)?.childIds)}`,
  );

  // ────── B: cross-project nesting ──────
  header('B — cross-project: child in project P2 with parent in P1');
  const bParent = await createTask('B parent in TEST', TEST_PROJECT_ID);
  const bChild = await createTask('B child in OTHER', SECONDARY_PROJECT_ID);
  // Try to set parent across projects — projectId in the body should match the CHILD's project.
  try {
    const bResp = await reparent(bChild, SECONDARY_PROJECT_ID, bParent);
    dump('cross-project reparent (child projectId)', bResp);
  } catch (err) {
    console.log(`cross-project reparent ERR: ${(err as Error).message}`);
  }
  const bChildAfter = await findTask(bChild);
  console.log(
    `B child after: parentId=${JSON.stringify((bChildAfter as { parentId?: unknown } | null)?.parentId)}, projectId=${JSON.stringify((bChildAfter as { projectId?: unknown } | null)?.projectId)}`,
  );
  // Also try with the PARENT's projectId in the body — does the server accept either?
  const bChild2 = await createTask('B child2 in OTHER', SECONDARY_PROJECT_ID);
  try {
    const bResp2 = await reparent(bChild2, TEST_PROJECT_ID, bParent);
    dump('cross-project reparent (parent projectId)', bResp2);
  } catch (err) {
    console.log(`alt-projectId ERR: ${(err as Error).message}`);
  }
  const bChild2After = await findTask(bChild2);
  console.log(
    `B child2 after: parentId=${JSON.stringify((bChild2After as { parentId?: unknown } | null)?.parentId)}, projectId=${JSON.stringify((bChild2After as { projectId?: unknown } | null)?.projectId)}`,
  );

  // ────── C: parent delete with REAL nested child — orphan or cascade? ──────
  header('C — delete parent that has a properly-nested child');
  const cParent = await createTask('C parent', TEST_PROJECT_ID);
  const cChild = await createTask('C child', TEST_PROJECT_ID, cParent);
  const cChildBefore = await findTask(cChild);
  console.log(
    `C child parentId before parent delete: ${JSON.stringify((cChildBefore as { parentId?: unknown } | null)?.parentId)}`,
  );
  // Delete parent.
  await raw.request('POST', `/api/v2/task/${cParent}`, {
    id: cParent,
    projectId: TEST_PROJECT_ID,
    status: -1,
  });
  const ixp = createdTaskIds.findIndex((c) => c.id === cParent);
  if (ixp >= 0) createdTaskIds.splice(ixp, 1);
  const cChildAfter = await findTask(cChild);
  if (cChildAfter === null) {
    console.log('C child GONE → parent delete CASCADES.');
  } else {
    console.log('C child STILL PRESENT → parent delete ORPHANS.');
    console.log(
      `C child parentId after parent delete: ${JSON.stringify((cChildAfter as { parentId?: unknown }).parentId)}`,
    );
  }

  // ────── D: multi-level nesting (3 levels) ──────
  header('D — 3-level nesting: A → B → C');
  const dA = await createTask('D level A', TEST_PROJECT_ID);
  const dB = await createTask('D level B', TEST_PROJECT_ID, dA);
  const dC = await createTask('D level C', TEST_PROJECT_ID, dB);
  const dAFetch = await findTask(dA);
  const dBFetch = await findTask(dB);
  const dCFetch = await findTask(dC);
  console.log(`A childIds: ${JSON.stringify((dAFetch as { childIds?: unknown } | null)?.childIds)}`);
  console.log(
    `B parentId: ${JSON.stringify((dBFetch as { parentId?: unknown } | null)?.parentId)}, B childIds: ${JSON.stringify((dBFetch as { childIds?: unknown } | null)?.childIds)}`,
  );
  console.log(
    `C parentId: ${JSON.stringify((dCFetch as { parentId?: unknown } | null)?.parentId)}`,
  );

  // ────── E: error cases ──────
  header('E — error handling: re-parent under self / under non-existent parent');
  const eTask = await createTask('E lone task', TEST_PROJECT_ID);
  // Self
  try {
    const r = await reparent(eTask, TEST_PROJECT_ID, eTask);
    console.log(`reparent under self OK → ${JSON.stringify(r).slice(0, 300)}`);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.log(`reparent under self ERR ${e.status ?? '?'} ${(e.message ?? '').slice(0, 200)}`);
  }
  const eAfterSelf = await findTask(eTask);
  console.log(
    `E after self-reparent: parentId=${JSON.stringify((eAfterSelf as { parentId?: unknown } | null)?.parentId)}`,
  );

  // Non-existent parent
  try {
    const r2 = await reparent(eTask, TEST_PROJECT_ID, '0'.repeat(24));
    console.log(`reparent under non-existent OK → ${JSON.stringify(r2).slice(0, 300)}`);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.log(`reparent under non-existent ERR ${e.status ?? '?'} ${(e.message ?? '').slice(0, 200)}`);
  }
  const eAfterFake = await findTask(eTask);
  console.log(
    `E after fake-parent reparent: parentId=${JSON.stringify((eAfterFake as { parentId?: unknown } | null)?.parentId)}`,
  );
} catch (err) {
  console.log('PROBE V5 FAILED:');
  console.log(err);
} finally {
  header('CLEANUP');
  for (const c of createdTaskIds) {
    await safeDelete(c.id, c.projectId);
  }
  console.log(`cleanup deleted ${createdTaskIds.length} tasks`);
}
