#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

readonly EXPECTED_NAME="stevelee477"
readonly EXPECTED_EMAIL="hi.whoareyou12@gmail.com"
readonly OFFICIAL_NPM_HOST="registry.npmjs.org"
# Keep denied identifiers encoded so the audit policy does not leak the
# private values in its own tracked source.
readonly DENIED_CORPORATE_MARKER="$(printf '\164\145\156\143\145\156\164')"
readonly DENIED_LOCAL_USER="$(printf '\163\164\145\146\141\156\157\154\151')"
readonly USER_PATH_PATTERN="/""Users/[^/[:space:]]+"
readonly EMAIL_PATTERN="[A-Za-z0-9.!#\$%&'*+/=?^_{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}"

commit_identity_issues=0
tag_identity_issues=0
user_path_issues=0
email_issues=0
npm_source_issues=0
denied_identifier_issues=0

if ! command -v git >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Privacy audit failed: required runtime unavailable." >&2
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  printf '%s\n' "Privacy audit failed: Git repository unavailable." >&2
  exit 1
fi

audit_tmp="$(mktemp -d)"
trap 'rm -rf -- "$audit_tmp"' EXIT

is_allowed_email() {
  local email="$1"

  if [[ "$email" == "$EXPECTED_EMAIL" || "$email" == "noreply@github.com" ]]; then
    return 0
  fi

  [[ "$email" =~ ^([0-9]+\+)?[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?(\[bot\])?@users\.noreply\.github\.com$ ]]
}

scan_repository_content() {
  local content_file="$1"
  local email

  if grep -aFqi -- "$DENIED_CORPORATE_MARKER" "$content_file" || grep -aFqi -- "$DENIED_LOCAL_USER" "$content_file"; then
    denied_identifier_issues=$((denied_identifier_issues + 1))
  fi

  if grep -aEq -- "$USER_PATH_PATTERN" "$content_file"; then
    user_path_issues=$((user_path_issues + 1))
  fi

  # Compressed image/archive bytes can coincidentally resemble an email. Scan
  # email tokens only in text; local-path byte sequences remain checked above
  # for every blob. Binary release assets receive a separate archive audit.
  if ! grep -Iq . "$content_file"; then
    return
  fi

  while IFS= read -r email; do
    if ! is_allowed_email "$email"; then
      email_issues=$((email_issues + 1))
    fi
  done < <(grep -aEo -- "$EMAIL_PATTERN" "$content_file" | sort -fu || true)
}

scan_npm_sources() {
  local kind="$1"
  local content_file="$2"

  if ! node - "$kind" "$content_file" "$OFFICIAL_NPM_HOST" <<'NODE'
const fs = require("node:fs");

const kind = process.argv[2];
const file = process.argv[3];
const officialHost = process.argv[4];
const source = fs.readFileSync(file, "utf8");
let valid = true;

function isOfficialSource(value) {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === officialHost
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function checkJson(value, inspectDependencySpecs) {
  if (Array.isArray(value)) {
    for (const item of value) {
      checkJson(item, inspectDependencySpecs);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (["registry", "resolved", "tarball"].includes(normalizedKey)
        && typeof child === "string"
        && !isOfficialSource(child)) {
      valid = false;
    }

    if (inspectDependencySpecs
        && ["dependencies", "devdependencies", "optionaldependencies", "peerdependencies"].includes(normalizedKey)
        && child
        && typeof child === "object") {
      for (const spec of Object.values(child)) {
        if (typeof spec === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(spec) && !isOfficialSource(spec)) {
          valid = false;
        }
      }
    }

    checkJson(child, inspectDependencySpecs);
  }
}

function checkNpmConfig() {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const separator = line.indexOf("=");
    const key = (separator >= 0 ? line.slice(0, separator) : line).trim().toLowerCase();
    const value = (separator >= 0 ? line.slice(separator + 1) : "").trim();

    if (key === "registry" || key.endsWith(":registry")) {
      if (!isOfficialSource(value)) {
        valid = false;
      }
    }

    if (key.startsWith("//")) {
      try {
        const parsed = new URL(`https:${key}`);
        if (parsed.hostname !== officialHost) {
          valid = false;
        }
      } catch {
        valid = false;
      }
    }

    const urls = value.match(/https?:\/\/[^\s"'`}]+/gi) || [];
    for (const url of urls) {
      if (!isOfficialSource(url)) {
        valid = false;
      }
    }
  }
}

function checkTextLock() {
  for (const rawLine of source.split(/\r?\n/)) {
    if (!/(resolved|resolution|tarball|registry)/i.test(rawLine)) {
      continue;
    }
    const urls = rawLine.match(/https?:\/\/[^\s"'`}]+/gi) || [];
    for (const url of urls) {
      if (!isOfficialSource(url)) {
        valid = false;
      }
    }
  }
}

try {
  if (kind === "lock-json") {
    checkJson(JSON.parse(source), false);
  } else if (kind === "package-json") {
    checkJson(JSON.parse(source), true);
  } else if (kind === "npm-config") {
    checkNpmConfig();
  } else if (kind === "text-lock") {
    checkTextLock();
  } else {
    valid = false;
  }
} catch {
  valid = false;
}

process.exitCode = valid ? 0 : 1;
NODE
  then
    npm_source_issues=$((npm_source_issues + 1))
  fi
}

npm_file_kind() {
  local base_name="${1##*/}"

  case "$base_name" in
    package-lock.json|npm-shrinkwrap.json)
      printf '%s' "lock-json"
      ;;
    package.json)
      printf '%s' "package-json"
      ;;
    .npmrc|npmrc|.pnpmrc|.yarnrc|.yarnrc.yml)
      printf '%s' "npm-config"
      ;;
    yarn.lock|pnpm-lock.yaml|pnpm-lock.yml)
      printf '%s' "text-lock"
      ;;
  esac
}

while IFS= read -r commit; do
  author_name="$(git show -s --format='%an' "$commit" 2>/dev/null)"
  author_email="$(git show -s --format='%ae' "$commit" 2>/dev/null)"
  committer_name="$(git show -s --format='%cn' "$commit" 2>/dev/null)"
  committer_email="$(git show -s --format='%ce' "$commit" 2>/dev/null)"

  if [[ "$author_name" != "$EXPECTED_NAME"
      || "$author_email" != "$EXPECTED_EMAIL"
      || "$committer_name" != "$EXPECTED_NAME"
      || "$committer_email" != "$EXPECTED_EMAIL" ]]; then
    commit_identity_issues=$((commit_identity_issues + 1))
  fi
done < <(git rev-list --all)

object_metadata="$audit_tmp/object-metadata"
git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' > "$object_metadata"

while IFS=' ' read -r object_id object_type; do
  case "$object_type" in
    blob)
      git cat-file blob "$object_id" > "$audit_tmp/stored-content" 2>/dev/null
      scan_repository_content "$audit_tmp/stored-content"
      ;;
    tag)
      tagger_line="$(git cat-file tag "$object_id" 2>/dev/null | sed -n 's/^tagger //p' | head -n 1)"
      tagger_identity="$(printf '%s\n' "$tagger_line" | sed -E 's/ [0-9]+ [+-][0-9]{4}$//')"
      if [[ "$tagger_identity" != "$EXPECTED_NAME <$EXPECTED_EMAIL>" ]]; then
        tag_identity_issues=$((tag_identity_issues + 1))
      fi
      ;;
  esac
