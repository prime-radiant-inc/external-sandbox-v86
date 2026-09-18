import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApiServer } from '../../src/http.js';
import { ShellVM } from '../../src/vm.js';

const run = promisify(execFile);
const image = fileURLToPath(new URL('../../images/linux', import.meta.url));
const codex = process.env.CODEX_CLI_BIN ?? 'codex';

interface ProviderRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: { input?: Array<{ type?: string; call_id?: string; output?: unknown }> };
}

function responseEvents(id: string, item: object): string {
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

// This is the real Codex CLI and real VM. The only simulated component is the
// Responses provider: deterministic SSE responses replace remote inference.
test('Codex 0.154.0 exec-server executes in v86 with live RO and RW mounts', { timeout: 120_000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'v86-codex-cli-'));
  const root = await fs.realpath(temporary);
  const codexState = path.join(root, 'codex-state');
  const ro = path.join(root, 'readonly');
  const rw = path.join(root, 'writable');
  let vm: ShellVM | undefined;
  t.after(async () => {
    await vm?.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await Promise.all([codexState, ro, rw].map(directory => fs.mkdir(directory)));
  // Even --version may initialize Codex's temporary executable aliases, so
  // isolate every CLI invocation, including this compatibility probe.
  const childEnv = {
    PATH: process.env.PATH,
    CODEX_HOME: codexState,
    CODEX_SQLITE_HOME: codexState,
    TERM: 'dumb',
  };
  let version: string;
  try {
    version = (await run(codex, ['--version'], { cwd: rw, env: childEnv, timeout: 5_000 })).stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('Install Codex 0.154.0 or set CODEX_CLI_BIN to run this compatibility test');
      return;
    }
    throw error;
  }
  assert.equal(version, 'codex-cli 0.154.0', 'This integration test pins the experimental exec-server protocol');

  await fs.writeFile(path.join(ro, 'input.txt'), 'live readonly fixture\n');

  vm = await ShellVM.boot({
    image,
    bootTimeoutMs: 45_000,
    mounts: [
      { name: 'rw', hostPath: rw, mode: 'rw', preservedPaths: [rw] },
      { name: 'ro', hostPath: ro, mode: 'ro', preservedPaths: [ro] },
    ],
  });
  const api = createApiServer(vm);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise<void>(resolve => {
    api.closeAllConnections();
    api.close(() => resolve());
  }));
  const apiPort = (api.address() as { port: number }).port;

  const command = [
    'set -eu',
    "printf 'architecture='; uname -m",
    "printf 'readonly='; cat /mnt/ro/input.txt",
    "printf 'created through Codex in v86\\n' > /mnt/rw/codex-result.txt",
    "printf 'stderr from v86\\n' >&2",
    "if printf forbidden > /mnt/ro/forbidden.txt; then echo 'READONLY_BYPASSED'; exit 99; fi",
    "printf 'readonly write denied\\n'",
  ].join('\n');
  const requests: ProviderRequest[] = [];
  const fixtureErrors: string[] = [];
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, undefined, 'Fixture must not receive any credentials');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 4 * 1024 * 1024, 'Provider request exceeded fixture limit');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest['body'];
      requests.push({ url: request.url, headers: request.headers, body });
      assert.ok(requests.length <= 4, 'Only three tool-call responses and a final response are expected');
      const item = requests.length === 1
        ? {
          type: 'function_call',
          call_id: 'v86-command',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: command,
            workdir: '/mnt/rw',
            login: false,
            yield_time_ms: 30_000,
            environment_id: 'v86',
          }),
        }
        : requests.length < 4
          ? {
            type: 'custom_tool_call',
            call_id: requests.length === 2 ? 'v86-patch-rw' : 'v86-patch-ro',
            name: 'apply_patch',
            input: [
              '*** Begin Patch',
              `*** Add File: /mnt/${requests.length === 2 ? 'rw' : 'ro'}/codex-patch.txt`,
              '+created by remote apply_patch',
              '*** End Patch',
            ].join('\n'),
          }
          : {
          type: 'message',
          role: 'assistant',
          id: 'v86-final',
          content: [{ type: 'output_text', text: 'Verified the v86 execution fixture.' }],
        };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(responseEvents(`v86-response-${requests.length}`, item));
    } catch (error) {
      fixtureErrors.push(String(error));
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local test fixture rejected the request' } }));
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise<void>(resolve => {
    provider.closeAllConnections();
    provider.close(() => resolve());
  }));
  const providerPort = (provider.address() as { port: number }).port;

  await fs.writeFile(path.join(codexState, 'config.toml'), `
model = "gpt-5.4"
model_provider = "v86_fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[features]
unified_exec = true
shell_snapshot = false

[analytics]
enabled = false

[feedback]
enabled = false

[model_providers.v86_fixture]
name = "Deterministic loopback fixture"
base_url = "http://127.0.0.1:${providerPort}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  await fs.writeFile(path.join(codexState, 'environments.toml'), `
default = "v86"
include_local = false

[[environments]]
id = "v86"
url = "ws://127.0.0.1:${apiPort}/codex"
connect_timeout_sec = 5
initialize_timeout_sec = 5
`);

  // Deliberately construct a small child environment. No user auth, provider
  // credentials, proxy configuration, plugins, or user CODEX_HOME are inherited.
  const execution = run(codex, [
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--json',
    '--color', 'never', '--cd', rw,
    'Run the supplied fixture command in the v86 environment and report completion.',
  ], {
    cwd: rw,
    env: childEnv,
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
    signal: t.signal,
  });
  execution.child.stdin?.end();
  const result = await execution;
  assert.deepEqual(fixtureErrors, [], result.stderr);
  assert.equal(requests.length, 4, result.stderr);
  const toolOutput = requests[1].body.input?.find(item => item.type === 'function_call_output' && item.call_id === 'v86-command');
  assert.ok(toolOutput, 'Real Codex must send the command result back to its provider');
  const output = JSON.stringify(toolOutput.output);
  assert.match(output, /architecture=i686/);
  assert.match(output, /readonly=live readonly fixture/);
  assert.match(output, /stderr from v86/);
  assert.match(output, /readonly write denied/);
  assert.doesNotMatch(output, /READONLY_BYPASSED/);
  assert.equal(await fs.readFile(path.join(rw, 'codex-result.txt'), 'utf8'), 'created through Codex in v86\n');
  const patchResult = (index: number, callId: string) => requests[index].body.input?.find(item =>
    item.type === 'custom_tool_call_output' && item.call_id === callId);
  assert.ok(patchResult(2, 'v86-patch-rw'), 'Native apply_patch must return its RW result to the provider');
  assert.ok(patchResult(3, 'v86-patch-ro'), 'Native apply_patch must return its RO denial to the provider');
  assert.match(JSON.stringify(patchResult(2, 'v86-patch-rw')!.output), /Success/);
  assert.match(JSON.stringify(patchResult(3, 'v86-patch-ro')!.output), /failed|denied|read.only|EACCES|EROFS/i);
  assert.equal(await fs.readFile(path.join(rw, 'codex-patch.txt'), 'utf8'), 'created by remote apply_patch\n');
  assert.equal(await fs.readFile(path.join(ro, 'input.txt'), 'utf8'), 'live readonly fixture\n');
  assert.deepEqual(await fs.readdir(ro), ['input.txt']);
  assert.match(result.stdout, /Verified the v86 execution fixture/);
});
