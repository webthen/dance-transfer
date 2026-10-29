import { jsonResponse, type Env } from '../../server/env';
import { listAllObjectsByPrefix } from '../../server/r2';
import {
  VIDEO_PREFIX,
  extractFileNameFromKey,
  isValidVideoObjectKey,
  type VideoItem,
} from '../../shared/dance';

function resolveObjectFileName(obj: R2Object): string {
  const metaName = obj.customMetadata?.fileName;
  if (metaName) {
    try {
      return decodeURIComponent(metaName);
    } catch {
      return metaName;
    }
  }
  return extractFileNameFromKey(obj.key);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  const objects = await listAllObjectsByPrefix(env.BUCKET, VIDEO_PREFIX);

  const videos: VideoItem[] = objects
    .filter((obj) => isValidVideoObjectKey(obj.key))
    .map((obj) => ({
      key: obj.key,
      fileName: resolveObjectFileName(obj),
      size: obj.size,
      uploadedAt: obj.uploaded.toISOString(),
      etag: obj.httpEtag || obj.etag,
    }))
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

  return jsonResponse(videos);
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: { keys?: unknown };
  try {
    body = (await request.json()) as { keys?: unknown };
  } catch {
    return jsonResponse({ error: '请求参数格式不正确（需为 JSON）' }, 400);
  }

  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    return jsonResponse({ error: '请提供要删除的视频 keys 数组' }, 400);
  }

  const validKeys: string[] = [];
  for (const key of body.keys) {
    if (!isValidVideoObjectKey(key)) {
      return jsonResponse({ error: '包含非法的对象 key，仅允许删除 videos/ 下的视频' }, 400);
    }
    validKeys.push(key);
  }

  // Cloudflare R2 单次批量删除上限为 1000 个 key，分片执行
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < validKeys.length; i += CHUNK_SIZE) {
    const chunk = validKeys.slice(i, i + CHUNK_SIZE);
    await env.BUCKET.delete(chunk);
  }

  return jsonResponse({
    success: true,
    deletedCount: validKeys.length,
  });
};
