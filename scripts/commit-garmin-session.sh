#!/usr/bin/env bash
set -euo pipefail

unexpected=()
while IFS= read -r -d '' entry; do
  path="${entry:3}"
  if [[ "$path" != "db/garmin.db" ]]; then
    unexpected+=("$path")
  fi
done < <(git status --porcelain=v1 -z --untracked-files=all)

if (( ${#unexpected[@]} )); then
  printf 'Refusing to commit runtime changes outside db/garmin.db:\n' >&2
  printf '  %s\n' "${unexpected[@]}" >&2
  exit 1
fi

if git diff --quiet HEAD -- db/garmin.db; then
  echo 'Garmin Sessions are unchanged.'
  exit 0
fi

pnpm session:check
git add -- db/garmin.db
staged=()
while IFS= read -r path; do
  staged+=("$path")
done < <(git diff --cached --name-only)
if (( ${#staged[@]} != 1 )) || [[ "${staged[0]}" != "db/garmin.db" ]]; then
  echo 'Refusing to commit anything except db/garmin.db.' >&2
  exit 1
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git commit -m 'Update Garmin sessions [skip ci]'
git push origin HEAD:main
