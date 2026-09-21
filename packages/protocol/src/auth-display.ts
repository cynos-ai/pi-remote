import { z } from "zod";
import { idSchema } from "./common.js";

// Ephemeral HTTPS response only. Never include this DTO in events or snapshots.
const linkSchema = z.object({ url: z.string().max(8192).url().refine(url => /^https?:\/\//i.test(url)), label: z.string().max(1024) }).strict();
export const authDisplaySchema = z.object({
  operationId: idSchema,
  title: z.string().max(120),
  message: z.string().max(32768).optional(),
  links: z.array(linkSchema).max(16),
  userCode: z.string().max(1024).optional(),
  prompt: z.object({
    interactionId: idSchema,
    message: z.string().max(32768),
    options: z.array(z.object({ id: z.string().max(32768), label: z.string().max(32768) }).strict()).max(256).optional()
  }).strict().optional()
}).strict();
export type AuthDisplay = z.infer<typeof authDisplaySchema>;
export const authDisplaysResponseSchema = z.object({ items: z.array(authDisplaySchema) }).strict();
