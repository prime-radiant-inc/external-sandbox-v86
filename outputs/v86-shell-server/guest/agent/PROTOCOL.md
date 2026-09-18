# Private guest protocol, version 1

Each message is a four-byte unsigned big-endian length followed by UTF-8 JSON.
Frames may not exceed 1 MiB. Corrupt framing or JSON ends the agent session.
The transport is stdin/stdout (`--stdio`, default), or one raw serial device
(`--device /dev/ttyS1`). Nothing else may write to this channel.

Requests are `{ "id": 1, "method": "hello", "params": { "version": 1 } }`.
IDs are nonnegative safe integers. Responses are `{ "id": 1, "result": {} }`
or `{ "id": 1, "error": { "code": "EINVAL", "message": "..." } }`.
The agent first sends `{ "event": "ready", "version": 1 }`.

| Method | Parameters | Result |
| --- | --- | --- |
| `hello` | `version: 1` | `version: 1` |
| `process.start` | `argv: string[]`, optional `cwd`, `env: Record<string,string>`, `envReplace: boolean`, `arg0: string`, `stdin: boolean` | `processId: string`, `pid: number` |
| `process.write` | `processId`, `data` (base64) | `written` |
| `process.closeStdin` | `processId` | empty object |
| `process.signal` | `processId`, `signal: 2, 15, or 9` | empty object |
| `process.terminate` | `processId` | empty object |
| `process.shutdown` | empty object | empty object; begins termination of all processes |
| `process.status` | empty object | `active`: count of owned process groups not yet quiescent |
| `fs.readFile` | `path`, optional `offset` (0), `length` (32768, maximum 49152), `follow` (true) | base64 `data`, boolean `eof` |
| `fs.writeFile` | `path`, base64 `data` (maximum 49152 decoded), optional `offset` (0), `truncate` (false), `mode` (0644), `follow` (true) | `written` |
| `fs.createDirectory` | `path`, optional `recursive` (false), `mode` (0755), `follow` (true) | empty object |
| `fs.readDirectory` | `path`, optional `follow` (true) | `entries: [{name, kind}]` |
| `fs.getMetadata` | `path`, optional `follow` (false) | `kind`, `size`, `mode` (permission bits), `mtimeMs` |
| `fs.canonicalize` | `path` | `path` |
| `fs.remove` | `path`, optional `recursive` (false), `follow` (true) | empty object |
| `fs.chmod` | `path`, `mode` | empty object |

Paths and cwd are absolute guest paths. The default cwd is `/workspace`.
Unless `envReplace: true`, environment overrides merge into `PATH=/usr/local/bin:/usr/bin:/bin`,
`HOME=/home/agent`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `USER=agent`,
`LOGNAME=agent`, `SHELL=/bin/sh`. No host environment is involved.
With `envReplace: true`, only the supplied environment is installed. The
optional `arg0` changes argv[0] without changing the executable selected by
the original argv[0]. Environment keys cannot be empty or contain `=`. Commands and filesystem
operations use UID/GID 1000 when the agent starts as root. A non-root agent
retains its account, for standalone tests only.

Process IDs increase for the lifetime of the agent and are never reused.
Events:

* `{event:"process.output",processId,stream:"stdout"|"stderr",seq,data}`:
  data is base64; seq starts at zero and increases across both streams.
* `{event:"process.error",processId,code,message}`: explicit output/drain limit
  failure; the process group is terminated and normal success is not implied.
* `{event:"process.exited",processId,exitCode,signal}`: exactly one of exitCode
  and signal is non-null, after output pipes have drained or a reported drain
  failure. Spawn failure instead produces a request error with no process ID.
* `{event:"process.closed",processId}`: emitted immediately after exited; all
  owned pipe descriptors are closed, the ordinary process group has no
  remaining members, and the handle is no longer usable. Linux uses child
  subreaping to collect orphaned grandchildren. Descendants deliberately
  escaping their process group are outside the MVP cleanup guarantee.

`stdin` defaults true; false closes stdin immediately. Writes enter a bounded
64 KiB per-process queue. A write rejected with `EAGAIN` has not been accepted.
Closing stdin waits for accepted writes to drain. Signals target the entire
process group. Termination sends SIGTERM, then SIGKILL after 1000 ms. When the
leader exits, remaining group members receive SIGTERM; open output pipes have
a 2000 ms drain deadline. At most 32 processes run at once. Output is limited
to 16 MiB per process. Transport output is bounded to 4 MiB and reserves
128 KiB for control events; pipe reads pause when capacity is low. After
`process.shutdown`, poll `process.status` until active is zero before export.

Filesystem requests run synchronously between poll iterations. Symlink
metadata defaults to lstat; ordinary reads/writes and chmod follow symlinks.
`follow: false` holds each ancestor directory open with O_NOFOLLOW and uses
descriptor-relative operations, so no ancestor can be a symlink. The final
component also cannot be a symlink for reads, writes, directory listing, or
recursive directory creation. Metadata can describe the final symlink;
removal unlinks the final symlink without following it. This behavior also
holds under concurrent ancestor rename/symlink swaps.
Recursive removal does not traverse symlinks and rejects `/`. Directory
listing rejects responses exceeding the frame limit. Filesystem errors retain
stable errno-style codes, including ENOENT, EACCES, EEXIST, and ENOTDIR. Binary
filesystem names that cannot be represented as UTF-8 fail with EILSEQ.

Malformed JSON, invalid UTF-8, escaped NUL, unpaired Unicode surrogates,
duplicate object keys, invalid IDs, and invalid frame lengths close the
transport and exit with status 1. Validation occurs before filesystem or
process side effects. JSON nesting is bounded to 32 levels and 32768 tokens.
