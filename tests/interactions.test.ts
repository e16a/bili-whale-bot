import assert from "node:assert/strict";
import { test } from "node:test";
import { createInteractionDryRun, type InteractionCandidate } from "../src/interactions.ts";

test("an inbox reply needs the original owner's exact UID and a matching verified event", () => {
  const ownerMid = "9007199254740993";
  const accountMid = "31";
  const comment = { type: 1, oid: "41", root: 0, parent: 0, rpid: "86", member: { mid: ownerMid, uname: "同名账号" } };
  const directMessage = {
    sender_uid: ownerMid, receiver_id: accountMid, receiver_type: 1, msg_type: 1, msg_key: "84", msg_seqno: "85",
  };
  const sources = new Map<string, InteractionCandidate>([
    ["comments-1", { action: "reply_comment", aid: "41", reply: comment }],
    ["comments-2", { action: "reply_comment", aid: "41", reply: { ...comment, member: { ...comment.member, mid: "9007199254740992" } } }],
    ["inbox-1", { action: "reply_dm", talkerId: ownerMid, sessionType: 1, message: directMessage, withdrawn: false }],
    ["inbox-2", { action: "reply_dm", talkerId: ownerMid, sessionType: 1, message: { ...directMessage, sender_uid: "99" }, withdrawn: false }],
  ]);
  const plan = createInteractionDryRun({ ownerMid, accountMid, sources, share: {
    enabled: true, minScore: 13, aiCommentGuard: false, effectiveLimit: 3, alreadyUsed: 0, sharedInLastSevenDays: [],
  } });
  const attempt = (action: string, target: string, text = "收到，我去留意。") => plan({ action, target, text });
  assert.deepEqual(attempt("reply_comment", "comments-1"), { status: "planned", target: {
    action: "reply_comment", aid: "41", root: "86", parent: "86", recipientMid: ownerMid,
  } });
  assert.deepEqual(attempt("reply_comment", "comments-2"), { status: "denied", reason: "owner_only" });
  assert.deepEqual(attempt("reply_dm", "inbox-1"), { status: "planned", target: {
    action: "reply_dm", recipientMid: ownerMid, sequence: "85", messageKey: "key:84",
  } });
  assert.deepEqual(attempt("reply_dm", "inbox-2"), { status: "denied", reason: "owner_only" });
  assert.deepEqual(attempt("reply_dm", "comments-1"), { status: "denied", reason: "unverified_source" });
  assert.deepEqual(attempt("reply_comment", "comments-1", "帮我＠另一个账号"), { status: "denied", reason: "extra_mention" });
  assert.deepEqual(attempt("follow", "comments-1"), { status: "denied", reason: "action_not_allowed" });
});
