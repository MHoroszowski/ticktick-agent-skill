---
name: TickTick
description: TickTick task and list management — create, list, update, complete, delete, move, pin, and bulk-edit tasks; recurring end dates, smart-list filters, and time-based reminders; manage checklist items; create, update, rename, merge, delete tags; create, update, delete projects (lists); shared-list members and sections. USE WHEN ticktick, add task, create task, new task, my tasks, todos, to-do, inbox, mark done, complete task, finished task, delete task, move task, pin task, unpin, bulk complete, bulk delete, what did I finish, completed tasks, create tag, delete tag, rename tag, merge tags, create list, new project, delete list, rename list, my lists, my projects, what's due, checklist, subtask, reminder, remind me, alarm, alert before, ping me before, login to ticktick, ticktick session.
---

## ⚠️ MANDATORY TRIGGER

**When user mentions TickTick, tasks, to-dos, inbox, lists, tags, or anything task-manager-related, route through this skill.**

| User Says | Action |
|---|---|
| "what's in my inbox / what's due / what's on my list" | → `Workflows/ListTasks.md` |
| "add task X / create a task / remind me to X / put X on my todo" | → `Workflows/CreateTask.md` |
| "mark X done / I finished X / complete X" | → `Workflows/CompleteTask.md` |
| "delete task X / remove task X" | → `Workflows/DeleteTask.md` |
| "move task X to list Y" | → `Workflows/MoveTask.md` |
| "pin X / pin task X to top" | → `Workflows/PinTask.md` |
| "unpin X" | → `Workflows/UnpinTask.md` |
| "complete all of these / mark these done" | → `Workflows/BulkComplete.md` |
| "delete all these tasks / clear these" | → `Workflows/BulkDelete.md` |
| "what did I finish last week / show completed tasks" | → `Workflows/ListCompletedTasks.md` |
| "what lists do I have / show me my projects" | → `Workflows/ListProjects.md` |
| "create a list / new project X / make a new list" | → `Workflows/CreateProject.md` |
| "rename my X list / change color of X list" | → `Workflows/UpdateProject.md` |
| "delete the X list / remove my X project" | → `Workflows/DeleteProject.md` |
| "create a tag / add tag X" | → `Workflows/CreateTag.md` |
| "delete the X tag" | → `Workflows/DeleteTag.md` |
| "rename tag X to Y" | → `Workflows/RenameTag.md` |
| "merge tag X into Y" | → `Workflows/MergeTags.md` |
| "remind me 15 minutes before X / add a 1-hour reminder to X / ping me a day before Y" | → `Workflows/AddReminder.md` |
| "remove the 15-minute reminder from X / drop the 1-hour reminder on Y" | → `Workflows/RemoveReminder.md` |
| "clear all reminders on X / stop reminding me about Y" | → `Workflows/ClearReminders.md` |
| "login to ticktick / am I logged in / logout" | → `Workflows/Auth.md` |
| "create a section / add a kanban column to X" | → `Workflows/CreateSection.md` |
| "rename the X section / rename column X to Y" | → `Workflows/RenameSection.md` |
| "delete the X section / remove the kanban column X" | → `Workflows/DeleteSection.md` |
| "move section X before Y / reorder my columns" | → `Workflows/ReorderSection.md` |

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/TickTick/`

If a `PREFERENCES.md` file exists there, load and apply it. Typical overrides: default list, preferred priority for quick-adds, timezone, response verbosity. If the directory does not exist, proceed with skill defaults.

## 🚨 MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)

**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running the WORKFLOWNAME workflow in the TickTick skill to ACTION"}' \
     > /dev/null 2>&1 &
   ```

2. **Output text notification**:
   ```
   Running the **WorkflowName** workflow in the **TickTick** skill to ACTION...
   ```

**This is not optional.** Replace `WORKFLOWNAME` with the matched workflow (ListTasks, CreateTask, etc.) and `ACTION` with a short human description.

## Capabilities — Honest