done < "$object_metadata"

seen_npm_objects="$audit_tmp/seen-npm-objects"
: > "$seen_npm_objects"
while IFS= read -r commit; do
  while IFS= read -r -d '' tree_entry; do
    metadata="${tree_entry%%$'\t'*}"
    repository_path="${tree_entry#*$'\t'}"
    object_type="$(printf '%s\n' "$metadata" | awk '{print $2}')"
    object_id="${metadata##* }"
    [[ "$object_type" == "blob" ]] || continue

    kind="$(npm_file_kind "$repository_path")"
    [[ -n "$kind" ]] || continue

    object_key="$object_id $kind"
    if grep -Fqx -- "$object_key" "$seen_npm_objects"; then
      continue
    fi
    printf '%s\n' "$object_key" >> "$seen_npm_objects"

    git cat-file blob "$object_id" > "$audit_tmp/npm-content" 2>/dev/null
    scan_npm_sources "$kind" "$audit_tmp/npm-content"
  done < <(git ls-tree -r -z "$commit")
done < <(git rev-list --all)

while IFS= read -r -d '' repository_path; do
  if [[ -L "$repository_path" ]]; then
    readlink "$repository_path" > "$audit_tmp/worktree-content"
  elif [[ -f "$repository_path" ]]; then
    cp -- "$repository_path" "$audit_tmp/worktree-content"
  else
    continue
  fi

  scan_repository_content "$audit_tmp/worktree-content"
  kind="$(npm_file_kind "$repository_path")"
  if [[ -n "$kind" ]]; then
    scan_npm_sources "$kind" "$audit_tmp/worktree-content"
  fi
done < <(git ls-files -co --exclude-standard -z)

if (( commit_identity_issues > 0
      || tag_identity_issues > 0
      || user_path_issues > 0
      || email_issues > 0
      || npm_source_issues > 0
      || denied_identifier_issues > 0 )); then
  printf '%s\n' "Privacy audit failed." >&2
  (( commit_identity_issues > 0 )) && printf '%s\n' "- Commit identity policy violation." >&2
  (( tag_identity_issues > 0 )) && printf '%s\n' "- Tag identity policy violation." >&2
  (( user_path_issues > 0 )) && printf '%s\n' "- Local user path policy violation." >&2
  (( email_issues > 0 )) && printf '%s\n' "- Email allowlist policy violation." >&2
  (( npm_source_issues > 0 )) && printf '%s\n' "- Package source policy violation." >&2
  (( denied_identifier_issues > 0 )) && printf '%s\n' "- Denied private identifier policy violation." >&2
  exit 1
fi

printf '%s\n' "Privacy audit passed."
