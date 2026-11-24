import { setTimeout as sleep } from "node:timers/promises";
import { isVisibleMessage, messageText, withdrawnKeys } from "./bilibili-dm-message.ts";
import type { InteractionCandidate } from "./interactions.ts";
import type { Preferences } from "./home.ts";
import { canonicalBilibiliId, createOwnerGuard, directMessageReplyReference, videoCommentReplyTarget } from "./bilibili-owner.ts";
import {
  apiData, commentPageUrl, dmPageUrl, findCommentSource, getJson, isBilibiliVideoId, loadBilibiliSession,
  ownerConversationMessages, ProbeError, requestGapMs, signWbiUrl, videoSearchPath, withReadDay,
  type BilibiliReadOptions,
} from "./bilibili-read.ts";
import { nightDate } from "./shanghai-time.ts";

const origin = "https://api.bilibili.com";
const maxCandidates = 6;
const maxEventsPerChannel = 3;
type JsonRow = Record<string, unknown>;
type OwnerSource = Exclude<InteractionCandidate, { action: "share_video" }>;
type SearchCard = { bvid: string; title: string; hits: string[]; rank: number };
export type NightOwnerEvent = { handle: string; source: OwnerSource; text: string };
export type NightReadOptions = Pick<BilibiliReadOptions, "credentialsPath" | "stateRoot" | "clock" | "transport" | "wait" | "signal">;

function row(value: unknown): JsonRow | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : undefined;
}

function rows(value: unknown) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new ProbeError("invalid_response");
  return value.map(item => row(item)).filter(item => item !== undefined);
}

// Search keyword splitting and ranking adapted from bili-whale 0.4.6 feed.mjs (MIT, see licenses/).
const joinWords = /[\s·,，、/]+|与|和|及|向|的|类/;
function partsOf(preference: string) {
  return [...new Set(preference.split(joinWords).map(part => part.trim()).filter(part => part.length >= 2))];
}

function chinesePairs(text: string) {
  const pairs: string[] = [];
  for (let index = 0; index + 2 <= text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(pair)) pairs.push(pair);
  }
  return pairs;
}

function searchKeyword(preference: string) {
  const parts = partsOf(preference);
  if (parts.length > 1 || (parts.length === 1 && parts[0].length < 4)) return parts[0];
  return chinesePairs(preference).at(-1) ?? preference;
}

