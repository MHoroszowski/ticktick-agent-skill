/**
 * scripts/probe-member-remove.ts — scratch endpoint-discovery script.
 *
 * Reverse-engineers the TickTick v2 API endpoint for removing a member
 * from a shared project. Reuses the main skill's session store so we
 * don't have to re-authenticate.
 *
 * Methodology: probe each candidate endpoint with a FAKE userId (999999999).
 *   - If the response says the user doesn't exist / isn't a member
 *     → endpoint exists, we found it.
 *   - If the response says the endpoint doesn't exist (HTML 404, generic
 *     "Not Found", etc.) → wrong endpoint, move on.
 *
 * Run:   bun run scripts/probe-member-remove.ts
 *
 * Not part of the shipping skill — lives under scripts/ as a reference.
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

// Force a login/session warm-up so the internal request() method is ready.
await client.login();

// Expose the internal request() method via a structural cast.
const raw = client as unknown as {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

// TEST target: the Shopping project. We're using a FAKE userId so no real
// member is touched. 999999999 is not a real TickTick userId in this account.
const PID = '6852d2ff8f0867dce3d54ff5';
const FAKE_UID = 999999999;

type Probe = {
  readonly label: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
};

const probes: readonly Probe[] = [
  { label: 'A', method: 'DELETE', path: `/api/v2/project/${PID}/users/${FAKE_UID}` },
  { label: 'B', method: 'POST',   path: `/api/v2/project/${PID}/users/${FAKE_UID}/remove` },
  { label: 'C', method: 'POST',   path: `/api/v2/project/${PID}/share/remove`, body: { userId: FAKE_UID } },
  { label: 'D', method: 'POST',   path: `/api/v2/batch/shareUser`, body: { delete: [{ projectId: PID, userId: FAKE_UID }] } },
  { label: 'E', method: 'POST',   path: `/api/v2/project/${PID}/user/remove`, body: { userId: FAKE_UID } },
  { label: 'F', method: 'POST',   path: `/api/v2/share/project/${PID}/removeUser`, body: { userId: FAKE_UID } },
  { label: 'G', method: 'DELETE', path: `/api/v2/project/${PID}/user/${FAKE_UID}` },
  { label: 'H', method: 'DELETE', path: `/api/v2/project/${PID}/share/${FAKE_UID}` },
  { label: 'I', method: 'POST',   path: `/api/v2/project/${PID}/share/delete`, body: { userId: FAKE_UID } },
  { label: 'J', method: 'POST',   path: `/api/v2/project/${PID}/removeMember`, body: { userId: FAKE_UID } },
  { label: 'K', method: 'DELETE', path: `/api/v2/projectShare/${PID}/user/${FAKE_UID}` },
  { label: 'L', method: 'POST',   path: `/api/v2/projectShare/deleteShare`, body: { projectId: PID, userId: FAKE_UID } },
];

for (const p of probes) {
  const tag = `[${p.label}] ${p.method} ${p.path}${p.body ? ' ' + JSON.stringify(p.body) : ''}`;
  try {
    const result = await raw.request<unknown>(p.method, p.path, p.body);
    console.log(`${tag}\n  OK →`, JSON.stringify(result));
  } catch (err) {
    const e = err as { status?: number; message?: string; body?: unknown };
    console.log(`${tag}\n  ERR status=${e.status ?? '?'} msg=${e.message ?? err} body=${JSON.stringify(e.body ?? null)}`);
  }
}
