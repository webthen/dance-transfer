# 广场舞视频中转站 (Mom Dance Transfer)

解决长辈通过微信发送广场舞视频导致**文件名丢失、画质压缩或大小受限、手动重命名繁琐**的问题。基于 **Cloudflare Pages + Pages Functions + R2** 构建的零数据库、免运维轻量级视频中转站：

- **长辈上传端（`/`，手机微信内打开）**：极简适老化大字高对比度 UI（正文字号 `18px+`，按钮 `22px+`），必填舞蹈名称 + 一键追加快捷后缀（`[+背面]` `[+正面]` `[+分解教学]` `[+慢速]`），支持手机相册直传最大 **500MB** 视频并实时显示大号百分比进度条。
- **子女管理下载端（`/admin`，电脑浏览器打开）**：按上传时间倒序查看待拷贝列表，点击下载直接落地为 `苹果香_背面.mp4` 等老妈填好的中文名（可直接复制进 U 盘），自动标记 `✅ 已下载`，支持 **一键下载全部未读** 与 **一键清空所有已下载视频**。
- **自动化闭环运维**：GitHub 直连 Cloudflare Pages 自动部署，R2 对象生命周期规则 **14 天到期自动物理删除**，零 D1/KV 数据库依赖。

---

## 1. 技术栈与核心设计

- **前端**：Vue 3 + Vue Router 4 + Vite + Tailwind CSS v3（兼容长辈旧款 iOS / Android 微信内置浏览器）
- **后端接口层**：Cloudflare Pages Functions (`functions/api/*`)
- **存储与直传**：Cloudflare R2 + AWS S3 SDK (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
  - **大文件直传**：前端通过 `XMLHttpRequest` 直接 `PUT` 到 R2 预签名链接（绕过 Cloudflare Worker 免费版 100MB 请求体限制，支持最高 500MB 视频及实时上传进度条）。
  - **原名附件下载**：生成预签名 `GET` 链接时注入 `ResponseContentDisposition: attachment; filename*=UTF-8''...`，确保浏览器落地文件名严格等于 `舞蹈名称 + 原始扩展名`（同一天重名自动追加 `_(2)`、`_(3)`）。

---

## 2. 本地开发与测试

```bash
# 1. 安装依赖
npm install

# 2. 启动本地开发服务器（内置零配置本地 R2 沙盒，默认口令 mom666）
npm run dev
```

启动后可直接访问：
- **长辈上传端**：`http://localhost:5173/?pin=mom666`
- **子女管理端**：`http://localhost:5173/admin`

> **连接真实 Cloudflare R2 本地联调（可选）**：
> 复制 `.dev.vars.example` 为 `.dev.vars` 并填入真实的 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`，重启 `npm run dev` 后即可直接读写远程 R2 存储桶。

```bash
# 运行单元测试与接口测试
npm test

# 类型检查与生产构建
npm run typecheck
npm run build
```

---

## 3. Cloudflare R2 存储桶配置清单（首次部署前操作一次）

### 第一步：创建 R2 Bucket
在 Cloudflare 控制台进入 **R2 Object Storage**，创建存储桶，命名为：
```text
mom-dance-videos
```

### 第二步：配置 CORS（跨域直传必须）
进入 `mom-dance-videos` -> **Settings（设置）** -> **CORS Policy**，填入以下 JSON（将 `https://你的域名.com` 替换为你的 Cloudflare Pages 域名或自定义域名）：

```json
[
  {
    "AllowedOrigins": [
      "https://你的域名.com",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 第三步：配置 14 天对象生命周期自动清理
进入 `mom-dance-videos` -> **Settings（设置）** -> **Object lifecycle rules**，添加规则：
- **Rule name**：`Auto-Delete-14-Days`
- **Prefix（作用域前缀）**：`videos/`
- **Delete uploaded objects**：上传 **14 天** 后永久删除对象
- **Abort incomplete multipart uploads**：勾选 **1 天** 后中止未完成的分段上传（清理断网残留碎片）

### 第四步：创建 R2 S3 API 令牌
在 R2 概览页右上角点击 **Manage R2 API Tokens** -> **Create API token**：
- **Permissions**：`Object Read & Write`（对象读和写）
- **Specify bucket**：仅限 `mom-dance-videos`
- 创建后记录下：`Account ID`、`Access Key ID`、`Secret Access Key`。

---

## 4. Cloudflare Pages 自动部署配置

1. 将本仓库推送至 GitHub `main` 分支。
2. 在 Cloudflare 控制台进入 **Workers & Pages** -> **Create** -> **Pages** -> **Connect to Git**，选择本仓库：
   - **Framework preset**：`Vue`（或 `Vite`）
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
3. 在 Pages 项目的 **Settings** -> **Bindings** 中确认已绑定 R2 Bucket（仓库内 `wrangler.toml` 已预置声明）：
   - 变量名：`BUCKET` -> 指向 `mom-dance-videos`
4. 在 Pages 项目的 **Settings** -> **Variables and Secrets** 中添加以下环境变量：
   - `ACCESS_PIN`：访问口令（例如 `mom666`）
   - `R2_ACCOUNT_ID`：你的 Cloudflare Account ID
   - `R2_ACCESS_KEY_ID`：第三步生成的 R2 Access Key ID
   - `R2_SECRET_ACCESS_KEY`：第三步生成的 R2 Secret Access Key
   - `R2_BUCKET_NAME`：`mom-dance-videos`（可选，默认即为 `mom-dance-videos`）
5. 重新触发一次部署即可上线：
   - 把 `https://你的域名.com/?pin=mom666` 发到老妈微信并让她收藏（手机首次点开自动记住口令）。
   - 自己在电脑浏览器收藏 `https://你的域名.com/admin` 下载拷 U 盘。
