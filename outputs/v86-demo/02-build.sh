set -eu
cat > bin/logscope <<'LOGSCOPE'
#!/bin/bash
# Logscope: a dependency-free streaming HTTP log analyzer.
set -eu
slow=1000
fail_on_errors=0
while (($#)); do
    case "$1" in
        --slow-ms)
            if [[ $# -lt 2 || ! "$2" =~ ^[0-9]{1,9}$ ]]; then
                echo 'logscope: --slow-ms requires an integer from 0 to 600000' >&2
                exit 2
            fi
            slow=$((10#$2))
            if ((slow > 600000)); then
                echo 'logscope: --slow-ms must not exceed 600000' >&2
                exit 2
            fi
            shift 2
            ;;
        --fail-on-errors) fail_on_errors=1; shift ;;
        --version) echo 'logscope 0.1.0'; exit 0 ;;
        --help)
            cat <<'HELP'
Usage: logscope [--slow-ms N] [--fail-on-errors]
Read METHOD PATH STATUS DURATION_MS records from stdin.
Stream JSON statistics to stdout and alerts to stderr.
The default slow threshold is 1000 ms (inclusive).
Exit: 0 success, 2 invalid input/arguments, 3 server errors with --fail-on-errors.
At most 10000 records; integer durations must be between 0 and 600000 ms.
HELP
            exit 0 ;;
        *) printf 'logscope: unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

exec awk -v slowThreshold="$slow" -v failOnErrors="$fail_on_errors" '
function report(kind, rank) {
    rank = int((95 * n + 99) / 100)
    printf "{\"type\":\"%s\",\"requests\":%d,\"errors\":%d,\"slow\":%d,\"p95Ms\":%d,\"maxMs\":%d}\n", kind, n, errors, slow, (n ? latency[rank] : 0), maximum
    fflush()
}
function alert(kind) {
    printf "ALERT %s method=%s path=%s status=%d duration_ms=%d\n", kind, $1, $2, $3, $4 > "/dev/stderr"
    fflush("/dev/stderr")
}
/^[[:space:]]*($|#)/ { next }
{
    if (NF != 4 || $1 !~ /^[A-Z]+$/ || substr($2, 1, 1) != "/" ||
        $3 !~ /^[0-9][0-9][0-9]$/ || $3 < 100 || $3 > 599 ||
        $4 !~ /^[0-9]+$/ || $4 + 0 > 600000) {
        printf "INVALID line=%d: expected METHOD /PATH STATUS(100..599) MILLISECONDS(0..600000)\n", NR > "/dev/stderr"
        fflush("/dev/stderr")
        invalid = 1
        next
    }
    if (n >= 10000) {
        print "INVALID: record limit of 10000 exceeded; split the input into batches" > "/dev/stderr"
        invalid = 1
        exit 2
    }
    n++
    ms = $4 + 0
    position = n
    while (position > 1 && latency[position - 1] > ms) {
        latency[position] = latency[position - 1]
        position--
    }
    latency[position] = ms
    if (ms > maximum) maximum = ms
    if ($3 >= 500) { errors++; alert("server-error") }
    if (ms >= slowThreshold) { slow++; alert("slow") }
    report("update")
}
END {
    report("summary")
    if (invalid) exit 2
    if (failOnErrors && errors) exit 3
}
'
LOGSCOPE
chmod +x bin/logscope

cat > README.md <<'README'
# Logscope

A small streaming HTTP log analyzer, built and tested inside an emulated Linux
VM running in v86/WebAssembly. Requires Bash and Awk, with no downloaded packages.

Input is whitespace-separated `METHOD /PATH STATUS DURATION_MS`:

```sh
printf 'GET / 200 42\nPOST /checkout 503 1250\n' | ./bin/logscope
./bin/logscope --slow-ms 250 --fail-on-errors < access.log
```

Every accepted record produces one JSON update on stdout; EOF produces a summary.
The fields are requests, server errors (500–599), slow requests, exact nearest-rank
p95 latency, and maximum latency. Alerts for slow requests and server errors go to
stderr immediately. Both streams are explicitly flushed after each record.

Blank lines and comments are ignored. Invalid records produce diagnostics, do not
enter the statistics, and cause exit 2. Normal completion exits 0; the optional
`--fail-on-errors` flag returns 3 when server errors occurred. Invalid input takes
precedence over that exit status. The slow threshold is inclusive, defaults to
1000 ms, and can be zero. Status codes must be 100–599 and durations are integer
milliseconds from 0 to 600000. Each invocation accepts at most 10000 records.

The percentile implementation stores sorted latencies, so memory is bounded by
the record limit; insertion takes linear time. This is a small batch/live debugging
tool, not a production-scale telemetry database. No terminal UI or PTY is required.

Run `bash test.sh` for the contract tests. The demo began with a stub that failed
all 17 tests, then implemented the CLI and reran the same tests. `01-tests.sh` and
`02-build.sh` contain the exact guest command bodies. The host talks to the VM
through the Python/uv WebSocket client in the adjacent v86-shell-server app.

The release archive `dist/logscope-0.1.0.tar.gz` is built inside the VM. Its files
are immediately visible on the host through the live 9p mount.
README

bash -n bin/logscope test.sh
./test.sh
tar -czf dist/logscope-0.1.0.tar.gz bin/logscope README.md test.sh
sha256sum bin/logscope dist/logscope-0.1.0.tar.gz
ls -lh dist/logscope-0.1.0.tar.gz
