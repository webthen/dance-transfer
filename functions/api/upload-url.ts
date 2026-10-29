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

  // 1. 获取当前所有视频对象，统计总存储容量，严格锁死在安全限额内（默认 7.0GB，留出 3GB 绝对安全缓冲防扣费）
  const allObjects = await listAllObjectsByPrefix(env.BUCKET, VIDEO_PREFIX);
  const currentTotalBytes = allObjects.reduce((acc, obj) => acc + (obj.size || 0), 0);
  const maxStorageGb = Number(env.MAX_TOTAL_STORAGE_GB) > 0 ? Number(env.MAX_TOTAL_STORAGE_GB) : 7.0;
  const maxStorageBytes = maxStorageGb * 1024 * 1024 * 1024;

  if (currentTotalBytes + fileSize > maxStorageBytes) {
    const usedGb = (currentTotalBytes / (1024 * 1024 * 1024)).toFixed(2);
    return jsonResponse(
      {
        error: `云端存储空间已满（已用 ${usedGb}GB / 7GB 安全限额），请先提醒儿子在电脑管理端清空已下载的视频哦`,
      },
      400
    );
  }

  // 2. 检查同一天已存在的同名视频，若同名自动追加 _(2)、_(3)
  const existingKeys = new Set(
    allObjects.filter((obj) => obj.key.startsWith(todayPrefix)).map((obj) => obj.key)
  );

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

  return jsonResponse(responseData, 200, {
    'x-app-version': '1.0.2-account-id-fix',
  });
};
