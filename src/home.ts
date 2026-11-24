import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalBilibiliId } from "./bilibili-owner.ts";
import { readLocalBilibiliFile } from "./bilibili-read.ts";
import { diaryFiles } from "./diary.ts";
import { initializeInteractionLedger } from "./ledger.ts";
import { checkNightStateDirectory } from "./night-state.ts";

export type Preferences = { like: string[]; dislike: string[] };
export const defaultHome = join(homedir(), ".local", "share", "bili-whale-bot");

type Identity = { ownerMid: string; accountMid: string };
function identity(ownerMid: unknown, accountMid: unknown): Identity {
  if (typeof ownerMid !== "string" || typeof accountMid !== "string" ||
      canonicalBilibiliId(ownerMid) !== ownerMid || canonicalBilibiliId(accountMid) !== accountMid ||
      ownerMid.length > 20 || accountMid.length > 20 || ownerMid === accountMid) throw new Error("invalid_account_uids");
  return { ownerMid, accountMid };
}

function paths(path: string) {
  const home = resolve(path);
  const state = join(home, "state");
  return { home, state, reads: join(state, "video-reads"), diaries: join(home, "diaries"), config: join(home, "config.json") };
}

export async function initializeHome(path: string, ownerMid: string, accountMid: string, clock = () => new Date()) {
  const ids = identity(ownerMid, accountMid);
  const folders = paths(path);
  const parent = dirname(folders.home);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("invalid_home_directory");
  await mkdir(folders.home, { mode: 0o700 });
  await mkdir(folders.diaries, { mode: 0o700 });
  await initializeInteractionLedger({ directory: folders.state, ...ids });
  const write = (file: string, contents: string) => writeFile(file, contents, { mode: 0o600, flag: "wx", flush: true });
  await Promise.all([
    write(join(folders.home, "persona.md"), "你是一位爱观察的小帮手。喜欢具体、有趣的发现，给我分享时用自己的话说一两句。没有想推荐的，也可以安静地看完。\n"),
    write(join(folders.diaries, diaryFiles.owner), "# 给主人的日记\n"),
    write(join(folders.diaries, diaryFiles.self), "# 自留日记\n"),
  ]);
  await write(folders.config, JSON.stringify({
    ...ids, name: "小鲸", model: "deepseek-flash", inboxSince: Math.floor(clock().getTime() / 1000),
    interests: ["自然观察", "手工纸艺"], avoid: ["纯广告"],
  }, null, 2) + "\n");
  return folders;
}

function terms(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length > max || value.some(term => typeof term !== "string" ||
      !term.isWellFormed() || !term.trim() || term.length > 48 || /[\p{Cc}\p{Cf}]/u.test(term))) {
    throw new Error("invalid_preferences");
  }
  return [...new Set<string>(value.map(term => term.trim()))];
}

export async function loadHome(path: string) {
  const folders = paths(path);
  await Promise.all([folders.home, folders.state, folders.diaries].map(checkNightStateDirectory));
  const raw = await readLocalBilibiliFile(folders.config, 8192).catch(() => { throw new Error("invalid_home_config"); });
  const { ownerMid, accountMid, name, model, interests, avoid, inboxSince } = JSON.parse(raw) as Record<string, unknown>;
  const ids = identity(ownerMid, accountMid);
  const like = terms(interests, 6);
  const dislike = terms(avoid, 20);
  if (typeof name !== "string" || !name.trim() || name.length > 32 || !name.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(name) ||
      typeof model !== "string" || !/^[a-zA-Z0-9_.-]{1,60}$/.test(model) || !like.length ||
      typeof inboxSince !== "number" || !Number.isSafeInteger(inboxSince) || inboxSince < 1) throw new Error("invalid_home_config");
  const persona = await readLocalBilibiliFile(join(folders.home, "persona.md"), 8192)
    .catch(() => { throw new Error("invalid_persona_file"); });
  return { ...folders, ids, settings: { name: name.trim(), model, inboxSince, preferences: { like, dislike }, persona } };
}

export type BotHome = Awaited<ReturnType<typeof loadHome>>;
