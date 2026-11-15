import { z } from "zod";

// 会话工具设计 0.8：ReadTopicResource 只读取当前任务已接纳话题快照里的资源索引项
// （A1、A2…），不读其他会话或未接纳的群消息，也不接受任何 URL/路径。
export const READ_TOPIC_RESOURCE_TOOL_NAME = "ReadTopicResource";

export const ReadTopicResourceInputSchema = z
  .object({
    inputId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Snapshot inputId from the topic resource index; selects only an admitted input in this task.",
      ),
    messageId: z
      .string()
      .min(1)
      .max(256)
      .describe("Message id of the resource in the topic resource index."),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Resource position inside that message, starting at zero. Defaults to 0."),
  })
  .strict();

export type ReadTopicResourceInput = z.infer<typeof ReadTopicResourceInputSchema>;

export const ReadTopicResourceInputJsonSchema = z.toJSONSchema(ReadTopicResourceInputSchema);

export const ReadTopicResourceOutputSchema = z
  .object({
    status: z.literal("success"),
    path: z.string().min(1),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
  })
  .strict();

export type ReadTopicResourceOutput = z.infer<typeof ReadTopicResourceOutputSchema>;

export const ReadTopicResourceOutputJsonSchema = z.toJSONSchema(ReadTopicResourceOutputSchema);
