#!/usr/bin/env bash
# Runs every test*.js file and fails if any of them exits non-zero OR logs
# an assertion that evaluated to false. The tests are plain node scripts
# that console.log("description:", boolean) rather than throw/assert, so a
# clean exit code alone does NOT mean everything passed — this script is
# the thing that actually turns a failed assertion into a failed build.
#
# Every test runs the same locally and in CI; nothing is skipped.

set -uo pipefail

# A failed check, in any of the shapes one can print:
#   "…: false" or "… false"   a check whose description doesn't end in a colon fails too
#   "…: 0", "…: undefined", "…: null"   a check written `"desc:", a && b` prints a's falsy value, not false
#   "…:" with nothing after it   the same with an empty string ("desc:", "")
# So no passing test may print a line in these shapes for any other reason. test272 checks this pattern.
# Stack-trace lines ("    at …") are left out first: an error a test logs and carries on from (jsdom saying a
# stylesheet couldn't load, say) can end "AggregateError [ECONNREFUSED]: ", and it is not a check.
FAIL_LINE='(^|[[:space:]])false$|: (0|undefined|null)$|:[[:space:]]*$'
STACK_LINE='^[[:space:]]+at '

# Each file gets at most 5 minutes where a `timeout` command exists (Linux, so CI): a test that hangs then
# fails the run with its own line instead of holding the job until GitHub stops it with no clue which file it
# was. macOS has no `timeout`, so a local run there is unchanged. timeout exits 124 when it stops a file.
TIME_LIMIT=300
run=(node)
if command -v timeout >/dev/null 2>&1; then run=(timeout "$TIME_LIMIT" node); fi

fail=0
for f in test*.js; do
  out=$("${run[@]}" "$f" 2>&1)
  code=$?
  if [ $code -eq 124 ] && [ "${run[0]}" = timeout ]; then
    echo "FAIL (timed out after ${TIME_LIMIT}s): $f"
    echo "$out" | tail -30
    fail=1
    continue
  fi
  if [ $code -ne 0 ]; then
    echo "FAIL (exit $code): $f"
    echo "$out" | tail -30
    fail=1
    continue
  fi
  bad=$(echo "$out" | grep -vE "$STACK_LINE" | grep -E "$FAIL_LINE")
  if [ -n "$bad" ]; then
    echo "FAIL (assertion returned false): $f"
    echo "$bad"
    fail=1
    continue
  fi
  echo "PASS: $f"
done

exit $fail
