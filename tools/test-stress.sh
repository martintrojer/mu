#!/usr/bin/env bash
set -uo pipefail

runs="${MU_TEST_STRESS_RUNS:-30}"
parallel="${MU_TEST_STRESS_PARALLEL:-2}"
mode="${MU_TEST_STRESS_MODE:-serial}"
out_dir="${MU_TEST_STRESS_OUT_DIR:-.mu-test-stress}"
timeout_sec="${MU_TEST_STRESS_TIMEOUT_SEC:-600}"
args=()

usage() {
  cat <<'USAGE'
Usage: tools/test-stress.sh [--runs N] [--parallel N] [--mode serial|parallel|both] [--timeout-sec N] [--out DIR] [-- vitest args...]

Runs the full test suite repeatedly and stores one log per run under DIR.
Defaults: --runs 30 --parallel 2 --mode serial --timeout-sec 600 --out .mu-test-stress

Environment overrides:
  MU_TEST_STRESS_RUNS        number of repetitions (default: 30)
  MU_TEST_STRESS_PARALLEL    concurrent npm-test instances in parallel mode (default: 2)
  MU_TEST_STRESS_MODE        serial, parallel, or both (default: serial)
  MU_TEST_STRESS_TIMEOUT_SEC per-run timeout in seconds (default: 600)
  MU_TEST_STRESS_OUT_DIR     log directory (default: .mu-test-stress)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      runs="$2"
      shift 2
      ;;
    --parallel)
      parallel="$2"
      shift 2
      ;;
    --mode)
      mode="$2"
      shift 2
      ;;
    --out)
      out_dir="$2"
      shift 2
      ;;
    --timeout-sec)
      timeout_sec="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      args=("$@")
      break
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

if ! [[ "$runs" =~ ^[0-9]+$ ]] || [[ "$runs" -lt 1 ]]; then
  echo "test-stress: --runs must be a positive integer" >&2
  exit 2
fi
if ! [[ "$parallel" =~ ^[0-9]+$ ]] || [[ "$parallel" -lt 1 ]]; then
  echo "test-stress: --parallel must be a positive integer" >&2
  exit 2
fi
if ! [[ "$timeout_sec" =~ ^[0-9]+$ ]] || [[ "$timeout_sec" -lt 1 ]]; then
  echo "test-stress: --timeout-sec must be a positive integer" >&2
  exit 2
fi
case "$mode" in
  serial|parallel|both) ;;
  *)
    echo "test-stress: --mode must be serial, parallel, or both" >&2
    exit 2
    ;;
esac

mkdir -p "$out_dir"
summary="$out_dir/summary.tsv"
: > "$summary"

run_one() {
  local label="$1"
  local log="$out_dir/$label.log"
  echo "[$(date +%H:%M:%S)] start $label"
  node - "$timeout_sec" "$log" "${args[@]}" <<'NODE'
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const timeoutSec = Number(process.argv[2]);
const logPath = process.argv[3];
const vitestArgs = process.argv.slice(4);
const fd = fs.openSync(logPath, "w");
const child = spawn("npm", ["run", "test", "--", ...vitestArgs], {
  detached: true,
  stdio: ["ignore", fd, fd],
});

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  fs.writeSync(fd, `\n[test-stress] run timed out after ${timeoutSec}s; terminating process group ${child.pid}\n`);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000).unref();
}, timeoutSec * 1000);

child.on("error", (err) => {
  clearTimeout(timeout);
  fs.writeSync(fd, `\n[test-stress] failed to spawn npm: ${err.message}\n`);
  fs.closeSync(fd);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearTimeout(timeout);
  if (signal) fs.writeSync(fd, `\n[test-stress] process exited via signal ${signal}\n`);
  fs.closeSync(fd);
  if (timedOut) process.exit(124);
  process.exit(code ?? 1);
});
NODE
  local code=$?
  if [[ "$code" -eq 0 ]]; then
    printf '%s\tPASS\t%s\n' "$label" "$log" >>"$summary"
    echo "[$(date +%H:%M:%S)] pass  $label"
    return 0
  fi

  if [[ "$code" -eq 124 ]]; then
    printf '%s\tTIMEOUT\t%s\n' "$label" "$log" >>"$summary"
    echo "[$(date +%H:%M:%S)] TIMEOUT $label after ${timeout_sec}s (see $log)" >&2
  else
    printf '%s\tFAIL\t%s\n' "$label" "$log" >>"$summary"
    echo "[$(date +%H:%M:%S)] FAIL  $label (see $log)" >&2
  fi
  grep -E "test-stress|Failed Tests| FAIL |× " "$log" >&2 || tail -80 "$log" >&2
  return 1
}

failures=0

run_serial_wave() {
  local prefix="$1"
  local i
  for i in $(seq 1 "$runs"); do
    if ! run_one "$prefix-$i"; then
      failures=$((failures + 1))
    fi
  done
}

run_parallel_wave() {
  local wave="$1"
  local pids=()
  local labels=()
  local slot
  for slot in $(seq 1 "$parallel"); do
    local label="parallel-$wave-$slot"
    labels+=("$label")
    (run_one "$label") &
    pids+=("$!")
  done
  local i
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      failures=$((failures + 1))
    fi
  done
}

case "$mode" in
  serial)
    run_serial_wave serial
    ;;
  parallel)
    for i in $(seq 1 "$runs"); do
      run_parallel_wave "$i"
    done
    ;;
  both)
    run_serial_wave serial
    for i in $(seq 1 "$runs"); do
      run_parallel_wave "$i"
    done
    ;;
esac

printf '\nSummary: %s failure(s). Logs: %s\n' "$failures" "$out_dir"
if [[ "$failures" -gt 0 ]]; then
  printf '\nFailure markers:\n' >&2
  grep -H -E "Failed Tests| FAIL |× " "$out_dir"/*.log >&2 || true
  exit 1
fi
