import { randomUUID } from "node:crypto";

/** 开启/刷新配对的一次性授权令牌：绑定 window + workspaceKey，短 TTL，消费即焚。 */

const START_AUTHORIZATION_TTL_MS = 30_000;

export interface StartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

export interface StartAuthorizationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export function createStartAuthorizationStore() {
  const authorizations = new Map<string, StartAuthorization>();

  function clearExpired(): void {
    const now = Date.now();
    for (const [token, authorization] of authorizations) {
      if (authorization.expiresAt <= now) {
        authorizations.delete(token);
      }
    }
  }

  return {
    issue(
      windowId: number,
      target: StartAuthorizationTarget,
      workspaceKey: string,
    ): StartAuthorization {
      clearExpired();
      const authorization: StartAuthorization = {
        token: randomUUID(),
        expiresAt: Date.now() + START_AUTHORIZATION_TTL_MS,
        windowId,
        workspaceKey,
        remoteSessionId: target.remoteSessionId,
      };
      authorizations.set(authorization.token, authorization);
      return authorization;
    },
    consume(
      windowId: number,
      target: StartAuthorizationTarget,
      authorization: StartAuthorization,
      workspaceKey: string,
    ): void {
      const stored = authorizations.get(authorization.token);
      authorizations.delete(authorization.token);
      if (!stored || stored !== authorization) {
        throw new Error("Web remote control authorization is invalid or already used");
      }
      if (stored.expiresAt <= Date.now()) {
        throw new Error("Web remote control authorization expired");
      }
      if (
        stored.windowId !== windowId ||
        stored.workspaceKey !== workspaceKey ||
        stored.remoteSessionId !== target.remoteSessionId
      ) {
        throw new Error("Web remote control authorization target mismatch");
      }
    },
    dispose(): void {
      authorizations.clear();
    },
  };
}
