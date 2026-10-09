#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets==17.0.1"]
# ///
"""Execute one complete guest shell command and stream byte-exact stdin/stdout/stderr.

Usage: uv run scripts/remote_sandbox_exec.py [--no-stdin] 'the complete command'
The command is sent as JSON and is never evaluated by the host shell.
"""

import asyncio
import base64
import contextlib
import json
import os
import posixpath
import signal
import stat
import sys
from urllib.parse import urlsplit

from websockets.asyncio.client import connect


CHUNK_BYTES = 32 * 1024
MAX_MOUNTS_BYTES = 1024 * 1024


class DirectConnection(connect):
    """Do not allow even same-origin redirects of command-bearing connections.

    websockets' pinned connect implementation calls this hook on failed handshakes.
    """

    def process_redirect(self, exc):
        return exc


def environment_setting(name, fallback=None):
    """Prefer the current client setting, with legacy V86 names as fallbacks."""
    return os.environ.get(name, os.environ.get(name.replace("REMOTE_SANDBOX_", "V86_", 1), fallback))


def api_origin():
    raw = environment_setting("REMOTE_SANDBOX_API_URL", "http://127.0.0.1:8686")
    url = urlsplit(raw)
    if (url.scheme not in {"http", "ws"} or url.hostname not in {"localhost", "127.0.0.1", "::1"}
            or url.username is not None or url.password is not None or url.path not in {"", "/"}
            or url.query or url.fragment or any(character.isspace() for character in raw)):
        raise ValueError("REMOTE_SANDBOX_API_URL must be an http:// or ws:// localhost, 127.0.0.1, or [::1] origin without credentials or a path.")
    try:
        port = 80 if url.port is None else url.port
    except ValueError as error:
        raise ValueError("REMOTE_SANDBOX_API_URL contains an invalid port.") from error
    if not 1 <= port <= 65535:
        raise ValueError("REMOTE_SANDBOX_API_URL contains an invalid port.")
    return url.hostname, port, url.netloc


def integer_setting(name, fallback, maximum):
    raw = environment_setting(name)
    if raw is None:
        return fallback
    if not raw.isascii() or not raw.isdecimal() or not 1 <= int(raw) <= maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}.")
    return int(raw)


async def mounts_json(origin):
    """Read this API's bounded, Content-Length HTTP response without proxies/redirects."""
    host, port, authority = origin
    async with asyncio.timeout(10):
        reader, writer = await asyncio.open_connection(host, port)
        try:
            writer.write(f"GET /mounts HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n\r\n".encode("ascii"))
            await writer.drain()
            head = (await reader.readuntil(b"\r\n\r\n")).decode("iso-8859-1")
            status, *lines = head.split("\r\n")
            parts = status.split(" ", 2)
            if len(parts) < 2 or parts[1] != "200":
                raise ValueError(f"API /mounts failed: {status}")
            headers = {}
            for line in lines:
                if line:
                    key, value = line.split(":", 1)
                    headers[key.lower()] = value.strip()
            length = headers.get("content-length", "")
            if ("transfer-encoding" in headers or not length.isdecimal()
                    or not 0 <= int(length) <= MAX_MOUNTS_BYTES):
                raise ValueError("API /mounts returned an invalid or oversized response.")
            return json.loads(await reader.readexactly(int(length)))
        finally:
            writer.close()
            await writer.wait_closed()


def relative_within(parent, child):
    if not isinstance(parent, str) or not os.path.isabs(parent):
        return None
    relative = os.path.relpath(child, parent)
    return relative if relative != ".." and not relative.startswith(".." + os.sep) else None


