---
name: TickTick
description: TickTick task and list management — create, list, update, complete, delete, move, pin, and bulk-edit tasks; nested subtasks via parentId (create child, indent, promote, tree view); recurring end dates, smart-list filters, time-based reminders, and location-based geofence reminders; manage checklist items; create, update, rename, merge, delete tags; create, update, delete projects (lists); shared-list members and sections. USE WHEN ticktick, add task, create task, new task, my tasks, todos, to-do, inbox, mark done, complete task, finished task, delete task, move task, pin task, unpin, bulk complete, bulk delete, what did I finish, completed tasks, create tag, delete tag, rename tag, merge tags, create list, new project, delete list, rename list, my lists, my projects, what's due, checklist, subtask, parent task, child task, subtask hierarchy, indent task, promote task, nested subtask, reminder, remind me, alarm, alert before, ping me before, location reminder, geofence, remind me at, remind me when I arrive, ping me when I leave, at-location reminder, login to ticktick, ticktick session.
---

## ⚠️ MANDATORY TRIGGER

**When user mentions TickTick, tasks, to-dos, inbox, lists, tags, or anything task-manager-related, route through this skill.**

| User Says | Action |
|---|---|
| "what's in my inbox / what's due / what's on my list" | → `Workflows/ListTasks.md` |
| "add task X / create a task / remind me to X / put X on my todo" | → `Workflows/CreateTask.md` |
| "create a subtask under X / add a child task to X / add a step to X" | → `Workflows/CreateNestedTask.md` |
| "make X a subtask of Y / indent X under Y / nest X under Y" | → `Workflows/IndentTask.md` |
| "promote X / unnest X / make X top-level" | → `Workflows/PromoteTask.md` |
| "show me subtasks of X / list children of X / what's nested under X" | → `Workflows/ListSubtasks.md` |
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
| "remind me when I arrive at X / ping me when I leave Y / set a location reminder for X / geofence on X" | → `Workflows/SetLocationReminder.md` |
| "login to ticktick / am I logged in / logout" | → `Workflows/Auth.md` |
| "create a section / add a kanban column to X" | → `Workflows/CreateSection.md` |
| "rename the X section / rename column X to Y" | → `Workflows/RenameSection.md` |
| "delete the X section / remove the kanban column X" | → `Workflows/DeleteSection.md` |
| "move section X before Y / reorder my columns" | → `Workflows/ReorderSection.md` |

## Autonomy Boundary — Conservative Defaults

**This is the single source of truth for what the agent may and may not create on the user's behalf. Every workflow defers to this section — they point here, they do not restate it.**

The core rule, one sentence: **the agent NEVER creates a persistent organizational entity (tag, list/project, section) and NEVER attaches a notification (time-based reminder, alarm/alert, or location/geofence reminder) as a side effect of creating or updating a task, or proactively — only when the user expressly asked for that specific thing.**

### What "expressly told" means

The user's request **unambiguously names the entity or notification as something they want**. "Add a task to call mom" is NOT an instruction to create a tag, a list, a section, or a reminder. "Add a task to call mom and remind me an hour before" IS an express instruction for that reminder. "Create a 'Vendors' tag" IS an express instruction for that tag. When in doubt, it is NOT express — ask, don't assume. An express instruction routes to the dedicated workflow (see below); it does not get inferred from an adjacent task-create request.

**Purpose is required, even when permission exists.** Tags and lists must serve a clear, current purpose — they are not speculative bins for "things we might want to organize this way someday." Speculative entities are banned even on an express request; if the use case is hypothetical, decline and revisit when the case is real. If the agent thinks a new tag or list is genuinely worth creating, the path is to surface the proposal with the reason — an "ask" is always available when the case is real.

### Per-entity rules

