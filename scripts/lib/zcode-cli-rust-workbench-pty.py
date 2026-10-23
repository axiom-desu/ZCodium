#!/usr/bin/env python3
"""Real PTY acceptance for the Rust TUI workbench batch (history/@file/queue/usage/MCP).

Scenario driver only: user input is real keystrokes/bracketed paste, every wait is
on rendered state or an explicit model-request marker, and all files live under the
temporary root passed on stdin. Screen reconstruction is imported from the existing
baseline driver; this file never runs it.
"""
import importlib.util
import json
import os
import re
import signal
import sys
import time
import urllib.parse
import urllib.request


def _load_support():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "zcode-cli-rust-workbench-pty-support.py")
    spec = importlib.util.spec_from_file_location("zcode_workbench_pty_support", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = _load_support()
PtySession = support.PtySession
activity = support.activity
composer_line = support.composer_line
latest_queue_block = support.latest_queue_block
live_queue_header = support.live_queue_header
live_queue_rows = support.live_queue_rows
wait_ready = support.wait_ready


def wait_idle(session, label, timeout=90):
    """队列条消失 + actor 两次连续空闲：串行队列真正跑完，而不是两个 turn 之间的间隙。"""
    session.wait_until(
        lambda s: live_queue_header(s) is None and activity(s) in ("Ready", "Cancelled"),
        label,
        timeout,
    )
    wait_ready(session, timeout)

STATE_FILE = None
CONFIG = {}


def state_url(config):
    """controlUrl 是 POST /release；/state 是同一 loopback server 的只读请求计数。"""
    parts = urllib.parse.urlsplit(config["controlUrl"])
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, "/state", "", ""))


def request_count(config):
    with urllib.request.urlopen(state_url(config), timeout=10) as response:
        return json.loads(response.read())["requests"]


def submit_draft(session, response, label=None, timeout=40):
    """Enter 前取真实 request 计数，之后只等 `WB_REPLY_<before+1>`。

    旧 response/旧 Ready 都可能在 Enter 后立刻出现在 screen 上（尤其重启后同一份
    gamma 草稿），没有新 nonce 无法区分；marker 序号由 fixture 的 requests.push
    真实计数生成（TITLE 不计），所以只有本轮新请求才能满足。
    """
    before = request_count(CONFIG)
    marker = f"WB_REPLY_{before + 1}"
    session.send("\r")
    session.wait_until(
        lambda s: marker in s and response in s and composer_line(s, "Type a prompt"),
        label or f"new model reply {marker}",
        timeout,
    )
    wait_ready(session)


def prompt(session, text, response, timeout=30):
    session.send(text)
    submit_draft(session, response, repr(response), timeout)


def check(result, name, detail=""):
    result["checks"].append({"name": name, "ok": True, "detail": detail})


def fail(result, name, detail):
    result["checks"].append({"name": name, "ok": False, "detail": detail})


def expect(result, name, condition, detail):
    (check if condition else fail)(result, name, detail)


def dismiss_panels(session):
    """Esc closes mention/completion panels; wait for the frame so the next key is not an Alt chord."""
    if "Files · Tab inserts" in session.screen() or "Tab completes" in session.screen():
        session.send("\x1b")
        session.wait_until(
            lambda s: "Files · Tab inserts" not in s and "Tab completes" not in s,
            "panels dismissed",
        )


def clear_draft(session):
    session.send("\x15")
    session.wait_until(lambda s: composer_line(s, "Type a prompt"), "empty draft")


def prompt(session, text, response, timeout=30):
    session.send(text + "\r")
    session.wait_for(response, timeout)
    wait_ready(session)


def open_workspace(session, result, label):
    session.launch([])
    session.wait_for("ZCodium Rust")
    session.wait_for("Status")
    wait_ready(session)
    check(result, f"{label}: TUI reached a real actor Ready state")


def mention_panel(session, query, entry, draft):
    """Type an `@token` and wait for the current editor token + the suggestion it renders.

    只等 `› entry` 不够：`docs/beta.txt` 对前缀 `b` 也匹配，等待可能在最后一个字符
    还没处理完时命中，Tab 落到刚清空/在飞的候选上。必须同时看到完整 token 在
    composer 里，才说明当前 query 就是这条建议。
    """
    session.send(query)
    session.wait_until(
        lambda s: composer_line(s, draft) and f"› {entry}" in s,
        f"mention suggestion {entry} for {draft}",
    )


