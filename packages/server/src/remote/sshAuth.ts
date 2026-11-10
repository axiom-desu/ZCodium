import type { ConnectConfig } from "ssh2";
import type { PublicZCodeErrorCode } from "@zcode/shared";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;
// ssh2 在第 COUNT_MAX + 1 个无响应间隔才报告 keepalive 超时。
const SSH_KEEPALIVE_TIMEOUT_MS = SSH_KEEPALIVE_INTERVAL_MS * (SSH_KEEPALIVE_COUNT_MAX + 1);

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
  /**
   * 主机密钥校验器（TOFU known_hosts，见 sshKnownHosts.ts）。
   * 不提供时 ssh2 接受任意主机密钥——中间人可冒充目标主机骗取凭据，\   * 因此正式连接链路必须注入；仅测试与明确无需校验的场景才留空。
   */
  hostVerifier?: ConnectConfig["hostVerifier"];
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

// ssh2 在 hostVerifier 回调 verify(false) 后抛出的固定文案（lib/protocol/kex.js）。
// 正常链路里拒绝原因已由 ssh-backend 从 verifier 的 onRejection 取出并换成可区分错误，
// 这里只是兜底：消息必须如实说“校验未通过”，不能断言是密钥变更（那需要 verifier 的证据）。
function isHostKeyVerificationDeniedMessage(message: string): boolean {
  return message.includes("Host denied (verification failed)");
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // 密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。
  // 某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽，导致正确密码也无法进入认证。
  // 这里改成“显式传入 agent 才启用”；否则密码模式默认禁用隐式 agent。
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    hostVerifier: input.hostVerifier,
    // ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时。
    // 这里显式放宽连接握手超时，既给真实慢连接机会，也让错误归一化能和实际配置保持一致。
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close。
    // 启用 SSH-level keepalive，让 ssh2 在连续无响应后主动触发 error/close，避免 UI 任务长期卡在 loading。
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // 一些 SSH 服务端只开启 keyboard-interactive（challenge-response）而关闭 plain password。
    // 开启 tryKeyboard + 交互回调后，同一份密码可以覆盖这类主机，避免“命令行可登录、应用里认证失败”。
    tryKeyboard: hasPassword,
  };
}

// 多轮、多条 Password 也可能只是重试密码，不能作为二次验证证据。
const ADDITIONAL_VERIFICATION_PROMPT_PATTERN =
  /verification code|one[- ]?time|\bOTP\b|pass ?code|(?:second|two|2nd)[- ]?factor|\b(?:2FA|MFA)\b|authenticator|动态口令|动态密码/iu;

export function createKeyboardInteractiveResponder(
  password?: string,
  onAdditionalVerificationPrompt?: () => void,
) {
  return (
    name: string,
    instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    // Bug 原因：只按提示次数推断 2FA 会把错误密码误判为不支持认证，丢失补密码入口。
    // 只认服务器明确提示文字；回答方式保持不变，不在 responder 上累积跨连接计数。
    if (
      [name, instructions, ...prompts.map(({ prompt }) => prompt)].some((text) =>
        ADDITIONAL_VERIFICATION_PROMPT_PATTERN.test(text),
      )
    ) {
      onAdditionalVerificationPrompt?.();
    }
    finish(prompts.map(() => password));
  };
}

export interface NormalizeSSHConnectErrorOptions {
  established?: boolean;
  additionalVerificationPrompted?: boolean;
}

export function normalizeSSHConnectError(
  error: unknown,
  options: NormalizeSSHConnectErrorOptions = {},
): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    if (options.additionalVerificationPrompted) {
      // Bug 原因：只给认证失败文案会被上层误归为补密码；明确的额外验证必须带不可重试公开码。
      return Object.assign(
        new Error(
          "SSH 认证失败：服务器在密码之后还要求额外验证（例如动态口令），当前不支持，请改用私钥或 SSH agent 登录",
          { cause: error },
        ),
        {
          code: "remote-authentication-unsupported" satisfies PublicZCodeErrorCode,
          retryable: false,
        },
      );
    }
    return new Error("SSH 认证失败：请检查用户名、密码或私钥配置", { cause: error });
  }

  if (isHostKeyVerificationDeniedMessage(error instanceof Error ? error.message : String(error))) {
    return new Error(
      "SSH 主机密钥校验未通过，已拒绝连接。若服务器更换过主机密钥，请先清理本地 known_hosts 记录",
    );
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    if (options.established) {
      // Bug 原因：握手与 keepalive 共用 client-timeout，必须在断连清状态前按阶段区分。
      return new Error(
        `SSH 连接无响应：约 ${SSH_KEEPALIVE_TIMEOUT_MS / 1000} 秒没有收到服务器的心跳响应，连接已断开，请检查网络或服务器状态`,
        { cause: error },
      );
    }
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  if (error instanceof Error) {
    // ssh2 对不同私钥格式（OpenSSH 旧/新格式、PPK）会返回不同文案。
    // 之前仅匹配单一字符串，导致部分“缺少口令/口令错误”场景泄露底层错误文本，用户难以判断应输入哪种凭据。
    // 这里改为模式化归一化，把同类错误稳定映射成产品语义提示，便于用户直接修正输入。
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令");
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确");
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH 连接失败");
}
