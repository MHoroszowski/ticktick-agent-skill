# Workflow: PromoteTask

**Intent:** User wants to make an existing child task top-level — "promote X to a top-level task," "make X not a subtask anymore," "unnest X," "X isn't really a sub-task — make it its own task."

**Distinct from:** Deleting the child or moving it to a different project. Promote ONLY clears the child's parentId. The task stays in the same project, keeps its id, and retains all its other fields (due, priority, tags, content, status).

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the PromoteTask workflow in the TickTick skill to make a subtask top-level"}' \
  > /dev/null 2>&1 &
```

## Resolve the task id

If the user named the task by title, list and fuzzy-match:

```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks promote \
  --id <taskId>
```

The CLI auto-resolves the project from the task. You don't need `--project`.

## Presentation

On success:

> "'Draft outline' is no longer a subtask — it's now top-level in [project name]."

If the user is likely to chain follow-ups, mention that the id is unchanged.

## Errors

- `NOT_FOUND` → the task id doesn't exist. Tell the user, suggest listing.
- `AUTH_*` → as in `ListTasks.md`.

## Notes

- **No-op on already-top-level tasks.** Promoting a task that has no parent silently succeeds (the server accepts the `parentId: null` mutation regardless). Don't gate on parentId being set first.
- **Promote does NOT delete the task.** If the user actually wants to remove it, use `tasks delete` instead.
- **Promote is the right tool for "I want to keep this task but it shouldn't be nested anymore."** If the user wants to also move it to a different list, do `tasks promote` first then `tasks move` second — moves are copy+delete and would lose the parent relationship anyway, so promote-then-move is the cleanest order.
