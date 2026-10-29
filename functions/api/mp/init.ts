import { jsonResponse, type Env } from '../../../server/env';
import { listAllObjectsByPrefix } from '../../../server/r2';
import {
  MAX_FILE_SIZE_BYTES,
  MP_PART_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  VIDEO_PREFIX,
  getBeijingDateString,
  normalizeFileExt,
  resolveUniqueSameDayObject,
  sanitizeDanceName,
  type MpUploadInitResponse,
  type UploadUrlRequest,
} from '../../../shared/dance';

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
    return jsonResponse({ error: '请先填写舞蹈名称' }, 400);
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

  // 1. 严格校验 7.0GB 安全存储总限额
  const allObjects = await listAllObjectsByPrefix(env.BUCKET, VIDEO_PREFIX);
  const currentTotalBytes = allObjects.reduce((acc, obj) => acc + (obj.size || 0), 0);
  const maxStorageGb =
    Number(env.MAX_TOTAL_STORAGE_GB) > 0 ? Number(env.MAX_TOTAL_STORAGE_GB) : 7.0;
  const maxStorageBytes = maxStorageGb * 1024 * 1024 * 1024;

  if (currentTotalBytes + fileSize > maxStorageBytes) {
    const usedGb = (currentTotalBytes / (1024 * 1024 * 1024)).toFixed(2);
    return jsonResponse(
      {
        error: `云端存储空间已满（已用 ${usedGb}GB / 7.0GB 安全限额），请先在管理端清理已下载的视频`,
      },
      400
    );
  }

  // 2. 同一天同名视频自动防覆盖追加 _(2)、_(3)
  const existingKeys = new Set(
    allObjects.filter((obj) => obj.key.startsWith(todayPrefix)).map((obj) => obj.key)
  );

  const { objectKey, fileName, danceTitle } = resolveUniqueSameDayObject(
    cleanDanceName,
    cleanExt,
    todayStr,
    existingKeys
  );

  // 3. 小于等于单个分片 (8MB) 走单次写入；大于 8MB 开启 R2 原生分段上传
  if (fileSize <= MP_PART_SIZE_BYTES) {
    const singleRes: MpUploadInitResponse = {
      mode: 'single',
      objectKey,
      uploadId: '',
      partSize: MP_PART_SIZE_BYTES,
      totalParts: 1,
      fileName,
      danceTitle,
      contentType,
    };
    return jsonResponse(singleRes);
  }

  const multipart = await env.BUCKET.createMultipartUpload(objectKey, {
    httpMetadata: { contentType },
    customMetadata: {
      fileName: encodeURIComponent(fileName),
      danceTitle: encodeURIComponent(danceTitle),
    },
  });

  const multiRes: MpUploadInitResponse = {
    mode: 'multipart',
    objectKey,
    uploadId: multipart.uploadId,
    partSize: MP_PART_SIZE_BYTES,
    totalParts: Math.ceil(fileSize / MP_PART_SIZE_BYTES),
    fileName,
    danceTitle,
    contentType,
  };

  return jsonResponse(multiRes);
};
