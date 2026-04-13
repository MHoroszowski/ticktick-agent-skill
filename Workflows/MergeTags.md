# Workflow: MergeTags

**Intent:** User wants to consolidate two tags — "merge tag X into Y," "combine X and Y into Y," "fold the X tag into Y."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the MergeTags workflow in the TickTick skill to merge tags"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **from** — the source tag slug (will be removed after the merge)
- **to** — the destination tag slug (receives the tasks)

Always confirm the direction — "merge X into Y" means from=X, to=Y. Ask if ambiguous.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tags merge --from work-old --to work
```

## Presentation

**Confirm before executing** — merge is destructive for the source tag:
> "I'm about to merge 'work-old' into 'work'. Every task currently tagged 'work-old' will be re-tagged 'work', and the 'work-old' tag itself will be deleted. Proceed?"

On success:
> "Merged 'work-old' into 'work'. 12 tasks were re-tagged."

(The count comes from the tags list diff; run `tags list` before and after if you need the exact number.)

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` ("--from and --to must differ") → the user named the same tag twice; ask them to clarify.
- `NOT_FOUND` → "I couldn't find one of those tags. Run `ticktick tags list`."
- Any other code → surface `.error.message` verbatim.
