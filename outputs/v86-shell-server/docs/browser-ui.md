# Browser terminal and proxy controls

Both pages are served by the existing Node process and bundled in the npm
package. They use local assets and require no frontend build service or CDN.
The design and browser JavaScript are ported from the user's `sandbox-exec-server`
implementation, including its new Copy session feature.

## Terminal

Open `http://127.0.0.1:8686/` after the server boots. Choose a working directory
and time limit, enter a command, and click **Run command**. Enter submits;
Shift+Enter inserts a newline. Arrow keys browse command history.

While a command is running, the editor sends stdin. **Send EOF** closes stdin;
**Cancel** terminates the command. stdout and stderr appear separately as chunks
arrive, followed by exit status, signal, timeout, or output-limit information.
Closing the page cancels its active command without stopping the VM.

**Copy session** copies the retained commands, submitted stdin, stdout/stderr,
and exit messages as plain text. It works while output is still arriving and
copies a snapshot without stopping the command. It excludes the unsubmitted
editor draft and page authorization token. Success, failure, and empty-session
feedback appear beside the button. A clipboard fallback preserves focus and
selection. **Clear output** clears the transcript without cancelling execution.
Scrollback is bounded to 500 KiB and 2,000 nodes; discarded history cannot be
recovered by copying. Command history and pending stdin are bounded too.

Each run starts a fresh Bash command. `cd` and `export` affect only that run;
use the working-directory field for later runs. Files persist for the VM's
lifetime, and read-write host mount changes persist after shutdown. This is a
pipe-based console; full-screen terminal programs and PTYs are unsupported.
Use unbuffered output when appropriate, for example `python3 -u`.

## Proxy editor

Start with `--proxy-config FILE`, then open `/proxy` or the terminal's
**Network policy** link. The page shows allowed origins, methods, paths, IP
ranges, credential references, a JSON editor, and recent request activity.

**Apply policy** validates before atomically replacing the active policy. Invalid
edits leave it unchanged. Successful updates close current proxy connections
and pending upstream requests, so revoked access cannot continue on an old
connection. The CA and listener stay in place. **Discard edits** restores the
last fetched policy. Activity refreshes every three seconds without overwriting
unsaved edits.

Changes apply only to this server instance; edit the configuration file
separately to preserve them. Changes to `guestEnv` are rejected because they
require restarting the VM. A server started without a proxy does not expose
the management page; the terminal reports networking disabled.

Only host environment variable **names** and guest placeholders belong in
credential rules. The editor never returns real key values. Activity retains
up to 500 events with method, origin, pathname, status, decision, reason,
duration, and whether a credential was injected. Query strings, headers, and
bodies are omitted. Known literal secrets are redacted from policy snapshots
and activity, including historical events after policy changes. Terminal
transcripts are ordinary command output: review their contents before sharing.

## Browser access and APIs

Pages require a loopback Host and reject cross-origin requests and Fetch
Metadata. Tokens are random per server instance; refresh pages after restarting.
CSP, framing restrictions, no-store responses, and text-only output rendering
protect the browser boundary. This remains a service for trusted local users;
another local process can fetch a page and obtain its token.

Browser `/exec/ws` sockets require the exact origin including port, plus
`sandbox-terminal` and `sandbox-token.<token>` offered subprotocols. Only
`sandbox-terminal` is negotiated; tokens never enter URLs or selected protocols.
Existing clients without an Origin retain access. `/exec` and `/codex` continue
rejecting browser Origins.

`GET /proxy/api` returns `{enabled, policy, events}`. `PUT /proxy/api` accepts
the replacement JSON object, capped at 256 KiB. Both require the token from
the page in `X-Proxy-Token`, plus the same browser checks. Terminal and proxy
tokens are separate. Invalid policy errors do not echo supplied values.

The real-VM test `test/integration/browser-ui.test.ts` exercises browser sockets,
stdin/EOF, stdout/stderr, mount modes, cancellation, HTTPS credential injection,
redaction, and live revocation using local upstreams and synthetic credentials.
