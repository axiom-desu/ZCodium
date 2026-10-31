import { z } from "zod";

/** SourceServer 契约共用的非空字符串与时间戳；保持与上游同名 schema 的约束。 */
export const sourceServerNonEmptyStringSchema = z.string().trim().min(1);
export const sourceServerTimestampSchema = z.number().int().nonnegative();
