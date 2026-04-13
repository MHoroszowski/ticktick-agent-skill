---
name: TickTick
description: TickTick task and list management — create, list, update, complete, delete, move, pin, and bulk-edit tasks; recurring end dates and smart-list filters; manage checklist items; create, update, rename, merge, delete tags; create, update, delete projects (lists); shared-list members and sections. USE WHEN ticktick, add task, create task, new task, my tasks, todos, to-do, inbox, mark done, complete task, finished task, delete task, move task, pin task, unpin, bulk complete, bulk delete, what did I finish, completed tasks, create tag, delete tag, rename tag, merge tags, create list, new project, delete list, rename list, my lists, my projects, what's due, checklist, subtask, login to ticktick, ticktick session.
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
| "login to ticktick / am I logged in / logout" | → `Workflows/Auth.md` |

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
- ✅ Tasks: smart-list filters — `--due today|tomorrow|overdue|week|next7days|none`, `--pinned`
- ✅ Tasks: completed-task listing — paginated iterator mode OR closed date-range mode
- ✅ Tasks: `--section` / `--assignee` on create and update (shared lists)
- ✅ Projects (lists): list, get, create, update, delete (delete requires `--confirm`)
- ✅ Tags: list, create, update, delete, rename, merge
- ✅ Sections (kanban columns): list (read-only in v1.3)
- ✅ Shared-list members: list, remove (remove is dry-run by default; `--force` to commit)
- ✅ **Checklist items** inside a task: list, add, complete, delete
- ✅ Automatic session refresh (silent re-login on 401/auth-expired)
- ✅ Both JSON (default) and `--human` table output modes

**Known limitations — NOT in v1.3:**
- ❌ **Nested subtasks** — TickTick has two "subtask" concepts: checklist items (supported here) and true nested child tasks with their own due dates, priorities, and tags (NOT supported). The underlying `ticktick-client` library does not expose `parentId`-based nesting. Tracked as a follow-up requiring reverse-engineering of TickTick v2 endpoints. See `README.md`.
- ❌ Sections create / rename / delete / reorder (list is read-only in v1.3; CRUD deferred to v1.4)
- ❌ Reminders (time-based or location) — deferred to v1.4
- ❌ Focus sessions, habits, calendar, countdowns
- ❌ 2FA / MFA accounts (library does not support the 2FA login flow)
- ❌ Listing trash (TickTick's v2 API has a known bug here — the library documents it). Restore works if you already know the task id from prior state.

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
