#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CHECKER="$SCRIPT_DIR/check-private-history.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/nested-json-tree-private-history.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT

new_repository() {
  local repository_dir="$1"

  git init --quiet -b main "$repository_dir"
  env \
    GIT_AUTHOR_NAME='stevelee477' \
    GIT_AUTHOR_EMAIL="hi.whoareyou12@gmail.com" \
    GIT_COMMITTER_NAME='stevelee477' \
    GIT_COMMITTER_EMAIL="hi.whoareyou12@gmail.com" \
    git -C "$repository_dir" -c commit.gpgsign=false commit --quiet --allow-empty -m 'base'
}

commit_as_github_bot() {
  local repository_dir="$1"
  shift

  env \
    GIT_AUTHOR_NAME='dependabot[bot]' \
    GIT_AUTHOR_EMAIL="49699333+dependabot[bot]@users.noreply.github.com" \
    GIT_COMMITTER_NAME='GitHub' \
    GIT_COMMITTER_EMAIL="noreply@github.com" \
    git -C "$repository_dir" -c commit.gpgsign=false commit --quiet --allow-empty "$@"
}

expect_pass() {
  local case_name="$1"
  local repository_dir="$2"
  local audit_output

  if ! audit_output="$(cd "$repository_dir" && bash "$CHECKER" 2>&1)"; then
    printf '%s\n%s\n' "$case_name unexpectedly failed:" "$audit_output" >&2
    exit 1
  fi
  if [[ "$audit_output" != *"Privacy audit passed."* ]]; then
    printf '%s\n%s\n' "$case_name returned unexpected output:" "$audit_output" >&2
    exit 1
  fi
}

expect_failure() {
  local case_name="$1"
  local repository_dir="$2"
  local expected_text="$3"
  local audit_output

  if audit_output="$(cd "$repository_dir" && bash "$CHECKER" 2>&1)"; then
    printf '%s\n' "$case_name unexpectedly passed." >&2
    exit 1
  fi
  if [[ "$audit_output" != *"$expected_text"* ]]; then
    printf '%s\n%s\n' "$case_name failed for the wrong reason:" "$audit_output" >&2
    exit 1
  fi
}

expect_rejection() {
  local case_name="$1"
  local repository_dir="$2"

  if (cd "$repository_dir" && bash "$CHECKER" >/dev/null 2>&1); then
    printf '%s\n' "$case_name unexpectedly passed." >&2
    exit 1
  fi
}

allowed_bot_repo="$test_root/allowed-bot"
new_repository "$allowed_bot_repo"
git -C "$allowed_bot_repo" switch --quiet -c automated-update
commit_as_github_bot "$allowed_bot_repo" \
  -m 'build(deps): test an automated update' \
  -m 'Signed-off-by: dependabot[bot] <support@github.com>'
allowed_bot_commit="$(git -C "$allowed_bot_repo" rev-parse HEAD)"
git -C "$allowed_bot_repo" update-ref refs/remotes/origin/dependabot/test "$allowed_bot_commit"
git -C "$allowed_bot_repo" switch --quiet main
git -C "$allowed_bot_repo" branch --quiet -D automated-update
env \
  GIT_COMMITTER_NAME='stevelee477' \
  GIT_COMMITTER_EMAIL="hi.whoareyou12@gmail.com" \
  git -C "$allowed_bot_repo" -c tag.gpgSign=false tag -a v-test -m 'valid annotated tag'
expect_pass 'GitHub bot remote branch' "$allowed_bot_repo"

strict_main_repo="$test_root/strict-main"
new_repository "$strict_main_repo"
commit_as_github_bot "$strict_main_repo" -m 'bot identity on strict main'
expect_failure 'Strict main identity' "$strict_main_repo" 'Commit identity policy violation.'

external_email_repo="$test_root/external-email"
new_repository "$external_email_repo"
git -C "$external_email_repo" switch --quiet -c external-email
external_email="$(printf '\160\145\162\163\157\156\100\145\170\141\155\160\154\145\056\156\145\164')"
env \
  GIT_AUTHOR_NAME='Contributor' \
  GIT_AUTHOR_EMAIL="$external_email" \
  GIT_COMMITTER_NAME='Contributor' \
  GIT_COMMITTER_EMAIL="$external_email" \
  git -C "$external_email_repo" -c commit.gpgsign=false commit --quiet --allow-empty -m 'external email'
expect_failure 'Non-allowlisted branch email' "$external_email_repo" 'Commit identity policy violation.'

wrong_name_repo="$test_root/wrong-name"
new_repository "$wrong_name_repo"
git -C "$wrong_name_repo" switch --quiet -c wrong-name
env \
  GIT_AUTHOR_NAME='Wrong Name' \
  GIT_AUTHOR_EMAIL="hi.whoareyou12@gmail.com" \
  GIT_COMMITTER_NAME='GitHub' \
  GIT_COMMITTER_EMAIL="noreply@github.com" \
  git -C "$wrong_name_repo" -c commit.gpgsign=false commit --quiet --allow-empty -m 'wrong name for project email'
