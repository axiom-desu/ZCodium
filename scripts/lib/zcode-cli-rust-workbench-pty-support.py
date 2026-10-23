#!/usr/bin/env python3
"""Shared real-PTY primitives for the Rust TUI acceptance drivers.

Only the screen reconstruction is reused from the existing baseline driver
(`zcode-cli-rust-tui-pty.py`), imported as a pure module so its `main` never
runs. Process/session handling stays here so new scenarios do not fork the
baseline driver.
"""
import errno
import fcntl
import importlib.util
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time
import unicodedata


def _load_baseline_renderer():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zcode-cli-rust-tui-pty.py")
    spec = importlib.util.spec_from_file_location("zcode_tui_baseline_pty", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.rendered


rendered = _load_baseline_renderer()


class PtySession:
    """One temporary PTY shared by every child of a scenario."""

    def __init__(self, binary, cwd, env, prefix_args=None, rows=40, cols=160):
        self.binary = binary
        self.cwd = cwd
        self.env = env
        self.prefix_args = prefix_args or []
        self.rows = rows
        self.cols = cols
        self.output = bytearray()
        self.children = []
        self.screen_cache = None
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)

    def launch(self, args=()):
        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        child = subprocess.Popen(
            [self.binary, *self.prefix_args, *args],
            cwd=self.cwd,
            env=self.env,
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            preexec_fn=setup,
            close_fds=True,
        )
        self.children.append(child)
        return child

    @property
    def child(self):
        return self.children[-1]

    def drain(self, timeout=0.1):
        if select.select([self.master], [], [], timeout)[0]:
            try:
                data = os.read(self.master, 65536)
                if data:
                    self.output.extend(data)
                    self.screen_cache = None
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise

    def screen(self):
        self.drain(0)
        if self.screen_cache is None:
            self.screen_cache = rendered(self.output, rows=self.rows, cols=self.cols)
        return self.screen_cache

    def send(self, text):
        os.write(self.master, text.encode())

    def paste(self, text):
        self.send("\x1b[200~" + text + "\x1b[201~")

    def wait_until(self, predicate, label, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain()
            if predicate(self.screen()):
                return self.screen()
            if self.child.poll() is not None:
                raise RuntimeError(
                    f"process exited {self.child.returncode} before {label}; screen={self.screen()[-2200:]}"
                )
        raise TimeoutError(f"deadline waiting for {label}; screen={self.screen()[-2200:]}")

    def wait_for(self, text, timeout=25):
        return self.wait_until(lambda s: text in s, repr(text), timeout)

    def resize(self, rows, cols):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.killpg(self.child.pid, signal.SIGWINCH)

    def terminated(self, sig=signal.SIGTERM):
        if self.child.poll() is None:
            os.killpg(self.child.pid, sig)
        return self.child.wait(timeout=15)

    def restored(self):
        actual = termios.tcgetattr(self.slave)
        mask = termios.ECHO | termios.ICANON
        if actual[3] & mask != self.original[3] & mask:
            raise AssertionError("terminal ECHO/ICANON not restored")

    def close(self):
        for child in self.children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=10)
        termios.tcsetattr(self.slave, termios.TCSANOW, self.original)
        os.close(self.master)
        os.close(self.slave)


def composer_line(screen, needle):
    """The editor border line holding `needle` (a selection panel may hide its right border)."""
    return any(line.startswith("│") and needle in line for line in screen.splitlines())


def activity(screen):
    """Sidebar Status block: Ready/Running/Cancelled is the actor's real phase."""
    lines = screen.splitlines()
    for index, line in enumerate(lines):
        if re.search(r"Status\s*$", line):
            for following in lines[index + 1 : index + 3]:
                found = re.search(r"(Ready|Running|Cancelled)\s*$", following)
                if found:
                    return found.group(1)
    return None


def wait_ready(session, timeout=30):
    """Two consecutive idle frames: a single Ready may be the previous turn's tail."""
    stable = {"seen": False}

    def confirmed(screen):
        if activity(screen) not in ("Ready", "Cancelled"):
            stable["seen"] = False
            return False
        if stable["seen"]:
            return True
        stable["seen"] = True
        return False

    session.wait_until(confirmed, "idle sidebar status", timeout)


QUEUE_HEADER = re.compile(r"(?:Queued|Queue paused|排队中|队列已暂停)\s+(\d+)")
QUEUE_ROW = re.compile(
    r"(queue_[0-9a-fA-F-]{36})\s*·\s*([A-Za-z]+)\s*·\s*(?:([a-zA-Z]+)\s*·\s*)?(.*)$"
)


def live_queue_header(screen):
    """composer 上方那条队列状态是 live actor 投影（不来自 transcript 文本）。"""
    lines = screen.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if re.match(r"┌ (?:Build|Plan)", lines[index]):
            for line in lines[max(0, index - 4) : index]:
                if QUEUE_HEADER.search(line):
                    return line.strip()
            return None
    return None


def live_queue_rows(screen):
    """composer 上方 live actor 投影的 `(header, rows)`。

    `/queue list` 会把当时的快照写进 transcript，随后异步动作（sendNow/promote）
    不会重写那行文本；要观察当前队列只能读 composer 条。
    """
    lines = screen.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if not re.match(r"┌ (?:Build|Plan)", lines[index]):
            continue
        header = None
        rows = []
        for line in lines[max(0, index - 6) : index]:
            if QUEUE_HEADER.search(line):
                header = line.strip()
            found = QUEUE_ROW.search(line)
            if found and header is not None:
                rows.append(
                    {
                        "id": found.group(1),
                        "kind": found.group(2),
                        "state": found.group(3) or "queued",
                        "text": found.group(4).strip(),
                    }
                )
        return header, rows
    return None, []


def latest_queue_block(screen):
    """The newest `/queue list` block: `(header, rows)`; rows carry the actor ids."""
    lines = screen.splitlines()
    starts = [index for index, line in enumerate(lines) if QUEUE_HEADER.search(line)]
    if not starts:
        return None, []
    header = lines[starts[-1]]
    rows = []
    for line in lines[starts[-1] + 1 :]:
        found = QUEUE_ROW.search(line)
        if found:
            state = found.group(3) or "queued"
            rows.append(
                {
                    "id": found.group(1),
                    "kind": found.group(2),
                    "state": state,
                    "text": found.group(4).strip(),
                }
            )
        elif rows:
            break
    return header, rows
