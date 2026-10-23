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
    return module


# 基线模块既是渲染器也是「在飞摘要」的唯一权威（scripts/ci/tui-pty-composer.test.mjs
# 已把它与 projection.rs 的 Pending 文案对齐），这里只复用，不另造第二份文案表。
baseline = _load_baseline_renderer()
rendered = baseline.rendered
pending_visible = baseline.pending_visible
PENDING_LABELS = baseline.PENDING_LABELS


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


# composer 顶边：mode_title 来自 config.mode（build/plan/edit/yolo → Build/Plan/Edit/Yolo），
# 带附件时标题为 `Build · 1 attachments`。transcript/tool card 也会用 `│`，不能只按前缀匹配。
COMPOSER_TOP = re.compile(
    r"^┌ (?:Build|Plan|Edit|Yolo|构建|计划|编辑|全权)(?:\b| ·)", re.IGNORECASE
)

# presentation.rs：editor 为空时按 busy 渲染的 placeholder（忙轮 `Type to queue input`）。
COMPOSER_PLACEHOLDERS = ("Type a prompt", "Type to queue input")


def composer_line(screen, needle):
    """The composer box content holding `needle`.

    只读取最末 composer 顶边（mode 标题）与其对应 `└` 底边之间的内容：transcript 有
    Borders::ALL，历史 user/assistant 行同样以 `│` 开头，按全屏前缀扫描会把旧草稿
    当成当前 editor。选择面板可能遮住右侧，因此不要求右 `│`；但只接受 box 内的
    有边线行，不扫描无 border 的提示/状态行。
    """
    lines = screen.splitlines()
    top = None
    for index in range(len(lines) - 1, -1, -1):
        if COMPOSER_TOP.match(lines[index]):
            top = index
            break
    if top is None:
        return False
    bottom = next(
        (index for index in range(top + 1, len(lines)) if lines[index].startswith("└")),
        None,
    )
    if bottom is None:
        return False
    for line in lines[top + 1 : bottom]:
        if not line.startswith("│"):
            continue
        content = line[1:]
        if content.endswith("│"):
            content = content[:-1]
        if needle in content:
            return True
    return False


def composer_idle(screen):
    """bottom composer 真的空了（只有 placeholder 行）。

    presentation.rs 按 `view.busy()` 换 placeholder：空闲 `Type a prompt`，忙轮
    `Type to queue input`。只认 `Type a prompt` 会把整个 busy 队列场景当成永不清空，
    只认行首 `│` 又会被 transcript 的旧草稿骗；因此固定为这两条文案 + 最末 box。
    """
    return any(composer_line(screen, placeholder) for placeholder in COMPOSER_PLACEHOLDERS)


def settled(screen):
    """命令真的被消费且 actor 已结算：composer 清空 + 该操作的在飞提示消失。

    只看到旧 queue 行/paused 标志不够：草稿被拒时正文仍留在 editor，mutation 在飞时
    下一条 Enter 会被 busy 闸门拒绝并保留草稿（PR88 CI 里三条命令拼成一行）。
    """
    return composer_idle(screen) and not pending_visible(screen)


def run_actor_command(session, text, label, timeout=25):
    """发送一行依赖 actor 的输入，并按因果等到它真的结算。

    先把回显等到：Enter 前的空闲帧也能满足 `settled`，不等回显就直接 Enter 会在
    真 PTY 里把“提交前”当成“已提交”。然后等上一条在飞提示消失再 Enter：busy 闸门
    只放行一个 mutation，前一条尚未 ACK 时 Enter 会被拒并保留草稿。Enter 后必须同时
    看到 composer 清空与在飞提示消失，才能发下一条依赖命令。
    """
    session.send(text)
    session.wait_until(
        lambda screen: composer_line(screen, text),
        f"{label}: draft visible in the bottom composer",
        timeout,
    )
    session.wait_until(
        lambda screen: not pending_visible(screen),
        f"{label}: previous operation settled before Enter",
        timeout,
    )
    session.send("\r")
    session.wait_until(
        settled,
        f"{label}: composer cleared and its in-flight label gone",
        timeout,
    )


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
