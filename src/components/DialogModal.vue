<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  message: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
  showCancel?: boolean;
  danger?: boolean;
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-5 py-6"
      role="alertdialog"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-3xl bg-white p-6 sm:p-8 shadow-2xl border-2 border-stone-200">
        <div class="text-center">
          <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-4xl">
            {{ icon || '⚠️' }}
          </div>
          <h3 class="text-[24px] font-extrabold text-stone-900 mb-3">
            {{ title }}
          </h3>
          <p class="text-[21px] font-semibold leading-relaxed text-stone-800 mb-7">
            {{ message }}
          </p>
        </div>

        <div class="flex flex-col sm:flex-row gap-3">
          <button
            v-if="showCancel"
            type="button"
            @click="emit('cancel')"
            class="w-full rounded-2xl border-2 border-stone-300 bg-white px-6 py-4 text-[21px] font-bold text-stone-700 hover:bg-stone-100 active:scale-[0.99] transition"
          >
            {{ cancelText || '取消' }}
          </button>
          <button
            type="button"
            @click="emit('confirm')"
            :class="[
              'w-full rounded-2xl px-6 py-4 text-[22px] font-extrabold text-white shadow-md active:scale-[0.99] transition',
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-rose-600 hover:bg-rose-700',
            ]"
          >
            {{ confirmText || '我知道了' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
