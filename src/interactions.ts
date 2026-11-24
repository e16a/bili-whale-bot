import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import {
  canonicalBilibiliId, createOwnerGuard, directMessageReplyReference, videoCommentReplyTarget,
} from "./bilibili-owner.ts";
import { isBilibiliVideoId } from "./bilibili-read.ts";

const actions = ["share_video", "reply_comment", "reply_dm"] as const;
type Action = typeof actions[number];
export const minShareScore = 13;
export const maxPublicCommentChars = 80;
const maxDailyShares = 3;
const handles = /^[A-Za-z0-9_-]{1,64}$/;
type RecordObject = Record<string, unknown>;

type ShareCandidate = {
  action: "share_video";
  aid: unknown;
  bvid: string;
  readCompleted: boolean;
  assessment: { score: number; reason: string; rank: number };
  aiReview?: "allow" | "block" | "uncertain";
};
type CommentCandidate = {
  action: "reply_comment";
  aid: unknown;
  reply: unknown;
  threadRoot?: unknown;
};
type DirectMessageCandidate = {
  action: "reply_dm";
  talkerId: unknown;
  sessionType: unknown;
  message: unknown;
  withdrawn: boolean;
};
export type InteractionCandidate = ShareCandidate | CommentCandidate | DirectMessageCandidate;

type SharePolicy = {
  enabled: boolean;
  minScore: number;
  aiCommentGuard: boolean;
};

export type DryRunShareBudget = SharePolicy & {
  effectiveLimit: number;
  alreadyUsed: number;
  sharedInLastSevenDays: readonly string[];
};

export type InteractionTarget =
  | { action: "share_video"; aid: string; bvid: string; mentionMid: string }
  | { action: "reply_comment"; aid: string; root: string; parent: string; recipientMid: string }
  | { action: "reply_dm"; messageKey: string; sequence?: string; recipientMid: string };
export type InteractionDenial = "invalid_proposal" | "action_not_allowed" | "unverified_source" | "owner_only"
  | "source_mismatch" | "extra_mention" | "video_not_read" | "share_ineligible"
  | "share_ai_review" | "share_limit" | "recent_share" | "duplicate_plan";
type Decision = { status: "denied"; reason: InteractionDenial } | { status: "planned"; target: InteractionTarget };
type SourceDecision = { status: "denied"; reason: InteractionDenial }
  | { status: "planned"; target: InteractionTarget };
type InteractionOptions = {
  ownerMid: unknown;
  accountMid: unknown;
  sources: ReadonlyMap<string, InteractionCandidate>;
};
type ToolDecision = Decision
  | { status: "simulated_sent" | "unknown"; action: Action }
  | { status: "denied" | "stopped"; reason: string };

function record(value: unknown): RecordObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordObject : undefined;
}

function rejected(reason: InteractionDenial) {
  return { status: "denied" as const, reason };
}

function isAction(value: unknown): value is Action {
  return actions.some(action => action === value);
}

// Adapted from bili-whale 0.4.6 share-policy.mjs (MIT, see licenses/).
function isEligibleShare(assessment: ShareCandidate["assessment"], policy: SharePolicy) {
  const { score, reason, rank } = assessment;
  return policy.enabled === true && typeof reason === "string" && reason.trim().length >= 8 &&
    Number.isFinite(score) && score >= policy.minScore && score >= 0 && score <= 20 && rank === 1;
}

// Adapted from bili-whale 0.4.6 quota.mjs (MIT, see licenses/).
export function effectiveDailyShareLimit(now: Date, lastOwnerAt: number | undefined, firstShareAt: number | undefined) {
  const baseline = lastOwnerAt === undefined ? firstShareAt : lastOwnerAt * 1000;
  const days = baseline === undefined ? 0 : Math.floor((now.getTime() - baseline) / 86_400_000);
  if (days < 3) return maxDailyShares;
  if (days >= 7) return 0;
  return Math.max(1, Math.floor(maxDailyShares * (7 - days) / (7 - 3)));
}

export function validateShareBudget(budget: Omit<DryRunShareBudget, "alreadyUsed">) {
  const { effectiveLimit, sharedInLastSevenDays } = budget;
  const recentlyShared = new Set(sharedInLastSevenDays);
  if (!Number.isInteger(effectiveLimit) || effectiveLimit < 0 || effectiveLimit > maxDailyShares ||
      [...recentlyShared].some(aid => canonicalBilibiliId(aid) !== aid)) throw new Error("invalid_dry_run_share_state");
  return recentlyShared;
}

