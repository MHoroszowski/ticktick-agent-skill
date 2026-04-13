# Workflow: IndentTask

**Intent:** User wants to nest an existing top-level task under another task — "make X a subtask of Y," "indent X under Y," "move X to be a child of Y," "X is really a sub-task of Y."

**Distinct from:** Creating a new child task (use `CreateNestedTask`). This workflow re-parents an existing task in place. The task id does NOT change.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the IndentTask workflow in the TickTick skill to nest one task under another"}' \
  > /dev/null 2>&1 &
```

## Resolve both ids

If the user named either task by title rather than id, list and fuzzy-match:

```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```

You need TWO ids: the task to indent (`--id`) and the new parent (`--under`).

If either is ambiguous, ask the user to disambiguate before running. **Never indent the wrong task** — the operation is reversible via `tasks promote` but you'll waste a round trip and risk confusing the user.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks indent \
  --id <childTaskId> \
  --under <parentTaskId>
```

The CLI auto-resolves the child's project. You don't need `--project`.

## Presentation

On success:

> "Made 'Draft outline' a subtask of 'Quarterly review prep.'"

The id is preserved — no need to mention id changes (unlike `tasks move`).

## Errors

- `USAGE` "cannot be the same task" → the user asked you to indent something under itself. Tell them you can't do that and ask which task should actually be the parent.
- `NOT_FOUND` on the parent → "I couldn't find a task matching '[X]' to use as the parent. Want me to list your open tasks?"
- `NOT_FOUND` on the child → "I couldn't find a task matching '[X]' to indent."
- `AUTH_*` → as in `ListTasks.md`.

## Notes

- **The child stays in its current project.** TickTick allows cross-project nesting (a child in project P2 can have its parentId pointing at a parent in project P1) but most users find this confusing. If the user clearly wants both tasks in the same list, run `tasks move` first to put them in the same project, THEN indent.
- **Re-parenting is supported.** If the task is already a child of some other parent, `tasks indent` will switch its parent to the new one — no need to promote first.
- **Arbitrary depth.** You can indent a task under another task that is itself already a child of something else. There's no observed depth limit.
