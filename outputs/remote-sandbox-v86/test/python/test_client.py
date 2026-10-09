"""Subprocess contract tests: uv run --with websockets==17.0.1 python -m unittest discover -s test/python -v."""

import asyncio
import base64
import json
import os
from pathlib import Path
import pty
import signal
import tempfile
import unittest

from websockets.asyncio.server import serve


ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "scripts" / "remote_sandbox_exec.py"
WRAPPER = ROOT / "scripts" / "claude-shell-prefix.sh"
EXIT = {"type": "exit", "exitCode": 0, "signal": None, "timedOut": False,
        "outputLimitExceeded": False, "durationMs": 12}


def data_frame(kind, data):
    return {"type": kind, "data": base64.b64encode(data).decode("ascii")}


async def send(ws, message):
    await ws.send(json.dumps(message))


async def receive(ws):
    return json.loads(await ws.recv())


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="v86-python-test-")
        self.root = Path(self.directory.name).resolve()
        self.cwd = self.root / "nested" / "child"
        self.cwd.mkdir(parents=True)
        self.mounts = [
            {"hostPath": str(self.root), "guestPath": "/mnt/root"},
            {"hostPath": str(self.root / "nested"), "guestPath": "/mnt/nested"},
        ]
        self.starts = []
        self.children = []
        self.errors = []
        self.http_paths = []
        self.redirect = False
        self.handler = self.finish
        self.server = await serve(self.dispatch, "127.0.0.1", 0,
                                  process_request=self.request, close_timeout=0.2)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        for child in self.children:
            if child.returncode is None:
                os.killpg(child.pid, signal.SIGKILL)
                await child.communicate()
                await child.wait()
            if child.stdin:
                child.stdin.close()
        self.server.close()
        await self.server.wait_closed()
        self.directory.cleanup()
        if self.errors:
            raise self.errors[0]

    async def request(self, connection, request):
        self.http_paths.append(request.path)
        if self.redirect:
            response = connection.respond(307, "redirect refused")
            response.headers["Location"] = f"http://127.0.0.1:{self.port}/redirect-target"
            return response
        if request.path == "/mounts":
            return connection.respond(200, json.dumps({"mounts": self.mounts}))
        if request.path != "/exec/ws":
            return connection.respond(404, "missing")

    async def dispatch(self, ws):
        try:
            start = await receive(ws)
            self.starts.append(start)
            await send(ws, {"type": "started", "processId": "test-process"})
            await self.handler(ws)
        except Exception as error:
            self.errors.append(error)

    async def finish(self, ws):
        await send(ws, EXIT)

    async def spawn(self, command="true", env=None, args=None, stdin=asyncio.subprocess.PIPE, wrapper=False):
        variables = {key: value for key, value in os.environ.items() if not key.startswith(("V86_", "REMOTE_SANDBOX_"))}
        variables.update(REMOTE_SANDBOX_API_URL=f"http://127.0.0.1:{self.port}")
        variables.update(env or {})
        variables = {key: value for key, value in variables.items() if value is not None}
        executable = [str(WRAPPER)] if wrapper else ["uv", "run", "--script", str(CLIENT)]
        child = await asyncio.create_subprocess_exec(
            *executable, *(args if args is not None else [command]), cwd=self.cwd, env=variables,
            stdin=stdin, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
        self.children.append(child)
        return child

    async def result(self, child):
        stdout, stderr = await asyncio.wait_for(child.communicate(), 5)
        return child.returncode, stdout, stderr

    async def test_output_precedes_stdin_and_multiple_delayed_binary_chunks(self):
        received = []
        async def handler(ws):
            await send(ws, data_frame("stdout", b"ready\x00\xff\n"))
            await send(ws, data_frame("stderr", b"warning\xfe\n"))
            for expected_id in range(2):
                frame = await receive(ws)
                self.assertEqual((frame["type"], frame["id"]), ("stdin", expected_id))
                chunk = base64.b64decode(frame["data"], validate=True)
                received.append(chunk)
                await send(ws, data_frame("stdout", chunk))
                await send(ws, {"type": "stdin_ack", "id": expected_id})
            self.assertEqual(await receive(ws), {"type": "stdin_eof"})
            await send(ws, {"type": "stdin_closed"})
            await send(ws, {**EXIT, "exitCode": 23})
        self.handler = handler
        child = await self.spawn("cat")
        self.assertEqual(await asyncio.wait_for(child.stdout.readexactly(8), 5), b"ready\x00\xff\n")
        self.assertEqual(await asyncio.wait_for(child.stderr.readexactly(9), 2), b"warning\xfe\n")
        for chunk in [b"first\x00\xff\n", b"second\xfe\n"]:
            child.stdin.write(chunk)
            await child.stdin.drain()
            self.assertEqual(await asyncio.wait_for(child.stdout.readexactly(len(chunk)), 2), chunk)
            await asyncio.sleep(0.05)
        child.stdin.close()
        self.assertEqual(await self.result(child), (23, b"", b""))
        self.assertEqual(received, [b"first\x00\xff\n", b"second\xfe\n"])

    async def test_exit_does_not_wait_for_still_open_parent_stdin(self):
        child = await self.spawn()
        self.assertFalse(child.stdin.is_closing())
        self.assertEqual(await asyncio.wait_for(child.wait(), 5), 0)

    async def test_complete_command_is_not_evaluated_and_deepest_mount_is_selected(self):
        command = "printf '$HOME `whoami` $(uname)'\nsource /missing\npwd >/tmp/claude-cwd"
        self.assertEqual((await self.result(await self.spawn(command, wrapper=True)))[0], 0)
        self.assertEqual(self.starts, [{"type": "start", "command": command, "cwd": "/mnt/nested/child",
                                      "timeoutMs": 120000, "stdin": True}])

    async def test_preserved_cwd_and_explicit_settings(self):
        self.mounts[0]["preservedPaths"] = [str(self.root)]
        self.assertEqual((await self.result(await self.spawn()))[0], 0)
        self.assertEqual(self.starts[-1]["cwd"], str(self.cwd))
        child = await self.spawn(env={"REMOTE_SANDBOX_CWD": "/root", "REMOTE_SANDBOX_TIMEOUT_MS": "4567",
                                     "REMOTE_SANDBOX_MAX_OUTPUT_BYTES": "1024", "REMOTE_SANDBOX_FORWARD_STDIN": "0"})
        self.assertEqual((await self.result(child))[0], 0)
        self.assertEqual(self.starts[-1], {"type": "start", "command": "true", "cwd": "/root",
                                          "timeoutMs": 4567, "maxOutputBytes": 1024, "stdin": False})

    async def test_legacy_settings_remain_fallbacks_and_current_names_win(self):
        legacy = {"REMOTE_SANDBOX_API_URL": None, "V86_API_URL": f"http://127.0.0.1:{self.port}",
                  "V86_CWD": "/legacy", "V86_TIMEOUT_MS": "2345", "V86_MAX_OUTPUT_BYTES": "512", "V86_FORWARD_STDIN": "0"}
        self.assertEqual((await self.result(await self.spawn(env=legacy)))[0], 0)
        self.assertEqual(self.starts[-1], {"type": "start", "command": "true", "cwd": "/legacy", "timeoutMs": 2345,
                                          "maxOutputBytes": 512, "stdin": False})
        current = {**legacy, "REMOTE_SANDBOX_API_URL": f"http://127.0.0.1:{self.port}", "V86_API_URL": "http://invalid.example",
                   "REMOTE_SANDBOX_CWD": "/current", "REMOTE_SANDBOX_TIMEOUT_MS": "4567",
                   "REMOTE_SANDBOX_MAX_OUTPUT_BYTES": "1024", "REMOTE_SANDBOX_FORWARD_STDIN": "1"}
        self.assertEqual((await self.result(await self.spawn(env=current)))[0], 0)
        self.assertEqual(self.starts[-1], {"type": "start", "command": "true", "cwd": "/current", "timeoutMs": 4567,
                                          "maxOutputBytes": 1024, "stdin": True})

    async def test_no_stdin_option_and_ws_origin(self):
        child = await self.spawn(args=["--no-stdin", "cat"], env={"REMOTE_SANDBOX_API_URL": f"ws://127.0.0.1:{self.port}"})
        self.assertEqual((await self.result(child))[0], 0)
        self.assertFalse(self.starts[-1]["stdin"])

    async def test_proxy_environment_is_ignored_for_local_api_and_websocket(self):
        proxy_env = {name: "http://127.0.0.1:1" for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY",
                                                           "https_proxy", "ALL_PROXY", "all_proxy",
                                                           "WS_PROXY", "ws_proxy"]}
        proxy_env.update(NO_PROXY="", no_proxy="")
        self.assertEqual((await self.result(await self.spawn(env=proxy_env)))[0], 0)
        self.assertEqual(len(self.starts), 1)

    async def test_regular_file_stdin_is_chunked_and_acknowledged(self):
        payload = bytes(range(256)) * 400
        received = bytearray()
        async def handler(ws):
            while (frame := await receive(ws))["type"] != "stdin_eof":
                chunk = base64.b64decode(frame["data"], validate=True)
                self.assertLessEqual(len(chunk), 32768)
                received.extend(chunk)
                # A client must stop sending until the server acknowledges this chunk.
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(ws.recv(), 0.025)
                await send(ws, {"type": "stdin_ack", "id": frame["id"]})
            await send(ws, EXIT)
        self.handler = handler
        source = self.root / "input.bin"
        source.write_bytes(payload)
        with source.open("rb") as source_file:
            result = await self.result(await self.spawn("cat", stdin=source_file))
        self.assertEqual(result, (0, b"", b""))
        self.assertEqual(received, payload)

    async def test_devnull_sends_eof(self):
        async def handler(ws):
            self.assertEqual(await receive(ws), {"type": "stdin_eof"})
            await send(ws, EXIT)
        self.handler = handler
        self.assertEqual((await self.result(await self.spawn(stdin=asyncio.subprocess.DEVNULL)))[0], 0)

    async def test_tty_stdin_forwards_a_line_without_waiting_for_eof(self):
        async def handler(ws):
            await send(ws, data_frame("stdout", b"ready\n"))
            frame = await receive(ws)
            self.assertEqual(frame["type"], "stdin")
            self.assertEqual(base64.b64decode(frame["data"]), b"tty response\n")
            await send(ws, {"type": "stdin_ack", "id": frame["id"]})
            await send(ws, EXIT)
        self.handler = handler
        master, slave = pty.openpty()
        try:
            child = await self.spawn("read answer", stdin=slave)
            self.assertEqual(await asyncio.wait_for(child.stdout.readexactly(6), 5), b"ready\n")
            os.write(master, b"tty response\n")
            self.assertEqual(await self.result(child), (0, b"", b""))
        finally:
            os.close(slave)
            os.close(master)

    async def test_server_closed_stdin_stops_input_pump(self):
        async def handler(ws):
            await send(ws, {"type": "stdin_closed"})
            await send(ws, data_frame("stdout", b"done\n"))
            await send(ws, EXIT)
        self.handler = handler
        self.assertEqual(await self.result(await self.spawn()), (0, b"done\n", b""))

    async def test_exit_status_conventions(self):
        for overrides, expected in [({"exitCode": 37}, 37), ({"exitCode": None, "signal": 9}, 137),
                                    ({"exitCode": None, "signal": 15, "timedOut": True}, 124),
                                    ({"outputLimitExceeded": True}, 125)]:
            with self.subTest(overrides=overrides):
                async def handler(ws):
                    await send(ws, {**EXIT, **overrides})
                self.handler = handler
                self.assertEqual((await self.result(await self.spawn()))[0], expected)

    async def test_missing_exit_frame_and_api_errors_fail(self):
        for message in [None, {"type": "error", "error": "VM unavailable"},
                        {"type": "stdout", "data": "not base64!"}, {**EXIT, "exitCode": True}]:
            with self.subTest(message=message):
                async def handler(ws):
                    if message is not None:
                        await send(ws, message)
                self.handler = handler
                code, _, stderr = await self.result(await self.spawn())
                self.assertEqual(code, 125)
                self.assertIn(b"remote-sandbox-shell-prefix:", stderr)

    async def test_sigterm_cancels_and_exits_promptly_while_stdin_remains_open(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        async def handler(ws):
            started.set()
            self.assertEqual(await receive(ws), {"type": "cancel"})
            cancelled.set()
            await ws.wait_closed()
        self.handler = handler
        child = await self.spawn("sleep 60", wrapper=True)
        await asyncio.wait_for(started.wait(), 5)
        child.send_signal(signal.SIGTERM)
        self.assertEqual(await asyncio.wait_for(child.wait(), 3), 143)
        await asyncio.wait_for(cancelled.wait(), 1)

    async def test_sigterm_remains_responsive_when_stdout_consumer_stops_reading(self):
        cancelled = asyncio.Event()
        async def handler(ws):
            await send(ws, data_frame("stdout", b"ready\n"))
            async def flood():
                for _ in range(64):
                    await send(ws, data_frame("stdout", b"x" * 32768))
            flood_task = asyncio.create_task(flood())
            try:
                self.assertEqual(await receive(ws), {"type": "cancel"})
                cancelled.set()
            finally:
                flood_task.cancel()
                await asyncio.gather(flood_task, return_exceptions=True)
            await ws.wait_closed()
        self.handler = handler
        child = await self.spawn("yes", wrapper=True)
        self.assertEqual(await asyncio.wait_for(child.stdout.readexactly(6), 5), b"ready\n")
        # asyncio's subprocess transport pauses its pipe reader at its high-water
        # mark. Leaving stdout unread here fills the client's OS pipe as well.
        await asyncio.sleep(0.1)
        child.send_signal(signal.SIGTERM)
        async def stopped():
            while child.returncode is None:
                await asyncio.sleep(0.01)
        try:
            await asyncio.wait_for(stopped(), 2)
        finally:
            if child.returncode is None:
                os.killpg(child.pid, signal.SIGKILL)
            # Drain after checking responsiveness; Process.wait() alone waits
            # for full pipe transport teardown on some Python versions.
            await child.communicate()
        self.assertEqual(child.returncode, 143)
        await asyncio.wait_for(cancelled.wait(), 1)

    async def test_requires_exactly_one_command(self):
        for args in [[], ["one", "two"]]:
            code, _, stderr = await self.result(await self.spawn(args=args))
            self.assertEqual(code, 125)
            self.assertIn(b"exactly one", stderr)
        self.assertEqual(self.starts, [])

    async def test_invalid_urls_settings_and_unmapped_cwd_fail_before_execution(self):
        for env in [{"REMOTE_SANDBOX_API_URL": "https://localhost:8686"}, {"REMOTE_SANDBOX_API_URL": "ws://example.com"},
                    {"REMOTE_SANDBOX_API_URL": "http://localhost/path"}, {"REMOTE_SANDBOX_API_URL": "http://user:pass@localhost"},
                    {"REMOTE_SANDBOX_API_URL": "http://localhost:0"},
                    {"REMOTE_SANDBOX_TIMEOUT_MS": "300001"}, {"REMOTE_SANDBOX_MAX_OUTPUT_BYTES": "0"}, {"REMOTE_SANDBOX_CWD": "relative"}]:
            with self.subTest(env=env):
                self.assertEqual((await self.result(await self.spawn(env=env)))[0], 125)
        self.mounts.clear()
        code, _, stderr = await self.result(await self.spawn())
        self.assertEqual(code, 125)
        self.assertIn(b"not in a mounted directory", stderr)
        self.assertEqual(self.starts, [])

    async def test_http_and_websocket_redirects_are_not_followed(self):
        self.redirect = True
        for env in [{}, {"REMOTE_SANDBOX_CWD": "/"}]:
            with self.subTest(env=env):
                self.assertEqual((await self.result(await self.spawn(env=env)))[0], 125)
        self.assertNotIn("/redirect-target", self.http_paths)
        self.assertEqual(self.starts, [])


if __name__ == "__main__":
    unittest.main()
