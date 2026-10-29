# 广场舞视频中转站 (Mom Dance Transfer) - 需求与技术规范文档

## 1. 项目背景与目标
解决长辈通过微信发送广场舞视频导致的文件名丢失、手动重命名繁琐问题。构建一个基于 Cloudflare 全家桶的轻量级视频中转站：
- **长辈端（手机微信内）**：必填舞蹈名称 + 选择本地视频上传（极简适老化 UI）。
- **子女端（PC 浏览器）**：查看待拷贝列表，点击下载直接获得以“舞蹈名称.mp4”命名的文件，直接复制进 U 盘，支持一键清空已拷贝视频。
- **自动化运维**：GitHub + Cloudflare Pages 自动构建部署，R2 存储桶到期自动物理删除，零数据库依赖。

---

## 2. 技术栈与架构约束（重要！严禁偏离）
- **前端框架**：Vue 3 + Vite + Tailwind CSS（单页应用，包含上传视图与管理下载视图）。
- **后端/接口层**：Cloudflare Pages Functions（基于 Hono 或原生 Pages Functions）。
- **存储层**：Cloudflare R2（**不使用 D1 或 KV 数据库**，直接利用 R2 的 Object 列表和 Custom Metadata 存储状态，保持架构极简）。
- **CI/CD**：GitHub 仓库直连 Cloudflare Pages，Push `main` 分支自动触发构建部署。

### ⚠️ 核心架构红线（防踩坑要求）
1. **严禁通过 Worker 中转视频流**：由于 Cloudflare 免费版限制请求体最大 100MB，而本项目支持最大 **500MB** 视频，上传必须采用 **AWS S3 SDK (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) 生成 R2 Presigned PUT URL（预签名直传链接）**，由前端使用 `XMLHttpRequest`（需监听上传进度条）直接 PUT 到 R2。
2. **严禁使用随机 UUID 作为下载文件名**：下载落地的文件名必须严格等于用户填写的 `舞蹈名称 + 原始扩展名`。
3. **定期清理机制**：不写定时任务代码。直接在 Cloudflare R2 控制台配置 **对象生命周期规则 (Object Lifecycle Rules)**，设置前缀 `videos/` 下的文件在创建 **14 天** 后自动过期删除（同时保留管理端手动删除接口）。

---

## 3. 功能需求明细

### 3.1 极简鉴权机制（免登录防刷）
- 系统通过环境变量配置一个静态访问口令 `ACCESS_PIN`（例如 `mom666`）。
- 用户首次访问 `https://domain.com/?pin=mom666` 时，前端读取 URL 参数 `pin` 并存入 `localStorage`。
- 所有后端 API 请求在 Header 中携带 `x-access-pin`。若口令不匹配，返回 `401 Unauthorized`，前端弹窗提示输入口令。

### 3.2 长辈上传端（默认首页 `/`）
**UI 适老化要求**：字体放大（正文字号不小于 `18px`，按钮字号 `20px+`），高对比度，无多余导航干扰。

1. **第一步：填写舞蹈名称（必填）**
   - 大号输入框，占位提示：`请输入舞蹈名字（如：苹果香）`。
   - **快捷后缀标签**：输入框下方提供可点击标签 `[+背面]` `[+正面]` `[+分解教学]` `[+慢速]`，点击后自动追加到输入框末尾。
   - **文件名清洗逻辑**：自动去除首尾空格，将文件名非法字符（`/ \ : * ? " < > |` 及换行符）替换为下划线 `_`。
2. **第二步：选择视频并上传**
   - 文件选择器：`<input type="file" accept="video/*">`（**严禁添加 `capture` 属性**，确保在微信内置浏览器中拉起的是手机相册而非相机）。
   - **前置校验**：
     - 校验是否已填写舞蹈名称（未填则高亮抖动提示，不触发选文件或上传）。
     - 校验文件大小：若超过 `500MB`（`500 * 1024 * 1024 bytes`），弹窗大字提示：`视频太大啦（超过500M），请换个清晰度低一点的`。
   - **重名防覆盖处理**：若同一天上传同名视频，后端生成 R2 Key 时若检测到同名，自动在文件名末尾追加 `_(2)`、`_(3)`。
3. **第三步：上传进度与反馈**
   - 使用 `XMLHttpRequest` 直传 R2，页面实时展示大号百分比进度条（`0% - 100%`）及提示文案：`正在上传中，请不要关闭页面...`。
   - 上传成功后展示全屏/大字成功页：`✅《XXX》上传成功！儿子收到啦`，并提供 `【继续传下一个】` 按钮（点击后清空表单）。

### 3.3 子女下载管理端（路径 `/admin`）
1. **视频列表展示**
   - 调用后端接口拉取 R2 `videos/` 目录下的所有文件，按上传时间倒序排列。
   - 展示字段：最终文件名（如 `苹果香_背面.mp4`）、文件大小（MB）、上传时间（如 `10月28日 19:30`）。
2. **直接下载（核心体验）**
   - 每个视频提供 `【下载视频】` 按钮。
   - 点击后通过预签名 GET URL 下载，生成预签名 URL 时必须指定 `ResponseContentDisposition: attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`。确保浏览器下载落地时，文件名直接就是老妈填好的中文名，可直接复制进 U 盘。
   - 点击下载后，前端在 `localStorage` 中将该文件的 `etag/key` 标记为 `已下载`（列表项变灰并打上 `✅ 已下载` 标签，方便区分增量）。
3. **批量操作与闭环清理**
   - `【一键下载全部未读】`：顺序触发所有未标记“已下载”视频的浏览器下载任务（间隔 500ms 防止浏览器拦截）。
   - `【单个删除】` 与 `【清空所有已下载视频】`：调用后端 `DELETE` 接口直接从 R2 物理删除对应对象，释放空间并清空列表。

---

## 4. 后端 API 接口设计 (Cloudflare Pages Functions)

| 路由 | 方法 | 功能描述 |
| :--- | :--- | :--- |
| `/api/upload-url` | `POST` | 接收 `{ danceName, fileExt, fileSize, contentType }`，校验体积 $\le 500\text{MB}$ 及重名检查，返回 R2 预签名 PUT URL 及最终生成的 `objectKey` |
| `/api/videos` | `GET` | 调用 R2 `list()` 获取 `videos/` 下所有对象，返回 `{ key, fileName, size, uploadedAt }[]` |
| `/api/download-url` | `GET` | 接收 `?key=xxx`，生成带 `Content-Disposition` 附件头的 R2 预签名 GET URL |
| `/api/videos` | `DELETE` | 接收 `{ keys: string[] }`，调用 R2 `delete()` 批量或单个删除已拷入 U 盘的视频 |

---

## 5. R2 存储桶配置清单（部署前手动操作一次）
1. **创建 Bucket**：命名为 `mom-dance-videos`。
2. **配置 CORS（跨域直传必须）**：
   ```json
   [
     {
       "AllowedOrigins": ["[https://你的域名.com](https://你的域名.com)", "http://localhost:5173"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. **配置对象生命周期（自动删除闭环）**：
   - 规则名称：`Auto-Delete-14-Days`
   - 作用域前缀：`videos/`
   - 操作：上传后 **14 天** 永久删除对象（同时勾选“中止 1 天后未完成的分段上传”以清理断网残留碎片）。