import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildContentDisposition } from '../shared/dance';
import type { Env } from './env';

const DEFAULT_BUCKET_NAME = 'mom-dance-videos';
const PRESIGN_EXPIRES_SECONDS = 3600; // 1 小时有效期，兼容大文件慢网速上传与下载

function resolveEndpoint(rawAccountOrEndpoint: string): string {
  const trimmed = rawAccountOrEndpoint.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  const cleanAccountId = trimmed.replace(/\.r2\.cloudflarestorage\.com$/i, '');
  return `https://${cleanAccountId}.r2.cloudflarestorage.com`;
}

export function getBucketName(env: Env): string {
  return env.R2_BUCKET_NAME?.trim() || DEFAULT_BUCKET_NAME;
}

export function createR2S3Client(env: Env): S3Client {
  if (!env.R2_ACCOUNT_ID?.trim() || !env.R2_ACCESS_KEY_ID?.trim() || !env.R2_SECRET_ACCESS_KEY?.trim()) {
    throw new Error(
      '服务端缺少 R2 S3 API 凭证配置（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）'
    );
  }

  return new S3Client({
    region: 'auto',
    endpoint: resolveEndpoint(env.R2_ACCOUNT_ID),
    forcePathStyle: true, // 使用路径样式 (endpoint/bucket/key)，避免两级子域名引发浏览器 ERR_SSL_VERSION_OR_CIPHER_MISMATCH
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID.trim(),
      secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(),
    },
    // 禁用 AWS SDK v3 默认附加的空包 CRC32 校验参数，确保浏览器 XHR 直传 Cloudflare R2 签名一致
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function createPresignedUploadUrl(
  env: Env,
  objectKey: string,
  contentType: string
): Promise<string> {
  const s3 = createR2S3Client(env);
  const command = new PutObjectCommand({
    Bucket: getBucketName(env),
    Key: objectKey,
    ContentType: contentType,
  });

  return getSignedUrl(s3, command, { expiresIn: PRESIGN_EXPIRES_SECONDS });
}

export async function createPresignedDownloadUrl(
  env: Env,
  objectKey: string,
  fileName: string
): Promise<string> {
  const s3 = createR2S3Client(env);
  const command = new GetObjectCommand({
    Bucket: getBucketName(env),
    Key: objectKey,
    ResponseContentDisposition: buildContentDisposition(fileName),
  });

  return getSignedUrl(s3, command, { expiresIn: PRESIGN_EXPIRES_SECONDS });
}

export async function listAllObjectsByPrefix(
  bucket: R2Bucket,
  prefix: string
): Promise<R2Object[]> {
  if (!bucket) {
    throw new Error('服务端未绑定 R2 存储桶 (BUCKET)，请在 Cloudflare Pages 设置中绑定 mom-dance-videos');
  }

  const allObjects: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix,
      cursor,
    });
    allObjects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return allObjects;
}
