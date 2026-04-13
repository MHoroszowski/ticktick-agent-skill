# TickTick skill

A PAI skill that gives an AI agent (Athena) access to the user's TickTick account via a thin Bun CLI wrapping the `ticktick-client` npm library.

Uses the **unofficial v2 TickTick API** (the same one the ticktick.com web app uses) rather than the severely limited official v1 OpenAPI. This is the only way to get full CRUD, tag management, move operations, and deletion — none of which the v1 API supports.

## What it does

| Capability | Status |
|---|---|
| Tasks — list / get / create / update / complete / delete | ✅ |
| Tasks — move between lists | ✅ *(with caveat: returns new id; see below)* |
| Tasks — pin / unpin / restore | ✅ *(restore requires explicit id — trash listing is broken upstream)* |
| Tasks — bulk create / update / delete / complete | ✅ |
| Tasks — recurring end date (`--repeat-end <ISO>`) | ✅ |
| Tasks — completed-task listing (paginated iterator OR statistics range) | ✅ |
| Tasks — filter by project, status, due window, tag, section, assignee, limit | ✅ |
| Tasks — smart-list filters (`today` / `tomorrow` / `overdue` / `week` / `next7days` / `none` / `--pinned`) | ✅ |
| Tasks — `--section` (kanban column) on create and update | ✅ |
| Tasks — `--assignee` (shared-list assignment) on create and update | ✅ |
| Projects (lists) — list / get / create / update / delete | ✅ *(delete requires `--confirm`)* |
| Tags — list / create | ✅ |
| Tags — update / rename / merge / delete | ⚠️ *(CLI returns ok but tags write-module is broken upstream — see Known quirks)* |
| Sections (kanban columns) — list / create / rename / delete / reorder | ✅ *(delete requires `--confirm`; supports `--reassign` to move tasks)* |
| Shared-list members — list / remove | ✅ *(remove is dry-run by default; `--force` to commit)* |
| Checklist items inside a task — list / add / complete / delete | ✅ |
| Automatic session refresh on 401/auth-expired | ✅ |
| JSON output (default) and `--human` table output | ✅ |

## Honest limits

**Nested subtasks are NOT supported.** TickTick has two features both called "subtasks":
1. **Checklist items** inside a task — lightweight, stored in `task.items[]`. ✅ Supported here.
2. **True nested subtasks** — indented child tasks with their own due dates, priorities, and tags, linked via `parentId`. ❌ NOT supported — the underlying `ticktick-client` library doesn't expose `parentId`-based nesting.

This is the largest intentional gap remaining. It's tracked as a follow-up — see `FOLLOWUPS.md` in this directory. The work required is reverse-engineering TickTick's v2 subtask endpoints via browser DevTools / Playwright traffic capture (the same technique `jaeyeonling` used for the rest of the library) and either patching upstream or forking.

**Other intentional gaps in v1.3:**

- ❌ **Reminders (time-based or location)** — deferred to v1.4. The field exists in the raw API but the library strips it on read and ignores it on write.
- ❌ **2FA / MFA accounts** — the library does not implement the 2FA login flow. Accounts with 2FA enabled will fail at login.
- ❌ **Focus sessions, habits, calendar events, countdowns** — not exposed in this skill.
- ⚠️ **Trash listing** — TickTick's v2 API has a known bug where the `status=-1` (trash) filter is ignored. Deleted tasks cannot be listed through the skill; use the TickTick web UI to find the id, then `tasks restore --id <id> --project <pid>` works.
- ⚠️ **Task moves change the task id.** TickTick's REST API doesn't support in-place project moves, so `tasks move` is implemented as copy-to-destination + delete-from-source. The response includes both the new task and `previousId` so the agent can update any references.
- ⚠️ **`projects delete` requires `--confirm`.** Without it, the CLI prints a warning showing the affected task count and exits with validation error code 6. This is a deliberate safety gate because deleting a project also deletes every task inside it.

## Known quirks in v1.3

These are upstream library quirks we've identified during smoke-testing. Documented here so you know what to expect before reaching for a sharp-edged feature.

### The whole tags write-module is broken upstream

`tags rename`, `tags delete`, `tags update`, and `tags merge` are all broken in v1.3. The CLI returns `ok: true` but TickTick's server silently drops the mutation — verified empirically 2026-04-13 for rename (label not updated) and delete (tag stays visible). The others share the same endpoint (`POST /api/v2/batch/tag`) and are almost certainly broken the same way.

**Only `tags create` and `tags list` work reliably.**

