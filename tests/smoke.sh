#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# tests/smoke.sh — live-API end-to-end acceptance test
# ─────────────────────────────────────────────────────────────────
#
# Prerequisites:
#   1. `TICKTICK_EMAIL` and `TICKTICK_PASSWORD` are set in ~/.env
#   2. A project named "TEST - PAI Skill" exists in your TickTick account.
#      Create it manually via the TickTick web UI before running this test.
#   3. `jq` is installed (apt install jq).
#
# What it does:
#   - whoami + projects list sanity
#   - Creates a task, gets it, updates it, adds+completes+deletes a checklist
#     item, completes and deletes the task
#   - Corrupts the session file and runs whoami to prove auto-refresh works
#
# The script exits non-zero on any failure and stops at the first error.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TICKTICK="$SKILL_DIR/bin/ticktick"
SESSION_FILE="$SKILL_DIR/.session/ticktick.json"
TEST_PROJECT="TEST - PAI Skill"

log() { printf '\033[1;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[  ok]\033[0m %s\n' "$*"; }

require() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || fail "Missing required tool: $name"
}

require jq
[ -x "$TICKTICK" ] || fail "Binary not executable: $TICKTICK"

# ─── 1. whoami ───
log "Step 1: whoami (auto-login if needed)"
WHOAMI_JSON="$("$TICKTICK" whoami)"
echo "$WHOAMI_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "whoami returned ok=false: $WHOAMI_JSON"
USER_EMAIL="$(echo "$WHOAMI_JSON" | jq -r '.user.email // .user.username // ""')"
[ -n "$USER_EMAIL" ] || fail "whoami returned no user email/username"
USER_ID="$(echo "$WHOAMI_JSON" | jq -r '.user.userId // empty')"
[ -n "$USER_ID" ] || fail "whoami returned no numeric userId (check /api/v2/user/status handling)"
ok "logged in as $USER_EMAIL (userId=$USER_ID)"

# ─── 2. projects list, find TEST project ───
log "Step 2: projects list"
PROJECTS_JSON="$("$TICKTICK" projects list)"
echo "$PROJECTS_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "projects list failed: $PROJECTS_JSON"
PROJECT_ID="$(echo "$PROJECTS_JSON" \
  | jq -r --arg name "$TEST_PROJECT" '.projects[] | select(.name == $name) | .id' \
  | head -n 1)"
[ -n "$PROJECT_ID" ] \
  || fail "Project '$TEST_PROJECT' not found. Create it manually in TickTick first."
ok "found $TEST_PROJECT ($PROJECT_ID)"

# ─── 3. create task ───
log "Step 3: create task"
CREATE_JSON="$("$TICKTICK" tasks create \
  --title "PAI smoke test" \
  --project "$TEST_PROJECT")"
echo "$CREATE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "create failed: $CREATE_JSON"
TASK_ID="$(echo "$CREATE_JSON" | jq -r '.task.id')"
ok "created task $TASK_ID"

# ─── 4. get task ───
log "Step 4: get task"
GET_JSON="$("$TICKTICK" tasks get --id "$TASK_ID")"
echo "$GET_JSON" | jq -e '.ok == true and .task.title == "PAI smoke test"' >/dev/null \
  || fail "get verification failed: $GET_JSON"
ok "verified task title"

# ─── 5. update task ───
log "Step 5: update task"
UPDATE_JSON="$("$TICKTICK" tasks update \
  --id "$TASK_ID" \
  --project "$PROJECT_ID" \
  --title "PAI smoke test (updated)")"
echo "$UPDATE_JSON" | jq -e '.ok == true and .task.title == "PAI smoke test (updated)"' >/dev/null \
  || fail "update verification failed: $UPDATE_JSON"
ok "updated task title"

# ─── 6. add checklist item ───
log "Step 6: add checklist item"
CHECKLIST_ADD_JSON="$("$TICKTICK" checklist add \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --title "sub-item 1")"
echo "$CHECKLIST_ADD_JSON" | jq -e '.ok == true and (.task.items | length) >= 1' >/dev/null \
  || fail "checklist add failed or items[] empty: $CHECKLIST_ADD_JSON"
