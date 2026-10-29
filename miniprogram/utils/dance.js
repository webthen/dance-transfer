/**
 * 舞蹈文件名清洗与格式化工具（与服务端 shared/dance.ts 保持完全一致）
 */

const EXT_TO_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.m4v': 'video/x-m4v',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
};

function sanitizeDanceName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[/\\:*?"<>|\r\n\t\x00-\x1f]+/g, '_')
    .trim()
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120);
}

function appendDanceSuffix(currentInput, suffix) {
  const cleanSuffix = String(suffix || '')
    .replace(/^[+_]+/, '')
    .trim();
  if (!cleanSuffix) return currentInput || '';

  const trimmed = String(currentInput || '').trim();
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

function extractFileExtFromPath(filePath) {
  if (filePath && typeof filePath === 'string') {
    const cleanPath = filePath.split('?')[0].split('#')[0];
    const base = cleanPath.split(/[/\\]/).pop() || '';
    const lastDot = base.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < base.length - 1) {
      const candidate = base
        .slice(lastDot + 1)
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase()
        .slice(0, 10);
      if (candidate) {
        return `.${candidate}`;
      }
    }
  }
  return '.mp4';
}

function guessContentTypeByExt(ext) {
  const lower = String(ext || '.mp4').toLowerCase();
  return EXT_TO_MIME[lower] || 'video/mp4';
}

function formatFileSizeMB(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0.0 MB';
  const mb = num / (1024 * 1024);
  if (mb < 0.1) return '0.1 MB';
  return `${mb.toFixed(1)} MB`;
}

module.exports = {
  sanitizeDanceName,
  appendDanceSuffix,
  extractFileExtFromPath,
  guessContentTypeByExt,
  formatFileSizeMB,
};
