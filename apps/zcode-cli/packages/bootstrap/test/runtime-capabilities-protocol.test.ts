import assert from "node:assert/strict";
import { it } from "node:test";
import { zcodeProtocolMethods, type ZCodeProtocolRequest } from "@zcode/shared";

import { dispatchLegacyRequest } from "../src/zcode-protocol/server-dispatch-legacy.js";
import type { ProtocolRequestDispatchHost } from "../src/zcode-protocol/server-dispatch-types.js";

/**
 * session/list 不带协议身份，握手改由 runtime/capabilities 声明（spec runtime/capabilities）。
 * 该响应是静态事实：用「任何属性访问都抛错」的 host 证明它不读 workspace、会话、模型或网络，
 * 因此也不会把用户数据带进握手帧；测试本身不落盘，无需临时目录。
 */
function inertHost(): ProtocolRequestDispatchHost {
  return new Proxy({} as ProtocolRequestDispatchHost, {
    get(_target, property) {
      throw new Error(`runtime/capabilities must not read host.${String(property)}`);
    },
  });
}

it("runtime/capabilities 声明 legacy 协议身份且不读取 host 数据", async () => {
  const request: ZCodeProtocolRequest = {
    id: 1,
    method: zcodeProtocolMethods.runtimeCapabilities,
    params: {},
  };

  const result = await dispatchLegacyRequest(inertHost(), request);

  assert.deepEqual(result, {
    protocol: { name: "ZCode Protocol", version: 1 },
    independentPlanState: true,
  });
});
