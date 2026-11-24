import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { effectiveDailyShareLimit, maxPublicCommentChars, minShareScore, type InteractionCandidate } from "./interactions.ts";
import { InteractionLedgerBusy, withInteractionLedger } from "./ledger.ts";
import { createShareDispatcher, ownerMention } from "./send-share.ts";
import { canonicalBilibiliId } from "./bilibili-owner.ts";
import { createBilibiliPostOnce } from "./bilibili-post-once.ts";
import {
  apiData, getJson, isBilibiliVideoId, loadBilibiliSession, maxVideosPerDay, ProbeError, readLocalBilibiliFile,
  requestBilibiliJson, requestGapMs, signWbiUrl,
} from "./bilibili-read.ts";
import { createBilibiliShareDelivery } from "./bilibili-share-delivery.ts";
import type { BotHome } from "./home.ts";
import { checkNightStateDirectory } from "./night-state.ts";
import { dateInShanghai, nightDate } from "./shanghai-time.ts";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const approvalFormat = /^[0-9a-f]{64}$/;
const apiOrigin = "https://api.bilibili.com";
const postShareOnce = createBilibiliPostOnce("share_video");

function row(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rating(value: unknown) {
  const { bvid, score, dimensions } = row(value) ?? {};
  if (typeof bvid !== "string" || !isBilibiliVideoId(bvid) || typeof score !== "number" ||
      !Array.isArray(dimensions) || dimensions.length !== 5 ||
      !dimensions.every(n => Number.isInteger(n) && n >= 0 && n <= 4) ||
      dimensions.reduce((total, n) => total + n, 0) !== score) return;
  return { bvid, score };
}

async function readShareDraft(state: string, date: string, ownerMid: string) {
  const directory = join(state, `night-${date}`);
  await checkNightStateDirectory(directory);
  const read = async (name: "run.json" | "drafts.json") => row(JSON.parse(await readLocalBilibiliFile(join(directory, name), 64_000)));
  const [run, file] = await Promise.all([read("run.json"), read("drafts.json")]);
  if (run?.date !== date || run.runId !== `night-${date}` || run.mode !== "bili-whale-night" ||
      run.status !== "completed" || run.bilibiliWrites !== 0 || !Array.isArray(run.ratings) || !Array.isArray(run.videoReads) ||
      file?.date !== date || !Array.isArray(file.drafts) || file.drafts.length !== run.interactionDrafts) return;
  const shares = file.drafts.map(row).filter(draft => row(draft?.target)?.action === "share_video");
  const [draft] = shares;
  const { bvid, aid, mentionMid } = row(draft?.target) ?? {};
  const text = draft?.text;
  const assessment = row(draft?.assessment);
  if (shares.length !== 1 || draft?.status !== "planned" || mentionMid !== ownerMid ||
      typeof bvid !== "string" || !isBilibiliVideoId(bvid) || typeof aid !== "string" || canonicalBilibiliId(aid) !== aid ||
      typeof text !== "string" || !text.trim() || text.length > maxPublicCommentChars ||
      !text.isWellFormed() || text.normalize("NFKC").includes("@")) return;

  const ranked = run.ratings.map(rating).filter(entry => entry !== undefined).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || ranked.length !== run.ratings.length || ranked.length > maxVideosPerDay ||
      new Set(ranked.map(entry => entry.bvid)).size !== ranked.length || best.bvid !== bvid || best.score < minShareScore) return;
  const reads = run.videoReads.map(row).filter(video => video?.bvid === bvid);
  const slot = reads[0]?.slot;
  if (reads.length !== 1 || reads[0]?.status !== "completed" || typeof slot !== "number" ||
      !Number.isInteger(slot) || slot < 1 || slot > maxVideosPerDay) return;
  if (assessment?.score !== best.score || typeof assessment.reason !== "string" ||
      assessment.reason.trim().length < 8 || assessment.reason.length > 400) return;
  return { bvid, aid, text, score: best.score, reason: assessment.reason };
}

