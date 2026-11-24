import { canonicalBilibiliId, parseOwnerIdentityJson } from "./bilibili-owner.ts";

type Message = Record<string, unknown>;

function parseMessageContent(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return parseOwnerIdentityJson(raw); } catch { return undefined; }
}

export function messageText(raw: unknown) {
  const parsed = parseMessageContent(raw);
  if (parsed && typeof parsed === "object" && "content" in parsed && typeof parsed.content === "string") {
    return parsed.content;
  }
}

export function isVisibleMessage(row: Message) {
  return (row.msg_status === 0 || row.msg_status === "0") && row.sys_cancel !== true;
}

export function withdrawnKeys(messages: readonly Message[]) {
  const keys = new Set<string>();
  for (const row of messages) {
    if (row.msg_type !== 5 && row.msg_type !== "5") continue;
    const cited = parseMessageContent(row.content);
    const fields = cited && typeof cited === "object" ? cited as Message : undefined;
    const plainKey = typeof row.content === "string" ? canonicalBilibiliId(row.content.trim()) : undefined;
    const key = plainKey ?? canonicalBilibiliId(fields?.msg_key_str ?? fields?.msg_key ?? cited);
    if (key) keys.add(key);
  }
  return keys;
}
