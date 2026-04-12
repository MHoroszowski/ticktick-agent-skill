# Workflow: ListProjects

**Intent:** User wants to see their lists / projects — "what lists do I have," "show me my projects," "what categories am I using."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ListProjects workflow in the TickTick skill to list projects"}' \
  > /dev/null 2>&1 &
```

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick projects list
```

Or fetch a single project by name:
```bash
~/.claude/skills/TickTick/bin/ticktick projects get --id "Work"
```

## Presentation

Parse `.projects` and present a simple list grouped by closed/open status. Use the project name prominently; surface color only if asked. Show the short id in parentheses so the user (or a follow-up command) can reference it by id if needed.

Example:
```
You have 5 active lists:
  • Inbox       (default)
  • Work
  • Personal
  • Home
  • TEST - PAI Skill
```

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on `projects get` → "No project named '[X]'. Try `ticktick projects list`."
