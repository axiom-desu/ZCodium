/**
 * source-server 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { RemoteConnectionDomainError } from "./index.js";
import {
  connectionProfileSchema,
  publicZCodeErrorCodeSchema,
  createCompatibilityManifest,
  evaluateSourceServerCompatibility,
  getSourceServerUpdateTarget,
  sourceServerUpdateRequestSchema,
  type ConnectionProfile,
  type SourceServerUpdateRequest,
} from "./contract.js";

export function exampleCloudProfile(sourceServerId: string): ConnectionProfile {
  return connectionProfileSchema.parse({
    profileId: "2a7b4d76-0d8d-4f1e-a2b8-9f0f0a1b2c3d",
    sourceServerId,
    transport: "ssh",
    target: {
      kind: "ssh",
      host: "dev.example.test",
      username: "developer",
      passwordCredentialKey: "connection-profile:example:password",
    },
    createdAt: 1,
  });
}

export function exampleUpdateRequest(profile: ConnectionProfile): SourceServerUpdateRequest {
  return sourceServerUpdateRequestSchema.parse({
    profileId: profile.profileId,
    force: true,
    expectedTarget: getSourceServerUpdateTarget(profile.target),
  });
}

/** 不支持额外验证不是缺少密码；消费者保留专用码并禁止自动重试。 */
export function exampleUnsupportedAuthentication() {
  return {
    code: publicZCodeErrorCodeSchema.parse("remote-authentication-unsupported"),
    retryable: false,
  };
}

/** 已完成 daemon 领域分类：unknown 不是可继续猜测 cause 的普通包装。 */
export function exampleDockerDaemonFailure(cause: unknown) {
  return Object.assign(new Error("Docker 环境不可用", { cause }), {
    code: "remote-connection-unknown",
    remoteConnectionErrorKind: "domain",
  } satisfies RemoteConnectionDomainError);
}

export function exampleCompatibility() {
  return evaluateSourceServerCompatibility(
    createCompatibilityManifest("3.16.2", "3.16.0"),
    createCompatibilityManifest("3.15.1", "3.16.0"),
  );
}