ITEM_ID="$(echo "$CHECKLIST_ADD_JSON" | jq -r '.task.items[] | select(.title == "sub-item 1") | .id' | head -n 1)"
[ -n "$ITEM_ID" ] || fail "couldn't locate newly added checklist item in response"
ok "added checklist item $ITEM_ID"

# ─── 7. complete checklist item ───
log "Step 7: complete checklist item"
CHECKLIST_DONE_JSON="$("$TICKTICK" checklist complete \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --item "$ITEM_ID")"
echo "$CHECKLIST_DONE_JSON" | jq -e ".ok == true and (.task.items[] | select(.id == \"$ITEM_ID\") | .completed == true)" >/dev/null \
  || fail "checklist complete verification failed: $CHECKLIST_DONE_JSON"
ok "completed checklist item"

# ─── 8. delete checklist item ───
log "Step 8: delete checklist item"
CHECKLIST_DEL_JSON="$("$TICKTICK" checklist delete \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --item "$ITEM_ID")"
echo "$CHECKLIST_DEL_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "checklist delete failed: $CHECKLIST_DEL_JSON"
ok "deleted checklist item"

# ─── 9. complete task ───
log "Step 9: complete task"
COMPLETE_JSON="$("$TICKTICK" tasks complete --id "$TASK_ID" --project "$PROJECT_ID")"
echo "$COMPLETE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "complete failed: $COMPLETE_JSON"
ok "completed task"

# ─── 10. delete task ───
log "Step 10: delete task"
DELETE_JSON="$("$TICKTICK" tasks delete --id "$TASK_ID" --project "$PROJECT_ID")"
echo "$DELETE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "delete failed: $DELETE_JSON"
ok "deleted task"

# ─── 11. members list ───
# Verifies /api/v2/project/{id}/users works. NOTE: TickTick returns [] on
# this endpoint for SOLO projects (only populates for shared lists with
# multiple members). The TEST project is solo, so we just assert ok=true
# here. The real shared-list test happens organically if you run the
# skill against your actual Shopping list.
log "Step 11: members list (TEST is a solo project, expect ok=true, count may be 0)"
MEMBERS_JSON="$("$TICKTICK" members list --project "$TEST_PROJECT")"
echo "$MEMBERS_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "members list failed: $MEMBERS_JSON"
MEMBER_COUNT="$(echo "$MEMBERS_JSON" | jq -r '.count')"
ok "members list ok=true, count=$MEMBER_COUNT (solo projects return 0)"

# ─── 12. create task assigned to self ───
log "Step 12: create task with --assignee me"
ASSIGN_CREATE_JSON="$("$TICKTICK" tasks create --title "Smoke assignee test" --project "$TEST_PROJECT" --assignee me)"
echo "$ASSIGN_CREATE_JSON" | jq -e '.ok == true and .task.assignee != null' >/dev/null \
  || fail "create-with-assignee failed or assignee is null: $ASSIGN_CREATE_JSON"
ASSIGNEE_TASK_ID="$(echo "$ASSIGN_CREATE_JSON" | jq -r '.task.id')"
ASSIGNEE_VALUE="$(echo "$ASSIGN_CREATE_JSON" | jq -r '.task.assignee')"
[ "$ASSIGNEE_VALUE" = "$USER_ID" ] \
  || fail "assigned userId $ASSIGNEE_VALUE != self userId $USER_ID (from whoami)"
ok "created task $ASSIGNEE_TASK_ID assigned to self ($ASSIGNEE_VALUE)"

# ─── 13. unassign via update ───
log "Step 13: update task with --assignee unassign"
UNASSIGN_JSON="$("$TICKTICK" tasks update --id "$ASSIGNEE_TASK_ID" --project "$PROJECT_ID" --title "Smoke assignee test" --assignee unassign)"
echo "$UNASSIGN_JSON" | jq -e '.ok == true and .task.assignee == null' >/dev/null \
  || fail "unassign failed or assignee still set: $UNASSIGN_JSON"
ok "unassigned task $ASSIGNEE_TASK_ID"

