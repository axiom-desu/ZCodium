#!/usr/bin/env python3
"""Shared real-PTY helpers for the slow-ACK responsiveness acceptance.

`zcode-cli-rust-responsive-pty.py` composes this module with the case modules; it
never duplicates the baseline screen reconstruction. Everything here is fixture
plumbing: it only reads rendered state, the temporary DB (see `-db.py`) and the
loopback control server owned by the Node wrapper.
"""
import importlib.util
import json
import os
import time
import urllib.request


def _load(filename, name):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 复用已提交的 workbench support（只读渲染助手），不复制、不修改它。
_workbench = _load("zcode-cli-rust-workbench-pty-support.py", "zcode_responsive_pty_support")
PtySession = _workbench.PtySession
COMPOSER_TOP = _workbench.COMPOSER_TOP
activity = _workbench.activity
composer_line = _workbench.composer_line
latest_queue_block = _workbench.latest_queue_block
live_queue_header = _workbench.live_queue_header
live_queue_rows = _workbench.live_queue_rows
wait_ready = _workbench.wait_ready

# A held lock must keep the actor's 5s SQLite wait open; fail before the lock can
# time out and masquerade as a responsive ACK.
LOCK_ASSERTION_BUDGET = 4.5
EXIT_BUDGET = 4.0
EDIT_POPUP_TITLE = "Edit queued input"
EDIT_POPUP_HINT = "Enter save · Esc cancel"


def check(result, name, condition, detail=""):
    entry = {"name": name, "ok": bool(condition), "detail": detail}
    result["checks"].append(entry)
    if not condition:
        raise AssertionError(f"{name}: {detail}")


def drain_for(session, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        session.drain(0.02)


def request_count(config):
    """Real submitted main-model request count reported by the fixture control server."""
    with urllib.request.urlopen(config["controlUrl"] + "/state", timeout=5) as response:
        return json.loads(response.read())["requests"]


def release_slow(config, text):
    """End the one loopback stream that a real request opened; never invent a request."""
    body = json.dumps({"text": text}).encode()
    request = urllib.request.Request(
        config["controlUrl"] + "/release",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def wait_exit(session, budget):
    end = time.monotonic() + budget
    while time.monotonic() < end:
        session.drain(0.02)
        if session.child.poll() is not None:
            return session.child.returncode
    raise TimeoutError(
        f"process did not exit within {budget}s while the write lock was held; "
        f"activity={activity(session.screen())!r}"
    )


def launch_ready(session):
    session.launch([])
    session.wait_for("ZCodium Rust")
    session.wait_for("Status")
    wait_ready(session)


def finish(session, result, name):
    code = session.child.wait(15)
    check(result, name, code == 0, f"exit={code}")
    session.restored()


def queue_edit_box(screen):
    """Strict popup locator: the `Edit queued input` bordered box interior.

    只认标题就是当前弹层的边框盒；transcript 里的 `Editing queued input · ...` 提示
    行没有边框标题，旧 `/queue list` 文本也不满足，因此不会把历史正文当成弹层。
    """
    lines = screen.splitlines()
    for top in range(len(lines) - 1, -1, -1):
        if EDIT_POPUP_TITLE not in lines[top] or "┌" not in lines[top]:
            continue
        column = lines[top].find("┌")
        bottom = next(
            (index for index in range(top + 1, len(lines)) if lines[index][column:][:1] == "└"),
            None,
        )
        if bottom is None:
            return None
        return lines[top : bottom + 1], column
    return None


def queue_edit_visible(screen, needle):
    found = queue_edit_box(screen)
    if not found:
        return False
    lines, column = found
    return any(needle in line[column:] for line in lines[1:-1])


def queue_edit_open(screen):
    return queue_edit_box(screen) is not None


def composer_top_line(screen):
    """The main composer top border (mode title + attachment count), not the popup."""
    lines = screen.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if COMPOSER_TOP.match(lines[index]):
            return lines[index]
    return None


def live_row(screen, row_id):
    """The live actor queue bar row for `row_id` (`(header, row)`), never transcript."""
    header, rows = live_queue_rows(screen)
    for row in rows:
        if row["id"] == row_id:
            return header, row
    return header, None


def mention_panel(session, query, entry, draft):
    """Type an `@token` and wait for the composer token plus the rendered suggestion."""
    session.send(query)
    session.wait_until(
        lambda screen: composer_line(screen, draft) and f"› {entry}" in screen,
        f"mention suggestion {entry} for {draft}",
    )


def dismiss_panels(session):
    if "Files · Tab inserts" in session.screen() or "Tab completes" in session.screen():
        session.send("\x1b")
        session.wait_until(
            lambda screen: "Files · Tab inserts" not in screen and "Tab completes" not in screen,
            "panels dismissed",
        )


def clear_draft(session):
    session.send("\x15")
    session.wait_until(lambda screen: composer_line(screen, "Type a prompt"), "empty draft")
