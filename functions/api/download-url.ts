import { jsonResponse, type Env } from '../../server/env';
import { createPresignedDownloadUrl } from '../../server/r2';
import {
  extractFileNameFromKey,
  isValidVideoObjectKey,
  type DownloadUrlResponse,
} from '../../shared/dance';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!isValidVideoObjectKey(key)) {
    return jsonResponse({ error: '非法的视频标识 key' }, 400);
  }

  const headObj = await env.BUCKET.head(key);
  if (!headObj) {
    return jsonResponse({ error: '该视频不存在或已被清理' }, 404);
  }

  let fileName = extractFileNameFromKey(key);
  if (headObj.customMetadata?.fileName) {
    try {
      fileName = decodeURIComponent(headObj.customMetadata.fileName);
    } catch {
      fileName = headObj.customMetadata.fileName;
    }
  }

  const downloadUrl = await createPresignedDownloadUrl(env, key, fileName);

  const responseData: DownloadUrlResponse = {
    downloadUrl,
    fileName,
    key,
  };

  return jsonResponse(responseData);
};
