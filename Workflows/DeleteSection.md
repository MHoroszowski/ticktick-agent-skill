# Workflow: DeleteSection

**Intent:** User wants to delete a kanban section — "delete the 'Old Stuff' section in Work," "remove the In Review column from my Project X board."

## ⚠️ Destructive — requires `--confirm`

`sections delete` will not run without `--confirm`. The CLI's safety gate is intentional: deleting a section can orphan tasks (TickTick clears their `columnId` but the tasks themselves remain in the project, just unassigned to any column).

If the user says "delete the section" without acknowledging task impact, ALWAYS first run the dry-run (no `--confirm`) so you can show them the impact preview, then ask before re-running with `--confirm`.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DeleteSection workflow in the TickTick skill to delete a section"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **project** — which project / list (`--project "Work"`)
- **section** — section name or id (`--section "Old Stuff"`)

Optional:
- **reassign** — move tasks in the section to a target section before deleting (`--reassign "Backlog"`). Without this, tasks are orphaned. If the user says "move the tasks to Y first" or "merge into Y," use `--reassign Y`.

## Execute

### Step 1: dry-run (preview the impact)

```bash
~/.claude/skills/TickTick/bin/ticktick sections delete \
  --project "Work" \
  --section "Old Stuff"
```

This will return a `USAGE` error explaining the impact — read the message and surface the task count to the user.

### Step 2: confirm with the user, then execute

```bash
~/.claude/skills/TickTick/bin/ticktick sections delete \
  --project "Work" \
  --section "Old Stuff" \
  --confirm
```

With reassignment:
```bash
~/.claude/skills/TickTick/bin/ticktick sections delete \
  --project "Work" \
  --section "Old Stuff" \
  --reassign "Backlog" \
  --confirm
```

## Presentation

On success without reassign:
> "Deleted the 'Old Stuff' section. 3 task(s) were orphaned — they're still in your Work list but no longer in any column."

On success with reassign:
> "Deleted the 'Old Stuff' section. Moved 3 task(s) to 'Backlog' first."

On the dry-run preview:
> "About to delete the 'Old Stuff' section in Work. It currently has 3 tasks — they will be orphaned (left in the project but with no column). Should I proceed?"

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on the project / section → standard "not found" messages with the suggestion to `sections list`.
- `USAGE` saying "Refusing to delete ... without --confirm" → this is the safety gate firing. Show the user the impact preview, ask, then re-run with `--confirm`.
- `USAGE` "--reassign target is the same as --section" → ask the user which section they actually want to merge into.
