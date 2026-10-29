import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';

describe('Vite Dev Server E2E Workflow', () => {
  it('completes full upload, deduplication, listing, attachment download, and cleanup flow', async () => {
    const server = await createServer({
      server: { port: 5198, strictPort: true },
      logLevel: 'silent',
    });
    await server.listen();
    const base = 'http://localhost:5198';

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
    } finally {
      await server.close();
    }
  });
});
