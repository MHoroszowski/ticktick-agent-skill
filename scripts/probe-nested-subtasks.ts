/**
 * scripts/probe-nested-subtasks.ts — endpoint discovery for PLAN_04 nested subtasks.
 *
 * Reverse-engineers TickTick's parentId-based nested-subtask API by probing
 * the same /api/v2/task and /api/v3/batch/check/0 endpoints the library
 * already uses, but with a `parentId` field in the body.
 *
 * Methodology mirrors scripts/probe-member-remove.ts: reuse the live skill
 * session (no need to re-auth), hit each candidate operation against the
 * `TEST - PAI Skill` project, dump raw request/response, then clean up.
 *
 * Why direct API probing instead of Playwright traffic capture?
 *   - Same evidence quality: we see the exact request body that lands on
 *     the server and the exact response body that comes back.
 *   - Reproducible: the script lives in the repo and can be re-run.
 *   - Faster: no browser harness, no manual click sequences, no flakiness.
 *   - Library is a transparent passthrough for /api/v2/task — TasksModule
 *     in dist/index.js literally does `request("POST", "/api/v2/task", {id, ...draft})`,
 *     so anything we POST verbatim is what the server sees, identical to
 *     what the web app would send if it used REST instead of WebSocket.
 *
 * If a probe is inconclusive (e.g. parentId silently stripped), we fall
 * back to Playwright for that one specific gap. So far that hasn't been
 * needed for any other endpoint discovered against this API.
 *
 * Run:   bun run scripts/probe-nested-subtasks.ts > /tmp/nested-probe.log 2>&1
 *
 * Output: structured per-capture log written to stdout. The plan file's
 * "Discovery results" section gets filled in by hand from this output.
 *
 * Cleanup: the script tracks every task it creates and best-effort deletes
 * them in a `finally` block. If you Ctrl-C mid-run, scan the TEST project
 * for "PROBE NS" titles and delete them manually.
 *
 * NOT part of the shipping skill. Reference artifact for PLAN_04 only.
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

// ──────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────

// TEST - PAI Skill project id, looked up before running this script.
// If the smoke project ever gets recreated, refresh via `ticktick projects list`.
const TEST_PROJECT_ID = '69dc26bab1ef24d9b50e5775';
const SECONDARY_PROJECT_ID = '683c9308e051515e036af622'; // 🖥️Other Projects — used for cross-project capture E

const TITLE_PREFIX = 'PROBE NS';

// ──────────────────────────────────────────────────────────────────
// Session bootstrap
// ──────────────────────────────────────────────────────────────────

sanitizeSessionFile();
const creds = loadCredentials();
if (!creds) throw new Error('no creds in env');

const client = new TickTickClient({
  credentials: { username: creds.email, password: creds.password },
  sessionStore: new FileSessionStore(resolveSessionPath()),
});
await client.login();

// Structural cast to access the library's internal request() helper.
// Same pattern used by adapter.ts for members and sections.
const raw = client as unknown as {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

// Track every task we create so we can clean up at the end.
const createdTaskIds: Array<{ id: string; projectId: string }> = [];

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function generateObjectId(): string {
  // Lightweight 24-hex generator (the library's internal one is identical
  // shape — random bytes, hex-encoded). Sufficient for create-via-POST.
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

async function postTask(body: Record<string, unknown>): Promise<unknown> {
  return raw.request('POST', '/api/v2/task', body);
}

async function patchTask(id: string, body: Record<string, unknown>): Promise<unknown> {
  return raw.request('POST', `/api/v2/task/${id}`, body);
}

async function listAllTasks(): Promise<readonly Record<string, unknown>[]> {
  // The library's tasks.list() does this exact call; we hit it directly so
  // we see the full raw response shape (including any fields the library
  // strips at the type layer).
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
    await patchTask(id, { id, projectId, status: -1 });
  } catch (err) {
    console.log(`cleanup: failed to delete ${id}: ${(err as Error).message}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// Captures
// ──────────────────────────────────────────────────────────────────

try {
  // ────── Capture F (run first — answers "does the GET response carry parentId at all?") ──────
  header('CAPTURE F — GET task list raw shape (look for parentId / childIds)');
  const allTasksBefore = await listAllTasks();
  console.log(`Total tasks in account: ${allTasksBefore.length}`);
  // Dump field names of the first task so we can see all keys, including
  // any parentId / childIds the library's TickTickTask type strips.
  const sample = allTasksBefore[0];
  if (sample) {
    console.log('Field names on first raw task:');
    console.log(JSON.stringify(Object.keys(sample).sort(), null, 2));
    dump('Full first raw task', sample);
  }
  // Specifically look for any task that already has parentId set.
  const tasksWithParent = allTasksBefore.filter((t) => {
    const v = t.parentId;
    return typeof v === 'string' && v.length > 0;
  });
  console.log(`Tasks with non-empty parentId in account: ${tasksWithParent.length}`);
  if (tasksWithParent.length > 0) {
    dump('Example task with parentId', tasksWithParent[0]);
  }
  const tasksWithChildIds = allTasksBefore.filter((t) => {
    const v = t.childIds;
    return Array.isArray(v) && v.length > 0;
  });
  console.log(`Tasks with non-empty childIds in account: ${tasksWithChildIds.length}`);
  if (tasksWithChildIds.length > 0) {
    dump('Example task with childIds', tasksWithChildIds[0]);
  }

  // ────── Setup: create two top-level tasks for subsequent captures ──────
  header('SETUP — create two top-level tasks in TEST project');
  const parentId = generateObjectId();
  const parentResp = (await postTask({
    id: parentId,
    title: `${TITLE_PREFIX} parent A`,
    projectId: TEST_PROJECT_ID,
  })) as Record<string, unknown>;
  createdTaskIds.push({ id: parentId, projectId: TEST_PROJECT_ID });
  dump('parent A POST response', parentResp);

  const futureChildId = generateObjectId();
  const futureChildResp = (await postTask({
    id: futureChildId,
    title: `${TITLE_PREFIX} future child A`,
    projectId: TEST_PROJECT_ID,
  })) as Record<string, unknown>;
  createdTaskIds.push({ id: futureChildId, projectId: TEST_PROJECT_ID });
  dump('future child A POST response', futureChildResp);

  // ────── Capture A — indent gesture (mutate existing top-level task to have parentId) ──────
  header('CAPTURE A — indent: PATCH existing task to set parentId');
  // The "indent gesture" in the web UI updates an existing top-level task
  // to be a child of another. We replicate via POST /api/v2/task/{id} with
  // parentId in the body.
  const indentResp = (await patchTask(futureChildId, {
    id: futureChildId,
    projectId: TEST_PROJECT_ID,
    parentId: parentId,
  })) as Record<string, unknown>;
  dump('indent POST response', indentResp);
  // Re-fetch via list — does the server now return parentId on this task?
  const indentedRefetch = await findTask(futureChildId);
  dump('refetch after indent', indentedRefetch);
  console.log(
    `parentId echoed back? ${(indentedRefetch as { parentId?: unknown } | null)?.parentId === parentId}`,
  );

  // ────── Capture B — direct subtask creation (POST a new task with parentId from the start) ──────
  header('CAPTURE B — direct subtask: POST new task with parentId in body');
  const directChildId = generateObjectId();
  const directChildResp = (await postTask({
    id: directChildId,
    title: `${TITLE_PREFIX} direct child B`,
    projectId: TEST_PROJECT_ID,
    parentId: parentId,
  })) as Record<string, unknown>;
  createdTaskIds.push({ id: directChildId, projectId: TEST_PROJECT_ID });
  dump('direct child POST response', directChildResp);
  const directRefetch = await findTask(directChildId);
  dump('refetch direct child', directRefetch);
  console.log(
    `parentId echoed back? ${(directRefetch as { parentId?: unknown } | null)?.parentId === parentId}`,
  );

  // ────── Capture C — promote (set parentId to null) ──────
  header('CAPTURE C — promote: PATCH child to null parentId');
  const promoteResp = (await patchTask(futureChildId, {
    id: futureChildId,
    projectId: TEST_PROJECT_ID,
    parentId: null,
  })) as Record<string, unknown>;
  dump('promote POST response', promoteResp);
  const promotedRefetch = await findTask(futureChildId);
  dump('refetch after promote', promotedRefetch);
  const promotedParentId = (promotedRefetch as { parentId?: unknown } | null)?.parentId;
  console.log(`parentId after promote: ${JSON.stringify(promotedParentId)} (expect null/missing)`);

  // ────── Capture D — re-parent (move under different parent) ──────
  header('CAPTURE D — re-parent: PATCH child to a different parent');
  // Create a second top-level parent.
  const parent2Id = generateObjectId();
  const parent2Resp = (await postTask({
    id: parent2Id,
    title: `${TITLE_PREFIX} parent D2`,
    projectId: TEST_PROJECT_ID,
  })) as Record<string, unknown>;
  createdTaskIds.push({ id: parent2Id, projectId: TEST_PROJECT_ID });
  dump('parent2 POST response', parent2Resp);

  // First indent under parent A, then re-parent under parent2.
  await patchTask(directChildId, {
    id: directChildId,
    projectId: TEST_PROJECT_ID,
    parentId: parentId,
  });
  const reparentResp = (await patchTask(directChildId, {
    id: directChildId,
    projectId: TEST_PROJECT_ID,
    parentId: parent2Id,
  })) as Record<string, unknown>;
  dump('re-parent POST response', reparentResp);
  const reparentRefetch = await findTask(directChildId);
  dump('refetch after re-parent', reparentRefetch);
  console.log(
    `parentId now ${(reparentRefetch as { parentId?: unknown } | null)?.parentId} (expect ${parent2Id})`,
  );

  // ────── Capture E — cross-project move (does parentId survive?) ──────
  header('CAPTURE E — cross-project move: copy task with parentId to other project');
  // Library's move() does copy + delete via POST /api/v2/task with the
  // existing task body but new id and projectId. Replicate, including
  // the parentId field, and observe whether the server keeps or strips it.
  const crossNewId = generateObjectId();
  const crossResp = (await postTask({
    id: crossNewId,
    title: `${TITLE_PREFIX} cross-project child E`,
    projectId: SECONDARY_PROJECT_ID,
    parentId: parentId, // parent lives in TEST_PROJECT_ID, child going to a different project
  })) as Record<string, unknown>;
  createdTaskIds.push({ id: crossNewId, projectId: SECONDARY_PROJECT_ID });
  dump('cross-project create with parentId POST response', crossResp);
  const crossRefetch = await findTask(crossNewId);
  dump('refetch cross-project child', crossRefetch);
  const crossParentEcho = (crossRefetch as { parentId?: unknown } | null)?.parentId;
  console.log(
    `parentId after cross-project create: ${JSON.stringify(crossParentEcho)} (was ${parentId})`,
  );

  // ────── Capture G — delete parent with children, observe orphan policy ──────
  header('CAPTURE G — delete parent with children: orphaned or cascaded?');
  // First, ensure parent A still has at least one child (re-indent
  // futureChildId back under parent A so we have a known child).
  await patchTask(futureChildId, {
    id: futureChildId,
    projectId: TEST_PROJECT_ID,
    parentId: parentId,
  });
  // Sanity-check the child IS under parent A.
  const childCheck = await findTask(futureChildId);
  dump('child sanity-check before parent delete', childCheck);

  // Delete parent A (status=-1).
  await patchTask(parentId, { id: parentId, projectId: TEST_PROJECT_ID, status: -1 });
  // Mark in tracking — already deleted, don't double-delete in finally.
  const idxParent = createdTaskIds.findIndex((c) => c.id === parentId);
  if (idxParent >= 0) createdTaskIds.splice(idxParent, 1);

  // Now check the child: still present? Still has parentId? Or gone?
  const orphanCheck = await findTask(futureChildId);
  if (orphanCheck === null) {
    console.log('CHILD GONE — cascade delete (parent delete removes children).');
  } else {
    console.log('CHILD STILL PRESENT — orphan policy:');
    dump('child after parent delete', orphanCheck);
    const stillHasParent = (orphanCheck as { parentId?: unknown }).parentId;
    console.log(
      `child.parentId after parent delete: ${JSON.stringify(stillHasParent)} (deleted parent id was ${parentId})`,
    );
  }
} catch (err) {
  console.log('PROBE FAILED:');
  console.log(err);
} finally {
  // Cleanup: best-effort delete every task we created.
  header('CLEANUP — deleting all probe tasks');
  for (const c of createdTaskIds) {
    await safeDelete(c.id, c.projectId);
    console.log(`deleted ${c.id} from ${c.projectId}`);
  }
  console.log('cleanup complete.');
}
