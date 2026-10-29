import type {
  DownloadUrlResponse,
  UploadUrlRequest,
  UploadUrlResponse,
  VideoItem,
} from '../../shared/dance';
import { promptForAccessPin } from './auth-modal';
import { getStoredPin } from './storage';

export class PinCancelledError extends Error {
  constructor(message = '未输入访问口令') {
    super(message);
    this.name = 'PinCancelledError';
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let pin = getStoredPin();

  if (!pin) {
    const entered = await promptForAccessPin('');
    if (!entered) {
      throw new PinCancelledError();
    }
    pin = entered;
  }

  // 当后端返回 401 Unauthorized 时，弹窗提示重新输入口令并自动重试请求
  while (true) {
    const headers = new Headers(init.headers || {});
    headers.set('x-access-pin', pin);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(path, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      const nextPin = await promptForAccessPin('口令不正确，请重新输入正确的访问口令');
      if (!nextPin) {
        throw new PinCancelledError();
      }
      pin = nextPin;
      continue;
    }

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      const text = await response.text();
      payload = text ? { error: text } : null;
    }

    if (!response.ok) {
      const errMsg =
        payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `请求失败 (HTTP ${response.status})`;
      throw new Error(errMsg);
    }

    return payload as T;
  }
}

export function requestUploadUrl(data: UploadUrlRequest): Promise<UploadUrlResponse> {
  return apiFetch<UploadUrlResponse>('/api/upload-url', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function fetchVideoList(): Promise<VideoItem[]> {
  return apiFetch<VideoItem[]>('/api/videos', {
    method: 'GET',
  });
}

export function requestDownloadUrl(key: string): Promise<DownloadUrlResponse> {
  const params = new URLSearchParams({ key });
  return apiFetch<DownloadUrlResponse>(`/api/download-url?${params.toString()}`, {
    method: 'GET',
  });
}

export function deleteVideos(keys: string[]): Promise<{ success: boolean; deletedCount: number }> {
  return apiFetch<{ success: boolean; deletedCount: number }>('/api/videos', {
    method: 'DELETE',
    body: JSON.stringify({ keys }),
  });
}

/**
 * 使用 XMLHttpRequest 直传文件到 Cloudflare R2 Presigned PUT URL，并实时回调上传进度
 */
export function uploadVideoDirectToR2(options: {
  uploadUrl: string;
  file: File;
  contentType: string;
  onProgress: (percent: number, loadedBytes: number, totalBytes: number) => void;
}): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<void>((resolve, reject) => {
    xhr.open('PUT', options.uploadUrl, true);
    xhr.setRequestHeader('Content-Type', options.contentType);

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
        options.onProgress(percent, event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress(100, options.file.size, options.file.size);
        resolve();
      } else {
        reject(new Error(`视频上传未成功（存储返回码 ${xhr.status}），请点击重试`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('网络信号不稳定或连接中断，请检查网络后点击重试'));
    };

    xhr.onabort = () => {
      reject(new Error('上传已取消'));
    };

    xhr.send(options.file);
  });

  return {
    promise,
    abort: () => xhr.abort(),
  };
}
