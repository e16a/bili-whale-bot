#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { defaultHome, initializeHome, loadHome } from "./home.ts";
import { runNight } from "./night.ts";
import { runDemo } from "./demo.ts";
import { runBilibiliShareTrial } from "./share.ts";

const usage = `BiliWhale Bot

  bili-whale demo
  bili-whale init --owner UID --bot UID [--home PATH]
  bili-whale run --session FILE [--home PATH]
  bili-whale share --day YYYY-MM-DD --session FILE [--home PATH] [--send-approved CODE]
`;
const stringFlag = { type: "string" } as const;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }
  if (command === "demo") {
    parseArgs({ args });
    const report = await runDemo();
    console.log(JSON.stringify(report, null, 2));
    return report.status === "completed" ? 0 : 1;
  }
  if (command === "init") {
    const { values } = parseArgs({ args, options: { home: stringFlag, owner: stringFlag, bot: stringFlag } });
    if (!values.owner || !values.bot) throw new Error("invalid_account_uids");
    const { home, config, diaries } = await initializeHome(values.home ?? defaultHome, values.owner, values.bot);
    console.log(JSON.stringify({ status: "initialized", home, config, diaries }, null, 2));
    return 0;
  }
  if (command === "run") {
    const { values } = parseArgs({ args, options: { home: stringFlag, session: stringFlag } });
    if (!values.session) throw new Error("session_file_required");
    const modelApiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!modelApiKey) throw new Error("deepseek_key_required");
    const home = await loadHome(values.home ?? defaultHome);
    const { deepseekProvider } = await import("@earendil-works/pi-ai/providers/deepseek");
    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = models.getModel("deepseek", home.settings.model);
    if (!model) throw new Error("unknown_deepseek_model");
    const report = await runNight({ home, models, model, modelApiKey, reads: { credentialsPath: resolve(values.session) } });
    console.log(JSON.stringify(report, null, 2));
    return report.status === "failed" ? 1 : 0;
  }
  if (command === "share") {
    const { values } = parseArgs({ args, options: { home: stringFlag, session: stringFlag, day: stringFlag, "send-approved": stringFlag } });
    if (!values.session || !values.day) throw new Error("session_and_day_required");
    const home = await loadHome(values.home ?? defaultHome);
    const approvalCode = values["send-approved"];
    const report = await runBilibiliShareTrial({
      home, credentialsPath: resolve(values.session), draftDate: values.day,
      submission: approvalCode === undefined ? undefined : { approvalCode },
    });
    console.log(JSON.stringify(report, null, 2));
    return report.status === "ready" || report.status === "sent" ? 0 : 1;
  }
  throw new Error("unknown_command");
}

const reportableErrors = new Set([
  "invalid_account_uids", "invalid_home_directory", "invalid_home_config", "invalid_preferences", "invalid_persona_file",
  "session_file_required", "session_and_day_required", "deepseek_key_required", "unknown_deepseek_model", "unknown_command",
]);

try {
  process.exitCode = await main();
} catch (error) {
  const reason = error instanceof Error && reportableErrors.has(error.message) ? error.message
    : error instanceof Error && "code" in error && error.code === "EEXIST" ? "home_already_exists" : "startup_failed";
  console.error(JSON.stringify({ status: "stopped", reason }));
  process.exitCode = 2;
}
