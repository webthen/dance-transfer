import { reactive } from 'vue';
import { getStoredPin, setStoredPin } from './storage';

interface PinModalState {
  visible: boolean;
  errorMessage: string;
  initialValue: string;
}

export const pinModalState = reactive<PinModalState>({
  visible: false,
  errorMessage: '',
  initialValue: '',
});

let pendingPromise: Promise<string | null> | null = null;
let pendingResolve: ((pin: string | null) => void) | null = null;

/**
 * 弹出访问口令输入框，等待用户输入口令后返回
 */
export function promptForAccessPin(errorMessage = ''): Promise<string | null> {
  pinModalState.errorMessage = errorMessage;
  pinModalState.initialValue = getStoredPin();
  pinModalState.visible = true;

  if (pendingPromise) {
    return pendingPromise;
  }

  pendingPromise = new Promise<string | null>((resolve) => {
    pendingResolve = resolve;
  });

  return pendingPromise;
}

export function submitPinModal(pin: string): void {
  const clean = pin.trim();
  if (!clean) {
    pinModalState.errorMessage = '请输入访问口令';
    return;
  }

  setStoredPin(clean);
  pinModalState.visible = false;
  pinModalState.errorMessage = '';

  const resolve = pendingResolve;
  pendingResolve = null;
  pendingPromise = null;

  if (resolve) {
    resolve(clean);
  }
}

export function cancelPinModal(): void {
  pinModalState.visible = false;
  pinModalState.errorMessage = '';

  const resolve = pendingResolve;
  pendingResolve = null;
  pendingPromise = null;

  if (resolve) {
    resolve(null);
  }
}