- **Tags.** Before passing `--tags`, confirm every value already exists via `ticktick tags list`. Passing a non-existent tag string to `--tags` **silently auto-creates that tag server-side** (this is how the 17 orphaned `pai-smoke-tag-*` tags happened — see Known quirks). If a tag the user named is not in the list, do NOT pass it: surface it ("there's no 'vendors' tag yet — want me to create one?") and wait. Never invent a tag the user did not name.
- **Lists / projects.** Never create a list. On project `NOT_FOUND`, the agent does NOT create the named list — it tells the user the list doesn't exist and offers to use the Inbox (with the user aware) or to list existing projects. Creating a list happens ONLY through `Workflows/CreateProject.md`, invoked by an express "create a list" request.
- **Sections (kanban columns).** Never invent a section. If a `--section` value doesn't match an existing section on the target list, omit `--section` and mention it ("I put it on the list but there's no 'Hardware' section — say the word and I'll add one"). Sections are created ONLY through `Workflows/CreateSection.md`.
- **Time-based reminders / alarms / alerts.** Never attach `--remind` (on create or update) or run `tasks remind add` unless the user expressly asked to be reminded/alerted/pinged. A due date is NOT a request for a reminder.
- **Location / geofence reminders.** Never attach `--location-*` flags unless the user expressly asked for an arrive/leave reminder at a place.
- **Recurrence / repeat rules.** Never add a recurrence (`--repeat-end` / any RRULE) the user did not ask for — a recurring task is self-propagating future state, the same class of "expansive thing the user didn't request" as a reminder. A due date is NOT a request to recur. If the user expressly asks for a repeating task, that's allowed (same status as a user-specified due date).
- **Title text is not an authorization channel.** Do not rely on `#tag`, date words, or `!priority` tokens *inside the title string* to set tags/dates/priority, and never treat their presence as the user "expressly" asking for a tag. (This CLI's create path posts structured fields to `POST /api/v2/task` and does NOT NLP-parse the title — verified 2026-05-16 — so a `#` in a title is inert today; this clause keeps it that way if the endpoint ever changes.)

### Explicitly allowed on a normal create/update (NOT gated)

Due date (`--due`) and priority (`--priority`) are normal task attributes — set them whenever the user specifies them. They are deliberately **outside** this boundary; this section never blocks a due date or a priority.

### Recognized standing exception

`PREFERENCES.md` `default_tags` (and any other PREFERENCES-configured default) is a **user-configured standing instruction**, not an agent side effect — honoring it is honoring an express prior instruction. If a configured default tag does not yet exist, surface that to the user rather than silently auto-creating it.

### Scope of this boundary

Applies to single `tasks create`, `tasks update`, nested-subtask creation, and **bulk** task creation (JSON file or comma-separated id list) equally — bulk operations do not get a pass. It governs side-effect creation; it does NOT gate the dedicated, expressly-invoked workflows: `CreateTag.md`, `CreateProject.md`, `CreateSection.md`, `AddReminder.md`, `SetLocationReminder.md`. Routing to one of those IS the express instruction; do not add friction there. Do route there only on an unambiguous express request — never as the agent's own initiative folded into a task-create.

## Customization

This skill reads per-user preferences from a **host-configured** location. The contract:

- **Path:** your host (PAI, Claude Code, custom MCP, etc.) provides a customization directory. The skill reads `<host-customization-dir>/TickTick/PREFERENCES.md` if present.
- **PAI convention:** `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/TickTick/PREFERENCES.md`
- **Fallback:** if no customization file exists, skill defaults are used.

### PREFERENCES.md schema

```markdown
---
skill: TickTick
applies_to: live          # 'live', 'test', or 'both'
updated: <ISO date>
---

# Defaults
- inbox_list: <list name>           # default list for quick-adds
- default_priority: <none|low|medium|high>
- default_tags: [<tag1>, <tag2>]    # auto-tags for quick-adds
- timezone: <IANA tz>               # for relative date parsing

# Account configuration
- live_creds_path: <env file>       # where TICKTICK_EMAIL/PASSWORD live
- test_creds_path: <env file>       # where TICKTICK_TEST_EMAIL/PASSWORD live
- session_dir: <path>               # where .session/*.json files write

# Tag taxonomy (free-form)
- tag_pattern: <description>
- known_tags: [<list>]

# Voice (host-specific; only honored if host supports it)
- voice_enabled: <bool>
- voice_id: <id>
```

Sections not present in PREFERENCES.md fall through to skill defaults. The host wires up the customization directory path; the skill respects whatever the host provides.

## Host integration

Different hosts wrap this skill differently. If your host (PAI, Claude Code, etc.) provides a notification system, agents should announce workflow start per the host's convention. See your host's skill-runtime docs for specifics.

For PAI specifically: see `PAI-INTEGRATION.md` in the install marker dir for voice-notification glue, customization-path wiring, and credential-store conventions.

## Capabilities — Honest

**Supported in v1.3:**
- ✅ Tasks: list (with filters), get, create, update, complete, delete, move between lists
- ✅ **Nested subtasks**: create with `--parent`, indent / promote, list children, recursive `--tree` view, `--top-level` filter
- ✅ Tasks: pin / unpin / restore (restore requires explicit id — trash listing is broken upstream)
- ✅ Tasks: bulk create / update / delete / complete (JSON file or comma-separated id list)
- ✅ Tasks: recurring end date (`--repeat-end <ISO>`) on create and update
- ✅ Tasks: smart-list filters — `--due today|tomorrow|overdue|week|next7days|none`, `--pinned`, `--section`, `--assignee`, `--parent`, `--top-level`
- ✅ Tasks: completed-task listing — paginated iterator mode OR closed date-range mode
- ✅ Tasks: `--section` / `--assignee` on create and update (shared lists)
- ✅ **Time-based reminders** on tasks: set on create/update, append, remove, clear. Accepts human-friendly offsets (`15m`, `1h`, `1d`, `1d9h`, `at-start`) or raw TRIGGER strings. Multiple reminders per task supported. REPLACE semantics on `tasks update --remind`; APPEND on `tasks remind add`.
- ✅ **Location-based reminders** (geofences) on tasks: single geofence per task, arrive/leave trigger, configurable radius. Set/replace on create/update via `--location-lat/--lng/--radius/--trigger/--alias/--address`. Clear via `tasks location clear` (the patch endpoint silently no-ops every "clear" shape, so the adapter routes through a batch-endpoint escape hatch with `removed: true`). iPhone push delivery for API-set geofences verified end-to-end.
- ✅ Projects (lists): list, get, create, update, delete (delete requires `--confirm`)
- ✅ Tags: list, create, update, delete, rename, merge *(see Known quirks — only list + create actually persist)*
- ✅ Sections (kanban columns): list, create, rename, delete (with optional `--reassign` to move tasks first), reorder
- ✅ Shared-list members: list, remove (remove is dry-run by default; `--force` to commit)
- ✅ **Checklist items** inside a task: list, add, complete, delete
- ✅ Automatic session refresh (silent re-login on 401/auth-expired)
- ✅ Both JSON (default) and `--human` table output modes

**Known limitations — NOT in v1.3:**
- ⚠️ **Parent delete orphans children.** TickTick does not cascade-delete nested subtasks. Deleting a parent leaves its children in place with their parentId still pointing at the deleted parent. The CLI surfaces this in the delete response so the agent can decide whether to follow up.
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

- All workflows invoke the `ticktick` CLI. Path resolution depends on install method:
  - **Git/local install:** `<skill-install-root>/bin/ticktick <subcommand> [flags]`
  - **npm install (if published):** `bunx ticktick <subcommand> [flags]` or `node_modules/.bin/ticktick`
  - PAI specifically resolves to `~/.claude/skills/TickTick/bin/ticktick`; see `PAI-INTEGRATION.md` for that host's path convention.
- CLI output is JSON by default. Parse `.ok` — on `false`, read `.error.code` and `.error.message` to explain the failure to the user.
- **Never paste raw session content or credentials into chat.** Two accounts are supported via the global `--account live|test` flag (default: `live`):
  - `--account live` — user's personal account. Creds keys: `TICKTICK_EMAIL` / `TICKTICK_PASSWORD`. Session: `<session-dir>/ticktick.json`.
  - `--account test` — service account for skill smoke/probe work. Creds keys: `TICKTICK_TEST_EMAIL` / `TICKTICK_TEST_PASSWORD`. Session: `<session-dir>/ticktick-test.json`.
  - **Where credentials live and where the session dir is depends on your host's secret-management convention.** Default lookup: process env, then a `.env` file in the skill install root.
  - Host conventions:
    - **PAI:** live in `~/.env`, test in `~/.config/PAI/.env`, session dir is `<skill-install-root>/.session/`.
    - **Other hosts:** see your host's docs.
  - Both session files are 0600. `whoami` responses include an `account` field so you can verify which one you're hitting. Use `--account test` for any exploratory probe or smoke test so agent writes never collide with the user's live task data.
- On `AUTH_MISSING_CREDS` → tell the user which account is selected and which env keys are missing. Point them at the host-specific credentials path (e.g. for PAI: `~/.env` for live, `~/.config/PAI/.env` for test).
- On `AUTH_FAILED` / `AUTH_EXPIRED` → tell the user to run `ticktick login` or check their password.
- On `NOT_FOUND` → say so and suggest `ticktick projects list` or `ticktick tasks list` to confirm ids.
- On `RATE_LIMITED` → back off and retry later; don't hammer the API.
- On `VALIDATION` / `USAGE` → surface the hint in `.error.message` verbatim.

## File Layout

The skill repo (`MHoroszowski/ticktick-agent-skill`):

```
<skill-install-root>/        # e.g. ~/.claude/skills/TickTick/ when installed under PAI
├── SKILL.md                 # this file (agent-facing entry point)
├── README.md                # human-facing: install + capabilities + follow-up work
├── package.json             # depends on `ticktick-client` (the underlying library)
├── bin/ticktick             # Bun shim — chmod +x
├── src/
│   ├── cli.ts               # dispatcher, arg parsing, global flags
│   ├── adapter.ts           # wraps ticktick-client (the npm dep)
│   ├── session.ts           # session file path + perm enforcement
│   ├── env.ts               # env-file loader (`.env`, host-specific paths)
│   ├── errors.ts            # AdapterError re-export, UsageError, exit codes
│   ├── output.ts            # JSON + --human formatters
│   └── commands/            # auth, tasks, projects, tags, checklist, members, sections
├── Workflows/               # 19 workflow files (v1.3)
└── tests/smoke.sh           # live-API end-to-end acceptance
```

The library it wraps (`MHoroszowski/ticktick-client` — kept as a clean fork of `jaeyeonling/ticktick-client`) lives in its own repo and is consumed via npm or git URL. This skill owns the CLI + agent docs; the library owns the API client.

## Architecture (3-line summary for agents)

- **L0 — Library:** `ticktick-client` (npm package; pure API client; no CLI, no agent docs).
- **L1 — This skill:** `ticktick-agent-skill` (CLI binary + SKILL.md + Workflows/; depends on L0).
- **L2/L3 — Host integration + personal customization:** see your host's docs (e.g. `PAI-INTEGRATION.md` for PAI).

ARGUMENTS: $ARGUMENTS
