const PIN_STORAGE_KEY = 'dance_transfer_access_pin';

let memoryPin = '';

function getStoredPin() {
  try {
    const val = wx.getStorageSync(PIN_STORAGE_KEY);
    if (typeof val === 'string' && val.trim()) {
      memoryPin = val.trim();
      return memoryPin;
    }
  } catch (e) {
    // 忽略受限存储异常
  }
  return memoryPin;
}

function setStoredPin(pin) {
  const clean = String(pin || '').trim();
  memoryPin = clean;
  try {
    wx.setStorageSync(PIN_STORAGE_KEY, clean);
  } catch (e) {
    // 忽略受限存储异常
  }
}

function clearStoredPin() {
  memoryPin = '';
  try {
    wx.removeStorageSync(PIN_STORAGE_KEY);
  } catch (e) {
    // 忽略受限存储异常
  }
}

module.exports = {
  getStoredPin,
  setStoredPin,
  clearStoredPin,
};
