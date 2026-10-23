#!/usr/bin/env python3
"""Real Linux PTY acceptance for slow-ACK responsiveness (spec cli-rust-tui-responsive-operations).

This entry point only composes the case modules; PTY helpers live in `-support.py`,
temporary-DB assertions in `-db.py`, and each scenario group in its own module so no
single file carries every responsibility. Every child runs against the temporary
HOME/XDG/workspace/DB(s) passed on stdin; nothing outside the disposable root is read.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(filename, name):
    path = os.path.join(HERE, filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = _load("zcode-cli-rust-responsive-support.py", "zcode_responsive_support")
db = _load("zcode-cli-rust-responsive-db.py", "zcode_responsive_db")
cases = _load("zcode-cli-rust-responsive-cases.py", "zcode_responsive_cases")
queue = _load("zcode-cli-rust-responsive-queue.py", "zcode_responsive_queue")
draft = _load("zcode-cli-rust-responsive-draft.py", "zcode_responsive_draft")

CASES = (
    cases.build(support, db) + draft.build(support, db) + queue.build(support, db)
)


def write_logs(config, session, name):
    with open(os.path.join(config["root"], f"pty-{name}-output.log"), "wb") as handle:
        handle.write(session.output)
    with open(
        os.path.join(config["root"], f"pty-{name}-screen.txt"),
        "w",
        encoding="utf8",
    ) as handle:
        handle.write(session.screen())


def main():
    config = json.load(sys.stdin)
    result = {
        "status": "failed",
        "checks": [],
        "cases": [],
        # Boot/open is intentionally absent: holding the write lock before the
        # CLI starts blocks the startup migration at Root prepare, which is not a
        # TUI boot. The Rust unit fixtures remain the only boot evidence.
        "coverage": {
            "realDbSubmitAck": True,
            "realDbSettingAck": True,
            "realDbCtrlD": True,
            "realDbQuit": True,
            "realDbSigterm": True,
            "realDbQueueEdit": True,
            "realDbDraft": True,
            "realDbStartupBoot": False,
        },
        "baseline": {
            "commit": "59ddf0bc",
            "investigation": (
                "old main: locked DB hides typing, delays Ctrl-D past unlock, "
                "SIGTERM already exits 143; new binary must pass all cases below"
            ),
        },
    }
    scopes = config.get("scopes") or {}
    for name, scope, case in CASES:
        scoped = {**config, **scopes.get(scope, {})}
        session = support.PtySession(
            config["binary"],
            scoped["cwd"],
            scoped["env"],
            config.get("prefixArgs", []),
        )
        try:
            case(session, result, scoped)
            result["cases"].append({"name": name, "ok": True})
        except Exception as error:
            result["error"] = str(error)
            result["failedCase"] = name
            result["activity"] = support.activity(session.screen())
            result["screenTail"] = session.screen()[-3000:]
            result["cases"].append({"name": name, "ok": False, "error": str(error)})
            break
        finally:
            write_logs(config, session, name)
            session.close()
    if "error" not in result:
        result["status"] = "passed"
    print(json.dumps(result))
    if result["status"] != "passed":
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
