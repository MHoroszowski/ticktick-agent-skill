# Workflow: ListSubtasks

**Intent:** User wants to see the children of a task — "show me the subtasks of X," "list the children of X," "what's nested under X," "what are the steps for X," "show me the breakdown for X."

**Distinct from:** Listing checklist items inside a task (use `checklist list` for those — `task.items[]` bullets). This workflow lists real child tasks linked via `parentId`.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ListSubtasks workflow in the TickTick skill to list children of a task"}' \
  > /dev/null 2>&1 &
```

## Resolve the parent id

If the user named the parent by title, list and fuzzy-match:

```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```

## Execute

**Direct children only (one level):**
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list \
  --parent <parentId>
```

**Recursive tree (all descendants):**
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list \
  --parent <parentId> \
  --tree
```

**Top-level only (filter out all subtasks across the whole list):**
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list \
  --top-level \
  --project "Work"
```

## Presentation

For one-level lists, present them as a numbered or bulleted list under the parent's title:

> "'Quarterly review prep' has 3 subtasks:
> 1. Draft outline (medium priority, due Friday)
> 2. Pull metrics from dashboard (no due date)
> 3. Send draft to manager (high priority, due Friday)"

For tree mode (`--tree`), use the `--human` output and pass it through verbatim — it's already indented:

```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --parent <id> --tree --human
```

The human output renders as:
```
[ ] Draft outline [b28f8ef1]
  [ ] Bullet research [a1b2c3d4]
  [ ] First pass writing [e5f6a7b8]
[ ] Pull metrics [c515837f]
```

## Errors

- `NOT_FOUND` on the parent (no such task): tell the user, suggest a list.
- `(no children)` or empty count: confirm that the task has no nested subtasks. Note for the user whether they meant to look at checklist items instead — TickTick conflates the two terms in the UI.
- `AUTH_*` → as in `ListTasks.md`.

## Notes

- **`--tree` requires `--parent`.** You can't print a recursive tree without a starting root.
- **Subtasks have their own status.** A parent task can be open while its children are completed, or vice versa. Don't infer one from the other.
- **An empty subtask list is normal.** Many tasks have no children. Don't apologize — just say "no subtasks" cleanly.
- **If the user is asking about checklist items by mistake, redirect.** "Subtasks are real child tasks; checklist items are bullets inside one task. Did you mean `checklist list --task X`?"