async def guest_cwd(origin):
    explicit = environment_setting("REMOTE_SANDBOX_CWD")
    if explicit is not None:
        if not posixpath.isabs(explicit) or "\0" in explicit:
            raise ValueError("REMOTE_SANDBOX_CWD must be an absolute guest path.")
        return explicit
    cwd = os.getcwd()
    body = await mounts_json(origin)
    if not isinstance(body, dict) or not isinstance(body.get("mounts"), list):
        raise ValueError("API /mounts returned an invalid mount list.")
    mounts = [mount for mount in body["mounts"] if isinstance(mount, dict)]
    for mount in mounts:
        aliases = mount.get("preservedPaths")
        if isinstance(aliases, list) and any(relative_within(alias, cwd) is not None for alias in aliases):
            return cwd
    candidates = []
    for mount in mounts:
        host = mount.get("hostPath")
        guest = mount.get("guestPath")
        relative = relative_within(host, cwd)
        if relative is not None and isinstance(guest, str) and posixpath.isabs(guest):
            candidates.append((len(host), posixpath.normpath(posixpath.join(guest, *relative.split(os.sep)))))
    if not candidates:
        raise ValueError(f"Host cwd {cwd} is not in a mounted directory. Set REMOTE_SANDBOX_CWD to an absolute guest path or mount this directory.")
    return max(candidates, key=lambda candidate: candidate[0])[1]


async def read_stdin():
    """Wait for a partial pipe/TTY read without a thread that could outlive the VM.

    Regular files and /dev/null cannot be registered with every platform selector;
    those descriptors can be read immediately. Never use buffered read(N), which
    waits to fill N bytes even when a prompt's response is already available.
    """
    descriptor = sys.stdin.fileno()
    info = os.fstat(descriptor)
    if stat.S_ISREG(info.st_mode) or (stat.S_ISCHR(info.st_mode) and info.st_rdev == os.stat(os.devnull).st_rdev):
        await asyncio.sleep(0)
        return os.read(descriptor, CHUNK_BYTES)
    loop = asyncio.get_running_loop()
    ready = loop.create_future()

    def readable():
        if not ready.done():
            try:
                ready.set_result(os.read(descriptor, CHUNK_BYTES))
            except BlockingIOError:
                return
            except OSError as error:
                ready.set_exception(error)
            loop.remove_reader(descriptor)

    loop.add_reader(descriptor, readable)
    try:
        return await ready
    finally:
        loop.remove_reader(descriptor)


async def write_output(descriptor, data):
    """Write one bounded chunk immediately, yielding if a pipe/TTY is full.

    A blocking buffered write would prevent SIGTERM and stdin processing while a
    downstream consumer is slow. Restore inherited fd flags even on cancellation.
    """
    if stat.S_ISREG(os.fstat(descriptor).st_mode):
        while data:
            written = os.write(descriptor, data)
            data = data[written:]
        return
    loop = asyncio.get_running_loop()
    was_blocking = os.get_blocking(descriptor)
    os.set_blocking(descriptor, False)
    remaining = memoryview(data)
    try:
        while remaining:
            try:
                written = os.write(descriptor, remaining)
                remaining = remaining[written:]
            except BlockingIOError:
                ready = loop.create_future()

                def writable():
                    if not ready.done():
                        ready.set_result(None)

                loop.add_writer(descriptor, writable)
                try:
                    await ready
                finally:
                    loop.remove_writer(descriptor)
    finally:
        os.set_blocking(descriptor, was_blocking)


def execution_status(frame):
    code, signum = frame.get("exitCode"), frame.get("signal")
    valid_code = code is None or type(code) is int and 0 <= code <= 255
    valid_signal = signum is None or type(signum) is int and 1 <= signum <= 127
    if (not valid_code or not valid_signal or type(frame.get("timedOut")) is not bool
            or type(frame.get("outputLimitExceeded")) is not bool):
        raise ValueError("API returned an invalid execution result.")
    if frame["timedOut"]:
        return 124
    if frame["outputLimitExceeded"]:
        return 125
    if signum is not None:
        return 128 + signum
    if code is None:
        raise ValueError("API returned neither an exit code nor a signal.")
    return code


