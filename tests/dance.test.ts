import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  appendDanceSuffix,
  buildContentDisposition,
  extractFileExtFromFileName,
  formatFileSizeMB,
  formatUploadTime,
  getBeijingDateString,
  isValidVideoObjectKey,
  resolveUniqueSameDayObject,
  sanitizeDanceName,
} from '../shared/dance';
import { onRequest as authMiddleware } from '../functions/api/_middleware';
import { onRequestPost as uploadUrlPost } from '../functions/api/upload-url';
import {
  onRequestDelete as videosDelete,
  onRequestGet as videosGet,
} from '../functions/api/videos';
import { onRequestGet as downloadUrlGet } from '../functions/api/download-url';
import type { Env } from '../server/env';

class FakeR2Bucket {
  public store = new Map<
    string,
    { key: string; size: number; uploaded: Date; etag: string; httpEtag: string }
  >();

  seed(key: string, size: number, uploaded: Date) {
    const etag = `etag-${key}-${size}`;
    this.store.set(key, {
      key,
      size,
      uploaded,
      etag,
      httpEtag: `"${etag}"`,
    });
  }

  async list(options?: { prefix?: string; cursor?: string }) {
    const prefix = options?.prefix || '';
    const objects = Array.from(this.store.values()).filter((item) =>
      item.key.startsWith(prefix)
    );
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    };
  }

  async head(key: string) {
    return this.store.get(key) || null;
  }

  async delete(keys: string | string[]) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) {
      this.store.delete(k);
    }
  }
}

function createTestEnv(bucket: FakeR2Bucket): Env {
  return {
    BUCKET: bucket as unknown as R2Bucket,
    ACCESS_PIN: 'mom666',
    R2_ACCOUNT_ID: 'testaccount123456',
    R2_ACCESS_KEY_ID: 'testAccessKeyId',
    R2_SECRET_ACCESS_KEY: 'testSecretAccessKey',
    R2_BUCKET_NAME: 'mom-dance-videos',
  };
}

function makePagesContext(request: Request, env: Env, nextFn?: () => Promise<Response>) {
  return {
    request,
    env,
    params: {},
    data: {},
    functionPath: '',
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: nextFn || (async () => new Response('ok')),
  } as unknown as Parameters<typeof authMiddleware>[0];
}

