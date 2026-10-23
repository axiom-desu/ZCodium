// Event reducer handler 表的共享签名；由 EventReducer 组合，不持有 projection 事实。
import type { SessionEvent } from "../session.events.js";
import type { SessionProjection } from "../../interfaces/session.port.js";

export type EventHandler = (
  projection: SessionProjection,
  event: SessionEvent,
) => SessionProjection;

export type EventHandlerTable = Record<string, EventHandler>;
