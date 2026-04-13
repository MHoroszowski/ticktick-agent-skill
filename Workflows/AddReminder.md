# Workflow: AddReminder

**Intent:** User wants to add a time-based reminder to an existing task — "remind me 15 minutes before X," "add a 1-hour reminder to X," "ping me a day before Y."

This workflow APPENDS a reminder. It preserves any reminders already on the task. To replace the full set, use `tasks update --remind` instead (REPLACE semantics — see `CreateTask.md` and `SKILL.md`). To remove reminders, use `RemoveReminder.md` or `ClearReminders.md`.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the AddReminder workflow in the TickTick skill to add a reminder"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task** — the task to add the reminder to. User will name it; use `tasks list` or `tasks get` to resolve to a task id if you don't already have one from context.
- **offset** — how far before the task's due time the reminder should fire. Convert natural language to one of the CLI-accepted forms:
  - `at-start` or `0` → at the task's scheduled time
  - `5m`, `15m`, `30m` → minutes before
  - `1h`, `2h`, `6h` → hours before
  - `1d`, `7d` → days before
  - `1d9h`, `2d3h45m` → combined
  - Raw `TRIGGER:...` passes through unchanged

Optional:
- **project / list** — only needed if the task id isn't unique across projects or you want to skip the implicit resolution.

## Preconditions

**TickTick reminders only fire on tasks that have a due date.** If the user asks you to add a reminder to a task with no due date, do ONE of:
1. Ask the user for the due date and use `tasks update --due ...` first, then add the reminder.
2. Add the reminder anyway if the user confirms they'll set the due date later. The CLI will warn on stderr but still persist the reminder.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks remind add \
  --id <task-id> \
  --offset 15m
```

With explicit project:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks remind add \
  --id <task-id> \
  --project "Work" \
  --offset 1h
```

## Presentation

On success, confirm with the new full reminder set:
> "Added a 15-minute reminder. This task now has [15m, 1d] queued."

If the task had no due date, surface the warning:
> "Added the reminder, but heads up — this task has no due date, so the reminder won't actually fire until you set one."

## Errors

- `USAGE` on offset → the parser message includes the accepted formats. Quote it verbatim and ask the user to rephrase.
- `NOT_FOUND` on the task id → "I couldn't find that task. Want me to list your recent tasks so you can pick it?"
- Auth errors → see `Auth.md`.
