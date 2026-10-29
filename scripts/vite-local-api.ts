import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { onRequest as authMiddleware } from '../functions/api/_middleware';
import { onRequestPost as uploadUrlPost } from '../functions/api/upload-url';
import {
  onRequestDelete as videosDelete,
  onRequestGet as videosGet,
} from '../functions/api/videos';
import { onRequestGet as downloadUrlGet } from '../functions/api/download-url';
import type { Env } from '../server/env';
import { createR2S3Client, getBucketName } from '../server/r2';
import {
  MAX_FILE_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  VIDEO_PREFIX,
  buildContentDisposition,
  extractFileNameFromKey,
  getBeijingDateString,
  isValidVideoObjectKey,
  normalizeFileExt,
  resolveUniqueSameDayObject,
  sanitizeDanceName,
} from '../shared/dance';

function parseDevVars(rootDir: string): Record<string, string> {
  const varsPath = path.join(rootDir, '.dev.vars');
  const result: Record<string, string> = {};
  if (!fs.existsSync(varsPath)) return result;

  const content = fs.readFileSync(varsPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    result[key] = val;
  }
  return result;
}

function hasRealR2Credentials(vars: Record<string, string>): boolean {
  const acc = vars.R2_ACCOUNT_ID || '';
  const ak = vars.R2_ACCESS_KEY_ID || '';
  const sk = vars.R2_SECRET_ACCESS_KEY || '';
  return Boolean(
    acc &&
      ak &&
      sk &&
      !acc.startsWith('your_') &&
      !ak.startsWith('your_') &&
      !sk.startsWith('your_')
  );
}

/**
 * 基于真实 S3 API 模拟 Cloudflare Pages R2Bucket 绑定（供本地 Vite 直连远程真实 R2 存储桶调试）
 */
function createRemoteS3R2BucketAdapter(env: Env) {
  const s3 = createR2S3Client(env);
  const bucketName = getBucketName(env);

  return {
    async list(options?: { prefix?: string; cursor?: string }) {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: options?.prefix,
          ContinuationToken: options?.cursor,
        })
      );
      const objects = (res.Contents || []).map((item) => ({
        key: item.Key || '',
        size: item.Size || 0,
        uploaded: item.LastModified || new Date(),
        etag: (item.ETag || '').replace(/"/g, ''),
        httpEtag: item.ETag || '',
      }));
      return {
        objects,
        truncated: Boolean(res.IsTruncated),
        cursor: res.NextContinuationToken,
        delimitedPrefixes: [],
      };
    },
    async head(key: string) {
      try {
        const res = await s3.send(
          new HeadObjectCommand({
            Bucket: bucketName,
            Key: key,
          })
        );
        return {
          key,
          size: res.ContentLength || 0,
          uploaded: res.LastModified || new Date(),
          etag: (res.ETag || '').replace(/"/g, ''),
          httpEtag: res.ETag || '',
          customMetadata: res.Metadata,
        };
      } catch {
        return null;
      }
    },
    async delete(keys: string | string[]) {
      const arr = Array.isArray(keys) ? keys : [keys];
      if (arr.length === 0) return;
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: arr.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
    },
  };
}

interface LocalObjectMeta {
  key: string;
  fileName: string;
  size: number;
  uploadedAt: string;
  etag: string;
  contentType: string;
  diskFile: string;
}

/**
 * 零配置本地磁盘 R2 沙盒（未配置真实 R2 凭证时开箱即用，完整验证 XHR 进度条与中文名下载）
 */
