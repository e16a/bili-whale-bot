import { setTimeout as sleep } from "node:timers/promises";
import { ownerMention, type InteractionRequest } from "./send-share.ts";
import { canonicalBilibiliId, createOwnerGuard, videoCommentPosition } from "./bilibili-owner.ts";
import { bilibiliWriteEndpoints } from "./bilibili-post-once.ts";
import {
  apiData, commentPageUrl, findCommentSource, getJson, isBilibiliVideoId, type loadBilibiliSession,
  ProbeError, requestBilibiliJson, requestGapMs, signWbiUrl,
} from "./bilibili-read.ts";
import { nightDate } from "./shanghai-time.ts";

type Options = {
  accountMid: string;
  ownerMid: string;
  account: Record<string, unknown>;
  ownerProfile: unknown;
  credentials: Awaited<ReturnType<typeof loadBilibiliSession>>;
  // The caller supplies a one-shot POST transport. This module has no live entry point.
  postOnce: typeof fetch;
  read: typeof fetch;
  clock?: () => Date;
  wait?: (ms: number) => Promise<unknown>;
};

const unknownReceipt = { status: "unknown" } as const;

export function createBilibiliShareDelivery({
  accountMid, ownerMid, account, ownerProfile, credentials, postOnce, read,
  clock = () => new Date(), wait = ms => sleep(ms),
}: Options) {
  const mention = ownerMention(ownerProfile, ownerMid);
  const author = createOwnerGuard(accountMid);
  const { session, csrf, deviceCookie } = credentials;

  return async ({ target, message, at_name_to_mid }: InteractionRequest) => {
    const now = clock();
    const date = nightDate(now);
    if (!date) return { status: "stopped", reason: "outside_window" } as const;
    if (account.isLogin !== true || canonicalBilibiliId(account.mid) !== accountMid || !session || !csrf ||
        !/^[0-9a-f]{32}$/i.test(csrf)) return { status: "stopped", reason: "session_invalid" } as const;
    if (!mention || accountMid === ownerMid || target.action !== "share_video" || target.mentionMid !== ownerMid ||
        canonicalBilibiliId(target.aid) !== target.aid || !isBilibiliVideoId(target.bvid) ||
        at_name_to_mid !== mention.mapping || !message.isWellFormed() || message.length > 1000 ||
        !message.startsWith(mention.prefix)) return unknownReceipt;
    const text = message.slice(mention.prefix.length);
    if (!text.trim() || text.normalize("NFKC").includes("@")) return unknownReceipt;

    // Form fields adapted from bili-whale 0.4.6 tools/commands/comment.mjs (MIT, see licenses/).
    const body = new URLSearchParams({
      type: "1", oid: target.aid, message, plat: "1", csrf, at_name_to_mid,
    });
    const url = signWbiUrl(new URL(bilibiliWriteEndpoints.share_video), account, Math.round(now.getTime() / 1000), body);
    const cookie = "SESSDATA=" + session + "; bili_jct=" + csrf + (deviceCookie ? "; buvid3=" + deviceCookie : "");
    let posted;
    try {
      posted = apiData(await requestBilibiliJson(url, {
        method: "POST", body: body.toString(), headers: {
          accept: "application/json", "content-type": "application/x-www-form-urlencoded", cookie,
          origin: "https://www.bilibili.com", referer: `https://www.bilibili.com/video/${target.bvid}/`,
        },
      }, postOnce));
    } catch (error) {
      if (!(error instanceof ProbeError)) throw error;
      if (error.apiCode === 12015) return { status: "stopped", reason: "captcha" } as const;
      if (error.reason === "session_invalid" || error.apiCode === -111) {
        return { status: "stopped", reason: "session_invalid" } as const;
      }
      if (error.reason === "platform_stop") return { status: "stopped", reason: "platform_stop" } as const;
      throw error;
    }
    if (posted.need_captcha === true) return { status: "stopped", reason: "captcha" } as const;
    const receipt = canonicalBilibiliId(posted.rpid);
    if (!receipt || receipt.length > 20 || (posted.rpid_str !== undefined && posted.rpid_str !== receipt)) return unknownReceipt;

    await wait(requestGapMs);
    const readAt = clock();
    if (nightDate(readAt) !== date) return unknownReceipt;
    const found = await findCommentSource(target.aid, receipt, async root => {
      if (root === undefined) return apiData(await getJson(commentPageUrl(account, target.aid, receipt, readAt), read, session));
    });
    if (found.status !== "found" || found.threadRoot !== undefined || !author.isOwnerComment(found.reply) ||
        videoCommentPosition(found.reply, target.aid)?.root !== "0") return unknownReceipt;
    const content = found.reply.content as { message?: unknown; members?: { mid?: unknown }[] } | undefined;
    if (content?.message !== message || !Array.isArray(content.members) || content.members.length !== 1 ||
        canonicalBilibiliId(content.members[0]?.mid) !== ownerMid) return unknownReceipt;
    return { status: "sent", receipt, mentionMid: ownerMid } as const;
  };
}
