import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
export type NoProgressHintKind = "same_call" | "no_progress" | "call_volume";
export interface NoProgressHint {
    kind: NoProgressHintKind;
    count: number;
    text: string;
}
export declare function createNoProgressGuard(): {
    observe({ requestMeta, code, result }: {
        requestMeta: NodeReplRequestMeta;
        code: string;
        result: CallToolResult;
    }): NoProgressHint | undefined;
};
//# sourceMappingURL=no-progress-guard.d.ts.map