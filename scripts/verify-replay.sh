#!/usr/bin/env bash
# Records one live run of a task, replays it from its own cassette with no network
# (an invalid API key makes any live call fail), and diffs the two results. Also
# checks that changing the model makes the replay miss rather than serve a recording.
#   scripts/verify-replay.sh <task> <request.json> [budget-usd]
set -uo pipefail
task="$1"; request="$2"; budget="${3:-5}"; meeting="${MEETING:-}"
out="${VERIFY_OUT:-.eval-verify}/$task"; mkdir -p "$out"
cli() { npx tsx src/cli.ts "$@" ${meeting:+--meeting "$meeting"}; }
# The dev shell has node but not jq.
jsonget() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=process.argv[2].split('.').reduce((o,k)=>o?.[k],d);process.stdout.write(typeof v==='object'?JSON.stringify(v):String(v))" "$1" "$2"; }
# Prints a result normalised for diffing: keys sorted, `usage` dropped (a replay
# reports zero usage by design). With "unordered", arrays are sorted too, which
# separates fetch-order differences from content differences.
normResult() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const u=process.argv[2]==='unordered';const s=v=>{if(Array.isArray(v)){const a=v.map(s);return u?a.map(x=>JSON.stringify(x)).sort().map(x=>JSON.parse(x)):a}return v&&typeof v==='object'?Object.fromEntries(Object.keys(v).filter(k=>k!=='usage').sort().map(k=>[k,s(v[k])])):v};console.log(JSON.stringify(s(d.result),null,1))" "$1" "${2:-}"; }

if [ -n "${LIVE_TRACE:-}" ] && [ -f "$out/live.json" ]; then
  echo "== $task: reusing live run $LIVE_TRACE"; trace="$LIVE_TRACE"
else
echo "== $task: live"
cli eval task run "$task" --request "$request" --env development --budget-usd "$budget" --out "$out/live.json" > "$out/live.log" 2>&1
grep -E "^[a-zA-Z]+: trace " "$out/live.log" || { echo "LIVE FAILED:"; grep -v "^\s*at " "$out/live.log" | tail -8; exit 1; }
trace=$(jsonget "$out/live.json" traceId)
fi
[ -n "$trace" ] && [ "$trace" != null ] || { echo "LIVE FAILED (no trace id)"; exit 1; }

echo "== $task: replay from cassette $trace (no network)"
ANTHROPIC_API_KEY=sk-ant-invalid TELEMETRY_SINKS=archive cli eval task run "$task" --request "$request" --env eval --cassette "$trace" --out "$out/replay.json" > "$out/replay.log" 2>&1
grep -E "^[a-zA-Z]+: trace " "$out/replay.log" || { echo "REPLAY FAILED:"; grep -v "^\s*at " "$out/replay.log" | tail -8; }
stats() { echo "$(jsonget "$out/replay.json" calls) calls, $(jsonget "$out/replay.json" liveCalls) live, \$$(jsonget "$out/replay.json" costUsd)"; }
if [ -f "$out/replay.json" ] && diff <(normResult "$out/live.json") <(normResult "$out/replay.json") > "$out/diff.txt"; then
  echo "REPLAY identical ($(stats))"
elif [ -f "$out/replay.json" ] && diff <(normResult "$out/live.json" unordered) <(normResult "$out/replay.json" unordered) > /dev/null; then
  echo "REPLAY identical up to array order ($(stats); ordered diff in $out/diff.txt)"
else
  echo "REPLAY DIFFERS: $(wc -l < "$out/diff.txt") diff lines (see $out/diff.txt)"
fi

echo "== $task: replay with a different model must miss"
if ANTHROPIC_API_KEY=sk-ant-invalid TELEMETRY_SINKS=archive cli eval task run "$task" --request "$request" --env eval --cassette "$trace" --override '*.model=claude-haiku-5-5' > "$out/override.log" 2>&1; then
  echo "OVERRIDE did NOT miss (unexpected)"
else
  grep -q "No recorded response" "$out/override.log" && echo "OVERRIDE missed as expected" || { echo "OVERRIDE failed for another reason:"; grep -m3 -i "error" "$out/override.log"; }
fi
echo "trace=$trace"
