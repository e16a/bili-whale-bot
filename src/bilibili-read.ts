import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { canonicalBilibiliId, parseOwnerIdentityJson, videoCommentPosition } from "./bilibili-owner.ts";
import { dateInShanghai, nightDate } from "./shanghai-time.ts";

export { dateInShanghai } from "./shanghai-time.ts";

// Session, video and WBI subtitle routes are adapted from bili-whale 0.4.6 (MIT, see licenses/).
const apiOrigin = "https://api.bilibili.com";
const subtitleOrigin = "https://aisubtitle.hdslb.com";
const dmOrigin = "https://api.vc.bilibili.com";
const dmHistoryPath = "/svr_sync/v1/svr_sync/fetch_session_msgs";
const commentSeekPath = "/x/v2/reply/wbi/main";
const commentThreadPath = "/x/v2/reply/reply";
export const videoSearchPath = "/x/web-interface/wbi/search/type";
const authenticatedApiPaths = new Set([
  "/x/web-interface/nav", "/x/web-interface/view", "/x/player/wbi/v2", "/x/relation", commentSeekPath, commentThreadPath,
  videoSearchPath, "/x/msgfeed/reply", "/x/msgfeed/at",
]);
const dmPageSize = 30;
const wbiKeyOrder = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
];
export const maxVideosPerDay = 5;
const maxCredentialBytes = 16_384;
export const requestGapMs = 1_500;
const requestTimeoutMs = 15_000;
const maxResponseBytes = 512_000;
const videoIdPattern = /^BV[A-Za-z0-9]{10}$/;
type RecordObject = Record<string, unknown>;
type SubtitleLine = { from: number; to: number; text: string };
type ProbeStep = "setup" | "session" | "video" | "subtitle_tracks" | "subtitles";
type Reason =
  | "invalid_bvid" | "credentials_unavailable" | "credentials_invalid"
  | "state_unavailable" | "probe_busy" | "probe_paused" | "video_limit" | "date_changed" | "outside_window"
  | "session_invalid" | "account_mismatch" | "platform_stop" | "redirect_blocked" | "subtitle_url_blocked"
  | "http_error" | "api_error" | "invalid_response" | "timeout" | "network_error" | "aborted";
type ResponseIssue =
  | "missing_body" | "body_too_large" | "empty_body" | "html_body" | "invalid_json"
  | "expected_object" | "invalid_api_code" | "invalid_api_data" | "invalid_comment_page";

export class ProbeError extends Error {
  readonly reason: Reason;
  readonly statusCode?: number;
  readonly apiCode?: number;
  readonly responseIssue?: ResponseIssue;
  constructor(reason: Reason, codes?: { http?: number; api?: number; responseIssue?: ResponseIssue }) {
    super(reason);
    this.reason = reason;
    this.statusCode = codes?.http;
    this.apiCode = codes?.api;
    this.responseIssue = codes?.responseIssue;
  }
}

function invalidResponse(responseIssue: ResponseIssue, http?: number) {
  return new ProbeError("invalid_response", { responseIssue, http });
}

function record(value: unknown, issue: ResponseIssue = "expected_object", http?: number): RecordObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(issue, http);
  }
  return value as RecordObject;
}

function isErrorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readLocalBilibiliFile(path: string, maxBytes: number) {
  try {
    if (await realpath(path) !== path) throw new ProbeError("credentials_unavailable");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes ||
          (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.nlink !== 1) {
        throw new ProbeError("credentials_unavailable");
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new ProbeError("credentials_unavailable");
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new ProbeError("credentials_unavailable");
  }
}

function cookieValue(value: unknown) {
  if (typeof value !== "string") return;
  const cleaned = value.replace(/^["'\s]+|["'\s]+$/g, "");
  if (/^[\x21-\x7E]{1,4096}$/.test(cleaned) && !/[;"\\]/.test(cleaned)) return cleaned;
}

export async function loadBilibiliSession(path: string) {
  const raw = await readLocalBilibiliFile(path, maxCredentialBytes);
  try {
    const fields = record(JSON.parse(raw.replace(/^\uFEFF/, "")));
    const session = cookieValue(fields.sessdata);
    if (!session) throw new ProbeError("credentials_invalid");
    return { session, csrf: cookieValue(fields.bili_jct), deviceCookie: cookieValue(fields.buvid3) };
  } catch {
    throw new ProbeError("credentials_invalid");
  }
}

async function ensurePrivateDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new ProbeError("state_unavailable");
  }
}

async function syncDirectory(path: string) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function reserveVideo(directory: string, bvid: string, now: Date) {
  for (let slot = 1; slot <= maxVideosPerDay; slot += 1) {
    const path = join(directory, "read-" + slot + ".json");
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) continue;
      throw error;
    }
    try {
      await file.writeFile(JSON.stringify({ bvid, reservedAt: now.toISOString() }) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(directory);
    return slot;
  }
  throw new ProbeError("video_limit");
}

export async function withReadDay<T>(stateRoot: string, date: string, work: (directory: string) => Promise<T>) {
  const parent = dirname(stateRoot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || await realpath(parent) !== parent) throw new ProbeError("state_unavailable");
  await ensurePrivateDirectory(stateRoot);
  await syncDirectory(parent);
  const day = join(stateRoot, date);
  await ensurePrivateDirectory(day);
  await syncDirectory(stateRoot);

  const lock = join(day, "active");
  const paused = join(day, "paused");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) throw new ProbeError("probe_busy");
    throw error;
  }
  try {
    // Interruption or a failed network operation keeps this day paused.
    try {
      await mkdir(paused, { mode: 0o700 });
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) throw new ProbeError("probe_paused");
      throw error;
    }
    await syncDirectory(day);
    let result: T;
    try {
      result = await work(day);
    } catch (error) {
      if (error instanceof ProbeError && error.reason === "video_limit") {
        await rmdir(paused);
        await syncDirectory(day);
      }
      throw error;
    }
    await rmdir(paused);
    await syncDirectory(day);
    return result;
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

export async function getJson(url: URL, transport: typeof fetch, session?: string, cancellation?: AbortSignal, deviceCookie?: string) {
  const allowed = session === undefined
    ? url.origin === subtitleOrigin
    : (url.origin === apiOrigin && authenticatedApiPaths.has(url.pathname)) ||
      (url.origin === dmOrigin && url.pathname === dmHistoryPath);
  if (!allowed || url.username || url.password || url.hash) throw new ProbeError("invalid_response");
  const headers: Record<string, string> = { accept: "application/json" };
  if (session !== undefined) headers.cookie = "SESSDATA=" + session;
  if ([commentSeekPath, commentThreadPath, dmHistoryPath, "/x/relation", "/x/msgfeed/reply", "/x/msgfeed/at"].includes(url.pathname)) {
    headers.referer = "https://www.bilibili.com/";
  }
  if (url.pathname === videoSearchPath && url.origin === apiOrigin) {
    headers.referer = "https://search.bilibili.com/";
    if (deviceCookie) headers.cookie += "; buvid3=" + deviceCookie;
  }
  return requestBilibiliJson(url, { method: "GET", headers }, transport, cancellation);
}

export async function requestBilibiliJson(
  url: URL, init: RequestInit, transport: typeof fetch, cancellation?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  const transportError = () => {
    if (cancellation?.aborted) return new ProbeError("aborted");
    return new ProbeError(timeout.aborted ? "timeout" : "network_error");
  };
  let response;
  try {
    response = await transport(url, { ...init, redirect: "manual", signal });
  } catch {
    throw transportError();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const codes = { http: response.status };
    if (response.status >= 300 && response.status < 400) throw new ProbeError("redirect_blocked", codes);
    if (response.status === 401) throw new ProbeError("session_invalid", codes);
    if ([403, 412, 429].includes(response.status)) throw new ProbeError("platform_stop", codes);
    throw new ProbeError("http_error", codes);
  }

  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse("missing_body", response.status);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw invalidResponse("body_too_large", response.status);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProbeError) throw error;
    throw transportError();
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) throw invalidResponse("empty_body", response.status);
  let json: unknown;
  try {
    json = parseOwnerIdentityJson(body);
  } catch {
    const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const looksLikeHtml = mediaType === "text/html" || /^\s*(?:<!doctype html\b|<html\b)/i.test(body);
    throw invalidResponse(looksLikeHtml ? "html_body" : "invalid_json", response.status);
  }
  return record(json, "expected_object", response.status);
}

