/**
 * scripts/probe-reminders.ts — discover the on-the-wire shape of the
 * `reminders` field on TickTick tasks.
 *
 * v3 strategy:
 *   1. Confirm baseline: create a task without reminders. Should succeed.
 *   2. Create one task per candidate `reminders` shape. Log the
 *      TickTickApiError.responseBody on 500s so we know what TickTick is
 *      complaining about.
 *   3. For any successful create, re-fetch via tasks.list() and via raw GET
 *      and dump the reminders field shape exactly as it comes back.
 *   4. Cleanup all probe tasks at the end.
 *
 * Run: bun run scripts/probe-reminders.ts
 */

import { TickTickClient, FileSessionStore, TickTickApiError } from 'ticktick-client';
import type { TickTickTaskDraft } from 'ticktick-client';
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

const raw = client as unknown as {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

type RawProject = { id: string; name: string };
const projects = (await client.projects.list()) as readonly RawProject[];
const test = projects.find((p) => p.name === 'TEST - PAI Skill');
if (!test) {
  console.error("TEST - PAI Skill project not found.");
  process.exit(1);
}
console.log(`[probe] using project ${test.name} (${test.id})`);

const dueIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
console.log(`[probe] dueDate = ${dueIso}\n`);

type RawTask = {
  id: string;
  projectId: string;
  reminders?: unknown;
  reminder?: unknown;
  [k: string]: unknown;
};

function logErr(label: string, err: unknown): void {
  if (err instanceof TickTickApiError) {
    console.log(`  [${label}] ERR status=${err.status}`);
    console.log(`            body=${JSON.stringify(err.responseBody)}`);
  } else {
    console.log(`  [${label}] ERR ${(err as Error).message}`);
  }
}

const created: { label: string; id: string; sent: unknown }[] = [];

// ── Phase 1: baseline (no reminders at all) ──
{
  const label = '0-baseline';
  const draft = {
    title: `probe ${label}`,
    projectId: test.id,
    dueDate: dueIso,
    isAllDay: false,
  } as TickTickTaskDraft;
  console.log(`[create ${label}] no reminders field`);
  try {
    const r = (await client.tasks.create(draft)) as unknown as RawTask;
    console.log(`  OK id=${r.id} reminders=${JSON.stringify(r.reminders)} reminder=${JSON.stringify(r.reminder)}`);
    console.log(`  keys=${Object.keys(r).sort().join(',')}`);
    created.push({ label, id: r.id, sent: null });
  } catch (e) {
    logErr(label, e);
  }
}

// ── Phase 2: try each candidate reminders shape ──
type Probe = { label: string; reminders: unknown };
const probes: readonly Probe[] = [
  { label: 'A-strings-unsigned',   reminders: ['TRIGGER:PT15M', 'TRIGGER:P1D'] },
  { label: 'B-strings-signed',     reminders: ['TRIGGER:-PT15M', 'TRIGGER:-P1D'] },
  { label: 'C-objects-trigger',    reminders: [{ trigger: 'TRIGGER:PT15M' }, { trigger: 'TRIGGER:P1D' }] },
  { label: 'D-objects-id-trigger', reminders: [
    { id: '6800000000000000000000a1', trigger: 'TRIGGER:PT15M' },
    { id: '6800000000000000000000a2', trigger: 'TRIGGER:P1D' },
  ] },
  { label: 'E-singular-string',    reminders: 'TRIGGER:PT15M' },
];

for (const p of probes) {
  const draft = {
    title: `probe ${p.label}`,
    projectId: test.id,
    dueDate: dueIso,
    isAllDay: false,
    reminders: p.reminders,
  } as unknown as TickTickTaskDraft;
  console.log(`\n[create ${p.label}] reminders=${JSON.stringify(p.reminders)}`);
  try {
    const r = (await client.tasks.create(draft)) as unknown as RawTask;
    console.log(`  OK id=${r.id}`);
    console.log(`  echo reminders=${JSON.stringify(r.reminders)} reminder=${JSON.stringify(r.reminder)}`);
    console.log(`  keys=${Object.keys(r).sort().join(',')}`);
    created.push({ label: p.label, id: r.id, sent: p.reminders });
  } catch (e) {
    logErr(p.label, e);
  }
}

// ── Phase 3: re-fetch via tasks.list() ──
console.log(`\n[re-fetch via tasks.list()]`);
const listed = (await client.tasks.list()) as readonly RawTask[];
for (const c of created) {
  const found = listed.find((t) => t.id === c.id);
  if (!found) {
    console.log(`  ${c.label}: NOT FOUND`);
    continue;
  }
  const reminderKeys = Object.keys(found).filter((k) => k.toLowerCase().includes('remind'));
  console.log(`  ${c.label}: reminderKeys=${JSON.stringify(reminderKeys)}`);
  for (const k of reminderKeys) {
    console.log(`    ${k}=${JSON.stringify(found[k])}`);
  }
}

// ── Phase 4: dump full first task body for inspection ──
if (created.length > 0) {
  console.log(`\n[full dump of first listed task]`);
  const first = listed.find((t) => t.id === created[0]!.id);
  if (first) {
    console.log(JSON.stringify(first, null, 2));
  }
}

// ── Phase 5: cleanup ──
console.log(`\n[cleanup]`);
for (const c of created) {
  try {
    await client.tasks.delete(test.id, c.id);
    console.log(`  deleted ${c.label} (${c.id})`);
  } catch (e) {
    logErr(`del ${c.label}`, e);
  }
}

console.log('\n[done]');
