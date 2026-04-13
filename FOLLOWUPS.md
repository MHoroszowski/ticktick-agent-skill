# TickTick skill — Follow-ups

Known gaps that are out of scope for v1, tracked for future work.

---

## v1.3 rough edges (discovered during merge smoke 2026-04-13)

**Hotfixed on main before PLAN_01 merge:**
- `tasks unpin` was sending `pinnedTime: null` via the library's patch endpoint, which silently no-ops. Fixed via `POST /api/v2/batch/task` with full task body and sentinel `pinnedTime: "-1"`.
- `tasks completed --from --to` was hitting `statistics.listCompleted()` which returns HTTP 500. Fixed by routing through the iterator endpoint with client-side date filtering.

**Known quirks shipped with v1.3 (documented, not yet fixed):**

1. **`tags rename` is label-only.** TickTick's tag model has `name` (immutable slug) and `label` (mutable display). The library's rename updates only `label`. A true slug rename is not exposed via the v2 API the library reaches. Documented in SKILL.md, README.md, and Workflows/RenameTag.md. Manual workaround for users: create new tag → re-tag affected tasks → delete old tag. *Fix path:* investigate whether TickTick's web UI does real slug renames via a different endpoint, or accept "label-only" as the final semantics and loosen the CLI validator to allow labels with spaces/caps.

2. **Untested v1.3 features — no smoke coverage:**
   - `tags merge`, `tags delete`
   - `projects create` / `update` / `delete`
   - `tasks restore`
   These typecheck and look wired but were not smoke-verified before ship. If any silently fails, apply the "upstream library bug pattern" from SKILL.md "Known quirks" — switch to the batch endpoint with a full record body. *Fix path:* write a focused diagnostic probe, exercise each once, fix any that silently fail via the adapter escape-hatch pattern.

3. **The upstream `ticktick-client@0.2.1` library has a systemic bug pattern** where mutations sent via `POST /api/v2/task/{id}` silently no-op for fields like `pinnedTime` (and presumably others). The batch endpoint (`POST /api/v2/batch/task`) with a full task body is the reliable alternative. *Fix path:* file upstream PR #5 against `jaeyeonling/ticktick-client` to correct pin/unpin (and audit other patch-endpoint calls for the same issue).

---

## 1. Engineer agent worktree infrastructure

**What happened:** When trying to delegate steps 5–12 of this skill's implementation to the Engineer subagent, the delegation failed:
```
Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured.
```

The Engineer agent is configured to run in an isolated git worktree. That requires either:
- The CWD at agent-spawn time (which is `~/.claude`) to be a git repository, OR
- WorktreeCreate / WorktreeRemove hooks to be configured in `settings.json` for non-git VCS isolation

`~/.claude` is not a git repo, and no hooks are configured, so the spawn failed.

**Workaround used:** Athena (the main conversation agent) completed all steps solo. No blockage — but no delegation either.

**Possible fixes (not yet done):**

1. **Make `~/.claude` a git repo.** Initialize git at the PAI root, gitignore credentials / caches / session files, commit the current state. Benefits: Engineer agent works, and the user gets version history on their PAI setup for free. Cost: structural change to PAI root; need to be careful about secrets.
2. **Configure WorktreeCreate hooks** in `settings.json`. Use a non-git worktree mechanism (e.g. `cp -a` to a temp dir, run agent there, merge back). Complex but avoids imposing git on the PAI root.
3. **Spawn Engineer with explicit CWD** pointing at a skill subdirectory that IS a git repo. The TickTick skill now has its own `.git/` — if the Agent tool exposes a way to override CWD for the Engineer spawn, that would unblock it. Not sure the tool supports this.
4. **Leave it alone.** If delegation to Engineer isn't critical for skill development, accept Athena-only execution for this category of work.

**Recommendation:** Option 1 (git at `~/.claude`) is probably the right long-term answer. Worth a conversation, not a fix made in passing.

---

## 2. Concurrent-invocation session file race

**What's missing:** If two `./bin/ticktick` invocations run at exactly the same time on a stale session, both will attempt a re-login and both will write to the session file. Last writer wins. No file lock.

**Why it's not in v1:** The agent is the primary consumer and invocations are naturally serial. A human double-invoking in the same second is unlikely.

**Fix:** Add an advisory lockfile in `.session/` that commands acquire before mutating the session. The `proper-lockfile` npm package handles this cleanly, or we can roll our own with `fs.openSync(..., 'wx')`.

---

## 3. `--human` output polish

The current `formatTasksTable` / `formatProjectsTable` are minimal — fixed column widths, no color, basic alignment. Usable but not pretty.

**Fix:** Add ANSI color for priority glyphs and overdue tasks, dynamic column widths based on terminal size (via `process.stdout.columns`), and maybe a compact mode for agent-mediated sessions where the human table is only shown for confirmation.

---

## 4. Natural-language date parsing at the CLI layer

`tasks create --due "tomorrow at 3pm"` currently fails because the CLI expects ISO 8601. The agent does the conversion today.

**Fix (optional):** Accept natural-language dates at the CLI layer using a small library like `chrono-node`. Adds a dependency but reduces agent-side complexity. **Verdict:** probably not worth it — the agent is better at natural language than any library.

---

## 5. `restore` command for recently-deleted tasks

Blocked on the TickTick v2 API bug where `GET /api/v2/project/{id}/tasks?status=-1` returns active tasks, not trashed ones. The library documents this.

**Fix (not us):** Would require TickTick to fix their API, or a workaround using a different endpoint we haven't discovered. Low priority.