export function apiData(payload: RecordObject) {
  const code = payload.code;
  if (typeof code !== "number" || !Number.isSafeInteger(code)) throw invalidResponse("invalid_api_code");
  if (code === -101) throw new ProbeError("session_invalid", { api: code });
  if ([-352, -403, -412, -509, -799, -10403, 10031, 12015, 12051].includes(code)) {
    throw new ProbeError("platform_stop", { api: code });
  }
  if (code !== 0) throw new ProbeError("api_error", { api: code });
  return record(payload.data, "invalid_api_data");
}

function wbiImageKey(value: unknown) {
  const match = typeof value === "string" ? /\/([a-fA-F0-9]{32})\.png$/.exec(value) : null;
  if (!match) throw new ProbeError("invalid_response");
  return match[1];
}

export function signWbiUrl(url: URL, account: RecordObject, timestamp: number, form?: URLSearchParams) {
  const images = record(account.wbi_img);
  const key = wbiImageKey(images.img_url) + wbiImageKey(images.sub_url);
  // Bilibili signs sorted parameters with the first 32 characters of the mixed key.
  const mixedKey = wbiKeyOrder.map(index => key[index]).join("");
  url.searchParams.set("wts", String(timestamp));
  url.searchParams.sort();
  let signingQuery = url.searchParams.toString();
  if (form) {
    // The legacy comment route signs the form fields and timestamp, using percent encoding.
    const params = new URLSearchParams(form);
    params.set("wts", String(timestamp));
    params.sort();
    signingQuery = [...params].map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value.replace(/[!'()*]/g, ""))}`).join("&");
  }
  const signature = createHash("md5").update(signingQuery + mixedKey).digest("hex");
  url.searchParams.set("w_rid", signature);
  return url;
}

function playerUrl(account: RecordObject, bvid: string, cid: unknown, now: Date) {
  if (typeof cid !== "number" || !Number.isSafeInteger(cid) || cid < 1) {
    throw new ProbeError("invalid_response");
  }
  const url = new URL("/x/player/wbi/v2", apiOrigin);
  url.search = new URLSearchParams({ bvid, cid: String(cid) }).toString();
  return signWbiUrl(url, account, Math.round(now.getTime() / 1000));
}

export function dmPageUrl(account: RecordObject, ownerMid: string, now: Date) {
  const url = new URL(dmHistoryPath, dmOrigin);
  url.search = new URLSearchParams({
    talker_id: ownerMid, session_type: "1", size: String(dmPageSize), begin_seqno: "0",
  }).toString();
  return signWbiUrl(url, account, Math.floor(now.getTime() / 1000));
}

export function commentPageUrl(account: RecordObject, aid: string, replyId: string, now: Date, root?: string) {
  if (root !== undefined) {
    const url = new URL(commentThreadPath, apiOrigin);
    url.search = new URLSearchParams({ type: "1", oid: aid, root, pn: "1", ps: "20" }).toString();
    return url;
  }
  const url = new URL(commentSeekPath, apiOrigin);
  url.search = new URLSearchParams({
    type: "1", oid: aid, mode: "3", plat: "1", seek_rpid: replyId, pagination_str: '{"offset":""}',
  }).toString();
  return signWbiUrl(url, account, Math.floor(now.getTime() / 1000));
}

function commentRows(value: unknown) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponse("invalid_comment_page");
  return value.map(row => record(row, "invalid_comment_page"));
}

export async function findCommentSource(
  aid: string, replyId: string,
  getPage: (root?: string) => Promise<RecordObject | undefined>,
): Promise<{ status: "found"; reply: RecordObject; threadRoot?: unknown } | { status: "not_found" | "thread_unverified" }> {
  const page = await getPage();
  if (!page) return { status: "not_found" };
  if (!Object.hasOwn(page, "replies") && !Object.hasOwn(page, "seek_root_reply")) {
    throw invalidResponse("invalid_comment_page");
  }
  const soughtRoot = page.seek_root_reply == null ? undefined : record(page.seek_root_reply, "invalid_comment_page");
  const exact = (row: RecordObject) => canonicalBilibiliId(row.rpid) === replyId;
  const roots = commentRows(page.replies);
  if (soughtRoot) roots.unshift(soughtRoot);
  for (const root of roots) {
    if (exact(root)) return { status: "found", reply: root };
    const reply = commentRows(root.replies).find(exact);
    if (reply) return { status: "found", reply, threadRoot: root };
  }

  // Only expand the single root identified by the anchored lookup.
  if (!soughtRoot) return { status: "not_found" };
  const anchor = videoCommentPosition(soughtRoot, aid);
  if (anchor?.root !== "0") return { status: "thread_unverified" };
  const thread = await getPage(anchor.rpid);
  const root = thread?.root;
  const parent = videoCommentPosition(root, aid);
  if (parent?.rpid !== anchor.rpid || parent.root !== "0") return { status: "thread_unverified" };
  const reply = commentRows(thread?.replies).find(exact);
  return reply ? { status: "found", reply, threadRoot: root } : { status: "not_found" };
}

export function ownerConversationMessages(data: RecordObject, ownerMid: string) {
  if ((data.talker_id !== undefined && canonicalBilibiliId(data.talker_id) !== ownerMid) ||
      (data.session_type !== undefined && data.session_type !== 1 && data.session_type !== "1")) {
    throw new ProbeError("invalid_response");
  }
  const messages = data.messages === null ? [] : data.messages;
  if (!Array.isArray(messages) || messages.length > dmPageSize) throw new ProbeError("invalid_response");
  return messages.map(message => record(message));
}

function pickSubtitleTrack(player: RecordObject) {
  const subtitles = record(player.subtitle).subtitles;
  if (!Array.isArray(subtitles)) throw new ProbeError("invalid_response");
  const tracks = subtitles.map(value => record(value));
  return tracks.find(track => track.lan === "ai-zh")
    ?? tracks.find(track => track.lan === "zh-CN")
    ?? tracks.find(track => typeof track.lan === "string" && track.lan.startsWith("zh"))
    ?? tracks[0];
}

function subtitleUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096 || !/^(?:https:)?\/\//.test(value)) {
    throw new ProbeError("subtitle_url_blocked");
  }
  const url = URL.parse(value.startsWith("//") ? "https:" + value : value);
  const subtitlePath = /^\/bfs\/(?:subtitle\/[A-Za-z0-9_-]+\.json|ai_subtitle\/prod\/[A-Za-z0-9_-]+(?:\.json)?)$/;
  if (!url || url.origin !== subtitleOrigin || url.username || url.password || url.hash ||
      !subtitlePath.test(url.pathname)) {
    throw new ProbeError("subtitle_url_blocked");
  }
  return url;
}

