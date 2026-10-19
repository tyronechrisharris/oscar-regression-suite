import assert from "node:assert/strict";
import {createServer, type RequestListener} from "node:http";
import test from "node:test";
import {boundedFetch} from "../src/bounded-fetch.js";

async function withServer(
  handler: RequestListener,
  operation: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("bounded fetch returns an exact in-limit body", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  }, async (url) => {
    const result = await boundedFetch({url, maxBytes: 64, decodeImage: false});
    assert.equal(result.ok, true);
    assert.equal(result.byteCount, 11);
    assert.equal(Buffer.from(result.bodyBase64, "base64").toString("utf8"), '{"ok":true}');
  });
});

test("bounded fetch rejects an oversized declared response before buffering it", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-length", "1024");
    response.end(Buffer.alloc(1024));
  }, async (url) => {
    await assert.rejects(
      boundedFetch({url, maxBytes: 32, decodeImage: false}),
      /rejected Content-Length 1024/,
    );
  });
});

test("bounded fetch hard-aborts a chunked response as soon as its limit is crossed", async () => {
  let connectionClosed = false;
  await withServer((_request, response) => {
    response.on("close", () => { connectionClosed = true; });
    response.write(Buffer.alloc(24, 1));
    response.write(Buffer.alloc(24, 2));
    setTimeout(() => response.end(Buffer.alloc(24, 3)), 25);
  }, async (url) => {
    await assert.rejects(
      boundedFetch({url, maxBytes: 32, decodeImage: false}),
      /exceeded 32 bytes/,
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(connectionClosed, true);
  });
});