def scenario_attachments_history(session, result, config):
    open_workspace(session, result, "attachments")
    prompt(session, "history one", "answer: history one")
    prompt(session, "history two", "answer: history two")

    # 目录：Tab 只补 `@docs/`，不提交、不附件；随后在目录里继续选文件。
    mention_panel(session, "@do", "docs/", "@do")
    session.send("\t")
    session.wait_until(lambda s: composer_line(s, "@docs/"), "Tab kept the directory token")
    check(result, "@file Tab continues into a directory without attaching a file")

    # 文件：Tab 写入 `@docs/alpha.txt ` 并成为草稿附件。
    mention_panel(session, "al", "docs/alpha.txt", "@docs/al")
    session.send("\t")
    session.wait_until(lambda s: composer_line(s, "@docs/alpha.txt"), "alpha file token inserted")
    check(result, "@file Tab inserts the workspace-relative file token")
    session.send("keep alpha attachment")
    submit_draft(session, "answer: @docs/alpha.txt keep alpha attachment")
    check(result, "accepted sendText carrying @file reached the model")

    # 删掉 inline placeholder：同一份草稿附件不得再发送。
    clear_draft(session)
    session.send("@docs/")
    session.wait_for("Files · Tab inserts")
    mention_panel(session, "be", "docs/beta.txt", "@docs/be")
    session.send("\t")
    session.wait_until(lambda s: composer_line(s, "@docs/beta.txt"), "beta file token inserted")
    session.send("\x15")
    session.wait_until(
        lambda s: composer_line(s, "Type a prompt") and not composer_line(s, "@docs/beta.txt"),
        "beta placeholder removed",
    )
    session.send("placeholder removed")
    submit_draft(session, "answer: placeholder removed")
    check(result, "deleting the inline placeholder kept the attachment out of the send")

    # 草稿正文 + 附件 → ↑ 召回 → ↓ 必须恢复两者，再真实提交。
    session.send("draft gamma notes ")
    session.send("@docs/")
    session.wait_for("Files · Tab inserts")
    mention_panel(session, "ga", "docs/gamma.txt", "@docs/ga")
    session.send("\t")
    session.wait_until(lambda s: composer_line(s, "@docs/gamma.txt"), "gamma file token inserted")
    dismiss_panels(session)
    session.send("\x1b[A")
    # 最近一次被接受的是刚提交的 `placeholder removed`；两条 history one/two 比它更旧。
    session.wait_until(
        lambda s: composer_line(s, "placeholder removed"), "Up recalled the newest history"
    )
    session.send("\x1b[B")
    session.wait_until(
        lambda s: composer_line(s, "draft gamma notes") and "@docs/gamma.txt" in s,
        "Down restored the saved draft and attachment placeholder",
    )
    check(result, "Up/Down recalls history and restores the original draft attachments")
    dismiss_panels(session)
    submit_draft(session, "answer: draft gamma notes @docs/gamma.txt")
    dismiss_panels(session)
    clear_draft(session)

    # 重启后 ↑ 仍是可编辑草稿（不是只读渲染窗口），同一份文本再次接受要命中历史去重。
    session.send("/quit\r")
    expect(result, "first process /quit exits 0", session.child.wait(15) == 0, "exit status")
    session.restored()
    session.output.clear()
    session.screen_cache = None
    session.launch(["--continue"])
    session.wait_for("ZCodium Rust")
    wait_ready(session)
    session.send("\x1b[A")
    session.wait_until(
        lambda s: composer_line(s, "draft gamma notes") and "@docs/gamma.txt" in s,
        "restart Up recalls the persisted prompt with its attachment",
    )
    check(result, "restart history recall restores the persisted draft (not a render buffer)")
    dismiss_panels(session)
    # 重启后 transcript 里已有同一份 gamma 回复；必须靠新 request nonce 放行。
    submit_draft(session, "answer: draft gamma notes @docs/gamma.txt")
    dismiss_panels(session)
    clear_draft(session)
    session.send("/quit\r")
    expect(result, "continued process /quit exits 0", session.child.wait(15) == 0, "exit status")
    session.restored()


