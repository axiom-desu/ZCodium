import {
  type AccessGrant,
  type CliScope,
  type CliSessionControlDependencies,
  type CliSessionRef,
  type CliTrustedContext,
  type DeadlinePort,
  type OperationFeed,
  type OperationSnapshot,
  type OperationUpdate,
  type SessionRef,
} from "../contract.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

export function createManualDeadlines() {
  const pending = new Set<ReturnType<typeof deferred<void>>>();
  const port: DeadlinePort & { readonly pendingCount: number; expireAll(): void } = {
    get pendingCount() {
      return pending.size;
    },
    create() {
      const deadline = deferred<void>();
      pending.add(deadline);
      return {
        expired: deadline.promise,
        close() {
          pending.delete(deadline);
        },
      };
    },
    expireAll() {
      for (const deadline of pending) deadline.resolve();
    },
  };
  return port;
}

// 可控事件源只保存测试事件，不模拟真实 owner 的队列或持久去重。
export function createOperationFeed<R extends SessionRef>(initial: OperationSnapshot<R>) {
  const events: OperationUpdate<R>[] = [];
  let waiter: ReturnType<typeof deferred<IteratorResult<OperationUpdate<R>>>> | undefined;
  let ended = false;
  let failure: unknown;
  let closeCount = 0;
  const feed: OperationFeed<R> & {
    readonly closeCount: number;
    push(update: OperationUpdate<R>): void;
    end(): void;
    fail(error: unknown): void;
  } = {
    initial,
    get closeCount() {
      return closeCount;
    },
    updates: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (events.length) return { done: false as const, value: events.shift()! };
            if (failure) throw failure;
            if (ended) return { done: true as const, value: undefined };
            waiter = deferred<IteratorResult<OperationUpdate<R>>>();
            return waiter.promise;
          },
          async return() {
            feed.end();
            return { done: true as const, value: undefined };
          },
        };
      },
    },
    push(update) {
      if (ended) throw new Error("Feed is closed");
      if (waiter) {
        const next = waiter;
        waiter = undefined;
        next.resolve({ done: false, value: update });
      } else events.push(update);
    },
    end() {
      ended = true;
      waiter?.resolve({ done: true, value: undefined });
      waiter = undefined;
    },
    fail(error) {
      failure = error;
      waiter?.reject(error);
      waiter = undefined;
    },
    async close() {
      if (closeCount === 0) {
        closeCount += 1;
        feed.end();
      }
    },
  };
  return feed;
}

export interface TestPortCall {
  method: string;
  ctx: unknown;
  input: unknown;
  grant?: unknown;
}
export interface CliTestPorts {
  calls: TestPortCall[];
  context: CliTrustedContext;
  deadlines: ReturnType<typeof createManualDeadlines>;
  cli: CliSessionControlDependencies;
  grants: AccessGrant<CliScope>[];
}

/**
 * 测试端口集合：按调用记录输入，按需替换某一方法。授权默认通过并返回同 scope 的 fence，
 * 测试用 `cli.access` 覆盖来验证拒绝路径（授权是产品行为，不该被测试夹具静默放宽）。
 */
export function createTestPorts(root: CliSessionRef): CliTestPorts {
  const calls: TestPortCall[] = [];
  const grants: AccessGrant<CliScope>[] = [];
  const scope: CliScope = {
    kind: "cli",
    workspacePath: root.workspacePath,
    ...(root.workspaceIdentity ? { workspaceIdentity: root.workspaceIdentity } : {}),
  };
  const context: CliTrustedContext = {
    callerId: root.sessionId,
    rootSession: root,
    allowedScopes: [scope],
    readAnyLocalSession: true,
  };
  const record = (method: string, ctx: unknown, input: unknown, grant?: unknown) => {
    calls.push({ method, ...(grant ? { grant } : {}), ctx, input });
  };
  const denied = () => Promise.reject(new Error("Test port not configured for this case"));
  const cli: CliSessionControlDependencies = {
    access: {
      async authorize(ctx, request) {
        record("access.authorize", ctx, request);
        const grant = { fence: `fence:${root.sessionId}`, scope: request.scope };
        grants.push(grant);
        return grant;
      },
    },
    sessions: {
      resolveSession: () => denied(),
      listSessions: () => denied(),
      readSession: () => denied(),
    },
    execution: {
      createSession: () => denied(),
      forkSession: () => denied(),
      sendToSession: () => denied(),
      interruptSession: () => denied(),
      renameSession: () => denied(),
    },
    observations: {
      open: () => denied(),
    },
    deadlines: createManualDeadlines(),
  };
  return {
    calls,
    cli,
    context,
    deadlines: cli.deadlines as ReturnType<typeof createManualDeadlines>,
    grants,
  };
}
