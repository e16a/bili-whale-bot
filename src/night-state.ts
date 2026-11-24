import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export async function checkNightStateDirectory(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("night_state_unavailable");
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("night_state_unavailable");
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function reserveNight(stateDirectory: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid_night_date");
  await checkNightStateDirectory(stateDirectory);
  const directory = join(stateDirectory, `night-${date}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    await checkNightStateDirectory(directory);
    return undefined;
  }
  // A permanent date reservation is durable even if the process dies before drawing or recording a result.
  await syncDirectory(stateDirectory);
  return directory;
}

export async function writeNightRecord(directory: string, filename: "decision.json" | "run.json" | "drafts.json", record: unknown) {
  await checkNightStateDirectory(directory);
  await writeFile(join(directory, filename), JSON.stringify(record, null, 2) + "\n", {
    flag: "wx", mode: 0o600, flush: true,
  });
  await syncDirectory(directory);
}
