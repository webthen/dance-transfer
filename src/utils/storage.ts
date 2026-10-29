import { ref } from 'vue';
import type { VideoItem } from '../../shared/dance';

const PIN_STORAGE_KEY = 'mom_dance_access_pin';
const DOWNLOADED_STORAGE_KEY = 'mom_dance_downloaded_v1';

let memoryPinFallback = '';
let memoryDownloadedFallback: string[] = [];

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 忽略无痕/受限 WebView 写入异常，已由内存态兜底
  }
}

export const currentPinRef = ref<string>(readInitialPin());

function readInitialPin(): string {
  const saved = safeGetItem(PIN_STORAGE_KEY)?.trim() || '';
  memoryPinFallback = saved;
  return saved;
}

/**
 * 首次访问 https://domain.com/?pin=mom666 时，自动读取 URL 参数 pin 并存入 localStorage
 */
export function capturePinFromUrl(): string {
  if (typeof window === 'undefined') return '';

  const searchParams = new URLSearchParams(window.location.search);
  const urlPin = searchParams.get('pin')?.trim();

  if (urlPin) {
    setStoredPin(urlPin);
    return urlPin;
  }

  return getStoredPin();
}

export function getStoredPin(): string {
  const stored = safeGetItem(PIN_STORAGE_KEY)?.trim();
  if (stored) {
    memoryPinFallback = stored;
    currentPinRef.value = stored;
    return stored;
  }
  return memoryPinFallback;
}

export function setStoredPin(pin: string): void {
  const clean = pin.trim();
  memoryPinFallback = clean;
  currentPinRef.value = clean;
  safeSetItem(PIN_STORAGE_KEY, clean);
}

export function clearStoredPin(): void {
  memoryPinFallback = '';
  currentPinRef.value = '';
  try {
    window.localStorage.removeItem(PIN_STORAGE_KEY);
  } catch {
    // 忽略受限环境异常
  }
}

/**
 * 已下载视频状态管理（基于 etag + key 存入 localStorage）
 */
function loadDownloadedList(): string[] {
  const raw = safeGetItem(DOWNLOADED_STORAGE_KEY);
  if (!raw) return [...memoryDownloadedFallback];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const list = parsed.filter((item): item is string => typeof item === 'string');
      memoryDownloadedFallback = list;
      return list;
    }
  } catch {
    // 忽略损坏缓存
  }
  return [...memoryDownloadedFallback];
}

function saveDownloadedList(list: string[]): void {
  memoryDownloadedFallback = list;
  safeSetItem(DOWNLOADED_STORAGE_KEY, JSON.stringify(list));
}

export const downloadedSignaturesRef = ref<Set<string>>(new Set(loadDownloadedList()));

export function getVideoDownloadSignature(video: Pick<VideoItem, 'key' | 'etag'>): string {
  return video.etag ? `${video.key}::${video.etag}` : video.key;
}

export function isVideoDownloaded(video: Pick<VideoItem, 'key' | 'etag'>): boolean {
  const sig = getVideoDownloadSignature(video);
  return downloadedSignaturesRef.value.has(sig) || downloadedSignaturesRef.value.has(video.key);
}

export function markVideoDownloaded(video: Pick<VideoItem, 'key' | 'etag'>): void {
  const next = new Set(downloadedSignaturesRef.value);
  next.add(getVideoDownloadSignature(video));
  downloadedSignaturesRef.value = next;
  saveDownloadedList(Array.from(next));
}

export function pruneStaleDownloadedRecords(activeVideos: VideoItem[]): void {
  if (downloadedSignaturesRef.value.size === 0) return;

  const validTokens = new Set<string>();
  for (const video of activeVideos) {
    validTokens.add(video.key);
    validTokens.add(getVideoDownloadSignature(video));
  }

  const next = new Set<string>();
  for (const item of downloadedSignaturesRef.value) {
    const baseKey = item.split('::')[0];
    if (validTokens.has(item) || validTokens.has(baseKey)) {
      next.add(item);
    }
  }

  if (next.size !== downloadedSignaturesRef.value.size) {
    downloadedSignaturesRef.value = next;
    saveDownloadedList(Array.from(next));
  }
}
