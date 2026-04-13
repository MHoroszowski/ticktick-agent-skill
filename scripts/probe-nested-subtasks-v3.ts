/**
 * scripts/probe-nested-subtasks-v3.ts — round 3 discovery for PLAN_04.
 *
 * Round 1 + 2 established:
 *   - parentId persists ONLY when set on POST /api/v2/task at create time.
 *   - PATCH variants (POST /api/v2/task/{id}, /api/v2/batch/task with
 *     update[]) silently no-op for parentId mutations on existing tasks.
 *   - The /api/v2/task/parent endpoint returned 200 with parentId set, but
 *     the response had a brand new id and empty title — needs deeper look.
 *   - childIds[] on the parent is the canonical hydration mirror, but it
 *     wasn't auto-populated even when create-with-parentId was used.
 *
 * Round 3 questions:
 *   1. What does POST /api/v2/task/parent actually do? Try with proper
 *      body shapes (taskId in body, taskId in query, etc.). Inspect.
 *   2. Try POST /api/v2/batch/taskParent with different body shapes —
 *      it returned 500 in round 2, which means the endpoint EXISTS but
 *      our body was malformed. 500 is more interesting than 404.
 *   3. Also try a "sort" / "reorder" angle: does TickTick's parent move
 *      go through a sort/reorder endpoint?
 *   4. Re-test: does childIds appear on the parent after creating a
 *      child via create-with-parentId, AFTER waiting a beat for the
 *      server to rebuild the mirror?
 *   5. Is there an /api/v2/task/{parentId}/parent or a similar shape?
 *
 * Run:   bun run scripts/probe-nested-subtasks-v3.ts > /tmp/nested-probe-v3.log 2>&1
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

const TEST_PROJECT_ID = '69dc26bab1ef24d9b50e5775';
const TITLE_PREFIX = 'PROBE NS V3';

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
  // ────── Setup ──────
  header('SETUP');
  const parentId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: parentId,
    title: `${TITLE_PREFIX} parent`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: parentId, projectId: TEST_PROJECT_ID });

  const orphanId = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: orphanId,
    title: `${TITLE_PREFIX} orphan to indent`,
    projectId: TEST_PROJECT_ID,
  });
  createdTaskIds.push({ id: orphanId, projectId: TEST_PROJECT_ID });
  console.log(`parentId: ${parentId}, orphanId: ${orphanId}`);

  // ────── Q1 — investigate /api/v2/task/parent more carefully ──────
  header('Q1 — POST /api/v2/task/parent with various body shapes');

  const parentEndpointProbes: Array<{
    label: string;
    body: unknown;
  }> = [
    { label: '1a empty', body: {} },
    { label: '1b taskId only', body: { taskId: orphanId } },
    { label: '1c taskId+parentId', body: { taskId: orphanId, parentId, projectId: TEST_PROJECT_ID } },
    { label: '1d add[]', body: { add: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }] } },
    { label: '1e id+parentId', body: { id: orphanId, parentId, projectId: TEST_PROJECT_ID } },
  ];
  for (const p of parentEndpointProbes) {
    try {
      const result = await raw.request<unknown>('POST', '/api/v2/task/parent', p.body);
      console.log(`[${p.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`[${p.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 200)}`);
    }
  }
  // Check whether any of those actually changed orphan's parentId.
  const orphanAfter1 = await findTask(orphanId);
  console.log(
    `orphan parentId after Q1 probes: ${JSON.stringify((orphanAfter1 as { parentId?: unknown } | null)?.parentId)}`,
  );

  // Also list ALL tasks and look for ghost tasks created by these probes
  // (titles that are empty or have unexpected ids).
  const all = await listAllTasks();
  const ghosts = all.filter((t) => {
    const title = String(t.title ?? '');
    return title === '' && (t.parentId === parentId || t.parentId === orphanId);
  });
  console.log(`ghost tasks created by /task/parent probes: ${ghosts.length}`);
  for (const g of ghosts) {
    console.log(`  ghost id=${g.id} parentId=${(g as { parentId?: unknown }).parentId}`);
    createdTaskIds.push({ id: g.id as string, projectId: g.projectId as string });
  }

  // ────── Q2 — /api/v2/batch/taskParent with various body shapes ──────
  header('Q2 — POST /api/v2/batch/taskParent (returned 500 in v2, body matters)');
  const batchParentProbes: Array<{ label: string; body: unknown }> = [
    { label: '2a add+update+delete', body: { add: [], update: [], delete: [] } },
    { label: '2b update[]', body: { update: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }] } },
    {
      label: '2c add[]',
      body: { add: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }] },
    },
    {
      label: '2d nested ids',
      body: [{ taskId: orphanId, parentTaskId: parentId, projectId: TEST_PROJECT_ID }],
    },
  ];
  for (const p of batchParentProbes) {
    try {
      const result = await raw.request<unknown>('POST', '/api/v2/batch/taskParent', p.body);
      console.log(`[${p.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string; body?: unknown };
      console.log(
        `[${p.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 250)}`,
      );
    }
  }

  // ────── Q3 — /api/v2/batch/task richer shapes (sync style) ──────
  header('Q3 — /api/v2/batch/task richer payloads (parent op)');
  const orphanFetched = await findTask(orphanId);
  const orphanFull = orphanFetched ?? { id: orphanId, projectId: TEST_PROJECT_ID };
  const richProbes: Array<{ label: string; body: unknown }> = [
    {
      label: '3a moveParent',
      body: {
        moveParent: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }],
      },
    },
    {
      label: '3b parent op',
      body: {
        parent: [{ taskId: orphanId, parentId, projectId: TEST_PROJECT_ID }],
      },
    },
    {
      label: '3c update with full task and parentId',
      body: { update: [{ ...orphanFull, parentId }] },
    },
  ];
  for (const p of richProbes) {
    try {
      const result = await raw.request<unknown>('POST', '/api/v2/batch/task', p.body);
      console.log(`[${p.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(
        `[${p.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 200)}`,
      );
    }
  }
  const orphanAfter3 = await findTask(orphanId);
  console.log(
    `orphan parentId after Q3 probes: ${JSON.stringify((orphanAfter3 as { parentId?: unknown } | null)?.parentId)}`,
  );

  // ────── Q4 — does childIds rebuild after a delay? ──────
  header('Q4 — childIds on parent after create-with-parentId + delay');
  const childA = generateObjectId();
  const childB = generateObjectId();
  await raw.request('POST', '/api/v2/task', {
    id: childA,
    title: `${TITLE_PREFIX} q4 child A`,
    projectId: TEST_PROJECT_ID,
    parentId,
  });
  createdTaskIds.push({ id: childA, projectId: TEST_PROJECT_ID });
  await raw.request('POST', '/api/v2/task', {
    id: childB,
    title: `${TITLE_PREFIX} q4 child B`,
    projectId: TEST_PROJECT_ID,
    parentId,
  });
  createdTaskIds.push({ id: childB, projectId: TEST_PROJECT_ID });
  // Wait briefly and re-fetch parent.
  await new Promise((r) => setTimeout(r, 1000));
  const parentAfter = await findTask(parentId);
  dump('parent after 2 children created', parentAfter);
  console.log(
    `parent.childIds: ${JSON.stringify((parentAfter as { childIds?: unknown } | null)?.childIds)}`,
  );

  // ────── Q5 — try POST /api/v2/task/{parentId}/subtasks ──────
  header('Q5 — POST /api/v2/task/{parentId}/subtasks and other shapes');
  const subtaskProbes: Array<{ label: string; method: 'POST'|'GET'; path: string; body?: unknown }> = [
    { label: '5a children', method: 'POST', path: `/api/v2/task/${parentId}/children`, body: { taskId: orphanId } },
    { label: '5b subtasks', method: 'POST', path: `/api/v2/task/${parentId}/subtasks`, body: { taskId: orphanId } },
    { label: '5c GET children', method: 'GET',  path: `/api/v2/task/${parentId}/children` },
    { label: '5d GET subtasks', method: 'GET',  path: `/api/v2/task/${parentId}/subtasks` },
  ];
  for (const p of subtaskProbes) {
    try {
      const result = await raw.request<unknown>(p.method, p.path, p.body);
      console.log(`[${p.label}] OK →`, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      const e = err as { status?: number; message?: string };
      console.log(`[${p.label}] ERR ${e.status ?? '?'} ${(e.message ?? String(err)).slice(0, 200)}`);
    }
  }

  // ────── Q6 — does adding a NEW task with parentId cause childIds to update? ──────
  // After Q4 we have 2 children created with parentId. Force a 2nd list call
  // that bypasses any caching.
  header('Q6 — explicit second list to look for childIds + look at children parentId');
  const all2 = await listAllTasks();
  const parent2 = all2.find((t) => t.id === parentId);
  console.log(`parent.childIds (2nd list): ${JSON.stringify((parent2 as { childIds?: unknown } | undefined)?.childIds)}`);
  const childAFetched = all2.find((t) => t.id === childA);
  const childBFetched = all2.find((t) => t.id === childB);
  console.log(`childA.parentId: ${JSON.stringify((childAFetched as { parentId?: unknown } | undefined)?.parentId)}`);
  console.log(`childB.parentId: ${JSON.stringify((childBFetched as { parentId?: unknown } | undefined)?.parentId)}`);

  // ────── Q7 — re-PATCH the children with full body and explicit parentId. Does etag update? ──────
  header('Q7 — full-body PATCH child with parentId still set, observe etag/modifiedTime');
  const childARefetch = await findTask(childA);
  console.log(`childA etag before: ${(childARefetch as { etag?: string } | null)?.etag}`);
  const titleChange = (childARefetch as { title?: string } | null)?.title + ' (touched)';
  const patchResp = await raw.request('POST', `/api/v2/task/${childA}`, {
    ...childARefetch,
    title: titleChange,
  });
  dump('childA touched response', patchResp);
  const childAAfter = await findTask(childA);
  console.log(
    `childA after touch: title=${(childAAfter as { title?: string } | null)?.title}, parentId=${JSON.stringify((childAAfter as { parentId?: unknown } | null)?.parentId)}, etag=${(childAAfter as { etag?: string } | null)?.etag}`,
  );

  // ────── Q8 — try PATCH the PARENT with a childIds[] array ──────
  header('Q8 — PATCH parent with childIds[] explicitly');
  const parentRefetch = await findTask(parentId);
  const patchParent = { ...parentRefetch, childIds: [childA, childB] };
  try {
    const r = await raw.request('POST', `/api/v2/task/${parentId}`, patchParent);
    dump('parent patch with childIds response', r);
  } catch (err) {
    console.log(`ERR: ${(err as Error).message}`);
  }
  const parentAfter8 = await findTask(parentId);
  console.log(
    `parent.childIds after PATCH-parent: ${JSON.stringify((parentAfter8 as { childIds?: unknown } | null)?.childIds)}`,
  );
} catch (err) {
  console.log('PROBE V3 FAILED:');
  console.log(err);
} finally {
  header('CLEANUP');
  for (const c of createdTaskIds) {
    await safeDelete(c.id, c.projectId);
  }
  console.log(`cleanup deleted ${createdTaskIds.length} tasks`);
}