function positiveNumber(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function durationSeconds(value: unknown) {
  if (typeof value !== "string" || !/^\d+(?::\d{1,2}){1,2}$/.test(value)) return positiveNumber(value);
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function rankedCandidates(results: JsonRow[], accountMid: string, seen: ReadonlySet<string>, preferences: Preferences) {
  const tokens = preferences.like.map(label => {
    const parts = partsOf(label);
    return { label, terms: [...parts, ...parts.filter(part => part.length >= 4).flatMap(chinesePairs)].map(term => term.toLowerCase()) };
  });
  const cards = new Map<string, SearchCard>();
  for (const result of results) {
    const { bvid, title: rawTitle } = result;
    if (typeof bvid !== "string" || !isBilibiliVideoId(bvid) || seen.has(bvid) || cards.has(bvid) ||
        typeof rawTitle !== "string" || canonicalBilibiliId(result.mid) === accountMid) continue;
    const title = rawTitle.replace(/<[^>]+>/g, "").trim().slice(0, 240).toWellFormed();
    if (!title || preferences.dislike.some(dislike => title.includes(dislike))) continue;
    const lower = title.toLowerCase();
    const hits = tokens.filter(p => p.terms.some(token => lower.includes(token))).map(p => p.label);
    if (!hits.length) continue;
    const danmaku = positiveNumber(result.danmaku);
    if (positiveNumber(result.play) < 300 && danmaku < 3 && hits.length < 2) continue;
    const density = Math.log10(1 + danmaku / Math.max(30, durationSeconds(result.duration)));
    cards.set(bvid, { bvid, title, hits, rank: density * 3 + hits.length * 4 });
  }
  const groupCounts = new Map<string, number>();
  return [...cards.values()].sort((a, b) => b.rank - a.rank).filter(card => {
    const group = card.hits.join("+");
    const count = groupCounts.get(group) ?? 0;
    if (count >= (card.hits.length ? 2 : 3)) return false;
    groupCounts.set(group, count + 1);
    return true;
  }).slice(0, maxCandidates).map(({ bvid, title, hits }) => ({ bvid, title, preferences: hits }));
}

function epoch(value: unknown) {
  const id = canonicalBilibiliId(value);
  const seconds = id ? Number(id) : 0;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function ownerNotices(items: JsonRow[], kind: "reply" | "at", ownerMid: string, now: Date, inboxSince: number) {
  return items.flatMap(notice => {
    if (canonicalBilibiliId(row(notice.user)?.mid) !== ownerMid) return [];
    const item = row(notice.item);
    const aid = canonicalBilibiliId(item?.subject_id);
    const replyId = canonicalBilibiliId(item?.source_id);
    const id = canonicalBilibiliId(notice.id);
    const epochSeconds = epoch(kind === "reply" ? notice.reply_time : notice.at_time);
    if (!aid || !replyId || !id || !epochSeconds || (item?.business_id !== 1 && item?.business_id !== "1") ||
        epochSeconds < inboxSince || epochSeconds > Math.floor(now.getTime() / 1000)) return [];
    return [{ aid, replyId, epochSeconds }];
  });
}

export async function prepareNightReads({
  stateRoot, credentialsPath, identity, inboxSince, preferences, date, seen, transport = fetch, clock = () => new Date(), signal,
  wait = ms => sleep(ms, undefined, { signal }),
}: NightReadOptions & {
  identity: { ownerMid: string; accountMid: string };
  inboxSince: number;
  preferences: Preferences;
  date: string;
  seen: ReadonlySet<string>;
}) {
  const { session, csrf, deviceCookie } = await loadBilibiliSession(credentialsPath);
  const sensitive = [session, csrf, deviceCookie, ...[identity.ownerMid, identity.accountMid].filter(mid => mid.length >= 6)]
    .filter((value): value is string => !!value);
  const redact = (text: string) => sensitive.reduce((clean, secret) => clean.replaceAll(secret, "[已省略]"), text);
  const guard = createOwnerGuard(identity.ownerMid);
  const read = async (url: URL) => {
    await wait(requestGapMs);
    if (signal?.aborted) throw new ProbeError("aborted");
    if (nightDate(clock()) !== date) throw new ProbeError("outside_window");
    return getJson(url, transport, session, signal, deviceCookie);
  };

  return withReadDay(stateRoot, date, async () => {
    const nav = apiData(await read(new URL("/x/web-interface/nav", origin)));
    if (nav.isLogin !== true) throw new ProbeError("session_invalid");
    if (canonicalBilibiliId(nav.mid) !== identity.accountMid) throw new ProbeError("account_mismatch");

    const searchKeywords = [...new Set(preferences.like.slice(0, 6).map(searchKeyword))];
    const results: JsonRow[] = [];
    for (const [index, keyword] of searchKeywords.entries()) {
      const url = new URL(videoSearchPath, origin);
      url.search = new URLSearchParams({
        search_type: "video", keyword, order: index % 2 === 0 ? "click" : "pubdate", page: "1",
      }).toString();
      const data = apiData(await read(signWbiUrl(url, nav, Math.floor(clock().getTime() / 1000))));
      if (data.result === undefined && (data.numResults === 0 || data.numResults === "0")) continue;
      results.push(...rows(data.result).slice(0, 20));
    }
    const candidates = rankedCandidates(results, identity.accountMid, seen, preferences);
    const events: NightOwnerEvent[] = [];
    let lastOwnerAt: number | undefined;
    const observeOwner = (epoch: number) => { lastOwnerAt = Math.max(lastOwnerAt ?? 0, epoch); };

    const relationship = new URL("/x/relation", origin);
    relationship.searchParams.set("fid", identity.ownerMid);
    const relation = apiData(await read(relationship));
    if (canonicalBilibiliId(relation.mid) !== identity.ownerMid) throw new ProbeError("invalid_response");
    if (relation.attribute === 6 || relation.attribute === "6") {
      const messages = ownerConversationMessages(apiData(await read(dmPageUrl(nav, identity.ownerMid, clock()))), identity.ownerMid);
      const withdrawn = withdrawnKeys(messages);
      const pending = messages.flatMap(message => {
        const key = canonicalBilibiliId(message.msg_key);
        const reference = directMessageReplyReference(message, identity.accountMid);
        const at = epoch(message.timestamp);
        const text = messageText(message.content);
        if (!key || !reference?.sequence || !at || at < inboxSince || !text?.trim() || !isVisibleMessage(message) ||
            withdrawn.has(key) || !guard.isOwnerDirectMessage(message) || at > Math.floor(clock().getTime() / 1000)) return [];
        observeOwner(at);
        return [{ epoch: at, message, text, key }];
      });
      const distinct = new Map(pending.sort((a, b) => b.epoch - a.epoch).map(event => [event.key, event]));
      for (const [index, event] of [...distinct.values()].slice(0, maxEventsPerChannel).entries()) {
        events.push({ handle: "dm-" + (index + 1), text: event.text, source: {
          action: "reply_dm", talkerId: identity.ownerMid, sessionType: 1, message: event.message, withdrawn: false,
        } });
      }
    }

    // The notification page only supplies coordinates. Use the anchored lookup for identity and body.
    const notices = [];
    for (const kind of ["reply", "at"] as const) {
      const url = new URL("/x/msgfeed/" + kind, origin);
      url.search = "platform=web&build=0&mobi_app=web";
      const data = apiData(await read(url));
      notices.push(...ownerNotices(rows(data.items), kind, identity.ownerMid, clock(), inboxSince));
    }
    const knownComments = new Set<string>();
    const recentNotices = notices.sort((a, b) => b.epochSeconds - a.epochSeconds).filter(notice => {
      if (knownComments.has(notice.replyId)) return false;
      knownComments.add(notice.replyId);
      return true;
    }).slice(0, maxEventsPerChannel);
    for (const [index, notice] of recentNotices.entries()) {
      const { aid, replyId, epochSeconds } = notice;
      const found = await findCommentSource(aid, replyId, async root => {
        const payload = await read(commentPageUrl(nav, aid, replyId, clock(), root));
        return payload.code === -404 || payload.code === 12006 ? undefined : apiData(payload);
      });
      if (found.status !== "found" || !guard.isOwnerComment(found.reply) ||
          !videoCommentReplyTarget(aid, found.reply, found.threadRoot)) continue;
      const text = row(found.reply.content)?.message;
      if (typeof text !== "string" || !text.trim()) continue;
      observeOwner(epochSeconds);
      events.push({ handle: "comment-" + (index + 1), text, source: {
        action: "reply_comment", aid, reply: found.reply, threadRoot: found.threadRoot,
      } });
    }
    return { candidates, events, lastOwnerAt, redact };
  });
}
