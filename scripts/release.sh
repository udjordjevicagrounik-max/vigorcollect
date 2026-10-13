#!/usr/bin/env bash
# Release helper (task 6.5, git flow in docs/runbook.md: feature → develop → release/x.y → main).
#
#   scripts/release.sh notes [from] [to]     release notes (Markdown) from conventional commits
#   scripts/release.sh changelog <x.y.z>     put the section "## x.y.z" at the top of CHANGELOG.md
#   scripts/release.sh check <x.y.z>         is this tree releasable? (prints the checklist)
#   scripts/release.sh tag <x.y.z>           annotated tag vx.y.z with the notes (after check)
#
# Notes cover <from>..<to> (default: last v* tag .. HEAD; no tag = the whole history). Merge
# commits are left out. Nothing is pushed — pushing a tag is Uroš's `!` command. No secrets are
# read or printed: only commit subjects, branch names and file names.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
semver() { [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be x.y.z (got '${1:-}')"; }

last_tag() { git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true; }

notes() {
  local from="${1:-$(last_tag)}" to="${2:-HEAD}" range
  range="${from:+$from..}$to"
  local subjects
  subjects="$(git log --no-merges --format='%s' "$range" | grep -Ev '^chore: merge ' || true)"
  section() { # title, regex of types
    local lines
    lines="$(printf '%s\n' "$subjects" | grep -E "^($2)(\([^)]*\))?!?: " || true)"
    [[ -z "$lines" ]] && return 0
    printf '### %s\n\n' "$1"
    printf '%s\n' "$lines" | sed -E 's/^[a-z]+(\(([^)]*)\))?!?: (.*)$/- \3 (\2)/; s/ \(\)$//' | sort -u
    printf '\n'
  }
  section 'Novo' 'feat'
  section 'Ispravke' 'fix'
  section 'Performanse' 'perf'
  section 'Bezbednost' 'security'
  section 'Dokumentacija' 'docs'
  section 'Ostalo' 'refactor|test|build|ci|chore|style|revert'
}

changelog() {
  semver "$1"
  local file="$ROOT/CHANGELOG.md" head body tmp
  head="## $1 — $(date -u +%Y-%m-%d)"
  body="$(notes)"
  [[ -z "$body" ]] && die "no commits since $(last_tag || echo 'the beginning')"
  tmp="$(mktemp)"
  {
    printf '# Changelog\n\nGenerisano iz conventional commit-a: `scripts/release.sh changelog <x.y.z>`.\n\n'
    printf '%s\n\n%s\n' "$head" "$body"
    if [[ -f "$file" ]]; then
      # previous sections, without the header and without an older copy of this version
      awk -v v="## $1 " 'BEGIN{keep=0} /^## /{keep = (index($0, v) != 1)} keep' "$file"
    fi
  } > "$tmp"
  mv "$tmp" "$file"
  printf 'release: CHANGELOG.md — section %s\n' "$1"
}

check() {
  semver "$1"
  local ok=1 branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == release/* || "$branch" == main ]] || { echo "✗ branch is $branch (release/x.y or main)"; ok=0; }
  [[ -z "$(git status --porcelain)" ]] || { echo "✗ working tree is not clean"; ok=0; }
  grep -q "\"version\": \"$1\"" package.json || { echo "✗ package.json version is not $1"; ok=0; }
  grep -q "^## $1 " CHANGELOG.md 2>/dev/null || { echo "✗ CHANGELOG.md has no section $1"; ok=0; }
  git rev-parse -q --verify "refs/tags/v$1" >/dev/null && { echo "✗ tag v$1 already exists"; ok=0; }
  cat <<'EOF'

Release checklist (docs/runbook.md "Release checklist", docs/staging.md):
  [ ] npm test, npm run test:db, npm run test:e2e — green on this commit
  [ ] npx tsx scripts/perf.ts measure — all screens < 1 s (docs/performance.md)
  [ ] migrations tried on a copy of the target database (status: nothing pending afterwards)
  [ ] service roles exist before 007 / 011 / 021 (create-service-roles.sh)
  [ ] Turnstile, PII master key, BETTER_AUTH_*, backup age keys — in the vault and the env panel
  [ ] staging deploy by docs/staging.md, smoke.sh exit 0
  [ ] first backup + restore test green (Admin → System status)
  [ ] rollback step written in the release notes
EOF
  (( ok )) || die "not releasable yet"
  echo "release: $1 can be tagged"
}

tag() {
  semver "$1"
  check "$1" >/dev/null
  local msg
  msg="$(printf 'release %s\n\n' "$1"; notes)"
  git tag -a "v$1" -m "$msg"
  printf 'release: tag v%s created (push it: git push origin v%s)\n' "$1" "$1"
}

case "${1:-}" in
  notes) shift; notes "$@" ;;
  changelog) shift; changelog "${1:-}" ;;
  check) shift; check "${1:-}" ;;
  tag) shift; tag "${1:-}" ;;
  *) die "usage: scripts/release.sh notes [from] [to] | changelog <x.y.z> | check <x.y.z> | tag <x.y.z>" ;;
esac
