import { jsonResponse, type Env } from '../../../server/env';
import { isValidVideoObjectKey, type MpUploadedPartInfo } from '../../../shared/dance';

interface CompleteBody {
  objectKey?: string;
  uploadId?: string;
  parts?: MpUploadedPartInfo[];
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: CompleteBody;
  try {
    body = (await request.json()) as CompleteBody;
  } catch {
    return jsonResponse({ error: '请求参数格式不正确（需为 JSON）' }, 400);
  }

  const objectKey = body.objectKey || '';
  if (!isValidVideoObjectKey(objectKey)) {
    return jsonResponse({ error: '非法的视频标识 objectKey' }, 400);
  }

  const uploadId = body.uploadId?.trim() || '';
  if (!uploadId) {
    return jsonResponse({ error: '缺少分段上传标识 uploadId' }, 400);
  }

  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return jsonResponse({ error: '缺少分片列表 parts' }, 400);
  }

  const normalizedParts: R2UploadedPart[] = [];
  for (const item of body.parts) {
    const partNumber = Number(item?.partNumber);
    const etag = typeof item?.etag === 'string' ? item.etag.trim() : '';
    if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) {
      return jsonResponse({ error: '分片校验信息不完整' }, 400);
    }
    normalizedParts.push({ partNumber, etag });
  }

  normalizedParts.sort((a, b) => a.partNumber - b.partNumber);

  const multipart = env.BUCKET.resumeMultipartUpload(objectKey, uploadId);
  const completedObj = await multipart.complete(normalizedParts);

  return jsonResponse({
    success: true,
    objectKey,
    size: completedObj.size,
    etag: completedObj.etag,
  });
};