# ─── 14. cleanup the assignee test task ───
log "Step 14: delete assignee test task"
"$TICKTICK" tasks delete --id "$ASSIGNEE_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of assignee test task failed"
ok "cleaned up assignee test task"

# ─── 15. sections list ───
# Sections are tested against the user's real Shopping list since TEST is
# solo and has no sections. Read-only — no state mutation.
log "Step 15: sections list against a real shared project (🛒Shopping)"
SECTIONS_JSON="$("$TICKTICK" sections list --project "🛒Shopping" 2>&1)"
SECTIONS_OK="$(echo "$SECTIONS_JSON" | jq -r '.ok // false' 2>/dev/null || echo "false")"
if [ "$SECTIONS_OK" = "true" ]; then
  SECTION_COUNT="$(echo "$SECTIONS_JSON" | jq -r '.count')"
  [ "$SECTION_COUNT" -ge 1 ] \
    || fail "sections list returned 0 sections for 🛒Shopping (expected >= 1)"
  ok "sections list ok, count=$SECTION_COUNT on 🛒Shopping"
else
  log "skipped: sections list failed (likely no shared Shopping list on this account) — $SECTIONS_JSON"
fi

# ─── 16. tasks create with --section ───
# Round-trip: create a throwaway task targeting a specific section, verify
# columnId was set, then delete. Only runs if sections list succeeded.
if [ "$SECTIONS_OK" = "true" ] && [ "${SECTION_COUNT:-0}" -ge 1 ]; then
  FIRST_SECTION_NAME="$(echo "$SECTIONS_JSON" | jq -r '.sections[0].name')"
  FIRST_SECTION_ID="$(echo "$SECTIONS_JSON" | jq -r '.sections[0].id')"
  log "Step 16: create task in 🛒Shopping with --section \"$FIRST_SECTION_NAME\""
  SECTION_CREATE_JSON="$("$TICKTICK" tasks create \
    --title "PAI smoke section test (please delete me)" \
    --project "🛒Shopping" \
    --section "$FIRST_SECTION_NAME" 2>&1)"
  echo "$SECTION_CREATE_JSON" | jq -e '.ok == true' >/dev/null \
    || fail "create-with-section failed: $SECTION_CREATE_JSON"
  SECTION_TASK_ID="$(echo "$SECTION_CREATE_JSON" | jq -r '.task.id')"
  SECTION_TASK_COL="$(echo "$SECTION_CREATE_JSON" | jq -r '.task.columnId // empty')"
  [ "$SECTION_TASK_COL" = "$FIRST_SECTION_ID" ] \
    || fail "columnId mismatch: expected $FIRST_SECTION_ID, got $SECTION_TASK_COL"
  ok "task $SECTION_TASK_ID landed in section $FIRST_SECTION_NAME ($SECTION_TASK_COL)"
  # Find the Shopping project id from earlier and use it for cleanup
  SHOPPING_ID="$("$TICKTICK" projects list | jq -r '.projects[] | select(.name == "🛒Shopping") | .id')"
  "$TICKTICK" tasks delete --id "$SECTION_TASK_ID" --project "$SHOPPING_ID" >/dev/null \
    || fail "cleanup of section test task failed"
  ok "cleaned up section test task"
else
  log "skipped step 16: no sections available on Shopping"
fi

# ─── 17. members remove dry-run safety gate ───
# Verifies that `members remove` without --force aborts non-destructively
# with the confirmation message on stderr. Uses a fake userId (999999999)
# against the TEST project so nothing real is touched.
log "Step 17: members remove dry-run safety gate (no --force, fake user)"
set +e
REMOVE_DRY_OUTPUT="$("$TICKTICK" members remove --project "$TEST_PROJECT" --user 999999999 2>&1)"
REMOVE_DRY_EXIT=$?
set -e
[ $REMOVE_DRY_EXIT -eq 2 ] \
  || fail "dry-run should exit 2 (usage error), got $REMOVE_DRY_EXIT. output: $REMOVE_DRY_OUTPUT"
