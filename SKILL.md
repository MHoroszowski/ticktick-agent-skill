---
name: TickTick
description: TickTick task and list management — create, list, update, complete, delete, and move tasks; manage checklist items and time-based reminders; list projects and tags. USE WHEN ticktick, add task, create task, new task, my tasks, todos, to-do, inbox, mark done, complete task, finished task, delete task, move task, my lists, my projects, what's due, checklist, subtask, reminder, remind me, alarm, alert before, ping me before, login to ticktick, ticktick session.
---

## ⚠️ MANDATORY TRIGGER

**When user mentions TickTick, tasks, to-dos, inbox, lists, or anything task-manager-related, route through this skill.**

| User Says | Action |
|---|---|
| "what's in my inbox / what's due / what's on my list" | → `Workflows/ListTasks.md` |
| "add task X / create a task / remind me to X / put X on my todo" | → `Workflows/CreateTask.md` |
| "mark X done / I finished X / complete X" | → `Workflows/CompleteTask.md` |
| "delete task X / remove task X" | → `Workflows/DeleteTask.md` |
| "move task X to list Y" | → `Workflows/MoveTask.md` |
| "what lists do I have / show me my projects" | → `Workflows/ListProjects.md` |
| "remind me 15 minutes before X / add a 1-hour reminder to X / ping me a day before Y" | → `Workflows/AddReminder.md` |
| "remove the 15-minute reminder from X / drop the 1-hour reminder on Y" | → `Workflows/RemoveReminder.md` |
| "clear all reminders on X / stop reminding me about Y" | → `Workflows/ClearReminders.md` |
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

**Supported in v1:**
- ✅ Tasks: list (with filters), get, create, update, complete, delete, move between lists
- ✅ **Time-based reminders** on tasks: set on create/update, append, remove, clear. Accepts human-friendly offsets (`15m`, `1h`, `1d`, `1d9h`, `at-start`) or raw TRIGGER strings. Multiple reminders per task supported. REPLACE semantics on `tasks update --remind`; APPEND on `tasks remind add`.
- ✅ Projects (lists): list, get
- ✅ Tags: list
- ✅ **Checklist items** inside a task: list, add, complete, delete
- ✅ Automatic session refresh (silent re-login on 401/auth-expired)
- ✅ Both JSON (default) and `--human` table output modes

**Known limitations — NOT in v1:**
- ❌ **Nested subtasks** — TickTick has two "subtask" concepts: checklist items (supported here) and true nested child tasks with their own due dates, priorities, and tags (NOT supported). The underlying `ticktick-client` library does not expose `parentId`-based nesting. Tracked as a follow-up requiring reverse-engineering of TickTick v2 endpoints. See `README.md`.
- ❌ Focus sessions, habits, calendar, countdowns, recurring-rule editing
- ❌ 2FA / MFA accounts (library does not support the 2FA login flow)
- ❌ Listing trash / restoring deleted tasks (TickTick's v2 API has a known bug here — the library documents it)

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
│   └── commands/            # auth, tasks, projects, tags, checklist
├── Workflows/               # 7 workflow files
└── tests/smoke.sh           # live-API end-to-end acceptance
```

ARGUMENTS: $ARGUMENTS
