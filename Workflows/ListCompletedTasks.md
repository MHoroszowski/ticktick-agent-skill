# Workflow: ListCompletedTasks

**Intent:** User wants to see what they've finished — "what did I finish last week," "show completed tasks," "what did I get done today," "what have I accomplished in April."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ListCompletedTasks workflow in the TickTick skill to list completed tasks"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

The command has two modes — pick one based on intent:

**Mode A — paginated iterator (default, most recent completed tasks):**
- optional `--project <id|name>` to scope to a single list
- optional `--limit N` (default 50)
- Use when the user says "recent," "latest," "last few," or just "what have I finished."

**Mode B — statistics date range (closed range, all projects):**
- required `--from <ISO>` and `--to <ISO>` together
- optional `--limit N` (default 100)
- **Mutually exclusive with `--project`** — the statistics endpoint is global.
- Use when the user names a date window: "last week," "April 1 through today," "since Monday." Parse natural language into ISO 8601 BEFORE calling — the CLI does NOT parse natural language.

## Execute

Mode A — recent completed in a specific list:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks completed --project "Work" --limit 20
```

Mode A — recent completed across all lists:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks completed --limit 50
```

Mode B — date range, all lists:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks completed \
  --from 2026-04-01T00:00:00.000+0000 \
  --to   2026-04-12T23:59:59.999+0000
```

## Presentation

Parse the JSON `tasks` array (same shape as `tasks list`). Group by day or by project for readability depending on context. Call out the count and the window.

Example (Mode B):
```
12 tasks completed between April 1 and April 12:

Apr 12 · 3 tasks
  • Replace HVAC filter
  • Submit expense report
  • Call mom

Apr 11 · 2 tasks
  • Update quarterly review spreadsheet
  • Review PR #1061
...
```

If `.count === 0`, say "Nothing completed in that window." and offer a broader query.

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` (mutually exclusive flags) → tell the user you can filter by project *or* by date range but not both.
- `NOT_FOUND` on the project → "I couldn't find that list. Run `ticktick projects list`."
- Any other code → surface `.error.message` verbatim.