echo "$REMOVE_DRY_OUTPUT" | grep -q "Confirmation required" \
  || echo "$REMOVE_DRY_OUTPUT" | grep -q "force" \
  || fail "dry-run output didn't mention confirmation/force. output: $REMOVE_DRY_OUTPUT"
ok "dry-run correctly aborted without --force"

# ─── 18. nested subtasks: full lifecycle ───
log "Step 18: nested subtasks lifecycle (create parent → create child → indent → promote → tree → delete-orphans)"
NS_PARENT_JSON="$("$TICKTICK" tasks create --title "PAI smoke nested parent" --project "$TEST_PROJECT")"
echo "$NS_PARENT_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "nested parent create failed: $NS_PARENT_JSON"
NS_PARENT="$(echo "$NS_PARENT_JSON" | jq -r '.task.id')"
ok "created nested parent $NS_PARENT"

# 18a: create a child task using --parent (project auto-resolved from parent)
NS_CHILD1_JSON="$("$TICKTICK" tasks create --title "PAI nested child 1" --parent "$NS_PARENT")"
echo "$NS_CHILD1_JSON" | jq -e ".ok == true and .task.parentId == \"$NS_PARENT\"" >/dev/null \
  || fail "child create failed or parentId not echoed: $NS_CHILD1_JSON"
NS_CHILD1="$(echo "$NS_CHILD1_JSON" | jq -r '.task.id')"
ok "created child $NS_CHILD1 with parentId set on first write"

# 18b: create a sibling top-level, then indent it under the parent
NS_CHILD2_JSON="$("$TICKTICK" tasks create --title "PAI nested child 2" --project "$TEST_PROJECT")"
NS_CHILD2="$(echo "$NS_CHILD2_JSON" | jq -r '.task.id')"
echo "$NS_CHILD2_JSON" | jq -e '.ok == true and .task.parentId == null' >/dev/null \
  || fail "child2 should be created top-level: $NS_CHILD2_JSON"

INDENT_JSON="$("$TICKTICK" tasks indent --id "$NS_CHILD2" --under "$NS_PARENT")"
echo "$INDENT_JSON" | jq -e ".ok == true and .parentId == \"$NS_PARENT\"" >/dev/null \
  || fail "indent failed: $INDENT_JSON"
ok "indented child2 under parent via /api/v2/batch/taskParent"

# 18c: list direct children of the parent — both should show
LIST_PARENT_JSON="$("$TICKTICK" tasks list --parent "$NS_PARENT")"
echo "$LIST_PARENT_JSON" | jq -e '.ok == true and .count == 2' >/dev/null \
  || fail "expected 2 children under parent, got: $LIST_PARENT_JSON"
ok "tasks list --parent returns both children"

# 18d: promote child1 — should leave only child2 as a child
PROMOTE_JSON="$("$TICKTICK" tasks promote --id "$NS_CHILD1")"
echo "$PROMOTE_JSON" | jq -e '.ok == true and .parentId == null' >/dev/null \
  || fail "promote failed: $PROMOTE_JSON"
LIST_AFTER_PROMOTE_JSON="$("$TICKTICK" tasks list --parent "$NS_PARENT")"
echo "$LIST_AFTER_PROMOTE_JSON" | jq -e '.ok == true and .count == 1' >/dev/null \
  || fail "expected 1 child after promote, got: $LIST_AFTER_PROMOTE_JSON"
# Verify the child1 actually has parentId == null on the server
GET_CHILD1_JSON="$("$TICKTICK" tasks get --id "$NS_CHILD1")"
echo "$GET_CHILD1_JSON" | jq -e '.task.parentId == null' >/dev/null \
  || fail "child1 still has parentId after promote: $GET_CHILD1_JSON"
ok "promote cleared parentId server-side"

# 18e: error case — indent under self
set +e
INDENT_SELF_OUT="$("$TICKTICK" tasks indent --id "$NS_CHILD2" --under "$NS_CHILD2" 2>&1)"
INDENT_SELF_EXIT=$?
set -e
[ $INDENT_SELF_EXIT -eq 2 ] \
  || fail "indent-self should exit 2 (USAGE), got $INDENT_SELF_EXIT: $INDENT_SELF_OUT"
