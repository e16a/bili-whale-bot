import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { demoAccount, demoClock, demoComment, demoTransport, demoVideo, runDemo } from "../src/demo.ts";
import { initializeHome, loadHome } from "../src/home.ts";
import { runNight } from "../src/night.ts";
import { readBilibiliVideo } from "../src/bilibili-read.ts";
import { runBilibiliShareTrial } from "../src/share.ts";

test("a fresh home keeps preferences editable and preserves its files on repeated init", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bili-whale-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "home");
  await assert.rejects(initializeHome(dir, "11", "11"), /invalid_account_uids/);
  const paths = await initializeHome(dir, "11", "12", demoClock);
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  await writeFile(paths.config, JSON.stringify({ ...config, name: "拾叶", interests: ["观鸟", "纸模型"] }));
  await assert.rejects(initializeHome(dir, "13", "14"), { code: "EEXIST" });
  const home = await loadHome(dir);
  assert.deepEqual(home.ids, { ownerMid: "11", accountMid: "12" });
  assert.equal(home.settings.name, "拾叶");
  assert.deepEqual(home.settings.preferences.like, ["观鸟", "纸模型"]);
  assert.equal((await stat(home.home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home.diaries, "private.md"))).mode & 0o777, 0o600);
  const alias = join(root, "alias");
  await symlink(dir, alias);
  await assert.rejects(loadHome(alias), /night_state_unavailable/);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { home, models, model: faux.getModel(), clock: demoClock, draw: () => 2,
    reads: { credentialsPath: "/unused", transport: async () => assert.fail("skip must be offline") } };
  assert.equal((await runNight({ ...options, clock: () => new Date("2025-01-02T12:10:00Z") })).status, "outside_window");
  assert.equal((await runNight(options)).status, "skipped");
  assert.equal((await runNight({ ...options, draw: () => assert.fail("one decision per day") })).status, "already_decided");
});

test("offline demo uses the installed night path, writes two distinct diaries and never sends", async t => {
  const result = await runDemo();
  t.after(() => rm(dirname(result.home), { recursive: true, force: true }));
  assert.equal(result.status, "completed");
  assert.equal(result.bilibiliWrites, 0);
  assert.ok("interactionDrafts" in result && result.interactionDrafts === 1);
  const home = await loadHome(result.home);
  const day = join(home.state, "night-2025-01-02");
  const saved = JSON.parse(await readFile(join(day, "drafts.json"), "utf8"));
  assert.equal(saved.drafts[0].text, demoComment);
  assert.equal(saved.drafts[0].assessment.score, 18);
  const owner = await readFile(join(home.diaries, "owner.md"), "utf8");
  const privateDiary = await readFile(join(home.diaries, "private.md"), "utf8");
  assert.match(owner, /雨后的小景/);
  assert.doesNotMatch(owner, /水洼边|local-demo-session/);
  assert.match(privateDiary, /水洼边/);
  assert.equal(JSON.parse(await readFile(join(home.state, "interaction-ledger.json"), "utf8")).entries.length, 0);
});

test("disk-backed slots deny a sixth read, including across reopened calls", async t => {
  const result = await runDemo();
  t.after(() => rm(dirname(result.home), { recursive: true, force: true }));
  const home = await loadHome(result.home);
  let networkCalls = 0;
  const options = { credentialsPath: join(dirname(result.home), "demo-session.json"), stateRoot: home.reads,
    bvid: demoVideo.bvid, clock: demoClock, wait: async () => undefined,
    transport: ((url, init) => { networkCalls += 1; return demoTransport(url, init); }) satisfies typeof fetch,
    night: { date: "2025-01-02", accountMid: home.ids.accountMid } };
  for (let slot = 2; slot <= 5; slot += 1) {
    const next = await readBilibiliVideo(options);
    assert.equal(next.report.status, "completed");
    assert.equal(next.report.slot, slot);
  }
  const exhausted = await readBilibiliVideo(options);
  assert.equal(exhausted.report.status, "stopped");
  assert.ok("reason" in exhausted.report && exhausted.report.reason === "video_limit");
  assert.equal(networkCalls, 8);
});

test("share review requires the saved draft and approval for one exact public comment", async t => {
  const result = await runDemo();
  t.after(() => rm(dirname(result.home), { recursive: true, force: true }));
  const home = await loadHome(result.home);
  const receipt = "9007199254743991";
  const text = `@主人样本 ${demoComment}`;
  const data = (value: unknown) => Response.json({ code: 0, data: value });
  const reads: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.bilibili.com");
    assert.equal(init?.method, "GET");
    if (url.pathname === "/x/web-interface/nav") return data(demoAccount);
    if (url.pathname === "/x/space/wbi/acc/info") {
      assert.equal(url.searchParams.get("mid"), home.ids.ownerMid);
      return data({ mid: home.ids.ownerMid, name: "主人样本" });
    }
    assert.equal(url.pathname, "/x/v2/reply/wbi/main");
    assert.equal(url.searchParams.get("seek_rpid"), receipt);
    return data({ replies: [{
      type: 1, oid: demoVideo.aid, rpid: receipt, root: "0", parent: "0", member: { mid: home.ids.accountMid },
      content: { message: text, members: [{ mid: home.ids.ownerMid }] },
    }] });
  };
  const options = { home, draftDate: "2025-01-02", credentialsPath: join(dirname(result.home), "demo-session.json"),
    clock: demoClock, wait: async () => undefined, transport: reads };
  const preview = await runBilibiliShareTrial(options);
  assert.equal(preview.status, "ready");
  assert.equal(preview.writes, 0);
  assert.ok("approvalCode" in preview && preview.approvalCode);
  assert.equal(preview.publicComment, text);
  let writes = 0;
  const transport: typeof fetch = async (input, init) => {
    writes += 1;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://api.bilibili.com/x/v2/reply/add");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "manual");
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("message"), text);
    assert.equal(body.get("at_name_to_mid"), `{"主人样本":${home.ids.ownerMid}}`);
    return data({ rpid: receipt });
  };
  const denied = await runBilibiliShareTrial({ ...options, submission: { approvalCode: "1".repeat(64), transport } });
  assert.equal(denied.status, "denied");
  assert.equal(writes, 0);
  const submission = { approvalCode: preview.approvalCode, transport };
  assert.equal((await runBilibiliShareTrial({ ...options, submission })).status, "sent");
  assert.equal((await runBilibiliShareTrial({ ...options, submission })).status, "denied");
  assert.equal(writes, 1);
});