expect_failure 'Project email with wrong name' "$wrong_name_repo" 'Commit identity policy violation.'

support_identity_repo="$test_root/support-identity"
new_repository "$support_identity_repo"
git -C "$support_identity_repo" switch --quiet -c support-identity
env \
  GIT_AUTHOR_NAME='Wrong Name' \
  GIT_AUTHOR_EMAIL="support@github.com" \
  GIT_COMMITTER_NAME='GitHub' \
  GIT_COMMITTER_EMAIL="noreply@github.com" \
  git -C "$support_identity_repo" -c commit.gpgsign=false commit --quiet --allow-empty -m 'support address is content-only'
expect_failure 'GitHub support address as an identity' "$support_identity_repo" 'Commit identity policy violation.'

wrong_tagger_repo="$test_root/wrong-tagger"
new_repository "$wrong_tagger_repo"
env \
  GIT_COMMITTER_NAME='GitHub' \
  GIT_COMMITTER_EMAIL="noreply@github.com" \
  git -C "$wrong_tagger_repo" -c tag.gpgSign=false tag -a invalid-tagger -m 'wrong tagger identity'
expect_failure 'Annotated tagger identity' "$wrong_tagger_repo" 'Tag identity policy violation.'

nul_commit_repo="$test_root/nul-commit"
new_repository "$nul_commit_repo"
nul_tree="$(git -C "$nul_commit_repo" rev-parse 'HEAD^{tree}')"
printf 'tree %s\nauthor stevelee477 <hi.whoareyou12@gmail.com> 1 +0000\ncommitter stevelee477 <hi.whoareyou12@gmail.com> 1 +0000\n\nmessage\000%s\n' \
  "$nul_tree" "$external_email" \
  | git -C "$nul_commit_repo" hash-object --literally -t commit -w --stdin >/dev/null
expect_failure 'NUL-bearing stored commit email' "$nul_commit_repo" 'Email allowlist policy violation.'

fake_tagger_repo="$test_root/fake-tagger"
new_repository "$fake_tagger_repo"
fake_tagger_target="$(git -C "$fake_tagger_repo" rev-parse HEAD)"
printf 'object %s\r\ntype commit\r\ntag forged\r\n\r\ntagger stevelee477 <hi.whoareyou12@gmail.com> 1 +0000\n' \
  "$fake_tagger_target" \
  | git -C "$fake_tagger_repo" hash-object --literally -t tag -w --stdin >/dev/null
expect_failure 'Tagger line forged after malformed headers' "$fake_tagger_repo" 'Tag identity policy violation.'

replace_ref_repo="$test_root/replace-ref"
new_repository "$replace_ref_repo"
replace_base="$(git -C "$replace_ref_repo" rev-parse HEAD)"
commit_as_github_bot "$replace_ref_repo" -m 'strict commit hidden by replacement'
replaced_commit="$(git -C "$replace_ref_repo" rev-parse HEAD)"
replace_tree="$(git -C "$replace_ref_repo" rev-parse 'HEAD^{tree}')"
replacement_commit="$(printf '%s\n' 'replacement with expected identity' \
  | env \
      GIT_AUTHOR_NAME='stevelee477' \
      GIT_AUTHOR_EMAIL="hi.whoareyou12@gmail.com" \
      GIT_COMMITTER_NAME='stevelee477' \
      GIT_COMMITTER_EMAIL="hi.whoareyou12@gmail.com" \
      git -C "$replace_ref_repo" commit-tree "$replace_tree" -p "$replace_base")"
git -C "$replace_ref_repo" replace "$replaced_commit" "$replacement_commit"
expect_failure 'Replace-ref identity bypass' "$replace_ref_repo" 'Commit identity policy violation.'

commit_message_repo="$test_root/commit-message"
new_repository "$commit_message_repo"
git -C "$commit_message_repo" switch --quiet -c encoded-marker
denied_marker="$(printf '\164\145\156\143\145\156\164')"
commit_as_github_bot "$commit_message_repo" -m "$denied_marker"
expect_failure 'Private marker in commit message' "$commit_message_repo" 'Denied private identifier policy violation.'

broken_graph_repo="$test_root/broken-graph"
new_repository "$broken_graph_repo"
broken_graph_tree="$(git -C "$broken_graph_repo" rev-parse 'HEAD^{tree}')"
missing_parent='1111111111111111111111111111111111111111'
broken_graph_commit="$(printf 'tree %s\nparent %s\nauthor GitHub <noreply@github.com> 1 +0000\ncommitter GitHub <noreply@github.com> 1 +0000\n\nbroken graph\n' \
  "$broken_graph_tree" "$missing_parent" \
  | git -C "$broken_graph_repo" hash-object --literally -t commit -w --stdin)"
git -C "$broken_graph_repo" update-ref refs/remotes/origin/broken "$broken_graph_commit"
expect_rejection 'Broken commit graph' "$broken_graph_repo"

printf '%s\n' 'Privacy history regression tests passed.'
