#!/usr/bin/env python3
"""Real PTY acceptance. Only the children and temporary profile passed on stdin are touched."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import unicodedata


def rendered(data, rows=40, cols=120):
    # Ratatui emits cursor-addressed diffs, not plain lines; reconstruct the screen
    # instead of looking for accidental contiguous bytes in its escape stream.
    text = data.decode("utf-8", "replace")
    grid = [[" "] * cols for _ in range(rows)]
    row = col = index = 0
    while index < len(text):
        ch = text[index]
        if ch == "\x1b":
            match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", text[index:])
            if match:
                params, _, command = match.groups()
                nums = [int(v) if v else 1 for v in params.split(";")] if params and re.fullmatch(r"[0-9;]+", params) else [1]
                if command in "Hf":
                    row = min(rows - 1, max(0, nums[0] - 1)); col = min(cols - 1, max(0, (nums[1] if len(nums) > 1 else 1) - 1))
                elif command == "J" and params in ("2", "3"):
                    grid = [[" "] * cols for _ in range(rows)]
                elif command == "K":
                    grid[row][col:] = [" "] * (cols - col)
                elif command == "G": col = min(cols - 1, nums[0] - 1)
                elif command == "A": row = max(0, row - nums[0])
                elif command == "B": row = min(rows - 1, row + nums[0])
                elif command == "C": col = min(cols - 1, col + nums[0])
                elif command == "D": col = max(0, col - nums[0])
                index += len(match.group(0)); continue
            if text[index:index+2] == "\x1b]":
                end = text.find("\x07", index)
                if end < 0: end = text.find("\x1b\\", index)
                index = len(text) if end < 0 else end + 1; continue
            index += 2; continue
        if ch == "\r": col = 0
        elif ch == "\n": row = min(rows - 1, row + 1)
        elif ch == "\b": col = max(0, col - 1)
        elif ord(ch) >= 32 and col < cols:
            grid[row][col] = ch
            width = 0 if unicodedata.combining(ch) else (2 if unicodedata.east_asian_width(ch) in "WF" else 1)
            col += width
        index += 1
    return "\n".join("".join(line).rstrip() for line in grid)


def main():
    config = json.load(sys.stdin)
    binary, cwd, env = config["binary"], config["cwd"], config["env"]
    output = bytearray()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    children = []

    def launch(args):
        def setup():
            os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        child = subprocess.Popen([binary, *config.get("prefixArgs", []), *args], cwd=cwd, env=env,
                                 stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, close_fds=True)
        children.append(child)
        return child

    def drain(timeout=0.1):
        if select.select([master], [], [], timeout)[0]:
            try:
                data = os.read(master, 65536)
                if data: output.extend(data)
            except OSError as exc:
                if exc.errno != errno.EIO: raise

    def screen():
        drain(0)
        return rendered(output)

    def wait_until(predicate, label, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            drain()
            if predicate(screen()): return
            if children[-1].poll() is not None:
                raise RuntimeError(f"process exited {children[-1].returncode} before {label}; screen={screen()[-2200:]}")
        raise TimeoutError(f"deadline waiting for {label}; screen={screen()[-2200:]}")

    def wait_for(text, timeout=25): wait_until(lambda s: text in s, repr(text), timeout)
    def send(text): os.write(master, text.encode())
    def prompt(text, response): send(text + "\r"); wait_for(response); wait_for("ready")
    def restored():
        actual = termios.tcgetattr(slave)
        if actual[3] & (termios.ECHO | termios.ICANON) != original[3] & (termios.ECHO | termios.ICANON):
            raise AssertionError("terminal ECHO/ICANON not restored")
    def terminate(child, sig):
        if child.poll() is None: os.killpg(child.pid, sig)
        return child.wait(timeout=10)

    result = {"assertions": []}
    try:
        first = launch([])
        wait_for("ZCodium Rust")
        prompt("first turn", "answer: first turn")
        prompt("second distinct turn", "answer: second distinct turn")
        prompt("use tool", "TUI_NOTE_MARKER")
        result["assertions"].append("title/multiturn/Read")
        send("tui-write-deny\r"); wait_for("allowOnce"); send("n\r"); wait_for("ready")
        if os.path.exists(os.path.join(cwd, "denied.txt")): raise AssertionError("denied Write created a file")
        send("tui-write-allow\r"); wait_for("allowOnce"); send("y\r"); wait_for("ready")
        with open(os.path.join(cwd, "allowed.txt"), encoding="utf8") as f:
            if f.read() != "TUI_WRITE_MARKER\n": raise AssertionError("Write content mismatch")
        result["assertions"].append("Write allow/deny")
        send("tui-question\r"); wait_for("Choose the TUI smoke answer"); send("SMOKE_ANSWER\r"); wait_for("ready")
        result["assertions"].append("AskUserQuestion")
        send("slow request\r"); wait_for("partial"); send("\x03"); wait_for("ready")
        prompt("after cancellation", "answer: after cancellation")
        ids = re.findall(r"[0-9a-f]{8}-[0-9a-f-]{27,}", screen(), re.I)
        if not ids: raise AssertionError("no real session id in footer")
        result["sessionId"] = ids[-1]
        send("/sessions\r")
        wait_until(lambda s: s.count(result["sessionId"]) >= 2, "session list and footer")
        send("/quit\r")
        if first.wait(timeout=10) != 0: raise AssertionError("/quit did not exit 0")
        restored(); result["assertions"].append("cancel/sessions/quit/termios")
        output.clear()
        resumed = launch(["--continue"])
        wait_for("ZCodium Rust"); wait_for(result["sessionId"]); wait_for("after cancellation")
        prompt("continue history check", "answer: continue history check")
        send("/quit\r")
        if resumed.wait(timeout=10) != 0: raise AssertionError("continued process did not quit cleanly")
        restored(); result["assertions"].append("continue/history/termios")
        output.clear()
        signaled = launch([]); wait_for("ZCodium Rust")
        if terminate(signaled, signal.SIGTERM) != 143: raise AssertionError("SIGTERM did not exit 143")
        restored(); result["assertions"].append("SIGTERM/termios")
        result["status"] = "passed"
    finally:
        with open(os.path.join(config["root"], "pty-output.log"), "wb") as f: f.write(output)
        with open(os.path.join(config["root"], "pty-screen.txt"), "w", encoding="utf8") as f: f.write(rendered(output))
        for child in children:
            if child.poll() is None: terminate(child, signal.SIGKILL)
        termios.tcsetattr(slave, termios.TCSANOW, original)
        os.close(master); os.close(slave)
    print(json.dumps(result))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)})); sys.exit(1)
