import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { canonicalBilibiliId } from "./bilibili-owner.ts";
import type { InteractionTarget } from "./interactions.ts";

export type LedgerLocation = { directory: string; ownerMid: string; accountMid: string };
export type PlatformStop = "session_invalid" | "captcha" | "platform_stop";
export type SendOutcome =
  | { status: "unknown"; reason: "reserved" | "transport_error" | "receipt_unverified" }
  | { status: "sent"; receipt: string }
  | { status: "stopped"; reason: PlatformStop | "outside_window" };
export type LedgerEntry = {
  id: string;
  date: string;
  runId: string;
  reservedAt: string;
  target: Extract<InteractionTarget, { action: "share_video" }>;
} & SendOutcome;
type PersistEntries = (entries: readonly LedgerEntry[]) => Promise<void>;

const filename = "interaction-ledger.json";
const lockName = ".interaction-send.lock";

export class InteractionLedgerBusy extends Error {}

function checksum(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function serialize({ ownerMid, accountMid }: LedgerLocation, entries: readonly LedgerEntry[]) {
  const state = { version: 1, ownerMid, accountMid, entries };
  return JSON.stringify({ ...state, sha256: checksum(JSON.stringify(state)) }, null, 2) + "\n";
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function checkLedgerDirectory(directory: string) {
  if (!isAbsolute(directory) || await realpath(directory) !== directory) throw new Error("invalid_interaction_ledger");
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("invalid_interaction_ledger");
  }
}

async function readLedger(directory: string, expected: LedgerLocation) {
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error("invalid_interaction_ledger");
    }
    const contents = await file.readFile();
    const { sha256, ...state } = JSON.parse(contents.toString("utf8"));
    const ownerMid = canonicalBilibiliId(state.ownerMid);
    const accountMid = canonicalBilibiliId(state.accountMid);
    if (state.version !== 1 ||
        state.ownerMid !== ownerMid || state.accountMid !== accountMid ||
        !ownerMid || !accountMid || ownerMid === accountMid ||
        (ownerMid !== expected.ownerMid || accountMid !== expected.accountMid) ||
        !Array.isArray(state.entries) || sha256 !== checksum(JSON.stringify(state))) {
      throw new Error("invalid_interaction_ledger");
    }
    return state.entries as LedgerEntry[];
  } finally {
    await file.close();
  }
}

/** One-time provisioning. An existing directory with a missing ledger requires recovery. */
export async function initializeInteractionLedger(
  location: LedgerLocation, options: { directoryReady?: boolean } = {},
) {
  const { directory, ownerMid, accountMid } = location;
  const parent = dirname(directory);
  if (!isAbsolute(directory) || join(parent, basename(directory)) !== directory ||
      await realpath(parent) !== parent ||
      canonicalBilibiliId(ownerMid) !== ownerMid || canonicalBilibiliId(accountMid) !== accountMid ||
      ownerMid === accountMid) throw new Error("invalid_interaction_ledger");

  if (options.directoryReady) {
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() ||
        await realpath(directory) !== directory) throw new Error("invalid_interaction_ledger");
  } else {
    await mkdir(directory, { mode: 0o700 });
  }
  await writeFile(join(directory, filename), serialize(location, []), { flag: "wx", mode: 0o600, flush: true });
  await syncDirectory(directory);
  await syncDirectory(parent);
}

export async function withInteractionLedger<Result>(
  location: LedgerLocation,
  run: (entries: readonly LedgerEntry[], persist: PersistEntries) => Promise<Result>,
): Promise<Result> {
  const { directory } = location;
  await checkLedgerDirectory(directory);

  const lock = join(directory, lockName);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new InteractionLedgerBusy();
    throw error;
  }
  try {
    const entries = await readLedger(directory, location);
    return await run(entries, async updated => {
      const staged = join(lock, "next.json");
      await writeFile(staged, serialize(location, updated), { flag: "wx", mode: 0o600, flush: true });
      await rename(staged, join(directory, filename));
      await syncDirectory(directory);
    });
  } finally {
    // An interrupted writer or leftover staging file keeps the ledger closed for inspection.
    await rmdir(lock).catch(() => undefined);
  }
}