function readSubtitleLines(subtitle: RecordObject) {
  if (!Array.isArray(subtitle.body)) throw new ProbeError("invalid_response");
  const lines: SubtitleLine[] = [];
  for (const value of subtitle.body) {
    const { from, to, content } = record(value);
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) ||
        !Number.isFinite(to) || from < 0 || to < from || typeof content !== "string") {
      throw new ProbeError("invalid_response");
    }
    const text = content.trim();
    if (text) lines.push({ from, to, text });
  }
  return lines;
}

export type BilibiliReadOptions = {
  bvid: string;
  credentialsPath: string;
  stateRoot: string;
  includeSubtitles?: boolean;
  transport?: typeof fetch;
  clock?: () => Date;
  wait?: (ms: number) => Promise<unknown>;
  signal?: AbortSignal;
  night?: { date: string; accountMid: string };
};

export function isBilibiliVideoId(value: string) {
  return videoIdPattern.test(value);
}

export async function readBilibiliVideo({
  bvid, credentialsPath, stateRoot, includeSubtitles = false,
  transport = fetch, clock = () => new Date(), signal, night,
  wait = ms => sleep(ms, undefined, { signal }),
}: BilibiliReadOptions) {
  const date = dateInShanghai(clock());
  let requests = 0;
  let loginVerified = false;
  let slot: number | null = null;
  let step: ProbeStep = "setup";
  const report = { mode: "bilibili-readonly" as const, date };
  const fetchOnDate = (url: URL, session?: string) => {
    if (signal?.aborted) throw new ProbeError("aborted");
    const now = clock();
    if (dateInShanghai(now) !== date) throw new ProbeError("date_changed");
    if (night && nightDate(now) !== night.date) throw new ProbeError("outside_window");
    requests += 1;
    return getJson(url, transport, session, signal);
  };

  try {
    if (signal?.aborted) throw new ProbeError("aborted");
    if (!isBilibiliVideoId(bvid)) throw new ProbeError("invalid_bvid");
    if (night && nightDate(clock()) !== night.date) throw new ProbeError("outside_window");
    const { session } = await loadBilibiliSession(credentialsPath);
    return await withReadDay(stateRoot, date, async day => {
      if (night && nightDate(clock()) !== night.date) throw new ProbeError("outside_window");
      slot = await reserveVideo(day, bvid, clock());

      await wait(requestGapMs);
      step = "session";
      const account = apiData(await fetchOnDate(new URL("/x/web-interface/nav", apiOrigin), session));
      if (account.isLogin !== true) throw new ProbeError("session_invalid");
      const accountMid = canonicalBilibiliId(account.mid);
      if (night && accountMid !== night.accountMid) throw new ProbeError("account_mismatch");
      loginVerified = true;
      await wait(requestGapMs);

      const videoUrl = new URL("/x/web-interface/view", apiOrigin);
      videoUrl.searchParams.set("bvid", bvid);
      step = "video";
      const video = apiData(await fetchOnDate(videoUrl, session));
      if (video.bvid !== bvid || typeof video.title !== "string" || !video.title.trim()) {
        throw new ProbeError("invalid_response");
      }

      let subtitles: SubtitleLine[] = [];
      let subtitleStatus: "read" | "no_track" | "empty" | undefined;
      if (includeSubtitles) {
        step = "subtitle_tracks";
        await wait(requestGapMs);
        const url = playerUrl(account, bvid, video.cid, clock());
        const track = pickSubtitleTrack(apiData(await fetchOnDate(url, session)));
        subtitleStatus = "no_track";
        if (track) {
          step = "subtitles";
          const url = subtitleUrl(track.subtitle_url);
          await wait(requestGapMs);
          subtitles = readSubtitleLines(await fetchOnDate(url));
          subtitleStatus = subtitles.length ? "read" : "empty";
        }
      }

      if (signal?.aborted) throw new ProbeError("aborted");
      return {
        report: {
          ...report, status: "completed" as const, requests, loginVerified, slot, bvid, metadataRead: true,
          ...(subtitleStatus ? { subtitleStatus, subtitleLines: subtitles.length } : {}),
        },
        video: {
          bvid, title: video.title, aid: canonicalBilibiliId(video.aid),
          description: typeof video.desc === "string" ? video.desc : "", subtitles,
        },
      };
    });
  } catch (error) {
    const failure = error instanceof ProbeError ? error : new ProbeError(signal?.aborted ? "aborted" : "state_unavailable");
    return {
      report: {
        ...report, status: "stopped" as const, requests, loginVerified, slot: slot as number | null, step: step as ProbeStep,
        reason: failure.reason, httpStatus: failure.statusCode, apiCode: failure.apiCode,
        ...(failure.responseIssue ? { responseIssue: failure.responseIssue } : {}),
      },
      video: undefined,
    };
  }
}
