#!/usr/bin/env bash
# Generates docs/security-review-input.md from git — never written by hand (session 5.0), so the
# next independent review always sees the real scope.
#
# Usage: scripts/security-review-input.sh [BASE] [HEAD]
#   BASE  default: the develop commit named in the newest docs/security-review-YYYY-MM-DD.md
#         ("develop = `<hash>`"), i.e. everything since the last review
#   HEAD  default: develop
# Output: docs/security-review-input.md (overwritten). Read-only for the repository otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="docs/security-review-input.md"

last_review="$(ls docs/security-review-20??-??-??.md 2>/dev/null | sort | tail -1 || true)"
default_base=""
if [[ -n "$last_review" ]]; then
  default_base="$(grep -oE 'develop = `[0-9a-f]{7,40}`' "$last_review" | head -1 | grep -oE '[0-9a-f]{7,40}' || true)"
fi
BASE="${1:-${default_base:-}}"
HEAD_REF="${2:-develop}"
[[ -n "$BASE" ]] || { echo "security-review-input: no BASE (pass one or keep a docs/security-review-*.md)" >&2; exit 2; }
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "unknown BASE $BASE" >&2; exit 2; }
git rev-parse --verify --quiet "$HEAD_REF^{commit}" >/dev/null || { echo "unknown HEAD $HEAD_REF" >&2; exit 2; }

base_short="$(git rev-parse --short "$BASE")"
head_short="$(git rev-parse --short "$HEAD_REF")"
commits="$(git rev-list --count "$BASE..$HEAD_REF")"
shortstat="$(git diff --shortstat "$BASE..$HEAD_REF" | sed 's/^ *//')"
generated="$(date -u +%F)"

# Protected paths (rule 13) = CODEOWNERS patterns.
protected_regex="$(grep -vE '^\s*(#|$)' CODEOWNERS | awk '{print $1}' | sed -e 's#^/##' -e 's#\.#\\.#g' -e 's#/$#/.*#' | paste -sd'|' -)"

{
  echo "# Ulaz za security review (odvojena sesija)"
  echo
  echo "_Generisano skriptom \`scripts/security-review-input.sh\` ($generated) — ne menjati ručno;"
  echo "pre review-a pokrenuti ponovo da opseg odgovara grani._"
  echo
  echo "- **Opseg:** \`git diff $base_short..$head_short\` ($HEAD_REF; $commits commit-a)."
  echo "- **Ukupno:** $shortstat"
  echo "- **Prethodni review:** ${last_review:-nema}"
  echo "- **Checklist:** \`docs/security-review-checklist.md\`; pravila: \`CLAUDE.md\` (NON-NEGOTIABLE)."
  echo "- **Kako:** odvojena sesija dobija samo ovaj opseg, \`CLAUDE.md\` i checklist; \`docs/NEXT.md\` i"
  echo "  ADR-ovi se čitaju tek posle nalaza."
  echo
  echo "## Izmenjeni fajlovi po oblasti"
  echo
  echo '| oblast | fajlova |'
  echo '| --- | --- |'
  git diff --name-only "$BASE..$HEAD_REF" |
    awk -F/ '{ key = ($1 == "src" && NF > 2) ? $1 "/" $2 "/" $3 : ($1 ~ /^(db|tests|docs|scripts)$/ && NF > 1 ? $1 "/" $2 : $1); n[key]++ }
             END { for (k in n) printf "| `%s` | %d |\n", k, n[k] }' | sort
  echo
  echo "## Zaštićeni fajlovi (pravilo 13) u opsegu"
  echo
  git diff --name-only "$BASE..$HEAD_REF" | grep -E "^($protected_regex)" | sed 's/^/- `/; s/$/`/' || echo "- nema"
  echo
  echo "## Migracije u opsegu"
  echo
  git diff --name-only --diff-filter=AM "$BASE..$HEAD_REF" -- 'db/migrations/*_up.sql' |
    sed 's/^/- `/; s/$/`/' | grep . || echo "- nema"
  echo
  echo "## ADR-ovi izmenjeni u opsegu"
  echo
  git diff --name-only "$BASE..$HEAD_REF" -- 'docs/adr/*.md' | while read -r f; do
    title="$(head -1 "$f" 2>/dev/null | sed 's/^# //')"
    echo "- \`$f\` — $title"
  done | grep . || echo "- nema"
  echo
  echo "## \`git diff $base_short..$head_short --stat\`"
  echo
  echo '```text'
  git diff --stat=200 "$BASE..$HEAD_REF"
  echo '```'
} >"$OUT"

echo "security-review-input: $OUT ($base_short..$head_short, $commits commits)"
