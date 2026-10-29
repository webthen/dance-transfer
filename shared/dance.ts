export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
export const MP_PART_SIZE_BYTES = 8 * 1024 * 1024; // 8MB 分片（满足 R2 >=5MB 要求且远低于 Worker 100MB 限制）
export const OVERSIZE_ERROR_MESSAGE = '视频太大啦（超过500M），请换个清晰度低一点的';
export const VIDEO_PREFIX = 'videos/';
export const QUICK_SUFFIXES = ['背面', '正面', '分解教学', '慢速'] as const;

export interface VideoItem {
  key: string;
  fileName: string;
  size: number;
  uploadedAt: string;
  etag?: string;
}

export interface UploadUrlRequest {
  danceName: string;
  fileExt: string;
  fileSize: number;
  contentType?: string;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  objectKey: string;
  fileName: string;
  danceTitle: string;
  contentType: string;
}

export interface MpUploadInitResponse {
  mode: 'single' | 'multipart';
  objectKey: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  fileName: string;
  danceTitle: string;
  contentType: string;
}

export interface MpUploadedPartInfo {
  partNumber: number;
  etag: string;
}

export interface DownloadUrlResponse {
  downloadUrl: string;
  fileName: string;
  key: string;
}

/**
 * 清洗舞蹈名称：
 * 去除首尾空格，将文件名非法字符（/ \ : * ? " < > | 及控制/换行符）替换为下划线 _，
 * 同时清理末尾句点以确保 Windows U 盘（FAT32/exFAT/NTFS）100% 兼容。
 */
export function sanitizeDanceName(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[/\\:*?"<>|\r\n\t\x00-\x1f]+/g, '_')
    .trim()
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120);
}

/**
 * 点击快捷后缀标签追加到输入框末尾（防止连续误触产生重复后缀）
 */
export function appendDanceSuffix(currentInput: string, suffix: string): string {
  const cleanSuffix = suffix.replace(/^[+_]+/, '').trim();
  if (!cleanSuffix) return currentInput;

  const trimmed = currentInput.trim();
  if (!trimmed) {
    return cleanSuffix;
  }

  if (trimmed === cleanSuffix || trimmed.endsWith(`_${cleanSuffix}`)) {
    return trimmed;
  }

  if (trimmed.endsWith('_')) {
    return `${trimmed}${cleanSuffix}`;
  }

  return `${trimmed}_${cleanSuffix}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/avi': '.avi',
  'video/3gpp': '.3gp',
  'video/3gpp2': '.3g2',
  'video/x-m4v': '.m4v',
  'video/mpeg': '.mpeg',
  'video/mp2t': '.ts',
  'video/x-flv': '.flv',
};

/**
 * 规范化视频扩展名（始终以 . 开头的小写字母数字，例如 .mp4）
 */
export function normalizeFileExt(rawExt?: string, contentType?: string): string {
  if (rawExt && typeof rawExt === 'string') {
    const trimmed = rawExt.trim();
    const dotIdx = trimmed.lastIndexOf('.');
    const candidate = (dotIdx >= 0 ? trimmed.slice(dotIdx + 1) : trimmed)
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase()
      .slice(0, 10);

    if (candidate) {
      return `.${candidate}`;
    }
  }

  if (contentType && typeof contentType === 'string') {
    const baseMime = contentType.split(';')[0].trim().toLowerCase();
    if (MIME_TO_EXT[baseMime]) {
      return MIME_TO_EXT[baseMime];
    }
  }

  return '.mp4';
}

/**
 * 从浏览器 File.name 提取原始扩展名
 */
export function extractFileExtFromFileName(fileName: string, contentType?: string): string {
  if (fileName && typeof fileName === 'string') {
    const base = fileName.split(/[/\\]/).pop() || '';
    const lastDot = base.lastIndexOf('.');
    if (lastDot > 0 && lastDot < base.length - 1) {
      return normalizeFileExt(base.slice(lastDot), contentType);
    }
  }
  return normalizeFileExt('', contentType);
}

/**
 * 获取北京时间 (UTC+8) 日期字符串 YYYY-MM-DD
 */
export function getBeijingDateString(date: Date = new Date()): string {
  const utc8Ms = date.getTime() + 8 * 60 * 60 * 1000;
  return new Date(utc8Ms).toISOString().slice(0, 10);
}

/**
 * 同一天重名防覆盖：若检测到同名，自动在文件名末尾追加 _(2)、_(3)
 */
export function resolveUniqueSameDayObject(
  cleanDanceName: string,
  cleanExt: string,
  dateStr: string,
  existingKeys: ReadonlySet<string>
): { objectKey: string; fileName: string; danceTitle: string } {
  const baseTitle = cleanDanceName;
  const baseFileName = `${baseTitle}${cleanExt}`;
  const baseKey = `${VIDEO_PREFIX}${dateStr}/${baseFileName}`;

  if (!existingKeys.has(baseKey)) {
    return {
      objectKey: baseKey,
      fileName: baseFileName,
      danceTitle: baseTitle,
    };
  }

  let counter = 2;
  while (counter < 10000) {
    const danceTitle = `${baseTitle}_(${counter})`;
    const fileName = `${danceTitle}${cleanExt}`;
    const objectKey = `${VIDEO_PREFIX}${dateStr}/${fileName}`;
    if (!existingKeys.has(objectKey)) {
      return { objectKey, fileName, danceTitle };
    }
    counter += 1;
  }

  const fallbackTitle = `${baseTitle}_(${Date.now()})`;
  const fallbackFileName = `${fallbackTitle}${cleanExt}`;
  return {
    objectKey: `${VIDEO_PREFIX}${dateStr}/${fallbackFileName}`,
    fileName: fallbackFileName,
    danceTitle: fallbackTitle,
  };
}

/**
 * RFC 5987 编码并生成 Content-Disposition 附件头
 */
export function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function buildContentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeRFC5987ValueChars(fileName)}`;
}

/**
 * 从 R2 Object Key 提取最终文件名（如 videos/2026-10-29/苹果香_背面.mp4 -> 苹果香_背面.mp4）
 */
export function extractFileNameFromKey(key: string): string {
  const segments = key.split('/').filter(Boolean);
  return segments[segments.length - 1] || key;
}

/**
 * 校验 R2 Object Key 是否合法且严格位于 videos/ 目录下
 */
export function isValidVideoObjectKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (!key.startsWith(VIDEO_PREFIX)) return false;
  if (key.length <= VIDEO_PREFIX.length) return false;
  if (key.endsWith('/')) return false;
  if (key.includes('..') || key.includes('\\') || key.includes('\0')) return false;
  return true;
}

/**
 * 格式化文件体积为 MB（例如 128.4 MB）
 */
export function formatFileSizeMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return '0.1 MB';
  return `${mb.toFixed(1)} MB`;
}

/**
 * 格式化上传时间为中文易读格式（例如：10月28日 19:30，按北京时间 UTC+8 展示）
 */
export function formatUploadTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;

  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const month = utc8.getUTCMonth() + 1;
  const day = utc8.getUTCDate();
  const hours = String(utc8.getUTCHours()).padStart(2, '0');
  const minutes = String(utc8.getUTCMinutes()).padStart(2, '0');

  return `${month}月${day}日 ${hours}:${minutes}`;
}
