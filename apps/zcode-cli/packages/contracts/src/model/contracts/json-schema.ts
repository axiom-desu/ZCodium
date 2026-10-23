import { JsonSchema, ModelFailureReason, ModelTransportKind } from "./request-contracts.js";

export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

const attachmentRefJsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { enum: ["local_file", "resource", "inline"] },
    uri: { type: "string" },
    path: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    placeholder: { type: "string" },
  },
} satisfies JsonSchema;

const modelMessageContentBlockJsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["text"] },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["reasoning"] },
        text: { type: "string" },
        providerOptions: { type: "object" },
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["image"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        detail: { enum: ["auto", "low", "high", "original"] },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["video"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType"],
      additionalProperties: false,
      properties: {
        type: { enum: ["file"] },
        mediaType: { type: "string", minLength: 1 },
        name: { type: "string" },
        uri: { type: "string" },
        dataUrl: { type: "string" },
        text: { type: "string" },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "uri"],
      additionalProperties: false,
      properties: {
        type: { enum: ["resource_link"] },
        uri: { type: "string", minLength: 1 },
        name: { type: "string" },
        title: { type: "string" },
      },
    },
  ],
} satisfies JsonSchema;

const modelMessageContentJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "array",
      items: modelMessageContentBlockJsonSchema,
    },
  ],
} satisfies JsonSchema;

export const modelInputMessageJsonSchema = {
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant", "tool"] },
    content: modelMessageContentJsonSchema,
    cacheControl: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["ephemeral"] },
        ttl: { enum: ["5m", "1h"] },
        scope: { enum: ["global", "org"] },
      },
    },
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
    toolName: { type: "string" },
    isError: { type: "boolean" },
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
  },
} satisfies JsonSchema;

const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
  ],
} satisfies JsonSchema;

export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;

export const modelNetworkStatusEventJsonSchema = {
  type: "object",
  required: [
    "type",
    "timestamp",
    "traceId",
    "requestId",
    "model",
    "transport",
    "attempt",
    "maxAttempts",
  ],
  additionalProperties: true,
  properties: {
    type: {
      enum: [
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
        "model_retry_scheduled",
        "model_stream_stalled",
      ],
    },
    timestamp: { type: "string", minLength: 1 },
    traceId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    turnId: { type: "string", minLength: 1 },
    querySource: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    model: modelSelectionJsonSchema,
    transport: { enum: Object.values(ModelTransportKind) },
    attempt: { type: "number", minimum: 1 },
    // 0 = 无上限重试预算，故下界是 0 而不是 1。
    maxAttempts: { type: "number", minimum: 0 },
    delayMs: { type: "number", minimum: 0 },
    durationMs: { type: "number", minimum: 0 },
    idleMs: { type: "number", minimum: 0 },
    nextAttempt: { type: "number", minimum: 1 },
    reason: { enum: Object.values(ModelFailureReason) },
    retryable: { type: "boolean" },
    message: { type: "string" },
    statusCode: { type: "number" },
    requestHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    responseHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    requestHeaderCount: { type: "number", minimum: 0 },
    responseHeaderCount: { type: "number", minimum: 0 },
    streamRecovery: {
      type: "object",
      required: ["attemptId", "retryNumber", "maxRetries"],
      additionalProperties: false,
      properties: {
        attemptId: { type: "string", minLength: 1 },
        retryNumber: { type: "number", minimum: 1 },
        maxRetries: { type: "number", minimum: 0 },
        recoveredFromRequestId: { type: "string", minLength: 1 },
        anchorId: { type: "string", minLength: 1 },
      },
    },
    timeoutMs: { type: "number", minimum: 0 },
  },
} satisfies JsonSchema;

// Re-export for backwards compatibility with code using ToolCall
