<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { cancelPinModal, pinModalState, submitPinModal } from '../utils/auth-modal';

const inputPin = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

watch(
  () => pinModalState.visible,
  async (visible) => {
    if (visible) {
      inputPin.value = pinModalState.initialValue || '';
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  }
);

function handleConfirm() {
  submitPinModal(inputPin.value);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="pinModalState.visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-5 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-modal-title"
    >
      <div class="w-full max-w-md rounded-3xl bg-white p-6 sm:p-8 shadow-2xl border-2 border-stone-200">
        <div class="flex items-center gap-3 mb-3">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-2xl">
            🔑
          </span>
          <h2 id="pin-modal-title" class="text-[24px] font-extrabold text-stone-900">
            请输入访问口令
          </h2>
        </div>

        <p class="text-[19px] leading-relaxed text-stone-700 mb-5">
          首次使用请输入家人告诉您的口令，输入一次后手机会自动记住。
        </p>

        <form @submit.prevent="handleConfirm" class="space-y-4">
          <div>
            <input
              ref="inputRef"
              v-model="inputPin"
              type="text"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="请输入访问口令（如：mom666）"
              class="w-full rounded-2xl border-2 border-stone-300 bg-stone-50 px-4 py-4 text-[22px] font-bold text-stone-900 placeholder:font-normal placeholder:text-stone-400 focus:border-rose-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <p
              v-if="pinModalState.errorMessage"
              class="mt-3 rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 text-[18px] font-bold text-red-700"
            >
              ⚠️ {{ pinModalState.errorMessage }}
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="submit"
              class="w-full rounded-2xl bg-rose-600 px-6 py-4 text-[22px] font-extrabold text-white shadow-md hover:bg-rose-700 active:scale-[0.99] transition"
            >
              确定
            </button>
            <button
              type="button"
              @click="cancelPinModal"
              class="w-full sm:w-36 rounded-2xl border-2 border-stone-300 bg-white px-5 py-4 text-[20px] font-bold text-stone-700 hover:bg-stone-100 active:scale-[0.99] transition"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
