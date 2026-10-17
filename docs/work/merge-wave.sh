#!/usr/bin/env bash
# Merge package branches into the integration branch, in the order given, then verify.
# Usage: merge-wave.sh <wave> <branch>[:<id>] ...
set -euo pipefail
REPO=/home/user/rulers-of-the-wild
cd "$REPO"
wave="$1"; shift
test -z "$(git status --porcelain)" || { echo "working tree not clean"; git status --short; exit 2; }
for spec in "$@"; do
  br="${spec%%:*}"; id="${spec#*:}"
  echo "=== merging $br ($id)"
  if ! git merge --no-ff -q "$br" -m "Merge $id (wave $wave) into the integration branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TfeUNzaAy4wDHcsFZqa5Vv"; then
    echo "MERGE CONFLICT on $br"; git status --short; exit 3
  fi
done
if ! git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json packages/sim/package.json apps/client/package.json 2>/dev/null; then
  npm install --prefer-offline --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
fi
npm install --prefer-offline --no-audit --no-fund >/dev/null 2>&1 || true
echo "=== typecheck"; npm run typecheck 2>&1 | grep -E "error" | head -20 || true
npm run typecheck >/dev/null 2>&1 && echo "typecheck: pass" || { echo "typecheck: FAIL"; exit 4; }
echo "=== tests"
LOG=/tmp/claude-0/-home-user/af22c14c-9be6-54bb-9fed-8058f6dbeadf/scratchpad/wf/wave-$wave-tests.log
run_tests() { (npx vitest run "$@" 2>&1 || true) > "$LOG"; grep -E "Test Files|Tests |Errors|FAIL|×" "$LOG" | head -30; }
run_tests
if grep -qE "Test Files .*failed|Tests .*failed" "$LOG"; then echo "tests: FAIL"; exit 5; fi
if grep -qE "^\s+Errors " "$LOG"; then
  echo "worker errors only (load); re-running with fewer workers"; run_tests --maxWorkers=2
  if grep -qE "Test Files .*failed|Tests .*failed|^\s+Errors " "$LOG"; then echo "tests: FAIL"; exit 5; fi
fi
grep -qE "Test Files .*passed" "$LOG" || { echo "tests: no summary"; exit 5; }
echo "tests: pass"
echo "=== build"; npm run build >/dev/null 2>&1 && echo "build: pass" || { echo "build: FAIL"; exit 6; }
git log --oneline -1
