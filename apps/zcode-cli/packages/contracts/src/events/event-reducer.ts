// ============================================================
// Event Reducer - State projection from events
// ============================================================

import type { SessionEvent } from "./session.events.js";
import type { SessionProjection } from "./../interfaces/session.port.js";
import { initialSessionProjection } from "./event-reducer-helpers.js";
import type { EventHandlerTable } from "./event-reducer-handlers/types.js";
import { session_lifecycleHandlers } from "./event-reducer-handlers/session-lifecycle.js";
import { turn_controlHandlers } from "./event-reducer-handlers/turn-control.js";
import { tool_permissionsHandlers } from "./event-reducer-handlers/tool-permissions.js";

// -----------------------------------------------
// Event Reducer
// -----------------------------------------------

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  // 处理器按域分片注册；apply 仍按 event.type 单表查，分片不改变事件顺序语义。
  private handlers: EventHandlerTable = {
    ...session_lifecycleHandlers,
    ...turn_controlHandlers,
    ...tool_permissionsHandlers,
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
