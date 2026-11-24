import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const diaryFiles = { owner: "owner.md", self: "private.md" } as const;
export type DiaryChannel = keyof typeof diaryFiles;

const maxDiaryBytes = 32 * 1024 * 1024;
const markerStart = "<!-- bili-whale-run: ";
const utf8 = new TextDecoder("utf-8", { fatal: true });
const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hourCycle: "h23",
});

export type DiaryEntry = { runId: string; occurredAt: Date; text: string };

function checkedChannel(channel: DiaryChannel) {
  if (channel !== "owner" && channel !== "self") throw new Error("invalid_diary_channel");
  return diaryFiles[channel];
}

async function checkWorkspace(workspace: string) {
  if (!isAbsolute(workspace) || await realpath(workspace) !== workspace) throw new Error("invalid_diary_workspace");
  const info = await lstat(workspace, { bigint: true });
  if (!info.isDirectory()) throw new Error("invalid_diary_workspace");
  return info;
}

function fileVersion(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.nlink}`;
}

function errorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function loadDiary(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1) ||
        (before.mode & 0o077n) !== 0n) throw new Error("unsafe_diary_file");
    if (before.size > BigInt(maxDiaryBytes)) throw new Error("diary_too_large");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const version = fileVersion(before);
    if (length !== Number(before.size) || fileVersion(await file.stat({ bigint: true })) !== version ||
        fileVersion(await lstat(path, { bigint: true })) !== version) throw new Error("diary_changed");
    const contents = bytes.subarray(0, length);
    return { contents, text: utf8.decode(contents), version };
  } finally {
    await file.close();
  }
}

export async function readDiary(workspace: string, channel: DiaryChannel) {
  const filename = checkedChannel(channel);
  await checkWorkspace(workspace);
  return (await loadDiary(join(workspace, filename))).text;
}

async function syncWorkspace(workspace: string) {
  const parent = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function appendDiaryEntry(workspace: string, channel: DiaryChannel, entry: DiaryEntry) {
  const filename = checkedChannel(channel);
  const body = entry.text.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry.runId) || !Number.isFinite(entry.occurredAt.getTime()) ||
      !body || body.length > 8000 || body.includes(markerStart)) throw new Error("invalid_diary_entry");

  const target = join(workspace, filename);
  const lock = join(workspace, ".bili-whale-diary-" + channel + ".lock");
  const originalDir = await checkWorkspace(workspace);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error, "EEXIST")) throw new Error("diary_busy");
    throw error;
  }

  let stageDir: string | undefined;
  try {
    const prior = await loadDiary(target);
    const footer = `\n${markerStart}${entry.runId} -->\n`;
    const record = Buffer.from(`\n\n## ${shanghaiTime.format(entry.occurredAt)}（上海时间）\n\n${body}\n${footer}`);
    const marker = prior.contents.indexOf(footer);
    if (marker >= 0) {
      if (!prior.contents.includes(record) || prior.contents.indexOf(footer, marker + 1) >= 0) {
        throw new Error("diary_run_conflict");
      }
      await syncWorkspace(workspace);
      return "already_present" as const;
    }
    if (prior.contents.length + record.length > maxDiaryBytes) throw new Error("diary_too_large");

    stageDir = await mkdtemp(join(workspace, ".bili-whale-diary-stage-"));
    const staged = join(stageDir, "diary.md");
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(Buffer.concat([prior.contents, record]));
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }

    const currentDir = await checkWorkspace(workspace);
    if (currentDir.dev !== originalDir.dev || currentDir.ino !== originalDir.ino ||
        fileVersion(await lstat(target, { bigint: true })) !== prior.version) throw new Error("diary_changed");
    await rename(staged, target);
    await syncWorkspace(workspace);
    return "appended" as const;
  } finally {
    try {
      if (stageDir) {
        await unlink(join(stageDir, "diary.md")).catch(error => {
          if (!errorCode(error, "ENOENT")) throw error;
        });
        await rmdir(stageDir);
      }
    } finally {
      await rmdir(lock);
    }
  }
}
