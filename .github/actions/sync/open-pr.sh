#!/usr/bin/env bash
# The git half of `import`: the files the adapter rewrote go on one long-lived branch (recreated from
# the checked-out base and force-pushed, so the pull request always shows the latest state), and the
# pull request is opened once and updated after. Inputs arrive as environment variables from action.yml.
set -euo pipefail

: "${GH_TOKEN:?github_token is required to open a pull request}"
: "${FILES:?}" "${BRANCH:?}" "${BASE_BRANCH:?}" "${PR_TITLE:?}" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
root="${ROOT:-.}"

mapfile -t files < <(jq -r '.[]' <<<"$FILES" | sed "s#^#${root%/}/#")
if [ "${#files[@]}" -eq 0 ]; then
  echo "nothing to commit"
  exit 0
fi

git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"

remote_exists=0
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then remote_exists=1; fi

# The workflow checked out the base branch; the rewritten files ride along onto the new branch.
git checkout --quiet -B "$BRANCH"
git add -- "${files[@]}"

if git diff --cached --quiet; then
  echo "translations already on $BASE_BRANCH"
  echo "pr_url=" >>"$GITHUB_OUTPUT"
  exit 0
fi

git commit --quiet -m "chore: update translations ($(date -u +%Y-%m-%d))"
if [ "$remote_exists" -eq 1 ]; then git push --force --quiet origin "$BRANCH"; else git push --quiet -u origin "$BRANCH"; fi

body="$(printf '%s translated values across %s files, applied from loqo.\n' "${WRITTEN:-?}" "${#files[@]}")"
existing="$(gh pr list --head "$BRANCH" --base "$BASE_BRANCH" --state open --json url --jq '.[0].url // empty')"
if [ -n "$existing" ]; then
  gh pr edit "$existing" --title "$PR_TITLE" --body "$body" >/dev/null
  url="$existing"
else
  url="$(gh pr create --title "$PR_TITLE" --body "$body" --head "$BRANCH" --base "$BASE_BRANCH")"
fi
echo "pr_url=$url" >>"$GITHUB_OUTPUT"
echo "$url"