export function createInteractionValidator({
  ownerMid: configuredOwner, accountMid: configuredAccount, sources, share: configuredShare,
}: InteractionOptions & { share: SharePolicy }) {
  const ownerMid = canonicalBilibiliId(configuredOwner);
  const accountMid = canonicalBilibiliId(configuredAccount);
  if (!ownerMid || !accountMid || accountMid === ownerMid) throw new Error("invalid_interaction_identity");
  const share = { ...configuredShare };
  if (!Number.isFinite(share.minScore) || share.minScore < 0 || share.minScore > 20 ||
      typeof share.enabled !== "boolean" || typeof share.aiCommentGuard !== "boolean") {
    throw new Error("invalid_dry_run_share_state");
  }
  const guard = createOwnerGuard(ownerMid);
  const known = new Map(sources);

  const checkSource = (source: InteractionCandidate): SourceDecision => {
    switch (source.action) {
      case "share_video": {
        const aid = canonicalBilibiliId(source.aid);
        if (!aid || !isBilibiliVideoId(source.bvid)) return rejected("source_mismatch");
        if (source.readCompleted !== true) return rejected("video_not_read");
        if (!isEligibleShare(source.assessment, share)) return rejected("share_ineligible");
        if (share.aiCommentGuard && source.aiReview !== "allow") return rejected("share_ai_review");
        return { status: "planned", target: { action: source.action, aid, bvid: source.bvid, mentionMid: ownerMid } };
      }
      case "reply_comment": {
        if (!guard.isOwnerComment(source.reply)) return rejected("owner_only");
        const aid = canonicalBilibiliId(source.aid);
        const coordinates = aid && videoCommentReplyTarget(aid, source.reply, source.threadRoot);
        if (!coordinates) return rejected("source_mismatch");
        return { status: "planned", target: { action: source.action, ...coordinates, recipientMid: ownerMid } };
      }
      case "reply_dm": {
        if (!guard.isOwnerDirectMessage(source.message)) return rejected("owner_only");
        const reference = directMessageReplyReference(source.message, accountMid);
        if (canonicalBilibiliId(source.talkerId) !== ownerMid ||
            (source.sessionType !== 1 && source.sessionType !== "1") ||
            source.withdrawn !== false || !reference) return rejected("source_mismatch");
        return { status: "planned", target: { action: source.action, ...reference, recipientMid: ownerMid } };
      }
    }
  };

  // Sources and counters are host inputs. Model proposals supply a handle and plain text only.
  return (proposal: unknown) => {
    const row = record(proposal);
    if (!row || Object.keys(row).length !== 3 ||
        !["action", "target", "text"].every(key => Object.hasOwn(row, key))) return rejected("invalid_proposal");
    const { action, target: handle, text } = row;
    if (!isAction(action)) return rejected("action_not_allowed");
    if (typeof handle !== "string" || !handles.test(handle) || typeof text !== "string" ||
        !text.trim()) return rejected("invalid_proposal");
    if (action !== "reply_dm" && text.normalize("NFKC").includes("@")) return rejected("extra_mention");

    const source = known.get(handle);
    if (!source || source.action !== action) return rejected("unverified_source");
    const decision = checkSource(source);
    return decision.status === "planned" ? { ...decision, text } : decision;
  };
}

export function createInteractionDryRun(options: InteractionOptions & { share: DryRunShareBudget }) {
  const validate = createInteractionValidator(options);
  const recentlyShared = validateShareBudget(options.share);
  const { effectiveLimit, alreadyUsed } = options.share;
  if (!Number.isInteger(alreadyUsed) || alreadyUsed < 0) throw new Error("invalid_dry_run_share_state");
  const planned = new Set<string>();
  let used = alreadyUsed;

  return (proposal: unknown): Decision => {
    const decision = validate(proposal);
    if (decision.status === "denied") return decision;
    const { target } = decision;
    if (target.action === "share_video" && recentlyShared.has(target.aid)) return rejected("recent_share");
    const key = target.action === "share_video" ? "video:" + target.aid
      : target.action === "reply_comment" ? "comment:" + target.parent
        : "dm:" + target.messageKey;
    const sequenceKey = target.action === "reply_dm" && target.sequence ? "dm:seq:" + target.sequence : undefined;
    if (planned.has(key) || (sequenceKey && planned.has(sequenceKey))) return rejected("duplicate_plan");
    if (target.action === "share_video") {
      if (used >= effectiveLimit) return rejected("share_limit");
      used += 1;
    }
    planned.add(key);
    if (sequenceKey) planned.add(sequenceKey);
    return { status: "planned", target };
  };
}

const parameters = obj({
  action: oneOf([...actions]),
  target: str({ minLength: 1, maxLength: 64 }),
  text: str({ minLength: 1 }),
});

export function createDryRunInteractionTool(
  plan: (proposal: unknown) => ToolDecision | Promise<ToolDecision>,
): AgentTool<typeof parameters> {
  return {
    name: "plan_interaction",
    label: "模拟互动决策",
    description: "检查指定的候选互动，返回模拟结果。target 使用宿主给出的候选编号。",
    parameters,
    execute: async (_callId, args) => {
      const decision = await plan(args);
      const result = decision.status === "planned" ? { status: "planned", action: decision.target.action } : decision;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  };
}
