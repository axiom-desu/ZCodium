import { constants } from "node:os";
import { Emitter, type Event } from "@zcode/rpc";

interface CloseEventController {
  event: Event<number>;
  fire(code: number): void;
}

export function createCloseEventController(): CloseEventController {
  const emitter = new Emitter<number>();
  let closed = false;
  let closeCode = 0;

  const event: Event<number> = (listener) => {
    // 远端命令可能在调用方订阅 onClose 之前就瞬间退出。
    // 如果事件只做“在线分发”不做补发，waitForClose 会永远等不到，表现为连接卡住。
    // 这里对晚订阅者补发最后一次 close code，避免竞态丢事件。
    if (closed) {
      queueMicrotask(() => {
        listener(closeCode);
      });
      return { dispose() {} };
    }

    return emitter.event(listener);
  };

  const fire = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    closeCode = code;
    emitter.fire(code);
    emitter.dispose();
  };

  return { event, fire };
}

/**
 * Bug 原因：code ?? 0 把 signal 终止、SSH 缺少 exit-status 的命令误报成功。
 * 依 shell 约定保留数字退出码、映射 signal；没有可用状态时返回 OpenSSH 的失败码 255。
 */
export function resolveRemoteExitCode(
  code: number | null | undefined,
  signal: string | null | undefined,
): number {
  if (typeof code === "number") return code;
  const signalNumber = signal
    ? constants.signals[signal as keyof typeof constants.signals]
    : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : 255;
}
