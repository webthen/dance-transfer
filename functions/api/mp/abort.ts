import { jsonResponse, type Env } from '../../../server/env';
import { isValidVideoObjectKey } from '../../../shared/dance';

interface AbortBody {
  objectKey?: string;
  uploadId?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: AbortBody;
  try {
    body = (await request.json()) as AbortBody;
  } catch {
    return jsonResponse({ error: '请求参数格式不正确（需为 JSON）' }, 400);
  }

  const objectKey = body.objectKey || '';
  const uploadId = body.uploadId?.trim() || '';

  if (!isValidVideoObjectKey(objectKey) || !uploadId) {
    return jsonResponse({ error: '缺少合法的 objectKey 或 uploadId' }, 400);
  }

  try {
    const multipart = env.BUCKET.resumeMultipartUpload(objectKey, uploadId);
    await multipart.abort();
  } catch {
    // 若分段任务已结束或已取消，忽略幂等异常
  }

  return jsonResponse({ success: true });
};
