import { createHmac, timingSafeEqual } from "node:crypto";
import { cursorSchema, idSchema } from "@pi-remote/protocol";

export type ListCursorKind = "projects" | "sessions";

export interface ListCursorPayload {
  kind: ListCursorKind;
  ownerId: string;
  scope: string;
  lastActivityAt: number;
  id: string;
}

export class InvalidCursorError extends Error {
  constructor(message = "invalid list cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function signature(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function encodeListCursor(payload: ListCursorPayload, secret: string): string {
  if (
    !Number.isSafeInteger(payload.lastActivityAt) ||
    payload.lastActivityAt < 0 ||
    !idSchema.safeParse(payload.ownerId).success ||
    !idSchema.safeParse(payload.id).success
  ) {
    throw new InvalidCursorError();
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return encoded + "." + signature(encoded, secret);
}

export function decodeListCursor(value: string, secret: string): ListCursorPayload {
  try {
    cursorSchema.parse(value);
  } catch {
    throw new InvalidCursorError();
  }
  const separator = value.lastIndexOf(".");
  if (separator <= 0) throw new InvalidCursorError();
  const encoded = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  const expected = signature(encoded, secret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new InvalidCursorError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) throw new InvalidCursorError();
  const candidate = decoded as Record<string, unknown>;
  if (
    (candidate.kind !== "projects" && candidate.kind !== "sessions") ||
    typeof candidate.ownerId !== "string" ||
    typeof candidate.scope !== "string" ||
    typeof candidate.id !== "string" ||
    typeof candidate.lastActivityAt !== "number" ||
    !Number.isSafeInteger(candidate.lastActivityAt) ||
    candidate.lastActivityAt < 0 ||
    !idSchema.safeParse(candidate.ownerId).success ||
    !idSchema.safeParse(candidate.id).success
  ) throw new InvalidCursorError();
  return {
    kind: candidate.kind,
    ownerId: candidate.ownerId,
    scope: candidate.scope,
    lastActivityAt: candidate.lastActivityAt,
    id: candidate.id
  };
}
