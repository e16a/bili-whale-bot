type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

export function canonicalBilibiliId(value: unknown) {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

const exactIdFields = new Set([
  "mid", "sender_uid", "receiver_id", "talker_id",
  "aid", "oid", "rpid", "root", "parent", "msg_key", "msg_seqno",
  "id", "subject_id", "source_id", "root_id",
]);

export function parseOwnerIdentityJson(text: string): unknown {
  // Read the original digits before converting a long ID to a JS number loses precision.
  return JSON.parse(text.replace(/^\uFEFF/, ""), (key, value: unknown, context?: { source: string }) => {
    if (typeof value === "number" && exactIdFields.has(key)) {
      return context?.source;
    }
    return value;
  });
}

export function createOwnerGuard(configuredMid: unknown) {
  const ownerMid = canonicalBilibiliId(configuredMid);
  if (ownerMid === undefined) throw new Error("invalid_owner_mid");

  // Use original event rows obtained by the host. Names and text are display data.
  return {
    isOwnerComment(reply: unknown) {
      const row = record(reply);
      const memberMid = canonicalBilibiliId(record(row?.member)?.mid);
      if (memberMid !== ownerMid) return false;
      return row?.mid === undefined || canonicalBilibiliId(row.mid) === ownerMid;
    },
    isOwnerDirectMessage(message: unknown) {
      return canonicalBilibiliId(record(message)?.sender_uid) === ownerMid;
    },
  };
}

export function videoCommentPosition(reply: unknown, aid: string) {
  const row = record(reply);
  if (!row || (row.type !== 1 && row.type !== "1") || canonicalBilibiliId(row.oid) !== aid) return;
  const rpid = canonicalBilibiliId(row.rpid);
  const root = row.root === 0 || row.root === "0" ? "0" : canonicalBilibiliId(row.root);
  const parent = row.parent === 0 || row.parent === "0" ? "0" : canonicalBilibiliId(row.parent);
  if (!rpid || !root || !parent || (root === "0") !== (parent === "0") ||
      root === rpid || parent === rpid) return;
  const ids = { oid: aid, rpid, root, parent };
  if (Object.entries(ids).some(([key, value]) => row[key + "_str"] !== undefined && row[key + "_str"] !== value)) return;
  return { rpid, root, parent };
}

export function videoCommentReplyTarget(aid: string, reply: unknown, threadRoot?: unknown) {
  const position = videoCommentPosition(reply, aid);
  if (!position) return;
  const { rpid, root } = position;
  if (root === "0") return { aid, root: rpid, parent: rpid };
  const thread = videoCommentPosition(threadRoot, aid);
  if (!thread || thread.rpid !== root || thread.root !== "0") return;
  return { aid, root, parent: rpid };
}

export function directMessageReplyReference(message: unknown, accountMid: string) {
  const row = record(message);
  if (!row || canonicalBilibiliId(row.receiver_id) !== accountMid ||
      (row.receiver_type !== 1 && row.receiver_type !== "1") ||
      (row.msg_type !== 1 && row.msg_type !== "1")) return;
  const key = canonicalBilibiliId(row.msg_key);
  const sequence = canonicalBilibiliId(row.msg_seqno);
  const messageKey = key ? "key:" + key : sequence ? "seq:" + sequence : undefined;
  if (messageKey) return { messageKey, sequence };
}
