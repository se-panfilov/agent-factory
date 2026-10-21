import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface HttpGetOptions {
  url: string;
  timeoutMs: number;
  deadlineMs: number;
  maxBodyBytes: number;
}

export interface HttpAdapter {
  get(options: HttpGetOptions): Promise<HttpResponse>;
}

const RETRYABLE_STATUS = new Set([429, 500, 503]);

function canRetryStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS.has(statusCode);
}

function shouldRetryError(error: NodeJS.ErrnoException): boolean {
  const code = error.code ?? "";
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

function retryDelayMs(attempt: number, retryAfterHeader: string | string[] | undefined): number {
  if (retryAfterHeader !== undefined) {
    const value = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const seconds = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  return attempt === 0 ? 2_000 : 5_000;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class NodeHttpAdapter implements HttpAdapter {
  async get(options: HttpGetOptions): Promise<HttpResponse> {
    const started = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 3 && Date.now() - started < options.deadlineMs) {
      try {
        const response = await this.requestOnce(options);
        if (canRetryStatus(response.statusCode) && attempt < 2) {
          const delay = retryDelayMs(attempt, response.headers["retry-after"]);
          await sleep(delay);
          attempt += 1;
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= 2 || !(error instanceof Error) || !shouldRetryError(error as NodeJS.ErrnoException)) {
          throw error;
        }
        const delay = retryDelayMs(attempt, undefined);
        await sleep(delay);
      }
      attempt += 1;
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("HTTP GET deadline exceeded");
  }

  private requestOnce(options: HttpGetOptions): Promise<HttpResponse> {
    const requestUrl = new URL(options.url);
    const transport = requestUrl.protocol === "https:" ? https : http;

    return new Promise<HttpResponse>((resolve, reject) => {
      const req = transport.request(
        requestUrl,
        {
          method: "GET",
          timeout: options.timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bodySize = 0;
          res.on("data", (chunk: Buffer) => {
            bodySize += chunk.byteLength;
            if (bodySize > options.maxBodyBytes) {
              req.destroy(new Error("HTTP body exceeds max size bound"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
        }
      );

      req.on("timeout", () => req.destroy(new Error("HTTP request timed out")));
      req.on("error", (error) => reject(error));
      req.end();
    });
  }
}
