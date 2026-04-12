# Workflow: CompleteTask

**Intent:** User says they finished something — "mark X done," "I finished Y," "complete Z," "check off W."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CompleteTask workflow in the TickTick skill to mark a task done"}' \
  > /dev/null 2>&1 &
```

## Resolve the task id

If the user named the task by title (not id), first list open tasks and find a match:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```
Fuzzy-match the title against `.tasks[].title`. If 0 matches, tell the user and stop. If 2+ matches, show them the list with ids and ask which one. If exactly 1 match, proceed.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks complete --id <taskId>
```

(The CLI fetches the task's projectId automatically if you don't pass `--project`.)

## Presentation

On success, confirm briefly and include the title of the task that was completed:
> "Marked 'Call mom about weekend trip' as done. 🎉"

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find a task with that id. Was it maybe already completed? Run `ticktick tasks list --status completed` to check."
