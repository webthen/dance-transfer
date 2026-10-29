import { jsonResponse, type Env } from '../../../server/env';
import { extractFileNameFromKey, isValidVideoObjectKey } from '../../../shared/dance';

const MAX_SINGLE_CHUNK_BYTES = 16 * 1024 * 1024; // 单片最大允许 16MB，远低于 Worker 100MB 限制

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const key = url.searchParams.get('key') || '';
  if (!isValidVideoObjectKey(key)) {
    return jsonResponse({ error: '非法的视频标识 key' }, 400);
  }

  const mode = url.searchParams.get('mode') || 'single';
  const contentType = url.searchParams.get('contentType')?.trim() || 'video/mp4';
  const fileName = url.searchParams.get('fileName')?.trim() || extractFileNameFromKey(key);

  const buf = await request.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    return jsonResponse({ error: '上传的分片数据为空' }, 400);
  }

  if (buf.byteLength > MAX_SINGLE_CHUNK_BYTES) {
    return jsonResponse({ error: '单个分片体积超出上限' }, 413);
  }

  if (mode === 'single') {
    const obj = await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType },
      customMetadata: {
        fileName: encodeURIComponent(fileName),
      },
    });
    return jsonResponse({
      done: true,
      partNumber: 1,
      etag: obj.etag,
    });
  }

  if (mode === 'multipart') {
    const uploadId = url.searchParams.get('uploadId')?.trim() || '';
    const partNumber = Number(url.searchParams.get('partNumber'));

    if (!uploadId) {
      return jsonResponse({ error: '缺少分段上传标识 uploadId' }, 400);
    }

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return jsonResponse({ error: '非法的分片序号 partNumber' }, 400);
    }

    const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const uploaded = await multipart.uploadPart(partNumber, buf);

    return jsonResponse({
      done: false,
      partNumber: uploaded.partNumber,
      etag: uploaded.etag,
    });
  }

  return jsonResponse({ error: '不支持的上传模式 mode' }, 400);
};
