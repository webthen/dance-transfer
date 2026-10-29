const { API_BASE_URL, DEFAULT_PIN } = require('../config');
const { extractFileExtFromPath, guessContentTypeByExt } = require('./dance');

function normalizeNetworkError(err) {
  const msg = (err && (err.errMsg || err.message)) || '';
  if (msg.includes('url not in domain list')) {
    return '域名未加入小程序白名单：体验阶段请点击右上角“...”开启“开发调试”，或在开发者工具勾选“不校验合法域名”';
  }
  if (msg.includes('timeout')) {
    return '网络连接超时，请检查手机网络信号后重试';
  }
  if (msg.includes('abort')) {
    return '已取消上传';
  }
  return '网络信号不稳定或连接中断，请检查网络后重试';
}

function getBaseUrl() {
  return String(API_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * 校验访问口令是否有效
 */
function verifyAccessPin(pin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) {
    return Promise.resolve({ valid: false, message: '请输入访问口令' });
  }

  return new Promise((resolve) => {
    wx.request({
      url: `${getBaseUrl()}/api/videos`,
      method: 'GET',
      timeout: 15000,
      header: {
        'x-access-pin': cleanPin,
      },
      success(res) {
        if (res.statusCode === 200) {
          resolve({ valid: true, message: '' });
          return;
        }
        if (res.statusCode === 401) {
          resolve({ valid: false, message: '访问口令不正确，请重新输入' });
          return;
        }
        const errText = (res.data && res.data.error) || `服务校验异常 (${res.statusCode})`;
        resolve({ valid: false, message: errText });
      },
      fail(err) {
        resolve({ valid: false, message: normalizeNetworkError(err) });
      },
    });
  });
}

/**
 * 按字节区间读取本地视频分片（单次仅读取 <=8MB 进入内存，防止大视频闪退）
 */
function readFileSlice(filePath, position, length) {
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => {
    fs.readFile({
      filePath,
      position,
      length,
      success(res) {
        if (res.data instanceof ArrayBuffer) {
          resolve(res.data);
        } else {
          reject(new Error('读取本地视频分片失败'));
        }
      },
      fail() {
        // 兼容降级：使用 open + read + close 读取指定区间
        fs.open({
          filePath,
          flag: 'r',
          success(openRes) {
            const fd = openRes.fd;
            const buffer = new ArrayBuffer(length);
            fs.read({
              fd,
              arrayBuffer: buffer,
              offset: 0,
              length,
              position,
              success(readRes) {
                fs.close({ fd });
                if (readRes.bytesRead === length) {
                  resolve(buffer);
                } else {
                  resolve(buffer.slice(0, readRes.bytesRead));
                }
              },
              fail(readErr) {
                fs.close({ fd });
                reject(new Error((readErr && readErr.errMsg) || '读取本地视频数据失败'));
              },
            });
          },
          fail(openErr) {
            reject(new Error((openErr && openErr.errMsg) || '无法打开所选视频文件'));
          },
        });
      },
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 分片直传视频至云端 R2
 * 支持 <=8MB 单次直传与 >8MB（最高 500MB）自动分片续传 + 单片 3 次自动重试 + 实时平滑进度回调
 */
function uploadVideoToCloud({ filePath, fileSize, danceName, pin, onProgress }) {
  const effectivePin = String(pin || DEFAULT_PIN || 'DancerAt654321').trim();
  let cancelled = false;
  let activeTask = null;
  let smoothTimer = null;
  let activeMultipart = null;

  const clearSmoothTimer = () => {
    if (smoothTimer) {
      clearInterval(smoothTimer);
      smoothTimer = null;
    }
  };

  const requestWithTask = (options) =>
    new Promise((resolve, reject) => {
      if (cancelled) {
        const abortErr = new Error('已取消上传');
        abortErr.isCancelled = true;
        reject(abortErr);
        return;
      }
      const task = wx.request({
        ...options,
        success(res) {
          activeTask = null;
          resolve(res);
        },
        fail(err) {
          activeTask = null;
          if (cancelled) {
            const abortErr = new Error('已取消上传');
            abortErr.isCancelled = true;
            reject(abortErr);
            return;
          }
          reject(new Error(normalizeNetworkError(err)));
        },
      });
      activeTask = task;
    });

  const abortRemoteMultipartIfNeeded = (info) => {
    if (!info || info.mode !== 'multipart' || !info.uploadId) return;
    wx.request({
      url: `${getBaseUrl()}/api/mp/abort`,
      method: 'POST',
      header: {
        'content-type': 'application/json',
        'x-access-pin': effectivePin,
      },
      data: {
        objectKey: info.objectKey,
        uploadId: info.uploadId,
      },
    });
  };

  const abort = () => {
    cancelled = true;
    clearSmoothTimer();
    if (activeTask && typeof activeTask.abort === 'function') {
      try {
        activeTask.abort();
      } catch (e) {
        // 忽略中止异常
      }
      activeTask = null;
    }
    if (activeMultipart) {
      abortRemoteMultipartIfNeeded(activeMultipart);
      activeMultipart = null;
    }
  };

  const promise = (async () => {
    const fileExt = extractFileExtFromPath(filePath);
    const contentType = guessContentTypeByExt(fileExt);

    // 1. 初始化上传会话（校验口令、500M 体积上限、7G 总空间配额与同名防覆盖）
    const initRes = await requestWithTask({
      url: `${getBaseUrl()}/api/mp/init`,
      method: 'POST',
      timeout: 20000,
      header: {
        'content-type': 'application/json',
        'x-access-pin': effectivePin,
      },
      data: {
        danceName,
        fileExt,
        fileSize,
        contentType,
      },
    });

    if (initRes.statusCode === 401) {
      const authErr = new Error('访问口令不正确或已失效，请重新验证口令');
      authErr.isUnauthorized = true;
      throw authErr;
    }

    if (initRes.statusCode < 200 || initRes.statusCode >= 300 || !initRes.data) {
      const errMsg = (initRes.data && initRes.data.error) || `初始化上传失败 (${initRes.statusCode})`;
      throw new Error(errMsg);
    }

    const session = initRes.data;
    const {
      mode,
      objectKey,
      uploadId,
      partSize,
      totalParts,
      fileName,
      danceTitle,
    } = session;

    activeMultipart = { mode, objectKey, uploadId };

    if (typeof onProgress === 'function') {
      onProgress({
        loaded: 0,
        total: fileSize,
        percent: 1,
        partNumber: 1,
        totalParts,
      });
    }

    const uploadedParts = [];
    let estBytesPerSec = 1.5 * 1024 * 1024; // 初始预估网速 1.5MB/s，后续根据实测动态校准

    try {
      // 2. 逐片读取并直传（单片 8MB，失败自动重试最多 3 次）
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (cancelled) {
          const abortErr = new Error('已取消上传');
          abortErr.isCancelled = true;
          throw abortErr;
        }

        const offset = (partNumber - 1) * partSize;
        const chunkLength = Math.min(partSize, fileSize - offset);
        const chunkBuffer = await readFileSlice(filePath, offset, chunkLength);

        const query = [
          `key=${encodeURIComponent(objectKey)}`,
          `mode=${encodeURIComponent(mode)}`,
          `uploadId=${encodeURIComponent(uploadId || '')}`,
          `partNumber=${partNumber}`,
          `fileName=${encodeURIComponent(fileName)}`,
          `contentType=${encodeURIComponent(contentType)}`,
        ].join('&');

        const partUrl = `${getBaseUrl()}/api/mp/part?${query}`;

        let partResult = null;
        let lastPartErr = null;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (cancelled) break;

          const chunkStartMs = Date.now();
          clearSmoothTimer();

          if (typeof onProgress === 'function') {
            smoothTimer = setInterval(() => {
              if (cancelled) return;
              const elapsedSec = (Date.now() - chunkStartMs) / 1000;
              const estimatedInChunk = Math.min(
                Math.floor(chunkLength * 0.86),
                Math.floor(elapsedSec * estBytesPerSec)
              );
              const virtualLoaded = Math.min(fileSize, offset + estimatedInChunk);
              const virtualPercent = Math.min(
                98,
                Math.max(1, Math.round((virtualLoaded / fileSize) * 100))
              );
              onProgress({
                loaded: virtualLoaded,
                total: fileSize,
                percent: virtualPercent,
                partNumber,
                totalParts,
              });
            }, 320);
          }

          try {
            const partRes = await requestWithTask({
              url: partUrl,
              method: 'PUT',
              timeout: 180000,
              header: {
                'content-type': 'application/octet-stream',
                'x-access-pin': effectivePin,
              },
              data: chunkBuffer,
            });

            clearSmoothTimer();

            if (partRes.statusCode === 401) {
              const authErr = new Error('访问口令不正确或已失效，请重新验证口令');
              authErr.isUnauthorized = true;
              throw authErr;
            }

            if (partRes.statusCode >= 200 && partRes.statusCode < 300 && partRes.data) {
              const durationSec = Math.max(0.2, (Date.now() - chunkStartMs) / 1000);
              estBytesPerSec = chunkLength / durationSec;
              partResult = partRes.data;
              break;
            }

            const serverMsg =
              (partRes.data && partRes.data.error) || `分片 #${partNumber} 上传异常 (${partRes.statusCode})`;
            lastPartErr = new Error(serverMsg);
            if (partRes.statusCode >= 400 && partRes.statusCode < 500) {
              throw lastPartErr;
            }
          } catch (err) {
            clearSmoothTimer();
            if (err.isCancelled || err.isUnauthorized) {
              throw err;
            }
            lastPartErr = err;
            if (attempt < 3 && !cancelled) {
              await sleep(800 * attempt);
            }
          }
        }

        if (!partResult) {
          throw lastPartErr || new Error(`分片 #${partNumber} 上传失败，请重试`);
        }

        uploadedParts.push({
          partNumber,
          etag: partResult.etag,
        });

        const exactLoaded = offset + chunkLength;
        const exactPercent =
          mode === 'multipart' && partNumber === totalParts
            ? 99
            : Math.min(100, Math.round((exactLoaded / fileSize) * 100));

        if (typeof onProgress === 'function') {
          onProgress({
            loaded: exactLoaded,
            total: fileSize,
            percent: exactPercent,
            partNumber,
            totalParts,
          });
        }
      }

      // 3. 多分片模式下通知服务端合并完成整个视频对象
      if (mode === 'multipart') {
        const completeRes = await requestWithTask({
          url: `${getBaseUrl()}/api/mp/complete`,
          method: 'POST',
          timeout: 30000,
          header: {
            'content-type': 'application/json',
            'x-access-pin': effectivePin,
          },
          data: {
            objectKey,
            uploadId,
            parts: uploadedParts,
          },
        });

        if (completeRes.statusCode < 200 || completeRes.statusCode >= 300) {
          const msg =
            (completeRes.data && completeRes.data.error) ||
            `合并视频文件失败 (${completeRes.statusCode})`;
          throw new Error(msg);
        }
      }

      activeMultipart = null;

      if (typeof onProgress === 'function') {
        onProgress({
          loaded: fileSize,
          total: fileSize,
          percent: 100,
          partNumber: totalParts,
          totalParts,
        });
      }

      return {
        objectKey,
        fileName,
        danceTitle,
      };
    } catch (err) {
      clearSmoothTimer();
      if (activeMultipart) {
        abortRemoteMultipartIfNeeded(activeMultipart);
        activeMultipart = null;
      }
      throw err;
    }
  })();

  return { promise, abort };
}

module.exports = {
  verifyAccessPin,
  uploadVideoToCloud,
};
