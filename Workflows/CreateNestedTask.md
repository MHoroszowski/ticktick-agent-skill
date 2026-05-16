# Workflow: CreateNestedTask

**Intent:** User wants to add a child task underneath an existing one — "create a subtask under X," "add a child task to X," "make a sub-task of X for Y," "add a step to project task Z."

**Distinct from:** Checklist items (`task.items[]` bullets — use `checklist add` for those). A nested subtask is a real task with its own due date, priority, tags, status, and the ability to have its OWN children. If the user asks for "a checklist inside this task" or "bullets," prefer `checklist add`. If they say "subtask," "child task," "step," or "sub-task," use this workflow.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateNestedTask workflow in the TickTick skill to create a child task"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **parent task** — id or fuzzy-match against the user's open tasks
- **title** — the main text of the new child task

Optional (extract if mentioned, same as CreateTask):
- **due date** — parse natural language into ISO 8601 yourself; the CLI does not parse natural language
- **priority** — none, low, medium, high
- **content** — markdown body
- **tags** — comma-separated

The project for the child is auto-resolved from the parent — you do NOT need to pass `--project`.

## Guardrails — read `SKILL.md` § Autonomy Boundary

Same boundary as `CreateTask.md`. On a nested-subtask create:

- **Tags:** only existing tags (verify with `ticktick tags list`); a new `--tags` string auto-creates the tag server-side — don't invent one. If the user named a missing tag, surface and ask.
- **Reminders / alarms:** do NOT add `--remind` or any alarm/alert unless the user expressly asked. A due date is not a reminder request.
- **Lists:** not applicable here (project inherits from the parent — never pass a new `--project`).
- **Allowed freely:** `--due` and `--priority` when the user specified them.

## Resolve the parent id

If the user named the parent by title rather than id, list and fuzzy-match first:

```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```

Pick the closest match by title and use its `.id`. If multiple plausibly match, ask the user to disambiguate before running the create.

## Execute

Minimum:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks create \
  --title "Draft outline" \
  --parent <parentId>
```

With options:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks create \
  --title "Draft outline" \
  --parent 69dcca57cf4d2ae49d211b99 \
  --due "2026-04-15T17:00:00.000+0000" \
  --priority medium \
  --tags writing,draft
```

The response includes the new child task's id and (echoed back) `parentId`. The id is stable — unlike `tasks move`, this operation does NOT change ids.

## Presentation

On success, mention BOTH the child and the parent:

> "Added 'Draft outline' as a subtask of 'Quarterly review prep,' due Friday April 15."

If the user is likely to chain (e.g. they said "add three subtasks: A, B, and C"), surface the child id so you can act on it next without re-listing.

## Errors

- `NOT_FOUND` on `--parent` → "I couldn't find a task matching '[X]' to use as the parent. Want me to list your open tasks so you can pick one?"
- `AUTH_*` → as in `ListTasks.md`.
- `VALIDATION` → pass through; usually a malformed date or bad priority.

## Notes

- **Arbitrary nesting depth is supported.** You can create a subtask of a subtask of a subtask. There's no observed depth limit in TickTick's API.
- **The child lives in the same project as the parent.** Even if you pass `--project foo` explicitly, the parent's project takes priority for nesting purposes (TickTick stores the parentId pointer regardless of project, but cross-project nesting is unusual and not what most users mean).
- **Deleting the parent does NOT delete children** — they're orphaned with their `parentId` still pointing at the deleted parent. Use `tasks promote` first if you want them to become top-level.
