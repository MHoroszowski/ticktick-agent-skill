/**
 * Exercise the new `members.remove` command directly, bypassing cli.ts
 * (which Athena will wire at the end). Two runs:
 *
 *   1. Without --force: should print confirmation to stderr and throw UsageError.
 *   2. With --force and a fake userId: should call removeMember on the
 *      adapter (which returns 2xx/undefined), diff the member list, and
 *      report stillPresent=false (because the fake user wasn't in the list
 *      to begin with) and remainingCount=3.
 *
 * This proves the full wiring works end-to-end without actually mutating
 * any real member.
 */

import * as members from '../src/commands/members.ts';

const PID = '6852d2ff8f0867dce3d54ff5';
const FAKE_UID = '999999999';

console.error('--- Run 1: confirmation required ---');
try {
  await members.remove(['--project', PID, '--user', FAKE_UID], { human: false, debug: false });
} catch (err) {
  console.error(`(expected) threw: ${(err as Error).message}`);
}

console.error('--- Run 2: --force with fake userId ---');
await members.remove(
  ['--project', PID, '--user', FAKE_UID, '--force'],
  { human: false, debug: false },
);
