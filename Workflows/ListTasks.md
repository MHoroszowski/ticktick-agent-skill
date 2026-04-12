# Workflow: ListTasks

**Intent:** User wants to see their tasks — "what's in my inbox," "what's due today," "show me my tasks for [list]," "what's on my todo."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ListTasks workflow in the TickTick skill to list tasks"}' \
  > /dev/null 2>&1 &
```

## Execute

Default — all open tasks across all projects:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list
```

Filter examples:
```bash
# Tasks in a specific list (name or id)
~/.claude/skills/TickTick/bin/ticktick tasks list --project "Inbox"

# What's due today
~/.claude/skills/TickTick/bin/ticktick tasks list --due today

# Overdue
~/.claude/skills/TickTick/bin/ticktick tasks list --due overdue

# Everything due in the next week
~/.claude/skills/TickTick/bin/ticktick tasks list --due week

# Tasks tagged with a specific tag
~/.claude/skills/TickTick/bin/ticktick tasks list --tag work

# Completed tasks (not in the default open filter)
~/.claude/skills/TickTick/bin/ticktick tasks list --status completed

# Cap the output
~/.claude/skills/TickTick/bin/ticktick tasks list --limit 10
```

## Presentation

Parse the JSON `tasks` array and present to the user as a scannable list. For each task, show: title, due date if present, priority if not "none", the list name, and the task id (shortened — last 8 chars).

Example:
```
Inbox · 3 open tasks
  • Call mom about weekend trip         (due today, !!, id: 7a5f1b2c)
  • Update quarterly review spreadsheet (!, id: 92ae3d4f)
  • Replace HVAC filter                   (id: 01cd9e6a)
```

If `.count === 0`, say "No tasks match that filter." and offer a broader query.

## Errors

- `AUTH_MISSING_CREDS` → "TickTick credentials aren't set. Add `TICKTICK_EMAIL` and `TICKTICK_PASSWORD` to `~/.env`."
- `AUTH_FAILED` / `AUTH_EXPIRED` → "Your TickTick session needs a refresh. Run `~/.claude/skills/TickTick/bin/ticktick login`."
- `NOT_FOUND` (usually from a typo in `--project`) → "I couldn't find a project matching that name. Run `ticktick projects list` to see what's available."
- Any other code → surface `.error.message` verbatim.
