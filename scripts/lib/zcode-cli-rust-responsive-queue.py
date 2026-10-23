#!/usr/bin/env python3
"""P1 queue-edit case: continue editing while the explicit save is still blocked.

Sequence (one disposable root, its own workspace/DB/process):
  slow real request → ordinary queued input → /queue pause → popup edit
  → hold a real SQLite BEGIN IMMEDIATE write lock → Enter save → keep typing
  → release → fresh snapshot keeps the continuation → Enter saves it explicitly
  → actor /queue list shows the continued body → release the slow stream + resume
  → the model really executes the continued body (unique reply nonce).
"""
import json
import time

FIRST_SAVE_SUFFIX = "queueEditFirstSave"
CONTINUED_SUFFIX = "queueEditContinued"


def build(support, db):
    def open_edit_popup(session, result, original):
        """`/queue` 菜单 → 选中项 → Edit → 独立弹层（严格按弹层标题定位）。"""
        session.send("/queue\r")
        session.wait_for("Queued inputs")
        session.send("\r")
        session.wait_for("Edit text")
        session.send("\r")
        session.wait_until(
            lambda screen: support.queue_edit_visible(screen, original),
            "queue edit: popup shows the actor-owned body",
        )
        support.check(result, "queue edit: popup opened with the actor-owned body", True)

    def case_queue_edit(session, result, config):
        texts = config["texts"]
        slow = texts["queueSlowTurn"]
        original = texts["queueEditOriginal"]
        committed_first = texts["queueEditCommitted"]
        edited = texts["queueEditExpected"]

        support.launch_ready(session)
        support.check(result, "queue edit: sessionReady reached a real actor Ready state", True)
        baseline = support.request_count(config)
        session.send(slow + "\r")
        session.wait_for("partial ", 40)
        support.check(
            result,
            "queue edit: slow model request started a real busy turn",
            support.request_count(config) == baseline + 1,
            f"requests={support.request_count(config)} baseline={baseline}",
        )

        # 普通输入在 actor 运行中按 requestedDelivery:queue 入队：不是前端伪入队。
        session.send(original + "\r")
        session.wait_until(
            lambda screen: any(
                candidate["text"] == original
                for candidate in support.live_queue_rows(screen)[1]
            ),
            "queue edit: busy normal input appeared in the live actor queue bar",
            30,
        )
        header, rows = support.live_queue_rows(session.screen())
        row = next(candidate for candidate in rows if candidate["text"] == original)
        row_id = row["id"]
        db_row = db.queue_row(config, row_id)
        support.check(
            result,
            "queue edit: busy normal input became an actor-owned queued item",
            db_row is not None
            and db_row["status"] == "admitted"
            and db_row["delivery"] == "queue"
            and db_row["text"] == original
            and support.request_count(config) == baseline + 1,
            json.dumps(db_row),
        )

        session.send("/queue pause\r")
        session.wait_until(
            lambda screen: "Queue paused" in (support.live_queue_header(screen) or ""),
            "queue edit: /queue pause reached the actor",
            25,
        )
        support.check(result, "queue edit: /queue pause reached the actor", True)
        open_edit_popup(session, result, original)

        # 第一版显式修改：Enter 前先写进弹层，这样被锁阻塞的保存正文与 actor 旧正文不同。
        session.send(" " + texts[FIRST_SAVE_SUFFIX])
        session.wait_until(
            lambda screen: support.queue_edit_visible(screen, committed_first),
            "queue edit: first save version typed into the popup",
        )
        lock = db.acquire_write_lock(config)
        started = time.monotonic()
        try:
            support.check(
                result,
                "queue edit: write lock held before the explicit save",
                lock.in_transaction,
                "real BEGIN IMMEDIATE",
            )
            session.send("\r")
            support.drain_for(session, 0.2)
            session.send(" " + texts[CONTINUED_SUFFIX])
            session.wait_until(
                lambda screen: support.queue_edit_visible(screen, edited),
                "queue edit: continuation visible in the popup before unlock",
                2.5,
            )
            support.check(
                result,
                "queue edit: continuation visible in the popup while the save is blocked",
                True,
            )
            support.check(
                result,
                "queue edit: blocked save did not commit the new body",
                (db.queue_row(config, row_id) or {}).get("text") == original,
                json.dumps(db.queue_row(config, row_id)),
            )
            support.check(
                result,
                "queue edit: blocked save created no model request",
                support.request_count(config) == baseline + 1,
                f"requests={support.request_count(config)}",
            )
            held_ms = round((time.monotonic() - started) * 1000)
            support.check(
                result,
                "queue edit: write lock still held when assertions completed",
                lock.in_transaction and held_ms < support.LOCK_ASSERTION_BUDGET * 1000,
                f"held_ms={held_ms}",
            )
        finally:
            db.release_write_lock(lock)
            lock = None

        # 解锁后快照落地：actor 正文 = 第一版；本地弹层仍保留续写内容（迟到 ACK 不清）。
        session.wait_until(
            lambda screen: (support.live_row(screen, row_id)[1] or {}).get("text")
            == committed_first,
            "queue edit: actor committed the first save after unlock",
            25,
        )
        support.check(result, "queue edit: actor committed the first save after unlock", True)
        support.check(
            result,
            "queue edit: late ACK kept the continued local edit",
            support.queue_edit_visible(session.screen(), edited)
            and (support.live_row(session.screen(), row_id)[1] or {}).get("text")
            == committed_first,
            json.dumps(support.live_row(session.screen(), row_id)[1]),
        )

        # 显式再次保存：P1 修复后基线 revision 已更新，这里必须是 accepted 而不是 stale。
        session.send("\r")
        session.wait_until(
            lambda screen: not support.queue_edit_open(screen)
            or "queue changed before this action" in screen.lower(),
            "queue edit: second explicit save settled",
            30,
        )
        support.check(
            result,
            "queue edit: second explicit save was accepted (no stale rejection)",
            not support.queue_edit_open(session.screen()),
            session.screen()[-1600:],
        )
        session.send("/queue list\r")
        session.wait_until(
            lambda screen: any(
                candidate["text"] == edited
                for candidate in support.latest_queue_block(screen)[1]
            ),
            "queue edit: actor queue list shows the continued body",
            30,
        )
        support.check(result, "queue edit: actor queue list shows the continued body", True)
        support.check(
            result,
            "queue edit: queued edit created no model request",
            support.request_count(config) == baseline + 1,
            f"requests={support.request_count(config)}",
        )

        # 释放慢请求后显式 resume：队列项必须作为新的真实请求执行续写后的正文。
        support.release_slow(config, slow)
        session.wait_for("slow done", 40)
        support.wait_ready(session)
        before_drain = support.request_count(config)
        marker = f"WB_REPLY_{before_drain + 1}"
        session.send("/queue resume\r")
        session.wait_until(
            lambda screen: marker in screen and f"answer: {edited}" in screen,
            "queue edit: resumed queue executed the edited body as a new request",
            40,
        )
        support.wait_ready(session)
        support.check(
            result,
            "queue edit: resumed queue executed the edited body through a new real request",
            support.request_count(config) == before_drain + 1,
            f"requests={support.request_count(config)} marker={marker}",
        )

        final_db = db.database_snapshot(config)
        promoted = next((row for row in final_db["inputs"] if row["id"] == row_id), None)
        support.check(
            result,
            "queue edit: promoted row carries the continued body",
            promoted is not None
            and promoted["status"] == "promoted"
            and promoted["text"] == edited
            and bool(promoted["promotedMessageId"]),
            json.dumps(promoted),
        )
        # `input_history` 记录 admission 时的原始提交（queue edit 不改写它）；
        # 续写正文必须真的进入 promoted message 的 text part，且只进一次。
        transcript = db.message_texts(config, promoted["promotedMessageId"])
        history = [row["text"] for row in final_db["history"]]
        support.check(
            result,
            "queue edit: transcript promoted the edited body exactly once",
            transcript.count(edited) == 1
            and history.count(slow) == 1
            and history.count(original) == 1
            and history.count(edited) == 0,
            json.dumps({"transcript": transcript, "history": history}),
        )
        result["queueDatabase"] = final_db
        result["queueTranscript"] = {
            "messageId": promoted["promotedMessageId"],
            "texts": transcript,
        }
        session.send("/quit\r")
        support.finish(session, result, "queue edit: process exits 0")

    return [("queue-edit", "queue", case_queue_edit)]
