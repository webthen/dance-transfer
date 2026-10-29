const { MAX_FILE_SIZE_BYTES, OVERSIZE_ERROR_MESSAGE, QUICK_SUFFIXES } = require('../../config');
const {
  sanitizeDanceName,
  appendDanceSuffix,
  formatFileSizeMB,
} = require('../../utils/dance');
const { getStoredPin, setStoredPin, clearStoredPin } = require('../../utils/storage');
const { verifyAccessPin, uploadVideoToCloud } = require('../../utils/uploader');

let activeUploadAbort = null;
let privacyResolvers = new Set();

function safeVibrate(type) {
  try {
    wx.vibrateShort({ type: type || 'medium' });
  } catch (e) {
    // 忽略部分静音/不支持设备异常
  }
}

function setScreenKeepAwake(keepAwake) {
  try {
    wx.setKeepScreenOn({ keepScreenOn: Boolean(keepAwake) });
  } catch (e) {
    // 忽略异常
  }
}

Page({
  data: {
    // 口令门禁状态
    isUnlocked: false,
    gatePinInput: '',
    gatePinError: '',
    verifyingGate: false,

    // 上传表单状态
    quickSuffixes: QUICK_SUFFIXES,
    danceNameInput: '',
    sanitizedName: '',
    nameErrorActive: false,
    shakeActive: false,
    focusNameInput: false,

    // 流程阶段：idle | uploading | success | error
    stage: 'idle',
    uploadingTitle: '',
    uploadPercent: 0,
    uploadedMBText: '0.0 MB',
    totalMBText: '0.0 MB',
    partNumber: 1,
    totalParts: 1,

    succeededDanceTitle: '',
    succeededFileName: '',
    errorMessage: '',
    hasPendingRetry: false,

    // 大字提示弹窗
    alertVisible: false,
    alertTitle: '温馨提示',
    alertMessage: '',

    // 微信官方隐私保护指引授权弹窗
    showPrivacyModal: false,
    privacyContractName: '《小程序隐私保护指引》',
  },

  pendingRetryFile: null,

  onLoad(options) {
    // 1. 捕获分享卡片或菊花码携带的 ?pin= 参数自动免密解锁
    let incomingPin = '';
    if (options && typeof options.pin === 'string' && options.pin.trim()) {
      incomingPin = decodeURIComponent(options.pin).trim();
    } else if (options && typeof options.scene === 'string' && options.scene.trim()) {
      const decodedScene = decodeURIComponent(options.scene);
      const match = decodedScene.match(/(?:^|&)pin=([^&]+)/);
      if (match && match[1]) {
        incomingPin = match[1].trim();
      }
    }

    if (incomingPin) {
      setStoredPin(incomingPin);
    }

    const storedPin = getStoredPin();
    this.setData({
      isUnlocked: Boolean(storedPin),
    });

    // 2. 兼容微信隐私保护协议按需弹窗（保障真机 wx.chooseMedia 100% 可用且合规过审）
    if (typeof wx.onNeedPrivacyAuthorization === 'function') {
      wx.onNeedPrivacyAuthorization((resolve) => {
        privacyResolvers.add(resolve);
        if (typeof wx.getPrivacySetting === 'function') {
          wx.getPrivacySetting({
            success: (res) => {
              this.setData({
                privacyContractName: res.privacyContractName || '《小程序隐私保护指引》',
                showPrivacyModal: true,
              });
            },
            fail: () => {
              this.setData({ showPrivacyModal: true });
            },
          });
        } else {
          this.setData({ showPrivacyModal: true });
        }
      });
    }
  },

  onUnload() {
    if (activeUploadAbort) {
      activeUploadAbort();
      activeUploadAbort = null;
    }
    setScreenKeepAwake(false);
    privacyResolvers.clear();
  },

  // 支持微信右上角及底部按钮一键转发免密卡片
  onShareAppMessage() {
    const pin = getStoredPin();
    const path = pin
      ? `/pages/index/index?pin=${encodeURIComponent(pin)}`
      : '/pages/index/index';
    return {
      title: '广场舞视频传送站 · 填写名称一键直传云端',
      path,
    };
  },

  // ================== 口令门禁逻辑 ==================

  onGatePinInput(e) {
    this.setData({
      gatePinInput: e.detail.value || '',
      gatePinError: '',
    });
  },

  async handleUnlockGate() {
    if (this.data.verifyingGate) return;
    const pin = String(this.data.gatePinInput || '').trim();
    if (!pin) {
      safeVibrate('medium');
      this.setData({ gatePinError: '请输入访问口令' });
      return;
    }

    this.setData({
      verifyingGate: true,
      gatePinError: '',
    });

    const result = await verifyAccessPin(pin);
    if (!result.valid) {
      safeVibrate('heavy');
      this.setData({
        verifyingGate: false,
        gatePinError: result.message || '访问口令不正确，请重新输入',
      });
      return;
    }

    setStoredPin(pin);
    safeVibrate('light');
    this.setData({
      verifyingGate: false,
      isUnlocked: true,
      gatePinInput: '',
      gatePinError: '',
    });
  },

  handleLockLogout() {
    wx.showModal({
      title: '退出当前口令',
      content: '退出后本机将清除已保存的访问口令，下次进入需重新输入口令。确认退出吗？',
      confirmText: '确认退出',
      confirmColor: '#E11D48',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          clearStoredPin();
          this.pendingRetryFile = null;
          this.setData({
            isUnlocked: false,
            stage: 'idle',
            danceNameInput: '',
            sanitizedName: '',
            hasPendingRetry: false,
          });
        }
      },
    });
  },

  // ================== 隐私保护弹窗逻辑 ==================

  handleOpenPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({});
    }
  },

  handleAgreePrivacy() {
    this.setData({ showPrivacyModal: false });
    privacyResolvers.forEach((resolve) => {
      resolve({ buttonId: 'agree-privacy-btn', event: 'agree' });
    });
    privacyResolvers.clear();
  },

  handleDisagreePrivacy() {
    this.setData({ showPrivacyModal: false });
    privacyResolvers.forEach((resolve) => {
      resolve({ event: 'disagree' });
    });
    privacyResolvers.clear();
  },

  // ================== 表单与快捷标签逻辑 ==================

  showLargeAlert(title, message) {
    this.setData({
      alertVisible: true,
      alertTitle: title || '温馨提示',
      alertMessage: message || '',
    });
  },

  closeLargeAlert() {
    this.setData({ alertVisible: false });
  },

  onDanceNameInput(e) {
    const val = e.detail.value || '';
    const clean = sanitizeDanceName(val);
    this.setData({
      danceNameInput: val,
      sanitizedName: clean,
      nameErrorActive: clean ? false : this.data.nameErrorActive,
    });
  },

  handleClearName() {
    this.setData({
      danceNameInput: '',
      sanitizedName: '',
      focusNameInput: true,
    });
  },

  handleAppendSuffix(e) {
    const suffix = e.currentTarget.dataset.suffix || '';
    const updated = appendDanceSuffix(this.data.danceNameInput, suffix);
    const clean = sanitizeDanceName(updated);
    safeVibrate('light');
    this.setData({
      danceNameInput: updated,
      sanitizedName: clean,
      nameErrorActive: false,
    });
  },

  triggerNameRequiredFeedback() {
    safeVibrate('heavy');
    this.setData(
      {
        nameErrorActive: true,
        shakeActive: false,
      },
      () => {
        setTimeout(() => {
          this.setData({
            shakeActive: true,
            focusNameInput: true,
          });
        }, 30);
      }
    );
  },

  // ================== 选视频与分片上传逻辑 ==================

  pickAlbumVideoOriginal() {
    return new Promise((resolve, reject) => {
      if (typeof wx.chooseMedia === 'function') {
        wx.chooseMedia({
          count: 1,
          mediaType: ['video'],
          sourceType: ['album'], // 仅拉起手机相册，避免误触打开相机
          sizeType: ['original'], // 强制原画直传，跳过微信耗时压缩并保留高清画质
          success(res) {
            const item = res.tempFiles && res.tempFiles[0];
            if (!item || !item.tempFilePath) {
              reject(new Error('未获取到所选视频文件'));
              return;
            }
            resolve({
              tempFilePath: item.tempFilePath,
              size: Number(item.size) || 0,
            });
          },
          fail(err) {
            reject(err);
          },
        });
      } else {
        wx.chooseVideo({
          sourceType: ['album'],
          compressed: false,
          success(res) {
            resolve({
              tempFilePath: res.tempFilePath,
              size: Number(res.size) || 0,
            });
          },
          fail(err) {
            reject(err);
          },
        });
      }
    });
  },

  async handleSelectAndUpload() {
    const cleanName = sanitizeDanceName(this.data.danceNameInput);
    if (!cleanName) {
      this.triggerNameRequiredFeedback();
      return;
    }

    let picked;
    try {
      picked = await this.pickAlbumVideoOriginal();
    } catch (err) {
      const msg = (err && err.errMsg) || '';
      if (msg.includes('cancel')) {
        return; // 用户主动取消选视频，静默返回
      }
      if (msg.includes('privacy') || msg.includes('authorize') || msg.includes('auth deny')) {
        this.showLargeAlert('需要相册访问权限', '请允许小程序读取手机相册以便选择要上传的舞蹈视频');
        return;
      }
      this.showLargeAlert('选取视频未成功', msg || '无法读取相册视频，请重试');
      return;
    }

    if (!picked.size || picked.size <= 0) {
      this.showLargeAlert('视频文件无效', '所选视频文件大小为 0，请重新选择其他视频');
      return;
    }

    if (picked.size > MAX_FILE_SIZE_BYTES) {
      safeVibrate('heavy');
      this.showLargeAlert('视频文件过大', OVERSIZE_ERROR_MESSAGE);
      return;
    }

    await this.startUploadProcess(picked, cleanName);
  },

  async startUploadProcess(videoFile, cleanDanceName) {
    const pin = getStoredPin();
    if (!pin) {
      this.setData({ isUnlocked: false });
      return;
    }

    this.pendingRetryFile = videoFile;
    setScreenKeepAwake(true);

    this.setData({
      stage: 'uploading',
      uploadingTitle: cleanDanceName,
      uploadPercent: 0,
      uploadedMBText: '0.0 MB',
      totalMBText: formatFileSizeMB(videoFile.size),
      partNumber: 1,
      totalParts: Math.max(1, Math.ceil(videoFile.size / (8 * 1024 * 1024))),
      errorMessage: '',
      hasPendingRetry: true,
    });

    const { promise, abort } = uploadVideoToCloud({
      filePath: videoFile.tempFilePath,
      fileSize: videoFile.size,
      danceName: cleanDanceName,
      pin,
      onProgress: ({ loaded, total, percent, partNumber, totalParts }) => {
        this.setData({
          uploadPercent: percent,
          uploadedMBText: formatFileSizeMB(loaded),
          totalMBText: formatFileSizeMB(total),
          partNumber: partNumber || 1,
          totalParts: totalParts || 1,
        });
      },
    });

    activeUploadAbort = abort;

    try {
      const result = await promise;
      activeUploadAbort = null;
      this.pendingRetryFile = null;
      safeVibrate('light');
      this.setData({
        stage: 'success',
        uploadPercent: 100,
        succeededDanceTitle: result.danceTitle,
        succeededFileName: result.fileName,
        hasPendingRetry: false,
      });
    } catch (err) {
      activeUploadAbort = null;
      if (err && err.isCancelled) {
        this.setData({
          stage: 'idle',
          uploadPercent: 0,
        });
        return;
      }

      if (err && err.isUnauthorized) {
        clearStoredPin();
        this.setData({
          isUnlocked: false,
          stage: 'idle',
          gatePinError: '访问口令已变更或失效，请重新输入口令',
        });
        return;
      }

      safeVibrate('heavy');
      this.setData({
        stage: 'error',
        errorMessage: (err && err.message) || '上传过程中连接中断，请点击重试',
        hasPendingRetry: Boolean(this.pendingRetryFile),
      });
    } finally {
      setScreenKeepAwake(false);
    }
  },

  handleCancelUploading() {
    if (activeUploadAbort) {
      activeUploadAbort();
      activeUploadAbort = null;
    }
    setScreenKeepAwake(false);
    this.setData({
      stage: 'idle',
      uploadPercent: 0,
    });
  },

  async handleRetryUpload() {
    const cleanName = sanitizeDanceName(this.data.danceNameInput);
    if (!this.pendingRetryFile || !cleanName) {
      this.setData({ stage: 'idle' });
      return;
    }
    await this.startUploadProcess(this.pendingRetryFile, cleanName);
  },

  handleBackToEdit() {
    this.setData({
      stage: 'idle',
      errorMessage: '',
    });
  },

  handleResetForNext() {
    this.pendingRetryFile = null;
    this.setData({
      danceNameInput: '',
      sanitizedName: '',
      nameErrorActive: false,
      shakeActive: false,
      stage: 'idle',
      uploadPercent: 0,
      succeededDanceTitle: '',
      succeededFileName: '',
      errorMessage: '',
      hasPendingRetry: false,
    });
  },
});