ok "indent-under-self correctly rejected"

# 18f: error case — indent under non-existent parent
set +e
INDENT_FAKE_OUT="$("$TICKTICK" tasks indent --id "$NS_CHILD2" --under 000000000000000000000000 2>&1)"
INDENT_FAKE_EXIT=$?
set -e
[ $INDENT_FAKE_EXIT -eq 4 ] \
  || fail "indent-fake should exit 4 (NOT_FOUND), got $INDENT_FAKE_EXIT: $INDENT_FAKE_OUT"
ok "indent-under-bogus-parent correctly rejected"

# 18g: tree mode — create a grandchild under child2 and verify recursive output
NS_GC_JSON="$("$TICKTICK" tasks create --title "PAI nested grandchild" --parent "$NS_CHILD2")"
NS_GC="$(echo "$NS_GC_JSON" | jq -r '.task.id')"
TREE_JSON="$("$TICKTICK" tasks list --parent "$NS_PARENT" --tree)"
# Should report 2 nodes total: child2 and the grandchild beneath it
echo "$TREE_JSON" | jq -e '.ok == true and .count == 2' >/dev/null \
  || fail "tree mode wrong count: $TREE_JSON"
# And the tree should be 2 levels deep
echo "$TREE_JSON" | jq -e ".tree[0].children[0].task.id == \"$NS_GC\"" >/dev/null \
  || fail "tree mode missing grandchild: $TREE_JSON"
ok "tree mode renders 2-level recursive children correctly"

# 18h: top-level filter — confirm parent appears, child2/grandchild don't
TOPLEVEL_JSON="$("$TICKTICK" tasks list --top-level --project "$TEST_PROJECT")"
echo "$TOPLEVEL_JSON" \
  | jq -e ".ok == true and ([.tasks[].id] | index(\"$NS_PARENT\") != null) and ([.tasks[].id] | index(\"$NS_CHILD2\") == null) and ([.tasks[].id] | index(\"$NS_GC\") == null)" >/dev/null \
  || fail "--top-level filter wrong: $TOPLEVEL_JSON"
ok "--top-level filter excludes nested children"

# 18i: delete parent — children should be ORPHANED, response should surface them
DELETE_PARENT_JSON="$("$TICKTICK" tasks delete --id "$NS_PARENT")"
echo "$DELETE_PARENT_JSON" | jq -e '.ok == true and (.orphanedChildren | length) >= 1' >/dev/null \
  || fail "delete parent didn't surface orphans: $DELETE_PARENT_JSON"
# Verify child2 still exists with stale parentId
GET_CHILD2_JSON="$("$TICKTICK" tasks get --id "$NS_CHILD2")"
echo "$GET_CHILD2_JSON" | jq -e ".ok == true and .task.parentId == \"$NS_PARENT\"" >/dev/null \
  || fail "child2 should have stale parentId after parent delete: $GET_CHILD2_JSON"
ok "parent delete orphaned children (as documented)"

# 18j: cleanup the orphans
"$TICKTICK" tasks delete --id "$NS_GC" >/dev/null \
  || fail "cleanup grandchild failed"
"$TICKTICK" tasks delete --id "$NS_CHILD2" >/dev/null \
  || fail "cleanup child2 failed"
"$TICKTICK" tasks delete --id "$NS_CHILD1" >/dev/null \
  || fail "cleanup child1 failed"
ok "cleaned up nested subtask test tasks"

# ─── 19. session auto-refresh ───
log "Step 19: session auto-refresh (corrupt session → whoami should silently re-login)"
if [ -f "$SESSION_FILE" ]; then
  echo '{"invalid": true}' > "$SESSION_FILE"
  WHOAMI2_JSON="$("$TICKTICK" whoami)"
  echo "$WHOAMI2_JSON" | jq -e '.ok == true' >/dev/null \
    || fail "whoami after session corruption failed: $WHOAMI2_JSON"
  ok "session auto-refresh recovered"
else
  log "skipped: no session file to corrupt"
fi

printf '\n\033[1;32m✓ All smoke tests passed\033[0m\n'
