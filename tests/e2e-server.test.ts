import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';

describe('Vite Dev Server E2E Workflow', () => {
  it('completes full upload, deduplication, listing, attachment download, and cleanup flow', async () => {
    const server = await createServer({
      server: { host: '127.0.0.1', port: 5198, strictPort: true },
      logLevel: 'silent',
    });
    await server.listen();
    const base = 'http://127.0.0.1:5198';

    try {
      // 1. SPA 页面路由均可正常访问
      const homeRes = await fetch(`${base}/`);
      const adminRes = await fetch(`${base}/admin`);
      expect(homeRes.status).toBe(200);
      expect(adminRes.status).toBe(200);

      // 2. 未携带 x-access-pin 返回 401
      const unauth = await fetch(`${base}/api/videos`);
      expect(unauth.status).toBe(401);

      const headers = {
        'x-access-pin': 'mom666',
        'Content-Type': 'application/json',
      };

      // 3. 超过 500MB 返回大字友好错误文案
      const overRes = await fetch(`${base}/api/upload-url`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          danceName: '苹果香',
          fileExt: '.mp4',
          fileSize: 501 * 1024 * 1024,
        }),
      });
      expect(overRes.status).toBe(400);
      const overData = (await overRes.json()) as { error: string };
      expect(overData.error).toBe('视频太大啦（超过500M），请换个清晰度低一点的');

      // 4. 首次上传 + 同一天同名二次上传自动追加 _(2)
      const u1Res = await fetch(`${base}/api/upload-url`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          danceName: ' 苹果香/背面 ',
          fileExt: '.mp4',
          fileSize: 12,
          contentType: 'video/mp4',
        }),
      });
      expect(u1Res.status).toBe(200);
      const u1 = (await u1Res.json()) as {
        uploadUrl: string;
        objectKey: string;
        fileName: string;
      };
      expect(u1.fileName).toBe('苹果香_背面.mp4');

      const put1 = await fetch(u1.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        body: 'fake-mp4-001',
      });
      expect(put1.status).toBe(200);

      const u2Res = await fetch(`${base}/api/upload-url`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          danceName: '苹果香_背面',
          fileExt: '.mp4',
          fileSize: 12,
          contentType: 'video/mp4',
        }),
      });
      expect(u2Res.status).toBe(200);
      const u2 = (await u2Res.json()) as {
        uploadUrl: string;
        objectKey: string;
        fileName: string;
      };
      expect(u2.fileName).toBe('苹果香_背面_(2).mp4');

      const put2 = await fetch(u2.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        body: 'fake-mp4-002',
      });
      expect(put2.status).toBe(200);

      // 5. 获取待拷贝列表
      const listRes = await fetch(`${base}/api/videos`, { headers });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ key: string; fileName: string }>;
      const ourKeys = list.filter((i) => i.key === u1.objectKey || i.key === u2.objectKey);
      expect(ourKeys).toHaveLength(2);

      // 6. 下载视频校验 Content-Disposition 中文原名附件头与文件内容
      const dlInfoRes = await fetch(
        `${base}/api/download-url?key=${encodeURIComponent(u1.objectKey)}`,
        { headers }
      );
      expect(dlInfoRes.status).toBe(200);
      const dlInfo = (await dlInfoRes.json()) as { downloadUrl: string; fileName: string };
      expect(dlInfo.fileName).toBe('苹果香_背面.mp4');

      const dlRes = await fetch(dlInfo.downloadUrl);
      expect(dlRes.status).toBe(200);
      const cd = dlRes.headers.get('content-disposition') || '';
      expect(cd).toContain("attachment; filename*=UTF-8''");
      expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe('苹果香_背面.mp4');
      expect(await dlRes.text()).toBe('fake-mp4-001');

      // 7. 批量物理删除闭环
      const delRes = await fetch(`${base}/api/videos`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ keys: [u1.objectKey, u2.objectKey] }),
      });
      expect(delRes.status).toBe(200);
      const delJson = (await delRes.json()) as { deletedCount: number };
      expect(delJson.deletedCount).toBe(2);

      // 8. 微信小程序单分片 (<=8MB) 与多分片 (>8MB) 上传至同一管理后台闭环验证
      const mpUnauth = await fetch(`${base}/api/mp/init`, {
        method: 'POST',
        body: JSON.stringify({ danceName: '早安隆回', fileSize: 100 }),
      });
      expect(mpUnauth.status).toBe(401);

      // 8a. 小程序单分片模式 (mode = single)
      const mpSingleInit = await fetch(`${base}/api/mp/init`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          danceName: ' 早安隆回:分解教学 ',
          fileExt: '.mp4',
          fileSize: 16,
          contentType: 'video/mp4',
        }),
      });
      expect(mpSingleInit.status).toBe(200);
      const sSession = (await mpSingleInit.json()) as {
        mode: string;
        objectKey: string;
        fileName: string;
      };
      expect(sSession.mode).toBe('single');
      expect(sSession.fileName).toBe('早安隆回_分解教学.mp4');

      const sPartRes = await fetch(
        `${base}/api/mp/part?key=${encodeURIComponent(sSession.objectKey)}&mode=single&fileName=${encodeURIComponent(sSession.fileName)}&contentType=video%2Fmp4`,
        {
          method: 'PUT',
          headers: { 'x-access-pin': 'mom666', 'Content-Type': 'application/octet-stream' },
          body: 'mp-single-video!',
        }
      );
      expect(sPartRes.status).toBe(200);

      // 8b. 小程序多分片模式 (mode = multipart, >8MB 拆分为 8MB + 4KB 两片)
      const part1Buf = Buffer.alloc(8 * 1024 * 1024, 0x61); // 8MB 'a'
      const part2Buf = Buffer.alloc(4096, 0x62); // 4KB 'b'
      const totalMultiSize = part1Buf.length + part2Buf.length;

      const mpMultiInit = await fetch(`${base}/api/mp/init`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          danceName: '最炫民族风_正面',
          fileExt: '.mp4',
          fileSize: totalMultiSize,
          contentType: 'video/mp4',
        }),
      });
      expect(mpMultiInit.status).toBe(200);
      const mSession = (await mpMultiInit.json()) as {
        mode: string;
        objectKey: string;
        uploadId: string;
        totalParts: number;
        fileName: string;
      };
      expect(mSession.mode).toBe('multipart');
      expect(mSession.totalParts).toBe(2);
      expect(mSession.uploadId.length).toBeGreaterThan(0);

      const mPart1Res = await fetch(
        `${base}/api/mp/part?key=${encodeURIComponent(mSession.objectKey)}&mode=multipart&uploadId=${encodeURIComponent(mSession.uploadId)}&partNumber=1`,
        {
          method: 'PUT',
          headers: { 'x-access-pin': 'mom666', 'Content-Type': 'application/octet-stream' },
          body: part1Buf,
        }
      );
      expect(mPart1Res.status).toBe(200);
      const mPart1 = (await mPart1Res.json()) as { partNumber: number; etag: string };

      const mPart2Res = await fetch(
        `${base}/api/mp/part?key=${encodeURIComponent(mSession.objectKey)}&mode=multipart&uploadId=${encodeURIComponent(mSession.uploadId)}&partNumber=2`,
        {
          method: 'PUT',
          headers: { 'x-access-pin': 'mom666', 'Content-Type': 'application/octet-stream' },
          body: part2Buf,
        }
      );
      expect(mPart2Res.status).toBe(200);
      const mPart2 = (await mPart2Res.json()) as { partNumber: number; etag: string };

      const mCompleteRes = await fetch(`${base}/api/mp/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          objectKey: mSession.objectKey,
          uploadId: mSession.uploadId,
          parts: [mPart2, mPart1], // 故意乱序提交，验证服务端自动按 partNumber 排序合并
        }),
      });
      expect(mCompleteRes.status).toBe(200);

      // 8c. 管理端列表可同时查看到小程序上传的两个视频并完整下载校验字节一致性
      const dlMultiInfoRes = await fetch(
        `${base}/api/download-url?key=${encodeURIComponent(mSession.objectKey)}`,
        { headers }
      );
      expect(dlMultiInfoRes.status).toBe(200);
      const dlMultiInfo = (await dlMultiInfoRes.json()) as { downloadUrl: string; fileName: string };
      expect(dlMultiInfo.fileName).toBe('最炫民族风_正面.mp4');

      const dlMultiBin = Buffer.from(await (await fetch(dlMultiInfo.downloadUrl)).arrayBuffer());
      expect(dlMultiBin.length).toBe(totalMultiSize);
      expect(dlMultiBin[0]).toBe(0x61);
      expect(dlMultiBin[8 * 1024 * 1024 - 1]).toBe(0x61);
      expect(dlMultiBin[8 * 1024 * 1024]).toBe(0x62);
      expect(dlMultiBin[totalMultiSize - 1]).toBe(0x62);

      // 8d. 清理小程序测试生成的视频对象
      const mpCleanupRes = await fetch(`${base}/api/videos`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ keys: [sSession.objectKey, mSession.objectKey] }),
      });
      expect(mpCleanupRes.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 30000);
});