**Effect on you as a user:**
- Try to delete a tag → the CLI says success, but the tag is still there.
- Try to rename a tag → the CLI says success, but the tag still has its old label.
- Try to merge two tags → probably the same deal.

**Workarounds until the library is fixed:**
- **Need to delete a tag cleanly:** use the TickTick web UI directly.
- **Need to "rename" a tag:** create a new tag with `tags create --name <new>`, re-tag each affected task with `tasks update --tags <new>` (you'll need to read each task's existing tag list and swap old→new), then delete the old one via the web UI.
- **Need to merge tags:** same three-step flow as rename.
- **Need to change a tag's color or label:** edit it in the TickTick web UI.

Athena knows this pattern and will offer the manual workaround whenever you hit one of these commands. She won't silently claim success.

**What caused this:** the upstream `ticktick-client` library's tag-mutation endpoints use a body shape that TickTick's current v2 server silently no-ops. Reverse-engineering what the actual web UI sends (via Playwright XHR capture) would resolve it — same approach that cracked the `tasks unpin` bug on the same date. Queued for a focused library-fixes follow-up plan.

### `tasks unpin` uses a workaround endpoint

Cosmetic / background detail. The underlying library's `tasks.unpin()` calls a patch endpoint that TickTick silently no-ops. The adapter bypasses via `POST /api/v2/batch/task` with a sentinel `pinnedTime: "-1"`. **No user-facing effect** — unpin works as expected. This only matters if you're reading adapter source and wondering why it looks different from the other pin-related methods.

### `tasks completed --from --to` paginates client-side

The library's statistics endpoint returns HTTP 500 for any date window, so we fetch via the iterator endpoint and filter by completion time locally. Fast enough for typical 7-30 day windows. Slower (and makes multiple round trips) if you scan year-long ranges on a very active account.

### Untested in v1.3 smoke

Smoke testing ran out of budget before covering these features end-to-end. They're wired and typecheck-clean but not yet verified against live TickTick:

- `tags merge`, `tags delete`
- `projects create`, `projects update`, `projects delete`
- `tasks restore`

If one of these returns `ok: true` but the effect doesn't materialize in your TickTick UI, let Athena know — she'll run a focused probe to identify whether it's an upstream library quirk and either fix it in the adapter or document the limitation.

## Setup

```bash
cd ~/.claude/skills/TickTick
bun install
```

Add credentials to `~/.env`:
```
TICKTICK_EMAIL=your-email@example.com
TICKTICK_PASSWORD=your-password
```

(Or set them in the environment directly. The skill checks `process.env` first, then `~/.env`.)

Verify login:
```bash
./bin/ticktick whoami
```

Expected output on first run:
```json
{"ok":true,"user":{"userId":"...","email":"your-email@example.com",...},"sessionAgeSec":0}
```

The session is cached at `.session/ticktick.json` (mode 0600) so subsequent calls skip the login roundtrip.

## Usage (for humans)

```bash
# See what's in your inbox
./bin/ticktick tasks list --project Inbox --human

# Add a task
./bin/ticktick tasks create --title "Pick up groceries" --project Inbox --due "2026-04-13T18:00:00.000+0000"

# What's due today, across all lists
./bin/ticktick tasks list --due today --human

# Complete a task (projectId is fetched automatically if omitted)
./bin/ticktick tasks complete --id 7a5f1b2c...

# See all your projects
./bin/ticktick projects list --human
```

Run `./bin/ticktick help` for the full command reference.

## Usage (from PAI / Athena)

You don't invoke the CLI directly. Just ask naturally — "add 'X' to my inbox," "what's in my TickTick," "mark X done." The PAI skill router picks up `TickTick` and routes to the right workflow file, which invokes the CLI.

The skill's workflows are in `Workflows/` (v1.3):
- Task verbs: `ListTasks.md`, `CreateTask.md`, `CompleteTask.md`, `DeleteTask.md`, `MoveTask.md`, `PinTask.md`, `UnpinTask.md`
- Bulk verbs: `BulkComplete.md`, `BulkDelete.md`, `ListCompletedTasks.md`
- Project verbs: `ListProjects.md`, `CreateProject.md`, `UpdateProject.md`, `DeleteProject.md`
- Tag verbs: `CreateTag.md`, `DeleteTag.md`, `RenameTag.md`, `MergeTags.md`
- Meta: `Auth.md`

## Credential rotation

1. Edit `~/.env` with the new password.
2. Delete the cached session: `./bin/ticktick logout` (or just `rm .session/ticktick.json`).
3. Next call auto-logs-in with the new creds.

