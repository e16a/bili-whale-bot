import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { initializeHome, loadHome } from "./home.ts";
import { runNight } from "./night.ts";

// Synthetic accounts and video. Every Bilibili URL in this function is intercepted locally.
export const demoVideo = { bvid: "BVDEMO000001", aid: "231", title: "自然观察 · 雨后的苔藓" };
export const demoComment = "叶尖挂水珠这个观察我记住了。";
export const demoClock = () => new Date("2025-01-02T13:10:00Z");
const ownerMid = "9007199254740993";
const accountMid = "9007199254740995";

export const demoAccount = { isLogin: true, mid: accountMid, wbi_img: {
  img_url: "https://i0.hdslb.com/" + "a".repeat(32) + ".png",
  sub_url: "https://i0.hdslb.com/" + "b".repeat(32) + ".png",
} };

export const demoTransport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.bilibili.com" || init?.method !== "GET") throw new Error("unexpected_demo_request");
  const data = (value: unknown) => Response.json({ code: 0, data: value });
  switch (url.pathname) {
    case "/x/web-interface/nav": return data(demoAccount);
    case "/x/web-interface/wbi/search/type": return data({ result: [{
      ...demoVideo, play: 890, danmaku: 18, duration: "02:01", mid: "19",
    }] });
    case "/x/relation": return data({ mid: ownerMid, attribute: 0 });
    case "/x/msgfeed/reply":
    case "/x/msgfeed/at": return data({ items: [] });
    case "/x/web-interface/view": return data({ ...demoVideo, cid: 71, desc: "示例资料记录叶片聚水和苔藓的生长位置。" });
    case "/x/player/wbi/v2": return data({ subtitle: { subtitles: [] } });
    default: throw new Error("unexpected_demo_request");
  }
};

export async function runDemo() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "bili-whale-demo-")));
  const path = join(parent, "bot");
  await initializeHome(path, ownerMid, accountMid, demoClock);
  const home = await loadHome(path);
  const credentialsPath = join(parent, "demo-session.json");
  await writeFile(credentialsPath, JSON.stringify({ sessdata: "local-demo-session", bili_jct: "c".repeat(32) }), { mode: 0o600 });
  const provider = fauxProvider();
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall("list_candidates", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read_video", { bvid: demoVideo.bvid })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("score_video", {
      bvid: demoVideo.bvid, information: 4, preference: 4, novelty: 4, feeling: 3, expression: 3,
      reason: "观察切口具体，简介和兴趣相关。",
    })], { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxToolCall("plan_interaction", { action: "share_video", target: demoVideo.bvid, text: demoComment }),
      fauxToolCall("write_diary", { diary: "owner", text: `示例里看了 ${demoVideo.bvid}。雨后的小景很值得留意。` }),
      fauxToolCall("write_diary", { diary: "self", text: "以后再留意水洼边的细节。" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("看完了。")]),
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const result = await runNight({
    home, models, model: provider.getModel(), clock: demoClock, draw: () => 3,
    reads: { credentialsPath, transport: demoTransport, wait: async () => undefined },
  });
  return { ...result, mode: "demo" as const, home: path };
}
