/**
 * scripts/probe-reminders-update.ts — second-pass probe.
 *
 * Verifies:
 *   - update flow: replace reminders on an existing task
 *   - clear flow: set reminders=[]
 *   - what happens when we send {trigger} without an id (does TickTick
 *     auto-assign one and persist it?)
 *   - whether the singular `reminder` scalar must be sent or is server-managed
 *   - whether app re-fetching shows server-assigned ids
 *   - a 5-reminder limit probe
 */

import { TickTickClient, FileSessionStore, TickTickApiError } from 'ticktick-client';
import type { TickTickTaskDraft, TickTickTaskUpdate } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

sanitizeSessionFile();
const creds = loadCredentials();
if (!creds) throw new Error('no creds in env');

const client = new TickTickClient({
  credentials: { username: creds.email, password: creds.password },
  sessionStore: new FileSessionStore(resolveSessionPath()),
});

await client.login();

type RawTask = {
  id: string;
  projectId: string;
  reminders?: unknown;
  reminder?: unknown;
  [k: string]: unknown;
};

type RawProject = { id: string; name: string };
const projects = (await client.projects.list()) as readonly RawProject[];
const test = projects.find((p) => p.name === 'TEST - PAI Skill')!;
const dueIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();

function logErr(label: string, err: unknown): void {
  if (err instanceof TickTickApiError) {
    console.log(`  [${label}] ERR status=${err.status} body=${JSON.stringify(err.responseBody)}`);
  } else {
    console.log(`  [${label}] ERR ${(err as Error).message}`);
  }
}

// ── 1. create a base task with no reminders ──
const base = (await client.tasks.create({
  title: 'probe-update-base',
  projectId: test.id,
  dueDate: dueIso,
  isAllDay: false,
} as TickTickTaskDraft)) as unknown as RawTask;
console.log(`[base] id=${base.id} reminders=${JSON.stringify(base.reminders)}`);

// ── 2. update path: add 2 reminders without id ──
console.log(`\n[u1] update: set 2 reminders without explicit id`);
try {
  const u = (await client.tasks.update({
    id: base.id,
    projectId: test.id,
    title: 'probe-update-base',
    dueDate: dueIso,
    isAllDay: false,
    reminders: [{ trigger: 'TRIGGER:PT15M' }, { trigger: 'TRIGGER:P1D' }],
  } as unknown as TickTickTaskUpdate)) as unknown as RawTask;
  console.log(`  echo reminders=${JSON.stringify(u.reminders)}`);
  console.log(`  echo reminder=${JSON.stringify(u.reminder)}`);
} catch (e) { logErr('u1', e); }

// re-fetch via list
let listed = (await client.tasks.list()) as readonly RawTask[];
let cur = listed.find((t) => t.id === base.id)!;
console.log(`  re-listed reminders=${JSON.stringify(cur.reminders)}`);
console.log(`  re-listed reminder=${JSON.stringify(cur.reminder)}`);

// ── 3. update again to REPLACE with a different set ──
console.log(`\n[u2] update: replace with [PT5M] only`);
try {
  const u = (await client.tasks.update({
    id: base.id,
    projectId: test.id,
    title: 'probe-update-base',
    dueDate: dueIso,
    isAllDay: false,
    reminders: [{ trigger: 'TRIGGER:PT5M' }],
  } as unknown as TickTickTaskUpdate)) as unknown as RawTask;
  console.log(`  echo reminders=${JSON.stringify(u.reminders)}`);
} catch (e) { logErr('u2', e); }

listed = (await client.tasks.list()) as readonly RawTask[];
cur = listed.find((t) => t.id === base.id)!;
console.log(`  re-listed reminders=${JSON.stringify(cur.reminders)}`);
console.log(`  re-listed reminder=${JSON.stringify(cur.reminder)}`);

// ── 4. CLEAR via empty array ──
console.log(`\n[u3] update: clear via reminders=[]`);
try {
  const u = (await client.tasks.update({
    id: base.id,
    projectId: test.id,
    title: 'probe-update-base',
    dueDate: dueIso,
    isAllDay: false,
    reminders: [],
  } as unknown as TickTickTaskUpdate)) as unknown as RawTask;
  console.log(`  echo reminders=${JSON.stringify(u.reminders)} reminder=${JSON.stringify(u.reminder)}`);
} catch (e) { logErr('u3', e); }

listed = (await client.tasks.list()) as readonly RawTask[];
cur = listed.find((t) => t.id === base.id)!;
console.log(`  re-listed reminders=${JSON.stringify(cur.reminders)} reminder=${JSON.stringify(cur.reminder)}`);

// ── 5. multi-reminder limit probe: try 5 reminders ──
console.log(`\n[u4] update: set 5 reminders`);
try {
  const u = (await client.tasks.update({
    id: base.id,
    projectId: test.id,
    title: 'probe-update-base',
    dueDate: dueIso,
    isAllDay: false,
    reminders: [
      { trigger: 'TRIGGER:PT0S' },
      { trigger: 'TRIGGER:PT5M' },
      { trigger: 'TRIGGER:PT15M' },
      { trigger: 'TRIGGER:PT1H' },
      { trigger: 'TRIGGER:P1D' },
    ],
  } as unknown as TickTickTaskUpdate)) as unknown as RawTask;
  console.log(`  echo count=${(u.reminders as unknown[])?.length} reminders=${JSON.stringify(u.reminders)}`);
} catch (e) { logErr('u4', e); }

listed = (await client.tasks.list()) as readonly RawTask[];
cur = listed.find((t) => t.id === base.id)!;
console.log(`  re-listed count=${(cur.reminders as unknown[])?.length}`);
console.log(`  re-listed reminders=${JSON.stringify(cur.reminders)}`);

// ── 6. variations on the singular `reminder` scalar: omit, vs send ──
// (Already inferred to be server-managed from probe v3, but verify by sending empty array
// after sending non-empty — we did that in u3.)

// ── 7. cleanup ──
console.log(`\n[cleanup]`);
try {
  await client.tasks.delete(test.id, base.id);
  console.log(`  deleted ${base.id}`);
} catch (e) { logErr('del', e); }

console.log(`\n[done]`);