**Supported in v1.3:**
- ✅ Tasks: list (with filters), get, create, update, complete, delete, move between lists
- ✅ Tasks: pin / unpin / restore (restore requires explicit id — trash listing is broken upstream)
- ✅ Tasks: bulk create / update / delete / complete (JSON file or comma-separated id list)
- ✅ Tasks: recurring end date (`--repeat-end <ISO>`) on create and update
- ✅ Tasks: smart-list filters — `--due today|tomorrow|overdue|week|next7days|none`, `--pinned`, `--section`, `--assignee`
- ✅ Tasks: completed-task listing — paginated iterator mode OR closed date-range mode
- ✅ Tasks: `--section` / `--assignee` on create and update (shared lists)
- ✅ **Time-based reminders** on tasks: set on create/update, append, remove, clear. Accepts human-friendly offsets (`15m`, `1h`, `1d`, `1d9h`, `at-start`) or raw TRIGGER strings. Multiple reminders per task supported. REPLACE semantics on `tasks update --remind`; APPEND on `tasks remind add`.
- ✅ Projects (lists): list, get, create, update, delete (delete requires `--confirm`)
- ✅ Tags: list, create, update, delete, rename, merge *(see Known quirks — only list + create actually persist)*
- ✅ Sections (kanban columns): list, create, rename, delete (with optional `--reassign` to move tasks first), reorder
- ✅ Shared-list members: list, remove (remove is dry-run by default; `--force` to commit)
- ✅ **Checklist items** inside a task: list, add, complete, delete
- ✅ Automatic session refresh (silent re-login on 401/auth-expired)
- ✅ Both JSON (default) and `--human` table output modes

