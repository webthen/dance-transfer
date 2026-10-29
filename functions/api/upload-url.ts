import { jsonResponse, type Env } from '../../server/env';
import { createPresignedUploadUrl, listAllObjectsByPrefix } from '../../server/r2';
import {
  MAX_FILE_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  VIDEO_PREFIX,
  getBeijingDateString,
  normalizeFileExt,
  resolveUniqueSameDayObject,
  sanitizeDanceName,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from '../../shared/dance';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: Partial<UploadUrlRequest>;
  try {
    body = (await request.json()) as Partial<UploadUrlRequest>;
  } catch {
    return jsonResponse({ error: '请求参数格式不正确（需为 JSON）' }, 400);
  }

  const cleanDanceName = sanitizeDanceName(body.danceName || '');
  if (!cleanDanceName) {
    return jsonResponse({ error: '请先填写舞蹈名字' }, 400);
  }

  const fileSize = Number(body.fileSize);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return jsonResponse({ error: '视频文件大小无效' }, 400);
  }

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    return jsonResponse({ error: OVERSIZE_ERROR_MESSAGE }, 400);
  }

  const contentType =
    typeof body.contentType === 'string' && body.contentType.trim()
      ? body.contentType.trim()
      : 'video/mp4';

  const cleanExt = normalizeFileExt(body.fileExt, contentType);
  const todayStr = getBeijingDateString();
  const todayPrefix = `${VIDEO_PREFIX}${todayStr}/`;

  // 检查同一天已存在的同名视频，若同名自动追加 _(2)、_(3)
  const todayObjects = await listAllObjectsByPrefix(env.BUCKET, todayPrefix);
  const existingKeys = new Set(todayObjects.map((obj) => obj.key));

  const { objectKey, fileName, danceTitle } = resolveUniqueSameDayObject(
    cleanDanceName,
    cleanExt,
    todayStr,
    existingKeys
  );

  const uploadUrl = await createPresignedUploadUrl(env, objectKey, contentType);

  const responseData: UploadUrlResponse = {
    uploadUrl,
    objectKey,
    fileName,
    danceTitle,
    contentType,
  };

  return jsonResponse(responseData);
};