class Session:
    def __init__(self):
        self.websocket = None
        self.started = asyncio.Event()
        self.pending_ack = None
        self.stdin_task = None

    async def send(self, frame):
        await self.websocket.send(json.dumps(frame, separators=(",", ":")))

    async def pump_stdin(self):
        await self.started.wait()
        sequence = 0
        while True:
            data = await read_stdin()
            if not data:
                await self.send({"type": "stdin_eof"})
                return
            acknowledged = asyncio.get_running_loop().create_future()
            self.pending_ack = (sequence, acknowledged)
            await self.send({"type": "stdin", "id": sequence, "data": base64.b64encode(data).decode("ascii")})
            await acknowledged
            self.pending_ack = None
            sequence += 1

    async def receive_output(self):
        async for message in self.websocket:
            frame = json.loads(message)
            if not isinstance(frame, dict):
                raise ValueError("API returned an invalid WebSocket message.")
            kind = frame.get("type")
            if kind == "started":
                if self.started.is_set():
                    raise ValueError("API sent duplicate started messages.")
                self.started.set()
            elif kind in {"stdout", "stderr"}:
                data = frame.get("data")
                if not isinstance(data, str):
                    raise ValueError("API output must contain base64 data.")
                output = base64.b64decode(data, validate=True)
                stream = sys.stdout if kind == "stdout" else sys.stderr
                await write_output(stream.fileno(), output)
            elif kind == "stdin_ack":
                if (self.pending_ack is None or type(frame.get("id")) is not int
                        or frame["id"] != self.pending_ack[0] or self.pending_ack[1].done()):
                    raise ValueError("API sent an unexpected stdin acknowledgement.")
                self.pending_ack[1].set_result(None)
            elif kind == "stdin_closed":
                if self.stdin_task:
                    self.stdin_task.cancel()
            elif kind == "exit":
                return execution_status(frame)
            elif kind == "error":
                raise ValueError(f"API error: {frame.get('error', 'unknown error')}")
            else:
                raise ValueError(f"API sent an unknown WebSocket message type: {kind!r}.")
        raise ValueError("API disconnected without an exit result.")

    async def execute(self, command, forward_stdin):
        origin = api_origin()
        timeout = integer_setting("REMOTE_SANDBOX_TIMEOUT_MS", 120000, 300000)
        maximum = integer_setting("REMOTE_SANDBOX_MAX_OUTPUT_BYTES", None, 16 * 1024 * 1024)
        request = {"type": "start", "command": command, "cwd": await guest_cwd(origin),
                   "timeoutMs": timeout, "stdin": forward_stdin}
        if maximum is not None:
            request["maxOutputBytes"] = maximum
        async with asyncio.timeout(timeout / 1000 + 60):
            async with DirectConnection(f"ws://{origin[2]}/exec/ws", proxy=None, compression=None,
                                        max_size=256 * 1024, max_queue=4, close_timeout=0.25) as websocket:
                self.websocket = websocket
                await self.send(request)
                output_task = asyncio.create_task(self.receive_output())
                self.stdin_task = asyncio.create_task(self.pump_stdin()) if forward_stdin else None
                try:
                    if self.stdin_task:
                        done, _ = await asyncio.wait({output_task, self.stdin_task}, return_when=asyncio.FIRST_COMPLETED)
                        if self.stdin_task in done and not self.stdin_task.cancelled():
                            self.stdin_task.result()
                    return await output_task
                finally:
                    tasks = [task for task in [self.stdin_task, output_task] if task is not None]
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)


async def main():
    arguments = sys.argv[1:]
    forward_stdin = environment_setting("REMOTE_SANDBOX_FORWARD_STDIN", "1") != "0"
    if len(arguments) == 2 and arguments[0] == "--no-stdin":
        forward_stdin = False
        arguments = arguments[1:]
    if len(arguments) != 1:
        raise ValueError("Expected exactly one argument containing the complete shell command (optionally preceded by --no-stdin).")
    loop = asyncio.get_running_loop()
    interrupted = loop.create_future()

    def interrupt(signum):
        if not interrupted.done():
            interrupted.set_result(signum)

    for signum in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
        loop.add_signal_handler(signum, interrupt, signum)
    session = Session()
    execution = asyncio.create_task(session.execute(arguments[0], forward_stdin))
    try:
        await asyncio.wait({execution, interrupted}, return_when=asyncio.FIRST_COMPLETED)
        if interrupted.done():
            if session.websocket is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(session.send({"type": "cancel"}), 0.25)
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
            return 128 + interrupted.result()
        return execution.result()
    finally:
        for signum in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
            loop.remove_signal_handler(signum)


if __name__ == "__main__":
    try:
        status = asyncio.run(main())
    except Exception as error:
        print(f"remote-sandbox-shell-prefix: {error}", file=sys.stderr, flush=True)
        status = 125
    sys.exit(status)
