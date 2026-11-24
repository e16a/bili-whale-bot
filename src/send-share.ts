import {
  createInteractionValidator,
  maxPublicCommentChars,
  validateShareBudget,
  type DryRunShareBudget,
  type InteractionCandidate,
  type InteractionDenial,
  type InteractionTarget,
} from "./interactions.ts";
import {
  InteractionLedgerBusy, withInteractionLedger, type LedgerEntry, type LedgerLocation, type SendOutcome,
} from "./ledger.ts";
import { canonicalBilibiliId } from "./bilibili-owner.ts";
import { dateInShanghai, nightDate } from "./shanghai-time.ts";

const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

export type InteractionRequest = {
  target: InteractionTarget;
  message: string;
  at_name_to_mid?: string;
};
type DispatchResult =
  | { status: "sent"; action: InteractionTarget["action"] }
  | { status: "unknown"; action: InteractionTarget["action"] }
  | { status: "planned"; target: InteractionTarget }
  | { status: "denied"; reason: InteractionDenial | "duplicate_operation" | "mention_unverified" | "message_too_long" }
  | { status: "stopped"; reason: "state_unavailable" | "ledger_busy" | "writes_paused" | "outside_window"
      | "session_invalid" | "captcha" | "platform_stop" };

function receiptOf(response: unknown, target: Extract<InteractionTarget, { action: "share_video" }>): SendOutcome {
  if (response && typeof response === "object") {
    const { status, reason, receipt, mentionMid } = response as Record<string, unknown>;
    if (status === "stopped" &&
        (reason === "session_invalid" || reason === "captcha" || reason === "platform_stop" || reason === "outside_window")) {
      return { status, reason };
    }
    const id = canonicalBilibiliId(receipt);
    if (status === "sent" && id &&
        canonicalBilibiliId(mentionMid) === target.mentionMid) {
      return { status, receipt: id };
    }
  }
  return { status: "unknown", reason: "receipt_unverified" };
}

export function ownerMention(profile: unknown, expectedMid: string) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return;
  const { mid, name } = profile as Record<string, unknown>;
  if (canonicalBilibiliId(mid) !== expectedMid || typeof name !== "string" || !name || !name.isWellFormed() ||
      /[@\s\p{Cc}\p{Cf}]/u.test(name.normalize("NFKC"))) return;
  // The API field uses JSON numbers. Keep the validated UID's original decimal digits.
  return { prefix: `@${name} `, mapping: "{" + JSON.stringify(name) + ":" + expectedMid + "}" };
}

type DispatchOptions = {
  ledger: LedgerLocation;
  runId: string;
  sources: ReadonlyMap<string, InteractionCandidate>;
  share: Omit<DryRunShareBudget, "alreadyUsed">;
  resolveOwnerByMid: (mid: string) => Promise<unknown>;
  clock?: () => Date;
};

export function createShareDispatcher({
  ledger: configuredLedger, runId, sources, share, resolveOwnerByMid, deliver,
  clock = () => new Date(),
}: DispatchOptions & { deliver: (request: InteractionRequest) => Promise<unknown> }) {
  const ledger = { ...configuredLedger };
  const validate = createInteractionValidator({ ...ledger, sources, share });
  const historicallyShared = validateShareBudget(share);
  const { effectiveLimit } = share;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error("invalid_interaction_run_id");

  return async (proposal: unknown, preview = false): Promise<DispatchResult> => {
    const decision = validate(proposal);
    if (decision.status === "denied") return decision;
    const { target, text } = decision;
    if (target.action !== "share_video") return { status: "denied", reason: "action_not_allowed" };
    const now = clock();
    const night = nightDate(now);
    if ((!night && !preview) || !Number.isFinite(now.getTime())) return { status: "stopped", reason: "outside_window" };
    const date = night ?? dateInShanghai(now);
    const id = `share:${date}:${target.aid}`;
    if (text.length > maxPublicCommentChars) return { status: "denied", reason: "message_too_long" };

    try {
      return await withInteractionLedger(ledger, async (entries, persist): Promise<DispatchResult> => {
        if (entries.some(entry => entry.id === id)) return { status: "denied", reason: "duplicate_operation" };
        const today = entries.filter(entry => entry.date === date);
        if (today.some(entry => entry.status !== "sent")) return { status: "stopped", reason: "writes_paused" };
        if (!preview && nightDate(clock()) !== date) return { status: "stopped", reason: "outside_window" };

        const sendingAt = clock().getTime();
        if (historicallyShared.has(target.aid) || entries.some(entry => entry.target.aid === target.aid &&
            (entry.status === "unknown" || sendingAt - Date.parse(entry.reservedAt) < sevenDaysMs))) {
          return { status: "denied", reason: "recent_share" };
        }
        if (today.length >= effectiveLimit) return { status: "denied", reason: "share_limit" };
        const mention = ownerMention(await resolveOwnerByMid(target.mentionMid).catch(() => undefined), target.mentionMid);
        if (!mention) return { status: "denied", reason: "mention_unverified" };
        const request: InteractionRequest = { target: { ...target }, message: mention.prefix + text, at_name_to_mid: mention.mapping };
        if (preview) return { status: "planned", target };

        const reservedAt = clock();
        if (nightDate(reservedAt) !== date) return { status: "stopped", reason: "outside_window" };
        const reservation: LedgerEntry = {
          id, date, runId, target, reservedAt: reservedAt.toISOString(), status: "unknown", reason: "reserved",
        };
        await persist([...entries, reservation]);

        let outcome: SendOutcome;
        try {
          if (nightDate(clock()) === date) {
            outcome = receiptOf(await deliver(request), target);
          } else {
            outcome = { status: "stopped", reason: "outside_window" };
          }
        } catch {
          // Transport errors may occur after the remote operation took effect.
          outcome = { status: "unknown", reason: "transport_error" };
        }
        const { status: _status, reason: _reason, ...reference } = reservation;
        try {
          await persist([...entries, { ...reference, ...outcome }]);
        } catch {
          return { status: "unknown", action: target.action };
        }
        if (outcome.status === "stopped") return { status: "stopped", reason: outcome.reason };
        return { status: outcome.status === "sent" ? "sent" : "unknown", action: target.action };
      });
    } catch (error) {
      return { status: "stopped", reason: error instanceof InteractionLedgerBusy ? "ledger_busy" : "state_unavailable" };
    }
  };
}
