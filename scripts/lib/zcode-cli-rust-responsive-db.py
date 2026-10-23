#!/usr/bin/env python3
"""Temporary-DB assertions for the slow-ACK responsiveness acceptance.

Only the disposable DB path handed down on stdin is opened. A real
`BEGIN IMMEDIATE` transaction is used to block the actor's own write, and every
post-hoc read is opened with `mode=ro` (never a second writable owner).
"""
import json
import sqlite3
import urllib.parse


def acquire_write_lock(config):
    connection = sqlite3.connect(config["db"], timeout=2)
    connection.isolation_level = None
    connection.execute("BEGIN IMMEDIATE")
    if not connection.in_transaction:
        raise AssertionError("BEGIN IMMEDIATE did not open a real write transaction")
    return connection


def release_write_lock(connection):
    if connection is not None and connection.in_transaction:
        connection.rollback()
    if connection is not None:
        connection.close()


def read_only(config):
    uri = "file:" + urllib.parse.quote(config["db"]) + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=2)


def queue_inputs(connection):
    rows = []
    for row in connection.execute(
        "select id, session_id, kind, delivery, status, payload, promoted_message_id "
        "from session_input order by admitted_sequence"
    ):
        payload = json.loads(row[5]) if row[5] else {}
        rows.append(
            {
                "id": row[0],
                "session": row[1],
                "kind": row[2],
                "delivery": row[3],
                "status": row[4],
                "text": payload.get("text"),
                "promotedMessageId": row[6],
            }
        )
    return rows


def database_snapshot(config):
    connection = read_only(config)
    try:
        history = [
            {"project": row[0], "text": row[1], "kind": row[2]}
            for row in connection.execute(
                "select project_id, text, kind from input_history order by rowid"
            )
        ]
        inputs = queue_inputs(connection)
        settings = [
            {"scope": row[0], "scopeId": row[1], "namespace": row[2], "key": row[3], "value": row[4]}
            for row in connection.execute(
                "select scope, scope_id, namespace, key, value from local_setting order by rowid"
            )
        ]
        messages = connection.execute("select count(*) from message").fetchone()[0]
        return {"history": history, "inputs": inputs, "settings": settings, "messages": messages}
    finally:
        connection.close()


def queue_row(config, row_id):
    """One actor row read from the temporary DB by id (no transcript snapshot)."""
    connection = read_only(config)
    try:
        for row in queue_inputs(connection):
            if row["id"] == row_id:
                return row
        return None
    finally:
        connection.close()


def message_texts(config, message_id):
    """The text parts of one transcript message (promotion target), read-only.

    `input_history` 只记录 admission 时的原始提交；queue edit 改的是队列项与它
    提升出的 message/part，因此“续写正文进入 transcript”必须查 part 表。
    """
    connection = read_only(config)
    try:
        rows = connection.execute(
            "select data from part where message_id = ? order by sequence",
            (message_id,),
        )
        return [json.loads(row[0]).get("text") for row in rows if row[0]]
    finally:
        connection.close()
