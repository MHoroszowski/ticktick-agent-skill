# Workflow: ReorderSection

**Intent:** User wants to change the order of kanban sections in a project — "move the 'Done' section to the end of my Work board," "put 'In Review' before 'Doing'," "reorder the columns so Backlog is first."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ReorderSection workflow in the TickTick skill to reorder a section"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **project** — which project / list (`--project "Work"`)
- **section** — the section being moved (`--section "Done"`)
- **anchor + direction** — exactly one of:
  - `--before <id|name>` — place the section immediately BEFORE the anchor
  - `--after <id|name>` — place the section immediately AFTER the anchor

Translate phrases:
- "move to the end" → `--after` the current LAST section (run `sections list` first to find it)
- "move to the start / make it first" → `--before` the current FIRST section
- "put X before Y" → `--section X --before Y`
- "put X after Y" → `--section X --after Y`

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick sections move \
  --project "Work" \
  --section "Done" \
  --after "In Progress"
```

## Presentation

On success, confirm with the new ordering:
> "Moved 'Done' to right after 'In Progress' in your Work board."

If helpful, follow up with the new column order from `sections list --project Work --human` so the user sees the result.

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on project / section / anchor → standard messages. Suggest `sections list --project <name>` to see what's available.
- `USAGE` "exactly one of --before or --after" → you passed both or neither. Pick one.
- `USAGE` "Cannot move a section relative to itself" → the user said "move X before X" — ask what they actually meant.

## Notes

TickTick uses huge integer gaps (often multiples of 2^16) for sortOrder. The CLI computes a midpoint between the anchor and its neighbor automatically — you don't need to think about sortOrder values directly.