class LocalDiskSandbox {
  private dir: string;
  private metaPath: string;
  public items = new Map<string, LocalObjectMeta>();

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, '.wrangler', 'local-r2-sandbox');
    this.metaPath = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.metaPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf-8')) as LocalObjectMeta[];
        for (const item of raw) {
          if (fs.existsSync(path.join(this.dir, item.diskFile))) {
            this.items.set(item.key, item);
          }
        }
      } catch {
        // 忽略旧沙盒索引异常
      }
    }
  }

  private persist() {
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify(Array.from(this.items.values()), null, 2),
      'utf-8'
    );
  }

  saveBuffer(key: string, buf: Buffer, contentType: string) {
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const diskFile = `${crypto.createHash('sha1').update(key).digest('hex')}.bin`;
    fs.writeFileSync(path.join(this.dir, diskFile), buf);
    const meta: LocalObjectMeta = {
      key,
      fileName: extractFileNameFromKey(key),
      size: buf.length,
      uploadedAt: new Date().toISOString(),
      etag: `"${hash}"`,
      contentType,
      diskFile,
    };
    this.items.set(key, meta);
    this.persist();
  }

  getFilePath(key: string): { meta: LocalObjectMeta; fullPath: string } | null {
    const meta = this.items.get(key);
    if (!meta) return null;
    const fullPath = path.join(this.dir, meta.diskFile);
    if (!fs.existsSync(fullPath)) return null;
    return { meta, fullPath };
  }

  asR2Bucket() {
    const self = this;
    return {
      async list(options?: { prefix?: string }) {
        const prefix = options?.prefix || '';
        const objects = Array.from(self.items.values())
          .filter((item) => item.key.startsWith(prefix))
          .map((item) => ({
            key: item.key,
            size: item.size,
            uploaded: new Date(item.uploadedAt),
            etag: item.etag.replace(/"/g, ''),
            httpEtag: item.etag,
          }));
        return { objects, truncated: false, delimitedPrefixes: [] };
      },
      async head(key: string) {
        const item = self.items.get(key);
        if (!item) return null;
        return {
          key: item.key,
          size: item.size,
          uploaded: new Date(item.uploadedAt),
          etag: item.etag.replace(/"/g, ''),
          httpEtag: item.etag,
        };
      },
      async delete(keys: string | string[]) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          const item = self.items.get(k);
          if (item) {
            const p = path.join(self.dir, item.diskFile);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            self.items.delete(k);
          }
        }
        self.persist();
      },
    };
  }
}

function readNodeRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function sendWebResponseToNode(webRes: Response, res: ServerResponse) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const arrayBuf = await webRes.arrayBuffer();
  res.end(Buffer.from(arrayBuf));
}

