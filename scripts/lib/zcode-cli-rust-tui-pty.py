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


def rendered(data, rows=40, cols=160):
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
            # 宽字符占两列；第二列是续格，不能让上一帧残留字母插进字符串。
            if width == 2 and col + 1 < cols:
                grid[row][col + 1] = ""
            col += width
        index += 1
    return "\n".join("".join(line).rstrip() for line in grid)


def main():
    config = json.load(sys.stdin)
    binary, cwd, env = config["binary"], config["cwd"], config["env"]
    # fixture 契约：PTY 按固定下标使用模型；缺项必须显式失败，不能回退到假单模型，
    # 否则选择器/档位断言会退化成对同一份假数据的自证。
    models = config.get("models")
    if not isinstance(models, list) or len(models) < 3:
        raise ValueError("TUI fixture contract: at least three distinct models are required")
    model_ids = set()
    for index, model in enumerate(models):
        if not isinstance(model, dict):
            raise ValueError(f"TUI fixture contract: model[{index}] must be an object")
        model_id = model.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            raise ValueError(f"TUI fixture contract: model[{index}] needs a non-empty id")
        if model_id in model_ids:
            raise ValueError(f"TUI fixture contract: duplicate model id {model_id}")
        model_ids.add(model_id)
        levels = model.get("levels")
        if not isinstance(levels, list) or not levels:
            raise ValueError(f"TUI fixture contract: {model_id} needs at least one reasoning level")
        if any(not isinstance(level, str) or not level.strip() for level in levels):
            raise ValueError(f"TUI fixture contract: {model_id} has an empty reasoning level")
        if len(set(levels)) != len(levels):
            raise ValueError(f"TUI fixture contract: {model_id} repeats a reasoning level")
    if len(model_ids) < 3:
        raise ValueError("TUI fixture contract: at least three distinct model ids are required")
    pasted = models[1]
    down = models[2]
    pasted_model, down_model = pasted["id"], down["id"]
    if len(down["levels"]) < 2:
        raise ValueError("TUI fixture contract: the down-arrow model needs multiple reasoning levels")
    target_level = down["levels"][1]
    default_level = down["levels"][-1]
    if target_level == default_level:
        raise ValueError("TUI fixture contract: the down-arrow model needs a non-default level")
    output = bytearray()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
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

    def activity(text):
        # 侧栏 Status 的第一行是 actor 活动事实（Ready/Running/Cancelled）；
        # 输入框下方的 composer 行已不再承担会话/模式状态。
        lines = text.splitlines()
        for index, line in enumerate(lines):
            if re.search(r"Status\s*$", line):
                for following in lines[index + 1:index + 3]:
                    found = re.search(r"(Ready|Running|Cancelled)\s*$", following)
                    if found: return found.group(1)
        return None

    def composer(text, draft):
        # 参数必须是当前屏幕；此前误把草稿当屏幕，splitlines 后永远匹配不到行首边框。
        # 补全面板会盖住输入框右边框，因此只锚定行首 `│` + 完整草稿，不要求闭合边框。
        return any(re.match(r"│" + re.escape(draft), line) for line in text.splitlines())

    def picker_selected(text):
        for line in text.splitlines():
            if "›" in line:
                found = re.search(r"(sess_[0-9a-f-]{36})", line, re.I)
                if found: return found.group(1)
        return None

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
    def paste(text): send("\x1b[200~" + text + "\x1b[201~")
    def filter_is(text, expected):
        # 选择器渲染行是 `Filter: <filter>▌`；bracketed paste 标记只能被消费，不能进入 filter。
        marker = "Filter: " + expected if expected else "Filter: ▌"
        return marker in text and "[200~" not in text and "[201~" not in text
    def ready():
        # 单帧 Ready 可能是上一回合遗留；连续两帧才认为已经空闲，避免下一条输入被 busy 拒绝。
        # Cancelled 也是 actor 的终态（取消后的 completedInterrupted），不是 busy。
        stable = {"seen": False}
        def confirmed(s):
            if activity(s) not in ("Ready", "Cancelled"):
                stable["seen"] = False
                return False
            if stable["seen"]:
                return True
            stable["seen"] = True
            return False
        wait_until(confirmed, "idle sidebar status")
    def clear_draft():
        # 本地错误会把同一份草稿放回编辑器；Ctrl-U 只清本地文本，不发送命令。
        send("\x15")
        wait_for("Type a prompt")
    def prompt(text, response): send(text + "\r"); wait_for(response); ready()
    def scroll_back_to(text, label, pages=12):
        # --continue 打开时跟随底部，早期消息不在 40 行视口内；PageUp 是真实滚动状态，
        # 必须看到历史行才证明续跑保留了 first turn，而不是只看任意模型请求。
        for _ in range(pages):
            if text in screen(): return
            send("\x1b[5~" * 10)
            try:
                wait_until(lambda s: text in s, label, timeout=3)
                return
            except TimeoutError:
                continue
        raise TimeoutError(f"history never showed {text!r}; screen={screen()[-2200:]}")
    def session_id(label):
        # 输入框/侧栏不再展示会话 id；从 /sessions 选择器的选中行读取 actor 的当前会话。
        send("/sessions\r"); wait_for("Sessions")
        wait_until(lambda s: picker_selected(s) is not None, label)
        found = picker_selected(screen())
        send("\x1b"); wait_until(lambda s: "Sessions" not in s, label + " cancelled")
        # Esc 把 "/sessions" 草稿放回编辑器；精确匹配的补全面板会盖住输入框，先关闭再清空。
        wait_for("Tab completes")
        send("\x1b"); wait_until(lambda s: "Tab completes" not in s, label + " completion dismissed")
        clear_draft()
        return found
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
        wait_for("Status")
        wait_for("███████")
        send("\x18b"); wait_until(lambda s: "Status" not in s, "sidebar hidden")
        send("\x18b"); wait_for("Status")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.killpg(first.pid, signal.SIGWINCH)
        wait_until(lambda s: "Status" not in s, "narrow layout")
        send("\x18b"); wait_for("Status")
        send("\x1b"); wait_until(lambda s: "Status" not in s, "narrow overlay dismissed")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        os.killpg(first.pid, signal.SIGWINCH)
        wait_for("Status")
        send("/model\r"); wait_for("Models"); send("\x1b")
        wait_until(lambda s: "Models" not in s, "model picker cancelled")
        send("\x7f" * len("/model"))
        send("/model\r"); wait_for("Models"); send("\r")
        wait_until(lambda s: "Models" not in s, "model picker committed")
        send("/mode\r"); wait_for("Modes"); send("\x1b[B\r")
        # 本批 composer 底栏只保留 model/provider/thought；模式事实由输入框标题反映。
        wait_until(lambda s: "┌ Plan " in s, "plan mode selected")
        send("/mode build\r"); wait_until(lambda s: "┌ Build " in s, "build mode restored")
        result["assertions"].append("welcome/sidebar/toggle/resize/model-mode pickers")
        # 计划切换有真实 system-reminder；新会话隔离该上下文，不让 echo fixture 把提醒当用户问题。
        prior = session_id("current session id")
        send("/new\r"); wait_for("███████")
        fresh = session_id("fresh session id")
        if prior == fresh: raise AssertionError("session id did not change after /new")
        result["assertions"].append("new session/new id")

        # 本地命令/补全/无效档位不得产生模型请求；JS 侧再以 fixture 请求记录复核。
        send("/help compact\r"); wait_for("/compact [instructions]"); wait_for("aliases: /compress")
        send("/nope\r"); wait_for("Unknown command: /nope"); clear_draft()
        send("/compactfoo hi\r"); wait_for("Unknown command: /compactfoo"); clear_draft()
        send("/effort\r"); wait_for("effort: none"); wait_for("levels: none")
        send("/effort bogus\r"); wait_for("Unsupported reasoning effort: bogus"); clear_draft()
        result["assertions"].append("help/unknown/compactfoo/effort-invalid stay local")

        # 裸 `/` 的默认候选必须是 help：Enter 走 canonical /help，不把 `/` 发给模型。
        send("/"); wait_for("Tab completes")
        wait_until(lambda s: "› /help" in s, "bare slash defaults to help")
        send("\r"); wait_for("/new — Start a fresh session")
        result["assertions"].append("bare slash defaults to help")
        # 子串 `/odel` 的选中项必须真正可确认；Tab 只写回 canonical /model，不提交。
        send("/odel"); wait_for("Tab completes")
        wait_until(lambda s: "› /model" in s, "substring completion selects model")
        send("\t"); wait_until(lambda s: composer(s, "/model"), "substring Tab wrote canonical /model")
        send("\x1b"); wait_until(lambda s: "Tab completes" not in s, "substring completion dismissed")
        clear_draft()
        result["assertions"].append("substring /odel completion writes canonical /model")

        send("/co"); wait_for("Tab completes"); wait_for("/compact")
        send("\t")
        # Tab 只写回 canonical 文本；关闭补全面板后编辑器里应看到未提交的 /compact。
        send("\x1b"); wait_until(lambda s: composer(s, "/compact"), "completion wrote /compact without submitting")
        clear_draft()
        result["assertions"].append("slash completion Tab/Esc")

        # 别名 + 附注在 actor 无历史时是健康的 noop：不产生摘要请求、不伪造成功。
        send("/compress alias compact notes\r"); wait_for("no compression needed"); wait_for("(manual)"); ready()
        result["assertions"].append("alias compact noop marker")

        prompt("first turn", "answer: first turn")
        prompt("second distinct turn", "answer: second distinct turn")
        send("/sessions\r"); wait_for("Sessions")
        wait_until(lambda s: picker_selected(s) == fresh, "current session selected in list")
        send("\r"); wait_until(lambda s: "Sessions" not in s, "current session resumed from picker")
        prompt("use tool", "TUI_NOTE_MARKER")
        result["assertions"].append("title/multiturn/Read")
        send("tui-write-deny\r"); wait_for("allowOnce"); send("n\r"); ready()
        if os.path.exists(os.path.join(cwd, "denied.txt")): raise AssertionError("denied Write created a file")
        send("tui-write-allow\r"); wait_for("allowOnce"); send("y\r"); ready()
        with open(os.path.join(cwd, "allowed.txt"), encoding="utf8") as f:
            if f.read() != "TUI_WRITE_MARKER\n": raise AssertionError("Write content mismatch")
        result["assertions"].append("Write allow/deny")
        send("tui-question\r")
        # 真实待回答面板：问题文本、选项 bullet 与问答页脚同时可见，才算交互真实挂起。
        # 工具参数错误只会留在 transcript 里，既不会渲染选项，也不会出现问答页脚。
        wait_for("Choose the TUI smoke answer"); wait_for("• SMOKE_ANSWER")
        wait_for("One answer per question"); send("SMOKE_ANSWER\r")
        # 回答后 actor 还会继续这一轮；只有模型收到同一 AskUserQuestion 的真实 tool result（答案关联）
        # 才会说出这句唯一新 completion。旧 `tool done`/参数错误文本和普通 SMOKE_ANSWER prompt
        # 都不产生它，所以不能等旧回显。等回合真实收尾再继续，避免下一条 Enter 被 busy 拒绝。
        wait_for("question answered: SMOKE_ANSWER"); ready()
        result["assertions"].append("AskUserQuestion real panel/answer tool result")
        send("slow request\r"); wait_for("partial"); send("\x03"); ready()
        prompt("after cancellation", "answer: after cancellation")
        send("/sessions\r"); wait_for("Sessions")
        wait_until(lambda s: picker_selected(s) == fresh, "current session selected after cancel")
        send("\r"); wait_until(lambda s: "Sessions" not in s, "session resumed after cancel")
        result["sessionId"] = fresh
        send("/quit\r")
        if first.wait(timeout=10) != 0: raise AssertionError("/quit did not exit 0")
        restored(); result["assertions"].append("cancel/sessions/quit/termios")

        output.clear()
        resumed = launch(["--continue"])
        wait_for("ZCodium Rust"); wait_for("Status"); wait_for("after cancellation")
        scroll_back_to("first turn", "continued history first turn")
        # 下一条 Enter 会重新跟随底部，滚动状态不会污染后续请求。
        prompt("continue history check", "answer: continue history check")
        result["assertions"].append("continue/history")

        # 新会话隔离上面的 13 请求 baseline，供选择器/档位/真实 compact 使用。
        # 13 而不是旧的 14：旧 fixture 的伪问答多了一次「工具参数错误 + 普通 SMOKE_ANSWER prompt」
        # 请求，真实问答把答案放进同一 AskUserQuestion 的 tool result，请求数少 1。
        send("/new\r"); wait_for("███████"); ready()
        wait_until(lambda s: "model-a personal:fixture" in s, "new session default model status")
        send("/model\r"); wait_for("Models")
        paste("模型筛选")
        wait_until(lambda s: filter_is(s, "模型筛选"), "bracketed paste reaches selector filter")
        wait_for("No matching choices")
        # 空结果 Enter 不选任何模型；空结果过滤不是模型，也不会调用 actor。
        send("\r")
        # Esc 仍能恢复原草稿，证明 Enter 没有关闭选择器（否则不会出现补全面板）。
        send("\x1b"); wait_until(lambda s: "Models" not in s, "empty-result picker cancelled")
        wait_for("Tab completes")
        send("\x1b"); wait_until(lambda s: composer(s, "/model"), "Esc restored the selector draft")
        wait_until(lambda s: "model-a personal:fixture" in s, "empty result did not change the model")
        clear_draft()

        # 选择器 Ctrl-U 必须清空 filter 并恢复完整 typed 列表，不能退化成只清 editor。
        send("/model\r"); wait_for("Models"); paste(pasted_model)
        wait_until(lambda s: filter_is(s, pasted_model), "bracketed paste filter exact")
        wait_until(lambda s: "personal:fixture / " + pasted_model in s, "typed model listed before Ctrl-U")
        send("\x15")
        wait_until(lambda s: filter_is(s, ""), "selector Ctrl-U cleared filter")
        wait_until(lambda s: all("personal:fixture / " + model["id"] in s for model in models),
                   "selector Ctrl-U restored the full typed list")
        send("\x1b"); wait_until(lambda s: "Models" not in s, "selector Ctrl-U picker cancelled")
        wait_for("Tab completes")
        send("\x1b"); wait_until(lambda s: "Tab completes" not in s, "selector Ctrl-U completion dismissed")
        clear_draft()
        result["assertions"].append("selector Ctrl-U clears filter and restores typed list")

        send("/model\r"); wait_for("Models"); paste(pasted_model)
        wait_until(lambda s: filter_is(s, pasted_model), "bracketed paste filter exact before commit")
        wait_until(lambda s: "personal:fixture / " + pasted_model in s, "filtered typed model")
        send("\r"); wait_until(lambda s: "Models" not in s, "filtered model committed")
        wait_until(lambda s: pasted_model + " personal:fixture" in s, "composer shows pasted typed model")
        prompt("typed model check", "answer: typed model check")
        send("/model\r"); wait_for("Models"); send("\x1b[B\r")
        wait_until(lambda s: "Models" not in s, "down-arrow model committed")
        wait_until(lambda s: down_model + " personal:fixture" in s, "composer shows down-arrow typed model")
        prompt("arrow model check", "answer: arrow model check")
        result["assertions"].append("selector filter/中文 paste/empty/ctrl-u/Esc/down-arrow typed model")

        levels = ", ".join(down["levels"])
        send("/variant list\r"); wait_for("effort: " + default_level); wait_for("levels: " + levels)
        send("/variant " + target_level + "\r")
        wait_until(lambda s: re.search(r"personal:fixture \| " + target_level + r"(?:\s|$)", s) is not None,
                   "variant set refreshed the composer thought")
        send("/variant turbo\r"); wait_for("Unsupported reasoning effort: turbo. Available: " + levels)
        wait_until(lambda s: re.search(r"personal:fixture \| " + target_level + r"(?:\s|$)", s) is not None,
                   "invalid variant kept the committed thought")
        clear_draft()
        result["assertions"].append("effort list/variant set/invalid stays local")

        # 慢摘要请求让 running marker 真实可见；取消后 actor 以 cancelled 收口。
        # 先确认附注完整留在草稿里，再 Enter；否则无法区分 PTY 丢字与 actor 丢附注。
        send("/compress slow compact notes")
        wait_until(lambda s: composer(s, "/compress slow compact notes"), "slow compact instructions in draft")
        send("\r")
        wait_for("Compressing context (manual)")
        send("\x03")
        wait_for("Context compression interrupted (manual)")
        ready()
        result["assertions"].append("compact alias running/cancelled with instructions")

        prompt("compact history one", "answer: compact history one")
        prompt("compact history two", "answer: compact history two")
        send("/co"); wait_for("Tab completes"); wait_for("/compact")
        send("\t")
        send("\x1b"); wait_until(lambda s: composer(s, "/compact"), "completion wrote /compact for compact")
        send(" keep these notes")
        wait_until(lambda s: composer(s, "/compact keep these notes"), "compact instructions kept in draft")
        # Enter 走真实 compact admission；成功 marker 与摘要请求都由 actor 给出。
        send("\r")
        wait_for("Context compressed (manual)"); wait_for("tokens ")
        ready()
        result["assertions"].append("completion Tab/Enter real compact success with instructions")
        prompt("after compact", "answer: after compact")
        result["assertions"].append("post-compact context")
        send("/quit\r")
        if resumed.wait(timeout=10) != 0: raise AssertionError("continued process did not quit cleanly")
        restored(); result["assertions"].append("resume/quit/termios")

        output.clear()
        signaled = launch([]); wait_for("ZCodium Rust"); wait_for("Status")
        if terminate(signaled, signal.SIGTERM) != 143: raise AssertionError("SIGTERM did not exit 143")
        restored(); result["assertions"].append("SIGTERM/termios")
        result["status"] = "passed"
    except Exception as error:
        # 失败时也回传已完成的断言，避免 JS 侧只能看到一句超时文本。
        result["status"] = "failed"
        result["error"] = str(error)
    finally:
        with open(os.path.join(config["root"], "pty-output.log"), "wb") as f: f.write(output)
        with open(os.path.join(config["root"], "pty-screen.txt"), "w", encoding="utf8") as f: f.write(rendered(output))
        for child in children:
            if child.poll() is None: terminate(child, signal.SIGKILL)
        termios.tcsetattr(slave, termios.TCSANOW, original)
        os.close(master); os.close(slave)
    print(json.dumps(result))
    if result["status"] != "passed":
        sys.exit(1)


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)})); sys.exit(1)
