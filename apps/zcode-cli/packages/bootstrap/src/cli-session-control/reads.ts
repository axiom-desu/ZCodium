import { SessionControlError } from "@zcode/session-control/contracts";
import type {
  AccessGrant,
  CliListSessionsInput,
  CliReadSessionInput,
  CliScope,
  CliSessionQueryPort,
  CliSessionRef,
  CliTrustedContext,
  ListSessionsResult,
  ReadSessionResult,
  SessionSummary,
} from "@zcode/session-control/contracts";
import { assertOpen, page, scopeKey, type ControlState } from "./models.js";
import {
  listStored,
  owner,
  readPersistedMessages,
  readStored,
  ref,
  storedRef,
  storedSummary,
  summary,
} from "./owners.js";
import { validateRead } from "./receipts.js";

/** 查询端口：读持久事实或已托管 root 的实时摘要，不恢复 runtime、不导航。 */
export function createQueryPort(state: ControlState): CliSessionQueryPort {
  async function listSessions(
    ctx: CliTrustedContext,
    input: CliListSessionsInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ListSessionsResult<CliSessionRef>> {
    validateRead(state, ctx, grant);
    // 规格 0.14：workspace 过滤器已从工具面删除；只读全库授权在场时读整个本机会话库。
    const items: SessionSummary<CliSessionRef>[] = ctx.readAnyLocalSession
      ? await listStored(state)
      : await Promise.all(
          [...state.roots.values()].filter((root) => root.verified).map((root) => summary(state, root)),
        );
    const query = input.query?.toLocaleLowerCase();
    const paged = page(
      items
        .filter((item) => !query || item.title.toLocaleLowerCase().includes(query))
        .sort(
          (a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
            a.session.sessionId.localeCompare(b.session.sessionId),
        ),
      input.cursor,
      input.limit,
    );
    return {
      sessions: paged.items,
      ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
    };
  }

  async function readSession(
    ctx: CliTrustedContext,
    input: CliReadSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ReadSessionResult<CliSessionRef>> {
    validateRead(state, ctx, grant);
    // 托管根沿用 manager 的规范引用与实时摘要；其他会话只在可读本机会话库时按 ID 读持久层。
    const root =
      state.roots.has(input.session.sessionId) || !ctx.readAnyLocalSession
        ? owner(state, input.session)
        : undefined;
    const stored = await readStored(state, input.session.sessionId);
    if (!root && (!stored || scopeKey(storedRef(stored)) !== scopeKey(input.session)))
      throw new SessionControlError("forbidden", "Session is not in the local session store");
    if (input.view === "summary")
      return { view: "summary", summary: root ? await summary(state, root) : storedSummary(stored!) };
    const visible = stored ? await readPersistedMessages(state, stored) : [];
    const paged = page(visible, input.cursor, input.limit);
    return {
      view: "messages",
      session: input.session,
      messages: paged.items.map((message) => ({
        id: String(message.info.id),
        role: message.info.role,
        text: message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      })),
      ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
    };
  }

  return {
    async resolveSession(ctx, sessionId) {
      assertOpen(state);
      owner(state, ctx.rootSession);
      // 托管根返回 manager 的规范引用，保证与 create/list 结果及写操作授权使用同一身份。
      if (state.roots.has(sessionId)) return ref(state, sessionId);
      const stored = await readStored(state, sessionId);
      return stored ? storedRef(stored) : undefined;
    },
    listSessions,
    readSession,
  };
}