describe('shared/dance utilities', () => {
  it('sanitizes illegal characters and whitespace in danceName', () => {
    expect(sanitizeDanceName('  苹果香  ')).toBe('苹果香');
    expect(sanitizeDanceName('苹果香/背面\\教学:慢速*?"<>|\n第二段')).toBe(
      '苹果香_背面_教学_慢速_第二段'
    );
    expect(sanitizeDanceName('   ')).toBe('');
    expect(sanitizeDanceName('早安隆回...')).toBe('早安隆回');
  });

  it('appends quick suffixes cleanly without duplicate double-taps', () => {
    let val = '苹果香';
    val = appendDanceSuffix(val, '背面');
    expect(val).toBe('苹果香_背面');
    // 连续误触同一标签不重复追加
    val = appendDanceSuffix(val, '背面');
    expect(val).toBe('苹果香_背面');
    // 追加其他标签正常拼接
    val = appendDanceSuffix(val, '慢速');
    expect(val).toBe('苹果香_背面_慢速');
    // 空输入框直接填入
    expect(appendDanceSuffix('', '+分解教学')).toBe('分解教学');
  });

  it('extracts and normalizes file extensions', () => {
    expect(extractFileExtFromFileName('wx_camera_001.MP4', 'video/mp4')).toBe('.mp4');
    expect(extractFileExtFromFileName('IMG_8899.MOV', 'video/quicktime')).toBe('.mov');
    expect(extractFileExtFromFileName('wechat_video_no_ext', 'video/quicktime')).toBe('.mov');
    expect(extractFileExtFromFileName('wechat_video_no_ext', '')).toBe('.mp4');
  });

  it('resolves same-day duplicate names with _(2), _(3)', () => {
    const existing = new Set<string>([
      'videos/2026-10-29/苹果香_背面.mp4',
      'videos/2026-10-29/苹果香_背面_(2).mp4',
    ]);
    const res = resolveUniqueSameDayObject('苹果香_背面', '.mp4', '2026-10-29', existing);
    expect(res.fileName).toBe('苹果香_背面_(3).mp4');
    expect(res.danceTitle).toBe('苹果香_背面_(3)');
    expect(res.objectKey).toBe('videos/2026-10-29/苹果香_背面_(3).mp4');

    // 次日不冲突
    const nextDay = resolveUniqueSameDayObject('苹果香_背面', '.mp4', '2026-10-30', existing);
    expect(nextDay.fileName).toBe('苹果香_背面.mp4');
    expect(nextDay.objectKey).toBe('videos/2026-10-30/苹果香_背面.mp4');
  });

  it('builds RFC5987 Content-Disposition attachment header for Chinese and deduplicated names', () => {
    const disp1 = buildContentDisposition('苹果香_背面.mp4');
    expect(disp1).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('苹果香_背面.mp4')}`);

    const disp2 = buildContentDisposition('苹果香_背面_(2).mp4');
    expect(disp2.startsWith("attachment; filename*=UTF-8''")).toBe(true);
    const encodedPart = disp2.replace("attachment; filename*=UTF-8''", '');
    expect(encodedPart).not.toContain('(');
    expect(encodedPart).not.toContain(')');
    expect(decodeURIComponent(encodedPart)).toBe('苹果香_背面_(2).mp4');
  });

  it('validates video object keys strictly under videos/', () => {
    expect(isValidVideoObjectKey('videos/2026-10-29/苹果香.mp4')).toBe(true);
    expect(isValidVideoObjectKey('videos/')).toBe(false);
    expect(isValidVideoObjectKey('other/苹果香.mp4')).toBe(false);
    expect(isValidVideoObjectKey('videos/../secret.txt')).toBe(false);
  });

  it('formats file size and upload time accurately', () => {
    expect(formatFileSizeMB(128.5 * 1024 * 1024)).toBe('128.5 MB');
    expect(formatUploadTime('2026-10-28T11:30:00.000Z')).toBe('10月28日 19:30');
  });
});

describe('Cloudflare Pages Functions API', () => {
  it('blocks unauthorized requests with 401 when x-access-pin mismatches', async () => {
    const bucket = new FakeR2Bucket();
    const env = createTestEnv(bucket);

    const badReq = new Request('https://example.com/api/videos', {
      headers: { 'x-access-pin': 'wrong' },
    });
    const res1 = await authMiddleware(makePagesContext(badReq, env));
    expect(res1.status).toBe(401);

    const okReq = new Request('https://example.com/api/videos', {
      headers: { 'x-access-pin': 'mom666' },
    });
    const res2 = await authMiddleware(
      makePagesContext(okReq, env, async () => new Response('authorized', { status: 200 }))
    );
    expect(res2.status).toBe(200);
  });

  it('validates 500MB limit and deduplicates same-day names on POST /api/upload-url', async () => {
    const bucket = new FakeR2Bucket();
    const env = createTestEnv(bucket);

    // 存储桶达到上限时自动拦截（防超出免费额度）
    env.MAX_TOTAL_STORAGE_GB = '1'; // 模拟设置为 1GB
    bucket.seed('videos/2026-10-28/old_large_dance.mp4', 1024 * 1024 * 1024, new Date());
    const quotaReq = new Request('https://example.com/api/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        danceName: '苹果香',
        fileExt: '.mp4',
        fileSize: 10 * 1024 * 1024,
        contentType: 'video/mp4',
      }),
    });
    const quotaRes = await uploadUrlPost(makePagesContext(quotaReq, env));
    expect(quotaRes.status).toBe(400);
    const quotaJson = (await quotaRes.json()) as { error: string };
    expect(quotaJson.error).toContain('云端存储空间已满');

    // 恢复正常容量限制（默认 7GB）
    delete env.MAX_TOTAL_STORAGE_GB;
    bucket.store.clear();

    // 超过 500MB 拦截
    const overReq = new Request('https://example.com/api/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        danceName: '苹果香',
        fileExt: '.mp4',
        fileSize: MAX_FILE_SIZE_BYTES + 1,
        contentType: 'video/mp4',
      }),
    });
    const overRes = await uploadUrlPost(makePagesContext(overReq, env));
    expect(overRes.status).toBe(400);
    const overJson = (await overRes.json()) as { error: string };
    expect(overJson.error).toBe(OVERSIZE_ERROR_MESSAGE);

    // 正常首次上传
    const today = getBeijingDateString();
    const req1 = new Request('https://example.com/api/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        danceName: ' 苹果香:背面 ',
        fileExt: '.mp4',
        fileSize: 50 * 1024 * 1024,
        contentType: 'video/mp4',
      }),
    });
    const res1 = await uploadUrlPost(makePagesContext(req1, env));
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as {
      uploadUrl: string;
      objectKey: string;
      fileName: string;
      danceTitle: string;
    };
    expect(data1.fileName).toBe('苹果香_背面.mp4');
    expect(data1.objectKey).toBe(`videos/${today}/苹果香_背面.mp4`);
    expect(data1.uploadUrl).toContain('X-Amz-Signature=');
    expect(data1.uploadUrl).not.toContain('x-amz-checksum-crc32');

    // 模拟该文件已上传进 R2，再次上传同名视频应自动变为 _(2)
    bucket.seed(data1.objectKey, 50 * 1024 * 1024, new Date());

    const req2 = new Request('https://example.com/api/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        danceName: '苹果香_背面',
        fileExt: '.mp4',
        fileSize: 60 * 1024 * 1024,
        contentType: 'video/mp4',
      }),
    });
    const res2 = await uploadUrlPost(makePagesContext(req2, env));
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { objectKey: string; fileName: string; danceTitle: string };
    expect(data2.fileName).toBe('苹果香_背面_(2).mp4');
    expect(data2.danceTitle).toBe('苹果香_背面_(2)');
    expect(data2.objectKey).toBe(`videos/${today}/苹果香_背面_(2).mp4`);
  });

  it('lists videos sorted descending, generates Content-Disposition download URL, and deletes videos', async () => {
    const bucket = new FakeR2Bucket();
    const env = createTestEnv(bucket);

    bucket.seed('videos/2026-10-28/早安隆回.mp4', 40 * 1024 * 1024, new Date('2026-10-28T08:00:00Z'));
    bucket.seed('videos/2026-10-29/苹果香_背面.mp4', 88 * 1024 * 1024, new Date('2026-10-29T09:00:00Z'));

    // 1. GET /api/videos 倒序排列
    const listReq = new Request('https://example.com/api/videos');
    const listRes = await videosGet(makePagesContext(listReq, env));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ key: string; fileName: string; size: number }>;
    expect(list).toHaveLength(2);
    expect(list[0].fileName).toBe('苹果香_背面.mp4');
    expect(list[1].fileName).toBe('早安隆回.mp4');

    // 2. GET /api/download-url 生成带 Content-Disposition 的预签名 GET URL
    const dlReq = new Request(
      `https://example.com/api/download-url?key=${encodeURIComponent(list[0].key)}`
    );
    const dlRes = await downloadUrlGet(makePagesContext(dlReq, env));
    expect(dlRes.status).toBe(200);
    const dlData = (await dlRes.json()) as { downloadUrl: string; fileName: string };
    expect(dlData.fileName).toBe('苹果香_背面.mp4');
    expect(dlData.downloadUrl).toContain('response-content-disposition=');
    expect(dlData.downloadUrl).toContain('X-Amz-Signature=');

    // 3. DELETE /api/videos 删除指定对象
    const delReq = new Request('https://example.com/api/videos', {
      method: 'DELETE',
      body: JSON.stringify({ keys: [list[1].key] }),
    });
    const delRes = await videosDelete(makePagesContext(delReq, env));
    expect(delRes.status).toBe(200);
    expect(bucket.store.size).toBe(1);
    expect(bucket.store.has('videos/2026-10-28/早安隆回.mp4')).toBe(false);
  });
});

describe('WeChat Mini Program Utils Parity', () => {
  it('sanitizes names, appends suffixes, and parses WeChat temp paths identically', async () => {
    const mpDance = await import('../miniprogram/utils/dance.js');
    expect(mpDance.sanitizeDanceName('  苹果香/背面:高清...  ')).toBe('苹果香_背面_高清');
    expect(mpDance.appendDanceSuffix('苹果香', '+分解教学')).toBe('苹果香_分解教学');
    expect(mpDance.appendDanceSuffix('苹果香_分解教学', '分解教学')).toBe('苹果香_分解教学');
    expect(mpDance.extractFileExtFromPath('wxfile://tmp_9a82b71c.MOV')).toBe('.mov');
    expect(mpDance.guessContentTypeByExt('.mov')).toBe('video/quicktime');
    expect(mpDance.formatFileSizeMB(25.6 * 1024 * 1024)).toBe('25.6 MB');
  });
});