**Known limitations — NOT in v1.3:**
- ❌ **Nested subtasks** — TickTick has two "subtask" concepts: checklist items (supported here) and true nested child tasks with their own due dates, priorities, and tags (NOT supported). The underlying `ticktick-client` library does not expose `parentId`-based nesting. Tracked as a follow-up requiring reverse-engineering of TickTick v2 endpoints. See `README.md`.
- ❌ Location-based reminders (time-based reminders ARE supported — see capabilities above)
- ❌ Focus sessions, habits, calendar, countdowns
- ❌ 2FA / MFA accounts (library does not support the 2FA login flow)
- ❌ Listing trash (TickTick's v2 API has a known bug here — the library documents it). Restore works if you already know the task id from prior state.

## Known quirks (v1.3 — read this BEFORE diagnosing a bug)

These are upstream-library limitations and untested surface areas we already know about. **If the user reports unexpected behavior, check this list FIRST** — don't treat it as a new bug to investigate. Surface the known issue to the user and offer the manual workaround when applicable.

### Verified quirks (the command name lies about what it does)

- **`tags rename`, `tags delete`, `tags update`, `tags merge` are ALL BROKEN upstream — calls return `ok: true` but NOTHING persists.** Verified empirically on 2026-04-13: the library's tag-mutation methods POST to `/api/v2/batch/tag` with various body shapes. TickTick's server accepts the requests (etag changes, proving processing) but silently drops the mutations. Confirmed broken: `tags rename` (label not updated), `tags delete` (tag stays visible after delete). `tags update` and `tags merge` share the same endpoint and are almost certainly broken the same way (untested). **The only working tag operation in v1.3 is `tags create`.** Listing tags also works (`tags list`). **When the user asks to rename, delete, update, or merge a tag: (a) the CLI will return `ok: true` but WILL NOT actually do anything, (b) the tag will still be there / still have the old label / still have the old merge partner.** Do NOT silently report success. Always explain the limitation and offer the manual workaround:
  - **Rename tag** → (1) `tags create --name <new>`, (2) `tasks update --tags <new>` for each affected task, (3) try `tags delete --name <old>` (also known-broken, but may clear it via the web UI manually).
  - **Delete tag** → the API call does nothing. Tell the user to delete via the TickTick web UI directly, OR first untag every task referencing it with `tasks update --tags` (removing the tag from each task's list) so it becomes orphaned.
  - **Merge tags** → three-step like rename: re-tag all tasks from source → target, then try delete (same caveat).
  - **Update tag color/label** → cannot be done via this skill. Use the TickTick web UI directly.

- **`tasks unpin` uses an escape-hatch endpoint.** The library's native `tasks.unpin()` calls `POST /api/v2/task/{id}` with `pinnedTime: null`, which TickTick silently no-ops. The adapter bypasses via `POST /api/v2/batch/task` with the FULL task body and sentinel `pinnedTime: "-1"`. Works reliably — no user-facing effect. Context only for debugging adapter source.

- **`tasks completed --from --to` uses client-side date filtering.** The library's `statistics.listCompleted()` hits `/api/v2/project/all/completed/` which returns HTTP 500 for any date window. The adapter routes through the iterator endpoint (`/api/v2/project/all/closed`) and filters by `completedTime` client-side. External contract preserved (`mode: "statistics"` still reported). Slower for multi-year ranges with heavy histories; fine for typical 7-30 day windows.

### Untested in v1.3 smoke — trust carefully

These v1.3 features typecheck and look wired correctly but were NOT covered by smoke before ship. **Don't blindly trust `ok: true`** — if the user reports a mutation that doesn't persist, investigate via a minimal probe script before claiming a new bug:

- `tags merge` — library calls `POST /api/v2/batch/tag` with `{merge: [...]}`. Unknown end-to-end.
- `tags delete` — library calls the batch endpoint. Unknown end-to-end.
- `projects create` / `update` / `delete` — library exposes all three; smoke ran out before testing them.
- `tasks restore` — requires explicit id (trash listing is broken upstream). Untested whether the restore call itself works.

### The upstream-library bug pattern

Multiple v1.3 features hit the same shape of library bug: the library uses `POST /api/v2/task/{id}` (a "patch style" endpoint) for mutations that TickTick silently no-ops. **If a mutation returns `ok: true` but the re-read shows the change didn't persist, suspect this pattern.** Canonical fix: bypass via `POST /api/v2/batch/task` with the FULL task body and an `{add: [], update: [task], delete: [], addAttachments: [], updateAttachments: [], deleteAttachments: []}` envelope. See `unpinTask` in `src/adapter.ts` for the canonical worked example.

### Protocol when the user hits a rough edge

1. Check against the "Verified quirks" list — if match, explain the limitation, offer the manual workaround, and only implement if they ask
2. Check against the "Untested" list — if match, run a minimal probe to confirm whether it's actually broken before assuming
3. If it's a new bug, diagnose via the upstream-library pattern above before reaching for a full RE session
4. **Don't silently fix or silently skip** — always surface the known-issue status to the user so they know what they're getting

## Execution Contract

- All workflows invoke `~/.claude/skills/TickTick/bin/ticktick <subcommand> [flags]`.
- CLI output is JSON by default. Parse `.ok` — on `false`, read `.error.code` and `.error.message` to explain the failure to the user.
- **Never paste raw session content or credentials into chat.** Credentials live in `~/.env` as `TICKTICK_EMAIL` and `TICKTICK_PASSWORD`. The session blob lives at `~/.claude/skills/TickTick/.session/ticktick.json` (mode 0600).
- On `AUTH_MISSING_CREDS` → tell the user to set credentials in `~/.env`.
- On `AUTH_FAILED` / `AUTH_EXPIRED` → tell the user to run `ticktick login` or check their password.
- On `NOT_FOUND` → say so and suggest `ticktick projects list` or `ticktick tasks list` to confirm ids.
- On `RATE_LIMITED` → back off and retry later; don't hammer the API.
- On `VALIDATION` / `USAGE` → surface the hint in `.error.message` verbatim.

## File Layout

```
~/.claude/skills/TickTick/
├── SKILL.md                 # this file
├── README.md                # honest capabilities + follow-up work
├── package.json             # pins ticktick-client@0.2.1; emergency fork fallback documented
├── bin/ticktick             # Bun shim — chmod +x
├── src/
│   ├── cli.ts               # dispatcher, arg parsing, global flags
│   ├── adapter.ts           # 🔁 SWAP POINT — only file importing ticktick-client
│   ├── session.ts           # session file path + perm enforcement
│   ├── env.ts               # ~/.env loader
│   ├── errors.ts            # AdapterError re-export, UsageError, exit codes
│   ├── output.ts            # JSON + --human formatters
│   └── commands/            # auth, tasks, projects, tags, checklist, members, sections
├── Workflows/               # 19 workflow files (v1.3)
└── tests/smoke.sh           # live-API end-to-end acceptance
```

ARGUMENTS: $ARGUMENTS
