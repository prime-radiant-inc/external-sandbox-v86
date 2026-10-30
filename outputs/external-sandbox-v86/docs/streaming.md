# Streaming shell execution

Connect to `ws://127.0.0.1:8686/exec/ws` on the same localhost port as the HTTP API. The WebSocket carries UTF-8 JSON text messages. Data within stdout, stderr, and stdin messages is canonical base64, preserving arbitrary bytes and UTF-8 characters split across transport chunks. One connection owns one command.

## Start and output

Send within ten seconds of connecting:

```json
{"type":"start","command":"printf ready; cat; printf problem >&2; exit 7","cwd":"/mnt/project","stdin":true,"timeoutMs":120000,"maxOutputBytes":4194304}
```

`command` is required. `cwd`, `env`, `timeoutMs`, and `maxOutputBytes` have the same meanings and limits as `POST /exec`. Here `stdin` is a boolean, defaulting to true. Set it to false to start with stdin already closed. Do not put initial stdin text in `start`; send stdin messages instead.

The server announces the command before any output:

```json
{"type":"started","processId":"1"}
{"type":"stdout","data":"cmVhZHk="}
```

That output is the bytes `ready`. stdout/stderr events are sent immediately as the guest produces them; data isn't retained for a final combined response. Program-level buffering still applies: use `python3 -u`, for example, when the guest program would otherwise buffer writes to a pipe.

## Incremental stdin and EOF

Send successive chunks while receiving output:

```json
{"type":"stdin","id":0,"data":"aGVsbG8K"}
```

This sends `hello\n`. Each chunk may contain at most 32 KiB of decoded bytes. IDs are nonnegative safe integers and must strictly increase within a connection. The server acknowledges acceptance into the guest input queue:

```json
{"type":"stdin_ack","id":0}
{"type":"stdout","data":"aGVsbG8K"}
```

Acknowledgement means accepted, not necessarily read by the guest process. Output and input acknowledgements may interleave. The Python client keeps only one chunk awaiting acknowledgement, providing input flow control without blocking receipt of stdout/stderr. There is no 32 KiB limit on cumulative stdin.

When no more input will arrive, send:

```json
{"type":"stdin_eof"}
```

EOF is ordered after already-queued input. The response is:

```json
{"type":"stdin_closed"}
```

`stdin_closed` may also mean the program closed its input early. Stop sending stdin when it arrives. Sending input after EOF, duplicate IDs, a second start, or malformed messages is a protocol error. If the command exits with input still outstanding, exit takes precedence; no acknowledgement is fabricated for bytes that weren't accepted. An explicit EOF receives `stdin_closed` before the final exit event, even if the process exits very quickly.

## Exit, errors, and cancellation

All output precedes the single final exit event:

```json
{"type":"stderr","data":"cHJvYmxlbQ=="}
{"type":"exit","exitCode":7,"signal":null,"timedOut":false,"outputLimitExceeded":false,"durationMs":123}
```

The server then closes normally with WebSocket code 1000. Exactly one of `exitCode` and `signal` is non-null. There are no repeated stdout/stderr fields in `exit`. A WebSocket closing without an exit event is a failed execution, even if its close code is 1000.

Send `{"type":"cancel"}` to kill the guest process group. Closing the connection also cancels it. Cancellation bypasses queued stdin, including a blocked write. The timeout and output-limit flags retain their HTTP API meanings. A protocol, transport, startup, or execution error sends:

```json
{"type":"error","error":"Explanation of the failure"}
```

The connection closes without a success result. Slow output consumers that exceed the bounded WebSocket send buffer also cancel the command and receive an error where the transport still permits delivery.

## Bounds

| Resource | Limit |
| --- | --- |
| Concurrent guest processes | 16 across HTTP and WebSockets |
| WebSocket message | 256 KiB |
| Decoded stdin chunk | 32 KiB |
| Pending stdin | 256 KiB / 256 messages |
| Pending encoded WebSocket output, including startup | 1 MiB |
| Combined command output | 4 MiB default, up to 16 MiB |
| Command timeout | 30 seconds API default, up to five minutes |
| First start message | Ten seconds after connection |

The standalone Python client and Claude shell-prefix wrappers are maintained in [external-sandbox/claude-code](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code). That guide defines their command-line options, environment settings, byte-stream handling, cancellation, and exit conventions.

Existing Origin and Host checks apply during WebSocket upgrade. The server remains bound to `127.0.0.1`; shared clients connect to this backend through `EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8686`.

## Test-driven development evidence

The streaming work was built with failing tests before behavior was implemented:

1. Seven guest-process tests first failed against the streaming stub, then passed
   after implementing immediate output, ordered incremental stdin, queue-pressure
   retries, EOF, cancellation, output limits, and bounded startup failure.
2. WebSocket contract tests first failed on the missing `/exec/ws` endpoint.
   The implementation then made them pass, followed by regression tests for
   slow consumers, connection deadlines, invalid messages, and shutdown.
3. The Python subprocess test first failed to receive live output before the
   client existed. The client was then built against a fake HTTP/WebSocket server,
   independently checking exact bytes, later stdin, EOF, exit status, signals,
   mapping of working directories, redirects, and a parent that holds stdin open.
4. Real-v86 tests initially failed on the absent endpoint/client, then passed with
   output-gated input: the test waits for a guest prompt before sending input and
   waits for the first response before sending the next chunk. This would deadlock
   if either side buffered until process exit or stdin EOF.
5. End-to-end testing exposed a fast-exit/EOF acknowledgement race. A focused
   failing test reproduced it, then the server was fixed to report stdin closure
   before exit without waiting indefinitely for a blocked input request.
6. A Python regression test left its stdout pipe unread and sent SIGTERM. The
   initial blocking writer failed to stop promptly; nonblocking output writes
   made cancellation responsive even when the downstream consumer stops reading.
7. A concurrency regression reproduced unrelated output canceling a quiet command
   during startup. Separate bounded buffers for each process now preserve the
   quiet command's output and attribute startup overflow to the correct command.

Run backend unit tests and the image-backed suite:

```sh
npm run check
npm test
npm run test:integration
```

Client-specific tests now live in [the shared client directory](https://github.com/prime-radiant-inc/external-sandbox/tree/main/claude-code). The historical development evidence above retains its original results. Backend integration tests run the external Python script only when `EXTERNAL_SANDBOX_CLIENT` is an absolute path to it; the prefix scenario additionally uses `EXTERNAL_SANDBOX_PREFIX`. See [optional shared-client integration checks](../README.md#optional-shared-client-integration-checks). Tests use temporary mounts and ports without a Claude model call.
