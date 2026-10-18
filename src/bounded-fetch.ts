export interface BoundedFetchRequest {
  url: string;
  maxBytes: number;
  decodeImage: boolean;
}

export interface BoundedFetchResult {
  status: number;
  ok: boolean;
  contentType: string;
  byteCount: number;
  bodyBase64: string;
  decodedWidth: number | null;
  decodedHeight: number | null;
}

/**
 * Browser-safe fetch helper whose limit is enforced while the response is read.
 *
 * This function is deliberately self-contained so Playwright can serialize it
 * into the authenticated Viewer page. It must not close over module state.
 */
export async function boundedFetch(request: BoundedFetchRequest): Promise<BoundedFetchResult> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new Error("bounded fetch requires a positive integer byte limit");
  }

  const controller = new AbortController();
  const response = await fetch(request.url, {
    cache: "no-store",
    credentials: "include",
    signal: controller.signal,
  });
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > request.maxBytes) {
      controller.abort();
      throw new Error(
        `bounded fetch rejected Content-Length ${declaredLength}; limit=${request.maxBytes}`,
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (!value) continue;
        if (byteCount > request.maxBytes - value.byteLength) {
          controller.abort();
          await reader.cancel("bounded response exceeded its byte limit").catch(() => undefined);
          throw new Error(`bounded fetch exceeded ${request.maxBytes} bytes`);
        }
        chunks.push(value);
        byteCount += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decodedWidth: number | null = null;
  let decodedHeight: number | null = null;
  if (request.decodeImage && response.ok) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("bounded image fetch cannot decode in this browser");
    }
    const bitmap = await createImageBitmap(new Blob([bytes], {
      type: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "",
    }));
    try {
      decodedWidth = bitmap.width;
      decodedHeight = bitmap.height;
    } finally {
      bitmap.close();
    }
  }

  let binary = "";
  const sliceSize = 0x8000;
  for (let start = 0; start < bytes.length; start += sliceSize) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + sliceSize, bytes.length)));
  }
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "",
    byteCount,
    bodyBase64: btoa(binary),
    decodedWidth,
    decodedHeight,
  };
}
