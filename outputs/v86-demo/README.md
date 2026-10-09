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
through the Python/uv WebSocket client in the adjacent remote-sandbox-v86 app.

The release archive `dist/logscope-0.1.0.tar.gz` is built inside the VM. Its files
are immediately visible on the host through the live 9p mount.
