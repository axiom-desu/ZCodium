#!/usr/bin/env python3
"""Original slow-ACK cases: submit / setting / Ctrl-D / quit / SIGTERM.

These are the 34 checks that already passed on the fixed client. They stay
verbatim (only the text payloads now come from the Node wrapper so the request
assertions and the typed keys share one source of truth).
"""
import json
import os
import signal
import time


def build(support, db):
    def case_submit(session, result, config):
        texts = config["texts"]
        first = texts["submitFirst"]
        next_draft = texts["submitNext"]
        support.launch_ready(session)
        support.check(result, "submit: sessionReady reached a real actor Ready state", True)
        session.send(first)
        session.wait_until(
            lambda screen: support.composer_line(screen, first),
            "submit: first draft visible in strict main composer",
        )
        support.check(result, "submit: first draft visible in strict main composer", True)

        baseline = support.request_count(config)
        lock = db.acquire_write_lock(config)
        started = time.monotonic()
        try:
            support.check(
                result,
                "submit: write lock held before Enter",
                lock.in_transaction,
                "real BEGIN IMMEDIATE",
            )
            session.send("\r")
            support.drain_for(session, 0.25)
            support.check(
                result,
                "submit: no model request while admission is blocked",
                support.request_count(config) == baseline,
                f"requests={support.request_count(config)} baseline={baseline}",
            )
            session.send(next_draft)
            session.wait_until(
                lambda screen: support.composer_line(screen, next_draft),
                "submit: NEXT_DRAFT visible before unlock",
                2.5,
            )
            support.check(result, "submit: NEXT_DRAFT visible before unlock", True)
            session.send("\r")
            support.drain_for(session, 0.25)
            support.check(
                result,
                "submit: repeated Enter did not admit a second request",
                support.request_count(config) == baseline,
                f"requests={support.request_count(config)} baseline={baseline}",
            )
            support.check(
                result,
                "submit: repeated Enter kept the new draft",
                support.composer_line(session.screen(), next_draft),
                session.screen()[-1200:],
            )
            support.check(
                result,
                "submit: repeated Enter reported the waiting operation",
                "previous operation is still waiting" in session.screen().lower(),
                "busy note",
            )
            held_ms = round((time.monotonic() - started) * 1000)
            support.check(
                result,
                "submit: write lock still held when assertions completed",
                lock.in_transaction and held_ms < support.LOCK_ASSERTION_BUDGET * 1000,
                f"held_ms={held_ms}",
            )
        finally:
            released = time.monotonic()
            db.release_write_lock(lock)
            lock = None

        session.wait_for(f"answer: {first}", 30)
        support.wait_ready(session)
        support.check(
            result,
            "submit: exactly one admission after unlock",
            support.request_count(config) == baseline + 1,
            f"requests={support.request_count(config)}",
        )
        support.check(
            result,
            "submit: ACK did not delete the waiting draft",
            support.composer_line(session.screen(), next_draft),
            session.screen()[-1200:],
        )
        first_db = db.database_snapshot(config)
        history_texts = [row["text"] for row in first_db["history"]]
        support.check(
            result,
            "submit: temp DB history contains only the accepted draft",
            history_texts == [first],
            f"history={history_texts}",
        )

        session.send("\r")
        session.wait_for(f"answer: {next_draft}", 30)
        support.wait_ready(session)
        support.check(
            result,
            "submit: new submitted draft was accepted and promoted",
            support.request_count(config) == baseline + 2,
            f"requests={support.request_count(config)}",
        )
        final_db = db.database_snapshot(config)
        history_texts = [row["text"] for row in final_db["history"]]
        support.check(
            result,
            "submit: temp DB history has both accepted drafts exactly once",
            history_texts == [first, next_draft],
            f"history={history_texts}",
        )
        expected_scope = os.path.realpath(config["cwd"])
        inputs = final_db["inputs"]
        support.check(
            result,
            "submit: input history transaction matches accepted inputs",
            [row["text"] for row in inputs] == [first, next_draft]
            and all(row["status"] == "promoted" for row in inputs)
            and all(row["promotedMessageId"] for row in inputs)
            and all(row["project"] == expected_scope for row in final_db["history"])
            and final_db["messages"] >= 2,
            json.dumps(
                {
                    "inputs": inputs,
                    "projects": sorted({row["project"] for row in final_db["history"]}),
                    "expectedScope": expected_scope,
                    "messages": final_db["messages"],
                }
            ),
        )
        result["database"] = final_db
        result["unlockToReplyMs"] = round((time.monotonic() - released) * 1000)
        session.send("/quit\r")
        support.finish(session, result, "submit: process exits 0")

    def case_setting_ack(session, result, config):
        setting_draft = config["texts"]["settingDraft"]
        support.launch_ready(session)
        support.check(result, "setting: sessionReady reached a real actor Ready state", True)
        before = support.request_count(config)
        lock = db.acquire_write_lock(config)
        try:
            session.send("/mode edit\r")
            support.drain_for(session, 0.25)
            session.send(setting_draft)
            session.wait_until(
                lambda screen: support.composer_line(screen, setting_draft),
                "setting: typed draft visible while setting waits for the lock",
                2.5,
            )
            support.check(result, "setting: typed draft visible while setting waits for the lock", True)
            support.check(
                result,
                "setting: real setting ACK row absent until the lock is released",
                not any(
                    row["namespace"] == "permission"
                    and row["key"] == "mode"
                    and '"edit"' in (row["value"] or "")
                    for row in db.database_snapshot(config)["settings"]
                ),
                "no committed setting row while blocked",
            )
        finally:
            db.release_write_lock(lock)
            lock = None
        session.wait_until(lambda screen: "┌ Edit " in screen, "setting: snapshot after lock release", 25)
        support.wait_ready(session)
        support.check(result, "setting: setting ACK refreshed the snapshot after unlock", True)
        settings = db.database_snapshot(config)["settings"]
        mode_rows = [
            row
            for row in settings
            if row["namespace"] == "permission" and row["key"] == "mode" and '"edit"' in row["value"]
        ]
        support.check(
            result,
            "setting: real setting ACK row recorded in temp DB",
            len(mode_rows) == 1,
            json.dumps(mode_rows),
        )
        result["settingRows"] = mode_rows
        support.check(
            result,
            "setting: ACK kept the newer draft",
            support.composer_line(session.screen(), setting_draft),
            session.screen()[-1200:],
        )
        support.check(
            result,
            "setting: setting did not create a model request",
            support.request_count(config) == before,
            f"requests={support.request_count(config)} baseline={before}",
        )
        session.send("\x15")
        session.wait_until(lambda screen: support.composer_line(screen, "Type a prompt"), "setting draft cleared")
        session.send("/quit\r")
        support.finish(session, result, "setting: process exits 0")

    def case_ctrl_d(session, result, config):
        support.launch_ready(session)
        support.check(result, "ctrl-d: sessionReady reached a real actor Ready state", True)
        lock = db.acquire_write_lock(config)
        try:
            session.send("\x04")
            code = support.wait_exit(session, support.EXIT_BUDGET)
            support.check(
                result,
                "ctrl-d: exits 0 while write lock is still held",
                code == 0 and lock.in_transaction,
                f"exit={code} lock={lock.in_transaction}",
            )
            session.restored()
            support.check(result, "ctrl-d: termios restored before unlock", True)
        finally:
            db.release_write_lock(lock)
            lock = None

    def case_quit_setting(session, result, config):
        quit_draft = config["texts"]["quitDraft"]
        support.launch_ready(session)
        support.check(result, "quit: sessionReady reached a real actor Ready state", True)
        lock = db.acquire_write_lock(config)
        try:
            # `/mode build` 会写项目偏好（上一 case 已提交 edit），因此该 setter 等这把写锁。
            session.send("/mode build\r")
            support.drain_for(session, 0.25)
            session.send(quit_draft)
            session.wait_until(
                lambda screen: support.composer_line(screen, quit_draft),
                "quit: typed draft visible while setting waits for the lock",
                2.5,
            )
            support.check(result, "quit: typed draft visible while setting waits for the lock", True)
            session.send("\x15")
            session.wait_until(lambda screen: support.composer_line(screen, "Type a prompt"), "quit draft cleared")
            session.send("/quit\r")
            code = support.wait_exit(session, support.EXIT_BUDGET)
            support.check(
                result,
                "quit: /quit exits 0 while write lock is still held",
                code == 0 and lock.in_transaction,
                f"exit={code} lock={lock.in_transaction}",
            )
            session.restored()
            support.check(result, "quit: termios restored before unlock", True)
        finally:
            db.release_write_lock(lock)
            lock = None

    def case_sigterm(session, result, config):
        support.launch_ready(session)
        support.check(result, "sigterm: sessionReady reached a real actor Ready state", True)
        lock = db.acquire_write_lock(config)
        try:
            os.killpg(session.child.pid, signal.SIGTERM)
            code = support.wait_exit(session, support.EXIT_BUDGET)
            support.check(
                result,
                "sigterm: exits 143 while write lock is still held",
                code == 143 and lock.in_transaction,
                f"exit={code} lock={lock.in_transaction}",
            )
            session.restored()
            support.check(result, "sigterm: termios restored before unlock", True)
        finally:
            db.release_write_lock(lock)
            lock = None

    return [
        ("submit", "main", case_submit),
        ("setting", "main", case_setting_ack),
        ("ctrl-d", "main", case_ctrl_d),
        ("quit", "main", case_quit_setting),
        ("sigterm", "main", case_sigterm),
    ]
