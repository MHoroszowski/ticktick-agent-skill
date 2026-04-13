---
name: TickTick
description: TickTick task and list management — create, list, update, complete, delete, and move tasks; manage checklist items; list projects and tags. USE WHEN ticktick, add task, create task, new task, my tasks, todos, to-do, inbox, mark done, complete task, finished task, delete task, move task, my lists, my projects, what's due, checklist, subtask, login to ticktick, ticktick session.
---

## ⚠️ MANDATORY TRIGGER

**When user mentions TickTick, tasks, to-dos, inbox, lists, or anything task-manager-related, route through this skill.**

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
| "what lists do I have / show me my projects" | → `Workflows/ListProjects.md` |
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

**Supported:**
- ✅ Tasks: list (with filters), get, create, update, complete, delete, move between lists
- ✅ **Nested subtasks**: create with `--parent`, indent / promote, list children, recursive tree view
- ✅ Projects (lists): list, get
- ✅ Tags: list
- ✅ Sections (kanban columns): list per project, filter / target tasks by section
- ✅ Shared-project members: list, remove
- ✅ Task assignment: create / update with `--assignee me|unassign|<id>|<name>`
- ✅ **Checklist items** inside a task (lightweight bullets in `task.items[]`): list, add, complete, delete
- ✅ Automatic session refresh (silent re-login on 401/auth-expired)
- ✅ Both JSON (default) and `--human` table output modes

**Known limitations:**
- ⚠️ **Parent delete orphans children.** TickTick does not cascade-delete nested subtasks. Deleting a parent leaves its children in place with their parentId still pointing at the deleted parent. The CLI surfaces this in the delete response so the agent can decide whether to follow up.
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
