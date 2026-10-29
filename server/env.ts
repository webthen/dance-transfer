export interface Env {
  BUCKET: R2Bucket;
  ACCESS_PIN: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME?: string;
  MAX_TOTAL_STORAGE_GB?: string; // 可选，默认 7.0GB（严格保护在 Cloudflare 10GB 免费层以内，预留 3GB 安全缓冲）
}

export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