export async function runBilibiliShareTrial({
  home, credentialsPath, draftDate, transport = fetch, submission, clock = () => new Date(), wait = ms => sleep(ms),
}: {
  home: BotHome;
  credentialsPath: string;
  draftDate: string;
  transport?: typeof fetch;
  submission?: { approvalCode: string; transport?: typeof fetch };
  clock?: () => Date;
  wait?: (ms: number) => Promise<unknown>;
}) {
  let reads = 0;
  let writes = 0;
  const finish = <T>(result: T) => ({ mode: "bilibili-share-trial", reads, writes, ...result });
  try {
    const now = clock();
    const date = dateInShanghai(now);
    const sourceDate = new Date(draftDate + "T00:00:00Z");
    if (!datePattern.test(draftDate) || !Number.isFinite(sourceDate.getTime()) ||
        sourceDate.toISOString().slice(0, 10) !== draftDate || draftDate > date) {
      return finish({ status: "denied", reason: "invalid_draft_date" });
    }
    if (submission && !approvalFormat.test(submission.approvalCode)) return finish({ status: "denied", reason: "approval_mismatch" });
    if (submission && !nightDate(now)) return finish({ status: "stopped", reason: "outside_window" });

    const ledger = { directory: home.state, ...home.ids };
    const draft = await readShareDraft(home.state, draftDate, ledger.ownerMid).catch(() => undefined);
    if (!draft) return finish({ status: "denied", reason: "draft_unverified" });
    const firstShareAt = await withInteractionLedger(ledger, async entries => {
      const first = entries.find(entry => entry.target.action === "share_video" && entry.status === "sent");
      return first && Date.parse(first.reservedAt);
    });
    const effectiveLimit = Math.min(1, effectiveDailyShareLimit(now, undefined, firstShareAt));
    const credentials = await loadBilibiliSession(credentialsPath);
    const { session, csrf, deviceCookie } = credentials;
    if (!csrf || !/^[0-9a-f]{32}$/i.test(csrf)) return finish({ status: "stopped", reason: "credentials_invalid" });
    if (Object.values(credentials).some(value => value && draft.text.includes(value))) {
      return finish({ status: "denied", reason: "draft_unverified" });
    }

    const read: typeof fetch = (url, init) => {
      if (dateInShanghai(clock()) !== date) throw new ProbeError("date_changed");
      reads += 1;
      return transport(url, init);
    };
    const account = apiData(await getJson(new URL("/x/web-interface/nav", apiOrigin), read, session));
    if (account.isLogin !== true) throw new ProbeError("session_invalid");
    if (canonicalBilibiliId(account.mid) !== ledger.accountMid) throw new ProbeError("account_mismatch");
    await wait(requestGapMs);
    const profileUrl = new URL("/x/space/wbi/acc/info", apiOrigin);
    profileUrl.searchParams.set("mid", ledger.ownerMid);
    signWbiUrl(profileUrl, account, Math.floor(clock().getTime() / 1000));
    const cookie = `SESSDATA=${session}; bili_jct=${csrf}` + (deviceCookie ? `; buvid3=${deviceCookie}` : "");
    const profile = apiData(await requestBilibiliJson(profileUrl, {
      method: "GET", headers: { accept: "application/json", cookie, referer: "https://space.bilibili.com/" },
    }, read));
    const mention = ownerMention(profile, ledger.ownerMid);
    if (!mention) return finish({ status: "denied", reason: "mention_unverified" });
    const message = mention.prefix + draft.text;
    const approvalCode = createHash("sha256").update(JSON.stringify([
      "bili-whale-share-v1", date, draftDate, ledger.accountMid, ledger.ownerMid,
      draft.bvid, draft.aid, message, mention.mapping,
    ])).digest("hex");
    if (submission && submission.approvalCode !== approvalCode) return finish({ status: "denied", reason: "approval_mismatch" });

    const sources = new Map<string, InteractionCandidate>([[draft.bvid, {
      action: "share_video", aid: draft.aid, bvid: draft.bvid, readCompleted: true,
      assessment: { score: draft.score, reason: draft.reason, rank: 1 },
    }]]);
    const delivery = createBilibiliShareDelivery({
      ...ledger, account, ownerProfile: profile, credentials, clock, wait, read,
      postOnce: (url, init) => {
        if (!submission || writes !== 0 || nightDate(clock()) !== date) throw new Error("invalid_share_trial_post");
        writes += 1;
        return (submission.transport ?? postShareOnce)(url, init);
      },
    });
    let receipt: string | undefined;
    const dispatch = createShareDispatcher({
      ledger, runId: `share-trial-${draftDate}`, sources, clock,
      share: { enabled: true, minScore: minShareScore, aiCommentGuard: false, effectiveLimit, sharedInLastSevenDays: [] },
      resolveOwnerByMid: async mid => mid === ledger.ownerMid ? profile : undefined,
      deliver: async request => {
        if (!submission || request.message !== message) throw new Error("invalid_share_trial_dispatch");
        const result = await delivery(request);
        if (result.status === "sent") receipt = result.receipt;
        return result;
      },
    });
    if (submission) await wait(requestGapMs);
    if (dateInShanghai(clock()) !== date) return finish({ status: "stopped", reason: "date_changed" });
    const result = await dispatch({ action: "share_video", target: draft.bvid, text: draft.text }, !submission);
    const videoUrl = `https://www.bilibili.com/video/${draft.bvid}/`;
    if (result.status === "planned") {
      const reviewedAt = clock();
      if (dateInShanghai(reviewedAt) !== date) return finish({ status: "stopped", reason: "date_changed" });
      return finish({
        status: "ready", draftDate, sendDate: date, videoUrl, publicComment: message, approvalCode, nightWindowOpen: nightDate(reviewedAt) === date,
      });
    }
    if (result.status === "sent" && receipt) return finish({ ...result, commentUrl: `${videoUrl}#reply${receipt}` });
    return finish(result);
  } catch (error) {
    const reason = error instanceof ProbeError ? error.reason : error instanceof InteractionLedgerBusy ? "ledger_busy"
      : "state_unavailable";
    return finish({ status: "stopped", reason });
  }
}