export function momDanceLocalApiPlugin(): Plugin {
  return {
    name: 'mom-dance-local-pages-functions',
    configureServer(server) {
      const rootDir = server.config.root;
      const sandbox = new LocalDiskSandbox(rootDir);

      server.middlewares.use(async (req, res, next) => {
        const reqUrl = req.url || '';

        // 本地沙盒直传 PUT 与附件下载 GET 模拟端点
        if (reqUrl.startsWith('/__local-r2/put')) {
          const parsed = new URL(reqUrl, `http://${req.headers.host || 'localhost:5173'}`);
          const key = parsed.searchParams.get('key') || '';
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== 'PUT' || !isValidVideoObjectKey(key)) {
            res.statusCode = 400;
            res.end('Invalid local R2 PUT request');
            return;
          }
          const buf = await readNodeRequestBody(req);
          if (buf.length > MAX_FILE_SIZE_BYTES) {
            res.statusCode = 413;
            res.end(OVERSIZE_ERROR_MESSAGE);
            return;
          }
          const ct = String(req.headers['content-type'] || 'video/mp4');
          sandbox.saveBuffer(key, buf, ct);
          res.statusCode = 200;
          res.setHeader('ETag', `"local-${buf.length}"`);
          res.end();
          return;
        }

        if (reqUrl.startsWith('/__local-r2/get')) {
          const parsed = new URL(reqUrl, `http://${req.headers.host || 'localhost:5173'}`);
          const key = parsed.searchParams.get('key') || '';
          const found = sandbox.getFilePath(key);
          if (!found) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', found.meta.contentType);
          res.setHeader('Content-Length', String(found.meta.size));
          res.setHeader('Content-Disposition', buildContentDisposition(found.meta.fileName));
          fs.createReadStream(found.fullPath).pipe(res);
          return;
        }

        if (!reqUrl.startsWith('/api/')) {
          next();
          return;
        }

        const devVars = parseDevVars(rootDir);
        const useRealR2 = hasRealR2Credentials(devVars);
        const origin = `http://${req.headers.host || 'localhost:5173'}`;
        const fullUrl = new URL(reqUrl, origin);

        const env: Env = {
          ACCESS_PIN: devVars.ACCESS_PIN || process.env.ACCESS_PIN || 'mom666',
          R2_ACCOUNT_ID: devVars.R2_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || '',
          R2_ACCESS_KEY_ID: devVars.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
          R2_SECRET_ACCESS_KEY:
            devVars.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '',
          R2_BUCKET_NAME:
            devVars.R2_BUCKET_NAME || process.env.R2_BUCKET_NAME || 'mom-dance-videos',
          BUCKET: undefined as unknown as R2Bucket,
        };

        env.BUCKET = (
          useRealR2 ? createRemoteS3R2BucketAdapter(env) : sandbox.asR2Bucket()
        ) as unknown as R2Bucket;

        const method = (req.method || 'GET').toUpperCase();
        const rawBody =
          method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
            ? undefined
            : await readNodeRequestBody(req);

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) headers.set(k, v.join(', '));
          else if (typeof v === 'string') headers.set(k, v);
        }

        const webReq = new Request(fullUrl.toString(), {
          method,
          headers,
          body: rawBody ? new Uint8Array(rawBody) : undefined,
        });

        const dispatchRoute = async (): Promise<Response> => {
          const pathname = fullUrl.pathname;

          if (pathname === '/api/upload-url' && method === 'POST') {
            if (useRealR2) {
              return uploadUrlPost({ request: webReq, env } as never);
            }
            // 本地沙盒模式：复用完全一致的校验与重名 _(2) 处理，返回本地直传 URL
            const body = (await webReq.json().catch(() => ({}))) as Record<string, unknown>;
            const cleanDanceName = sanitizeDanceName(String(body.danceName || ''));
            if (!cleanDanceName) {
              return Response.json({ error: '请先填写舞蹈名字' }, { status: 400 });
            }
            const fileSize = Number(body.fileSize);
            if (!Number.isFinite(fileSize) || fileSize <= 0) {
              return Response.json({ error: '视频文件大小无效' }, { status: 400 });
            }
            if (fileSize > MAX_FILE_SIZE_BYTES) {
              return Response.json({ error: OVERSIZE_ERROR_MESSAGE }, { status: 400 });
            }
            const contentType =
              typeof body.contentType === 'string' && body.contentType.trim()
                ? body.contentType.trim()
                : 'video/mp4';
            const cleanExt = normalizeFileExt(String(body.fileExt || ''), contentType);
            const today = getBeijingDateString();
            const todayPrefix = `${VIDEO_PREFIX}${today}/`;

            const listed = await env.BUCKET.list({ prefix: VIDEO_PREFIX });
            const currentTotalBytes = listed.objects.reduce((acc, obj) => acc + (obj.size || 0), 0);
            const maxStorageGb = Number(env.MAX_TOTAL_STORAGE_GB) > 0 ? Number(env.MAX_TOTAL_STORAGE_GB) : 7.0;
            const maxStorageBytes = maxStorageGb * 1024 * 1024 * 1024;

            if (currentTotalBytes + fileSize > maxStorageBytes) {
              const usedGb = (currentTotalBytes / (1024 * 1024 * 1024)).toFixed(2);
              return Response.json(
                {
                  error: `云端存储空间已满（已用 ${usedGb}GB / 7GB 安全限额），请先提醒儿子在电脑管理端清空已下载的视频哦`,
                },
                { status: 400 }
              );
            }

            const existingKeys = new Set(
              listed.objects.filter((o) => o.key.startsWith(todayPrefix)).map((o) => o.key)
            );
            const resolved = resolveUniqueSameDayObject(
              cleanDanceName,
              cleanExt,
              today,
              existingKeys
            );
            return Response.json({
              uploadUrl: `${origin}/__local-r2/put?key=${encodeURIComponent(resolved.objectKey)}`,
              objectKey: resolved.objectKey,
              fileName: resolved.fileName,
              danceTitle: resolved.danceTitle,
              contentType,
            });
          }

          if (pathname === '/api/videos' && method === 'GET') {
            return videosGet({ request: webReq, env } as never);
          }

          if (pathname === '/api/videos' && method === 'DELETE') {
            return videosDelete({ request: webReq, env } as never);
          }

          if (pathname === '/api/download-url' && method === 'GET') {
            if (useRealR2) {
              return downloadUrlGet({ request: webReq, env } as never);
            }
            const key = fullUrl.searchParams.get('key') || '';
            if (!isValidVideoObjectKey(key)) {
              return Response.json({ error: '非法的视频标识 key' }, { status: 400 });
            }
            const headObj = await env.BUCKET.head(key);
            if (!headObj) {
              return Response.json({ error: '该视频不存在或已被清理' }, { status: 404 });
            }
            const fileName = extractFileNameFromKey(key);
            return Response.json({
              downloadUrl: `${origin}/__local-r2/get?key=${encodeURIComponent(key)}`,
              fileName,
              key,
            });
          }

          return Response.json({ error: 'Not Found' }, { status: 404 });
        };

        const finalWebRes = await authMiddleware({
          request: webReq,
          env,
          params: {},
          data: {},
          functionPath: '',
          waitUntil: () => {},
          passThroughOnException: () => {},
          next: dispatchRoute,
        } as never);

        await sendWebResponseToNode(finalWebRes, res);
      });
    },
  };
}
