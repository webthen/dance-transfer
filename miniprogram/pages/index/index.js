const {
  MAX_FILE_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  QUICK_SUFFIXES,
  DEFAULT_PIN,
} = require('../../config');
const {
  sanitizeDanceName,
  appendDanceSuffix,
  formatFileSizeMB,
} = require('../../utils/dance');
const { uploadVideoToCloud } = require('../../utils/uploader');

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
    alertIcon: '🎬',
    alertAction: '',

    // 微信官方隐私保护指引授权弹窗
    showPrivacyModal: false,
    privacyContractName: '《小程序隐私保护指引》',
  },

  pendingRetryFile: null,

  onLoad() {
    // 兼容微信隐私保护协议按需弹窗（保障真机 wx.chooseMedia 100% 可用且合规过审）
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

  // 支持微信右上角及底部按钮一键转发
  onShareAppMessage() {
    return {
      title: '广场舞视频传送站 · 填写名称一键直传云端',
      path: '/pages/index/index',
    };
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

  showLargeAlert(title, message, options = {}) {
    this.setData({
      alertVisible: true,
      alertTitle: title || '温馨提示',
      alertMessage: message || '',
      alertIcon: options.icon || '🎬',
      alertAction: options.action || '',
    });
  },

  closeLargeAlert() {
    this.setData({
      alertVisible: false,
      alertAction: '',
    });
  },

  handleOpenSetting() {
    this.setData({ alertVisible: false, alertAction: '' });
    if (typeof wx.openSetting === 'function') {
      wx.openSetting({
        fail(err) {
          console.warn('[openSetting fail]', err);
        },
      });
    }
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
    return new Promise(async (resolve, reject) => {
      // 1. 若支持微信官方隐私协议鉴权，先主动触发合规检测
      if (typeof wx.requirePrivacyAuthorize === 'function') {
        await new Promise((res) => {
          wx.requirePrivacyAuthorize({
            success: () => res(true),
            fail: (err) => {
              console.warn('[requirePrivacyAuthorize fail]', err);
              res(false);
            },
          });
        });
      }

      // 2. 调用官方选取媒体接口
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
            console.error('[chooseMedia fail]', err);
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
            console.error('[chooseVideo fail]', err);
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
      const msg = (err && err.errMsg) || (typeof err === 'string' ? err : '');
      console.warn('[handleSelectAndUpload catch]', err);

      if (msg.includes('cancel')) {
        return; // 用户主动取消选视频，静默返回
      }

      // 微信隐私指引在腾讯后台尚未审核完成或未生效
      if (
        msg.includes('api scope is not declared in the privacy agreement') ||
        (msg.includes('privacy') && msg.includes('declared'))
      ) {
        this.showLargeAlert(
          '微信隐私指引生效中',
          '后台刚提交的《用户隐私保护指引》需微信官方审核数分钟。审核通过后，请下拉微信聊天界面删除本小程序并重新扫码进入。',
          { icon: '⏳' }
        );
        return;
      }

      // 系统相册访问权限被拒绝（iOS / Android 系统权限）
      if (msg.includes('auth deny') || msg.includes('authorize:fail')) {
        this.showLargeAlert(
          '需要相册访问权限',
          '小程序相册权限未开启。请点击下方按钮前往设置页面开启相册权限。',
          { action: 'openSetting', icon: '🔒' }
        );
        return;
      }

      if (msg.includes('privacy') || msg.includes('authorize')) {
        this.showLargeAlert(
          '需要相册访问权限',
          '请允许小程序读取手机相册以便选择要上传的视频。若刚在后台更新了隐私协议，请稍候几分钟微信后台生效。',
          { icon: '🛡️' }
        );
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
      pin: DEFAULT_PIN || 'DancerAt654321',
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
