#!/usr/bin/env python3
"""`/draft` + Ctrl-Y real PTY case: zero alternate must never lose the current draft.

The alternate-draft slot is empty in this run (nothing was rejected), which is the
normal zeroAlternate path: Ctrl-Y and `/draft` are pure local actions and must keep
the typed body and the real `@file` attachment while sending no model request.
A rejected-alternate swap needs a slow ACK rejection and is covered by the Rust
unit fixtures instead of a fabricated browser/PTY state.
"""


def build(support, db):
    del db

    def case_draft(session, result, config):
        body = config["texts"]["draftBody"]
        support.launch_ready(session)
        support.check(result, "draft: sessionReady reached a real actor Ready state", True)

        before = support.request_count(config)
        session.send(body + " @docs/")
        session.wait_for("Files · Tab inserts")
        support.mention_panel(session, "al", "docs/alpha.txt", body + " @docs/al")
        session.send("\t")
        session.wait_until(
            lambda screen: support.composer_line(screen, "@docs/alpha.txt"),
            "draft: @file token inserted into the composer",
        )
        support.dismiss_panels(session)
        title = support.composer_top_line(session.screen()) or ""
        support.check(
            result,
            "draft: @file attachment became a real composer attachment",
            "· 1 attachments" in title,
            title,
        )

        # zeroAlternate Ctrl-Y：没有备用草稿时是纯本地提示，正文与附件必须原样保留。
        session.send("\x19")
        session.wait_until(
            lambda screen: "No rejected draft from this session can be restored" in screen,
            "draft: Ctrl-Y reported the empty recovery slot",
        )
        support.check(
            result,
            "draft: Ctrl-Y with no alternate kept the body and attachment",
            support.composer_line(session.screen(), body)
            and "· 1 attachments" in (support.composer_top_line(session.screen()) or ""),
            session.screen()[-1200:],
        )
        support.check(
            result,
            "draft: Ctrl-Y created no model request",
            support.request_count(config) == before,
            f"requests={support.request_count(config)} baseline={before}",
        )

        # `/draft` 是唯一可靠入口：这里是空恢复槽的只读状态，不发模型请求。
        support.clear_draft(session)
        session.send("/draft\r")
        session.wait_until(
            lambda screen: "No alternate draft is kept" in screen,
            "draft: /draft reported the empty recovery slot",
        )
        support.check(result, "draft: /draft status reported the empty recovery slot locally", True)

        # `/draft swap` 在空恢复槽打印的提示与 Ctrl-Y 完全相同；如果只等这段文字，
        # 会命中上一条旧 transcript（假阳性）并在命令真正执行前就放行。因此先等命令
        # 完整出现在当前 composer，再 Enter，最后要求屏幕出现第二条同文案。
        session.send("/draft swap")
        session.wait_until(
            lambda screen: support.composer_line(screen, "/draft swap"),
            "draft: /draft swap typed in the current composer",
        )
        session.send("\r")
        session.wait_until(
            lambda screen: support.composer_line(screen, "Type a prompt")
            and screen.count("No rejected draft from this session can be restored") >= 2,
            "draft: /draft swap settled after the command was submitted",
        )
        support.check(
            result,
            "draft: /draft swap kept the editor local and sent nothing",
            support.composer_line(session.screen(), "Type a prompt"),
            session.screen()[-1200:],
        )

        session.send("/draft discard\r")
        session.wait_until(
            lambda screen: "No alternate draft to discard" in screen,
            "draft: /draft discard found no alternate",
        )
        support.check(result, "draft: /draft discard found no alternate and sent nothing", True)
        support.check(
            result,
            "draft: draft commands created no model request",
            support.request_count(config) == before,
            f"requests={support.request_count(config)} baseline={before}",
        )
        session.send("/quit\r")
        support.finish(session, result, "draft: process exits 0")

    return [("draft", "main", case_draft)]
