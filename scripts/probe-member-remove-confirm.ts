/**
 * Second-stage confirmation for endpoint H discovered in probe-member-remove.ts.
 *
 * Probe H:  DELETE /api/v2/project/{PID}/share/{UID}
 *
 * Tests two additional cases to rule out "H is a catch-all that 2xx-es
 * every DELETE regardless of path":
 *
 *   1. DELETE with owner's userId (115368611). If H is the real endpoint,
 *      the server should either refuse (owner can't be removed) OR still
 *      return 2xx — either way informative.
 *   2. DELETE /api/v2/project/{PID}/share/{BOGUS_PATH} with garbage to see
 *      if ANY DELETE under /share/ 2xx-es (ruling out a catch-all).
 *
 * Run after the main probe. Read-only-ish: removing yourself would be a
 * no-op for an owner; the garbage path can't affect real state.
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
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

const PID = '6852d2ff8f0867dce3d54ff5';

type Probe = { label: string; method: 'DELETE'; path: string };
const probes: readonly Probe[] = [
  // Owner — refusing this cleanly is a strong signal the endpoint is real
  { label: 'H-owner',   method: 'DELETE', path: `/api/v2/project/${PID}/share/115368611` },
  // Bogus userId shape (non-numeric) — should 400/404 if endpoint is real
  { label: 'H-bogus',   method: 'DELETE', path: `/api/v2/project/${PID}/share/notanumber` },
  // Bogus project id — should 404 project-not-found if endpoint is real
  { label: 'H-badpid',  method: 'DELETE', path: `/api/v2/project/000000000000000000000000/share/999999999` },
];

for (const p of probes) {
  const tag = `[${p.label}] ${p.method} ${p.path}`;
  try {
    const result = await raw.request<unknown>(p.method, p.path);
    console.log(`${tag}\n  OK →`, JSON.stringify(result));
  } catch (err) {
    const e = err as { status?: number; message?: string; body?: unknown };
    console.log(`${tag}\n  ERR status=${e.status ?? '?'} msg=${e.message ?? err} body=${JSON.stringify(e.body ?? null)}`);
  }
}