def release(config, text):
    body = json.dumps({"text": text}).encode()
    request = urllib.request.Request(
        config["controlUrl"], data=body, headers={"content-type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def scenario_queue(session, result, config):
    open_workspace(session, result, "queue")
    session.send("wb-slow first\r")
    session.wait_for("partial ", 40)
    check(result, "slow model stream started a real busy turn")

    texts = ["queue one marker", "queue two marker", "queue three marker"]
    for index, text in enumerate(texts):
        session.send(text + "\r")
        session.send("/queue list\r")
        session.wait_until(
            lambda s: len(latest_queue_block(s)[1]) >= index + 1 or "Turn is busy" in s,
            f"{index + 1} accepted queued inputs",
            30,
        )
        if "Turn is busy" in session.screen():
            raise RuntimeError(f"busy normal input was rejected: {text}")
    header, rows = latest_queue_block(session.screen())
    ids = {row["text"]: row["id"] for row in rows if row["text"] in texts}
    expect(
        result,
        "busy normal inputs are accepted into the actor queue with UI-visible ids",
        len(ids) == 3 and "Queued 3" in header and len(set(ids.values())) == 3,
        f"header={header!r} ids={sorted(ids.values())}",
    )
    if len(ids) < 3:
        raise RuntimeError(f"queue rows incomplete: {rows}")

    session.send("/queue pause\r")
    session.send("/queue list\r")
    session.wait_until(
        lambda s: (latest_queue_block(s)[0] or "").find("Queue paused") >= 0, "paused queue"
    )
    check(result, "/queue pause reached the actor (paused header)")

    session.send(f"/queue delete {ids['queue two marker']}\r")
    session.send("/queue list\r")
    session.wait_until(
        lambda s: "Queue paused 2" in (latest_queue_block(s)[0] or ""),
        "deleted row disappeared from the actor queue",
    )
    header, rows = latest_queue_block(session.screen())
    expect(
        result,
        "/queue delete removed exactly that item",
        ids["queue two marker"] not in {row["id"] for row in rows}
        and [row["text"] for row in rows] == [texts[0], texts[2]],
        f"header={header!r} rows={rows}",
    )

    session.send(f"/queue up {ids['queue three marker']}\r")
    session.send("/queue list\r")
    session.wait_until(
        lambda s: [row["text"] for row in latest_queue_block(s)[1]] == [texts[2], texts[0]],
        "reorder moved the item before its predecessor",
    )
    check(result, "/queue up reordered the actor queue")

    # 队列编辑：/queue 菜单 → 选中项 → Edit → 独立弹层 → Enter CAS 提交，编辑正文真正执行。
    # 先编辑再提升，避免 sendNow 引起的 revision 变化让这次 CAS 恰好 stale。
    session.send("/queue\r")
    session.wait_for("Queued inputs")
    session.send("\r")
    session.wait_for("Edit text")
    session.send("\r")
    session.wait_for("Edit queued input")
    session.wait_for("Enter save · Esc cancel")
    session.send(" edited")
    session.send("\r")
    session.wait_until(lambda s: "Edit queued input" not in s, "edit popup closed after CAS", 30)
    session.send("/queue list\r")
    session.wait_until(
        lambda s: any(row["text"] == "queue three marker edited" for row in latest_queue_block(s)[1]),
        "edited queue body became an actor fact",
        30,
    )
    check(result, "/queue edit popup committed the edited body through CAS")

    # Esc 只取消本地编辑，不提交、不改 actor 队列。
    session.send("/queue\r")
    session.wait_for("Queued inputs")
    session.send("\r")
    session.wait_for("Edit text")
    session.send("\r")
    session.wait_for("Edit queued input")
    session.send("discarded text")
    session.send("\x1b")
    session.wait_for("Queue edit cancelled.")
    session.send("/queue list\r")
    session.wait_until(
        lambda s: any(row["text"] == "queue three marker edited" for row in latest_queue_block(s)[1]),
        "cancelled edit left the actor queue unchanged",
    )
    check(result, "/queue edit Esc cancelled locally without touching the actor queue")

    session.send(f"/queue send {ids['queue one marker']}\r")
    # sendNow 的 promote 是异步的：transcript 里上一次 `/queue list` 只是旧快照，
    # wait 必须读 composer 上方的 live actor 队列条。
    session.wait_until(
        lambda s: [row["id"] for row in live_queue_rows(s)[1]] == [ids["queue three marker"]],
        "sendQueuedNow dispatched the promoted item",
    )
    session.send("/queue list\r")
    session.wait_until(
        lambda s: [row["id"] for row in latest_queue_block(s)[1]] == [ids["queue three marker"]],
        "queue list reflects the promoted item",
    )
    header, rows = latest_queue_block(session.screen())
    check(
        result,
        "/queue send dispatched exactly the promoted item while the turn stayed busy",
        f"header={header!r} rows={rows}",
    )

    # sendNow 取消 slow run 后把慢流真正收尾，再 resume 剩余的 paused 项。
    session.send("/queue resume\r")
    release(config, "wb-slow first")
    for _ in range(6):
        wait_ready(session)
        session.send("/queue list\r")
        session.wait_until(
            lambda s: latest_queue_block(s)[0] is not None or "The queue is empty." in s,
            "fresh queue list",
            20,
        )
        if "The queue is empty." in session.screen():
            break
    else:
        raise RuntimeError(f"actor queue still holds items: {latest_queue_block(session.screen())}")
    check(result, "/queue resume drained the held edited item and the model saw it")
    wait_idle(session, "edited queue drained")

    # 取消不清队列：stop 之后队列仍是 actor 事实；显式 resume 才派发 held 项。
    # 第二轮 slow 的 partial 文本在长 transcript 里可能被投影缓存截断，
    # 用固定的 sidebar Status 确认真实运行态。
    session.send("wb-slow second\r")
    session.wait_until(lambda s: activity(s) == "Running", "slow turn running", 40)
    for index, text in enumerate(["cancel one marker", "cancel two marker"], start=1):
        session.send(text + "\r")
        session.send("/queue list\r")
        session.wait_until(
            lambda s: len(latest_queue_block(s)[1]) >= index, "cancel queue rows", 30
        )
    session.send("/queue pause\r")
    session.send("/queue list\r")
    session.wait_until(
        lambda s: "Queue paused 2" in (latest_queue_block(s)[0] or ""), "paused cancel queue"
    )
    session.send("\x03")
    wait_ready(session)
    session.send("/queue list\r")
    session.wait_until(
        lambda s: len(latest_queue_block(s)[1]) == 2, "queue survived stop", 30
    )
    check(result, "stop/cancel did not clear the accepted queue")
    # wrapper 需要在 stop 那一刻的 actor 队列快照，而不是退出后可能已滚出屏幕的旧 list。
    result["queue_at_stop"] = latest_queue_block(session.screen())[1]
    release(config, "wb-slow second")
    session.send("/queue resume\r")
    wait_idle(session, "held queue drained after resume")
    check(result, "explicit /queue resume dispatched the held queue after a stop")
    session.send("/quit\r")
    expect(result, "queue process /quit exits 0", session.child.wait(15) == 0, "exit status")
    session.restored()


def mcp_journal():
    if not STATE_FILE or not os.path.exists(STATE_FILE):
        return []
    with open(STATE_FILE, encoding="utf8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def scenario_usage_mcp(session, result, config):
    open_workspace(session, result, "usage")
    session.send("wb-mcp\r")
    # MCP 工具每次调用都需要真实审批；回答走同一 interaction 通道。
    session.wait_for("allowOnce", 40)
    session.send("y\r")
    session.wait_for("mcp result observed", 60)
    wait_ready(session)
    check(result, "model called the real stdio MCP tool once and saw its result")

    session.wait_until(
        lambda s: re.search(r"connected\s+workbench\s+stdio\s*·\s*1 too", s) is not None,
        "sidebar MCP connected row with tool count",
        40,
    )
    check(result, "sidebar MCP section shows a real connected row with tool count")

    before = mcp_journal()
    session.send("/mcp\r")
    session.wait_until(
        lambda s: re.search(r"connected\s+workbench\s+stdio\s*·\s*1 too", s) is not None,
        "status-only /mcp refresh",
    )
    time.sleep(1)
    after = mcp_journal()
    starts = [entry for entry in after if entry["event"] == "started"]
    expect(
        result,
        "/mcp only refreshed status (no reconnect or second MCP process)",
        len(starts) == 1 and before == after,
        f"started={starts}",
    )

    # fixture 只对这三轮回 1000/700；queryTaskUsage 对 main_turn 只累计 input
    # 相对 source baseline 的增量，所以累计是 1000 input + 3*700 output = 3100，
    # 而不是把三轮 1000 输入相加；上下文 badge 只看最后一轮 1700，即 1.7K(1%)。
    session.send("/new\r")
    session.wait_for("███████")
    wait_ready(session)
    for index in (1, 2, 3):
        prompt(session, f"usage turn {index}", f"answer: usage turn {index}")
    session.send("/usage\r")
    session.wait_for("Usage:", 30)
    session.wait_until(
        lambda s: "Usage: 3.1K total · 1K input · 2.1K output" in s,
        "real cumulative usage line",
        30,
    )
    check(result, "/usage reported the actor's real cumulative tokens")
    expect(
        result,
        "usage used relative main_turn input growth, not naive per-turn billed input",
        "Usage: 5.1K total" not in session.screen(),
        "stable 1000-token context must add only one input baseline",
    )
    session.wait_until(
        lambda s: re.search(r"1\.7K \(1%\)", s) is not None,
        "context badge from contextWindow",
        30,
    )
    check(result, "context badge came from contextWindow, not cumulative usage")
    if re.search(r"3\.1K \(1%\)", session.screen()):
        raise AssertionError("context badge reused the cumulative total")

    session.send("/quit\r")
    expect(result, "usage process /quit exits 0", session.child.wait(15) == 0, "exit status")
    session.restored()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        events = mcp_journal()
        if any(entry["event"] in ("closed", "terminated") for entry in events):
            break
        time.sleep(0.05)
    events = mcp_journal()
    pid = next((entry["pid"] for entry in events if entry["event"] == "started"), None)
    check(result, "MCP fixture recorded its lifecycle", json.dumps(events[-3:]))
    if pid:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            check(result, "MCP fixture process exited with the CLI")
        else:
            fail(result, "MCP fixture process exited with the CLI", f"pid {pid} still alive")


def scenario_shutdown(session, result, config):
    session.launch([])
    session.wait_for("ZCodium Rust")
    wait_ready(session)
    # 读票据在飞（MCP/usage）时 /quit 仍必须立即收尾（投影读结果由 fake tests 覆盖）。
    session.send("/mcp\r")
    session.send("/usage\r")
    session.send("/quit\r")
    expect(result, "/quit exits 0 with read tickets in flight", session.child.wait(15) == 0, "exit")
    session.restored()

    session.output.clear()
    session.screen_cache = None
    session.launch([])
    session.wait_for("ZCodium Rust")
    session.wait_for("Status")
    expect(
        result,
        "SIGTERM exits 143 and restores termios",
        session.terminated(signal.SIGTERM) == 143,
        "exit status",
    )
    session.restored()

    session.output.clear()
    session.screen_cache = None
    session.launch([])
    session.wait_for("ZCodium Rust")
    wait_ready(session)
    session.send("\x04")
    expect(result, "Ctrl-D exits 0 and restores termios", session.child.wait(15) == 0, "exit")
    session.restored()


SCENARIOS = {
    "attachments": scenario_attachments_history,
    "queue": scenario_queue,
    "usage": scenario_usage_mcp,
    "shutdown": scenario_shutdown,
}


def main():
    global STATE_FILE, CONFIG
    config = json.load(sys.stdin)
    STATE_FILE = config.get("mcpStateFile")
    CONFIG = config
    scenario = config["scenario"]
    session = PtySession(
        config["binary"],
        config["cwd"],
        config["env"],
        config.get("prefixArgs", []),
    )
    result = {"scenario": scenario, "checks": [], "status": "failed"}
    try:
        SCENARIOS[scenario](session, result, config)
        result["status"] = "passed"
    except Exception as error:
        result["error"] = str(error)
        result["activity"] = activity(session.screen())
        result["screen_tail"] = session.screen()[-3000:]
    finally:
        screen = session.screen()
        with open(os.path.join(config["root"], f"pty-{scenario}-output.log"), "wb") as handle:
            handle.write(session.output)
        with open(
            os.path.join(config["root"], f"pty-{scenario}-screen.txt"), "w", encoding="utf8"
        ) as handle:
            handle.write(screen)
        result["queue"] = latest_queue_block(screen)[1]
        session.close()
    print(json.dumps(result))
    if result["status"] != "passed":
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
