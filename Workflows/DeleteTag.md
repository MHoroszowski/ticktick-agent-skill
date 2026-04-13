# Workflow: DeleteTag

**Intent:** User wants to remove a tag — "delete the X tag," "remove tag X," "get rid of the X tag."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DeleteTag workflow in the TickTick skill to delete a tag"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **name** — the tag slug. If the user names the tag by display label, look it up first with `tags list` and extract the slug.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tags delete --name work-projects
```

## Presentation

**Confirm before executing** — deleting a tag removes it from every task that currently uses it (TickTick does not delete the tasks, just un-tags them):
> "I'm about to delete the 'work-projects' tag. Tasks that currently have it will just be un-tagged. Proceed?"

On success:
> "Deleted the 'work-projects' tag."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find a tag named '[X]'. Run `ticktick tags list` to see available tags."
- Any other code → surface `.error.message` verbatim.
