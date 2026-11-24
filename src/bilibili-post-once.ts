import https from "node:https";
import { Readable } from "node:stream";

export const bilibiliWriteEndpoints = {
  share_video: "https://api.bilibili.com/x/v2/reply/add",
} as const;

// Do not use Fetch for writes, since it can replay an HTTP 421 response.
export function createBilibiliPostOnce(action: keyof typeof bilibiliWriteEndpoints): typeof fetch {
  const endpoint = bilibiliWriteEndpoints[action];
  return (url, init) => {
    if (!(url instanceof URL) || url.origin + url.pathname !== endpoint || url.username || url.password ||
        url.hash || init?.method !== "POST" || typeof init.body !== "string") throw new Error("invalid_write_request");
    const { body, signal } = init;
    const headers = Object.fromEntries(new Headers(init.headers));
    headers["content-length"] = String(Buffer.byteLength(body));
    headers["accept-encoding"] = "identity";

    return new Promise((resolve, reject) => {
      const request = https.request(url, { agent: false, method: "POST", headers, signal: signal ?? undefined }, reply => {
        const status = reply.statusCode ?? 0;
        if (status < 200 || status > 599) {
          reply.destroy();
          reject(new Error("invalid_write_response"));
          return;
        }
        const hasBody = status < 300 && status !== 204 && status !== 205;
        const stream = hasBody ? Readable.toWeb(reply) as ReadableStream<Uint8Array> : null;
        if (!hasBody) reply.destroy();
        const mediaType = reply.headers["content-type"];
        resolve(new Response(stream, { status, headers: mediaType ? { "content-type": mediaType } : undefined }));
      });
      request.once("error", reject);
      request.end(body);
    });
  };
}