If you ever want to purge everything the skill has stored locally:
```bash
rm -rf .session/
```
No other state is kept outside `~/.env`.

## Architecture: the swap point

The entire library dependency lives in **one file**: `src/adapter.ts`. Every other source file imports its types and error classes from there, not from `ticktick-client` directly.

```
cli.ts → commands/*.ts → adapter.ts → ticktick-client
                              ↑
                        swap point
```

If the `ticktick-client` library ever dies, is compromised, or a better library appears, rewriting `adapter.ts` is the only code change needed. The normalized `Task`, `Project`, `Tag`, `ChecklistItem`, `User`, `AdapterError` types insulate callers from upstream field renames.

## Bus factor and supply chain

`ticktick-client` is maintained by **one person** (`jaeyeonling`). It's currently actively verified against live TickTick traffic via Playwright capture, but the bus factor is 1.

Mitigations in place:
1. **Pinned to exact version** `ticktick-client@0.2.1` — no floating version ranges.
2. **Fork on file**: `MHoroszowski/ticktick-client` at commit `813a2cb813805075d65acbb41791be338b67419c`. If upstream ever becomes unavailable or compromised, swap the dep line in `package.json` from:
   ```json
   "ticktick-client": "0.2.1"
   ```
   to:
   ```json
   "ticktick-client": "github:MHoroszowski/ticktick-client#813a2cb813805075d65acbb41791be338b67419c"
   ```
   and run `bun install`. You'll need to build the `dist/` via `tsup` inside the fork (or commit prebuilt dist to the fork) since GitHub installs don't ship compiled output.
3. **Smoke test canary**: `tests/smoke.sh` hits the live API across every supported operation. Run it before and after upgrading the dep — if it breaks, the upstream broke. (Requires `jq` + a `TEST - PAI Skill` project in your TickTick.)

## Running the smoke test

Prerequisites:
- `TICKTICK_EMAIL` / `TICKTICK_PASSWORD` in `~/.env`
- `jq` installed (`sudo apt-get install -y jq`)
- A project named `TEST - PAI Skill` in your TickTick account (create it manually in the web UI first)

```bash
./tests/smoke.sh
```

The script is idempotent — it creates, mutates, and cleans up a single test task plus a checklist item, and verifies auto-refresh by corrupting the session file.

## File layout

```
TickTick/
├── SKILL.md                 # trigger phrases + voice notif + workflow routing
├── README.md                # this file
├── package.json             # pinned dep, emergency fork fallback documented
├── tsconfig.json            # strict, ES2022, bundler resolution
├── .gitignore
├── bin/
│   └── ticktick             # #!/usr/bin/env bun — thin shim into src/cli.ts
├── src/
│   ├── cli.ts               # dispatcher + arg parser + createAdapter factory
│   ├── adapter.ts           # 🔁 THE SWAP POINT
│   ├── session.ts           # session file path + perm enforcement
│   ├── env.ts               # ~/.env loader
│   ├── errors.ts            # UsageError + exit code mapping
│   ├── output.ts            # JSON + --human formatters
│   └── commands/
│       ├── auth.ts          # login, logout, whoami
│       ├── tasks.ts         # list, get, create, update, complete, delete, move,
│       │                    # pin, unpin, restore, create-many, update-many,
│       │                    # delete-many, complete-many, completed
│       ├── projects.ts      # list, get, create, update, delete
│       ├── tags.ts          # list, create, update, delete, rename, merge
│       ├── sections.ts      # list (read-only)
│       ├── members.ts       # list, remove
│       └── checklist.ts     # list, add, complete, delete
├── Workflows/                # 19 workflow files (v1.3)
│   ├── ListTasks.md  CreateTask.md  CompleteTask.md  DeleteTask.md  MoveTask.md
│   ├── PinTask.md  UnpinTask.md  BulkComplete.md  BulkDelete.md  ListCompletedTasks.md
│   ├── ListProjects.md  CreateProject.md  UpdateProject.md  DeleteProject.md
│   ├── CreateTag.md  DeleteTag.md  RenameTag.md  MergeTags.md
│   └── Auth.md
├── tests/
│   └── smoke.sh             # live-API end-to-end acceptance
└── .session/                # 0700 dir, runtime-created, gitignored
    └── ticktick.json        # 0600 file, library-owned session blob
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error (bad flags, unknown subcommand) |
| 3 | auth error (missing creds, failed login, expired session) |
| 4 | not found (task, project, checklist item) |
| 5 | network / rate limited |
| 6 | validation error (bad date format, invalid priority, etc) |
