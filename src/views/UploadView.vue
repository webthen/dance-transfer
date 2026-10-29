<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  MAX_FILE_SIZE_BYTES,
  OVERSIZE_ERROR_MESSAGE,
  QUICK_SUFFIXES,
  appendDanceSuffix,
  extractFileExtFromFileName,
  formatFileSizeMB,
  sanitizeDanceName,
} from '../../shared/dance';
import DialogModal from '../components/DialogModal.vue';
import { PinCancelledError, requestUploadUrl, uploadVideoDirectToR2 } from '../utils/api';

type UploadStage = 'idle' | 'uploading' | 'success' | 'error';

const danceNameInput = ref('');
const danceInputRef = ref<HTMLInputElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const nameErrorActive = ref(false);
const shakeTrigger = ref(false);

const stage = ref<UploadStage>('idle');
const uploadPercent = ref(0);
const uploadedBytes = ref(0);
const totalBytes = ref(0);
const uploadingTitle = ref('');
const succeededDanceTitle = ref('');
const errorMessage = ref('');
const pendingRetryFile = ref<File | null>(null);

const alertVisible = ref(false);
const alertTitle = ref('温馨提示');
const alertMessage = ref('');

let activeAbort: (() => void) | null = null;

const sanitizedName = computed(() => sanitizeDanceName(danceNameInput.value));

function showLargeAlert(title: string, message: string) {
  alertTitle.value = title;
  alertMessage.value = message;
  alertVisible.value = true;
}

function triggerNameRequiredFeedback() {
  nameErrorActive.value = true;
  shakeTrigger.value = false;
  // 重新触发抖动动画帧
  requestAnimationFrame(() => {
    shakeTrigger.value = true;
  });
  nextTick(() => {
    danceInputRef.value?.focus();
    danceInputRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function handleNameInput() {
  if (sanitizedName.value) {
    nameErrorActive.value = false;
  }
}

function clearDanceName() {
  danceNameInput.value = '';
  nameErrorActive.value = false;
  nextTick(() => {
    danceInputRef.value?.focus();
  });
}

function handleSuffixClick(suffix: string) {
  danceNameInput.value = appendDanceSuffix(danceNameInput.value, suffix);
  if (sanitizedName.value) {
    nameErrorActive.value = false;
  }
}

/**
 * 前置校验 1：点击选视频按钮时，若未填写舞蹈名称，高亮抖动提示，不触发选文件
 */
function handleSelectVideoClick(event: MouseEvent) {
  if (!sanitizedName.value) {
    event.preventDefault();
    triggerNameRequiredFeedback();
    return;
  }
  // 清空旧 value，确保长辈重复选择同一个视频也能正常触发 change 事件
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
}

async function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  if (!sanitizedName.value) {
    input.value = '';
    triggerNameRequiredFeedback();
    return;
  }

  // 前置校验 2：文件大小不能超过 500MB
  if (file.size > MAX_FILE_SIZE_BYTES) {
    input.value = '';
    showLargeAlert('视频太大啦', OVERSIZE_ERROR_MESSAGE);
    return;
  }

  if (file.size <= 0) {
    input.value = '';
    showLargeAlert('无法上传', '选中的视频文件大小为空，请重新选一个视频哦');
    return;
  }

  await startUploadFlow(file);
}

async function startUploadFlow(file: File) {
  const cleanName = sanitizedName.value;
  if (!cleanName) {
    triggerNameRequiredFeedback();
    return;
  }

  pendingRetryFile.value = file;
  errorMessage.value = '';
  uploadPercent.value = 0;
  uploadedBytes.value = 0;
  totalBytes.value = file.size;
  uploadingTitle.value = cleanName;
  stage.value = 'uploading';

  const contentType = file.type && file.type.trim() ? file.type.trim() : 'video/mp4';
  const fileExt = extractFileExtFromFileName(file.name, contentType);

  try {
    // 1. 向后端申请 R2 预签名直传 PUT URL（含重名防覆盖检查）
    const presigned = await requestUploadUrl({
      danceName: cleanName,
      fileExt,
      fileSize: file.size,
      contentType,
    });

    uploadingTitle.value = presigned.danceTitle;

    // 2. 使用 XMLHttpRequest 直传 R2，实时展示 0% - 100% 进度
    const uploader = uploadVideoDirectToR2({
      uploadUrl: presigned.uploadUrl,
      file,
      contentType: presigned.contentType,
      onProgress: (percent, loaded, total) => {
        uploadPercent.value = percent;
        uploadedBytes.value = loaded;
        totalBytes.value = total;
      },
    });

    activeAbort = uploader.abort;
    await uploader.promise;
    activeAbort = null;

    succeededDanceTitle.value = presigned.danceTitle;
    pendingRetryFile.value = null;
    stage.value = 'success';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    activeAbort = null;
    if (err instanceof PinCancelledError) {
      // 用户关闭了口令框，回到表单保留已填内容
      stage.value = 'idle';
      return;
    }
    const msg = err instanceof Error ? err.message : '上传过程中出现问题，请重试';
    if (msg === OVERSIZE_ERROR_MESSAGE) {
      stage.value = 'idle';
      showLargeAlert('视频太大啦', OVERSIZE_ERROR_MESSAGE);
      return;
    }
    errorMessage.value = msg;
    stage.value = 'error';
  }
}

function handleRetryUpload() {
  if (pendingRetryFile.value) {
    startUploadFlow(pendingRetryFile.value);
  } else {
    stage.value = 'idle';
  }
}

function handleResetForNext() {
  if (activeAbort) {
    activeAbort();
    activeAbort = null;
  }
  danceNameInput.value = '';
  nameErrorActive.value = false;
  shakeTrigger.value = false;
  uploadPercent.value = 0;
  uploadedBytes.value = 0;
  totalBytes.value = 0;
  uploadingTitle.value = '';
  succeededDanceTitle.value = '';
  errorMessage.value = '';
  pendingRetryFile.value = null;
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
  stage.value = 'idle';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (stage.value === 'uploading') {
    event.preventDefault();
    event.returnValue = '视频正在上传中，请不要关闭页面';
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (activeAbort) {
    activeAbort();
    activeAbort = null;
  }
});
</script>

<template>
  <main class="min-h-screen px-4 py-6 sm:py-10 flex flex-col items-center justify-start">
    <div class="w-full max-w-lg">
      <!-- 顶部简洁标题（无多余导航干扰） -->
      <header class="mb-6 text-center">
        <h1 class="text-[28px] sm:text-[32px] font-black tracking-tight text-stone-900">
          💃 广场舞视频传送站
        </h1>
        <p class="mt-2 text-[19px] font-medium text-stone-700">
          写好舞蹈名字，把视频传给儿子拷 U 盘
        </p>
      </header>

      <!-- 状态一：上传成功全屏/大字反馈页 -->
      <section
        v-if="stage === 'success'"
        class="rounded-3xl border-2 border-emerald-300 bg-white p-7 sm:p-9 text-center shadow-xl"
      >
        <div
          class="mx-auto mb-5 flex h-24 w-24 items-center justify-center rounded-full bg-emerald-100 text-6xl"
        >
          🎉
        </div>

        <h2 class="text-[26px] sm:text-[30px] font-black leading-snug text-stone-900 break-words">
          ✅《{{ succeededDanceTitle }}》上传成功！儿子收到啦
        </h2>

        <p class="mt-4 text-[20px] leading-relaxed text-stone-700">
          视频已经稳稳传好啦，现在可以放心退出，或者继续传下一支舞。
        </p>

        <button
          type="button"
          @click="handleResetForNext"
          class="mt-8 w-full min-h-[68px] rounded-2xl bg-emerald-600 px-6 py-5 text-[23px] font-extrabold text-white shadow-lg hover:bg-emerald-700 active:scale-[0.99] transition"
        >
          【继续传下一个】
        </button>
      </section>

      <!-- 状态二：正在上传大号进度页 -->
      <section
        v-else-if="stage === 'uploading'"
        class="rounded-3xl border-2 border-rose-200 bg-white p-7 sm:p-9 shadow-xl"
      >
        <div class="text-center">
          <p class="text-[20px] font-bold text-stone-600">正在传送舞蹈视频</p>
          <h2 class="mt-1 text-[24px] font-black text-stone-900 break-words">
            《{{ uploadingTitle }}》
          </h2>

          <!-- 超大号百分比数字 -->
          <div class="my-6 text-[64px] leading-none font-black text-rose-600 tabular-nums">
            {{ uploadPercent }}%
          </div>

          <!-- 高对比度大号进度条 -->
          <div
            class="h-8 w-full overflow-hidden rounded-full bg-stone-200 border border-stone-300 p-1"
            role="progressbar"
            :aria-valuenow="uploadPercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full rounded-full bg-gradient-to-r from-rose-500 to-rose-600 transition-all duration-200 ease-out"
              :style="{ width: `${Math.max(uploadPercent, 3)}%` }"
            />
          </div>

          <p class="mt-3 text-[19px] font-semibold text-stone-700 tabular-nums">
            已传 {{ formatFileSizeMB(uploadedBytes) }} / 共 {{ formatFileSizeMB(totalBytes) }}
          </p>
        </div>

        <!-- 醒目防关闭提示 -->
        <div
          class="mt-7 rounded-2xl border-2 border-amber-400 bg-amber-50 px-5 py-4 text-center"
        >
          <p class="text-[21px] font-extrabold text-amber-950 leading-relaxed">
            ⏳ 正在上传中，请不要关闭页面...
          </p>
        </div>
      </section>

      <!-- 状态三：网络异常一键重试页（保留已填舞名与已选文件） -->
      <section
        v-else-if="stage === 'error'"
        class="rounded-3xl border-2 border-red-300 bg-white p-7 sm:p-9 text-center shadow-xl"
      >
        <div
          class="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-red-100 text-5xl"
        >
          📡
        </div>
        <h2 class="text-[25px] font-black text-stone-900">上传没有完成</h2>
        <p class="mt-3 text-[20px] font-semibold leading-relaxed text-red-700">
          {{ errorMessage }}
        </p>

        <div class="mt-7 space-y-4">
          <button
            type="button"
            @click="handleRetryUpload"
            class="w-full min-h-[66px] rounded-2xl bg-rose-600 px-6 py-4 text-[22px] font-extrabold text-white shadow-lg hover:bg-rose-700 active:scale-[0.99] transition"
          >
            🔄 点这里重新上传
          </button>
          <button
            type="button"
            @click="stage = 'idle'"
            class="w-full min-h-[60px] rounded-2xl border-2 border-stone-300 bg-white px-6 py-4 text-[20px] font-bold text-stone-700 hover:bg-stone-100 transition"
          >
            返回修改名字或重选视频
          </button>
        </div>
      </section>

      <!-- 状态四：默认填写舞蹈名 & 选择视频表单 -->
      <section v-else class="space-y-6">
        <!-- 第一步：填写舞蹈名称（必填） -->
        <div
          :class="[
            'rounded-3xl border-2 bg-white p-6 sm:p-7 shadow-md transition-colors',
            nameErrorActive ? 'border-red-500 bg-red-50/30' : 'border-stone-200',
            shakeTrigger ? 'animate-shake' : '',
          ]"
          @animationend="shakeTrigger = false"
        >
          <div class="flex items-center gap-3 mb-4">
            <span
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-600 text-[20px] font-black text-white"
            >
              1
            </span>
            <label for="dance-name-input" class="text-[22px] font-extrabold text-stone-900">
              第一步：填写舞蹈名字（必填）
            </label>
          </div>

          <div class="relative">
            <input
              id="dance-name-input"
              ref="danceInputRef"
              v-model="danceNameInput"
              @input="handleNameInput"
              type="text"
              enterkeyhint="done"
              placeholder="请输入舞蹈名字（如：苹果香）"
              :class="[
                'w-full rounded-2xl border-2 px-4 py-4 pr-14 text-[22px] font-bold text-stone-900 placeholder:font-normal placeholder:text-stone-400 focus:outline-none focus:ring-4 transition',
                nameErrorActive
                  ? 'border-red-500 bg-white focus:border-red-600 focus:ring-red-100'
                  : 'border-stone-300 bg-stone-50 focus:border-rose-600 focus:bg-white focus:ring-rose-100',
              ]"
            />
            <button
              v-if="danceNameInput"
              type="button"
              @click="clearDanceName"
              aria-label="清空已填名字"
              class="absolute right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-stone-200 text-[18px] font-bold text-stone-700 hover:bg-stone-300"
            >
              ✕
            </button>
          </div>

          <!-- 未填写时的醒目提示 -->
          <p
            v-if="nameErrorActive"
            class="mt-3 rounded-xl bg-red-100 border border-red-300 px-4 py-3 text-[19px] font-extrabold text-red-800"
          >
            👆 请先在这里填写舞蹈名字，再选视频哦！
          </p>

          <!-- 快捷后缀标签 -->
          <div class="mt-5">
            <p class="text-[18px] font-bold text-stone-700 mb-3">
              点下面按钮可自动加标签：
            </p>
            <div class="grid grid-cols-2 gap-3">
              <button
                v-for="suffix in QUICK_SUFFIXES"
                :key="suffix"
                type="button"
                @click="handleSuffixClick(suffix)"
                class="min-h-[54px] rounded-2xl border-2 border-rose-200 bg-rose-50/70 px-4 py-2.5 text-[20px] font-extrabold text-rose-800 hover:bg-rose-100 active:bg-rose-200 active:scale-[0.98] transition"
              >
                +{{ suffix }}
              </button>
            </div>
          </div>

          <!-- 实时清洗后文件名预览 -->
          <div
            v-if="sanitizedName"
            class="mt-5 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3"
          >
            <p class="text-[18px] font-bold text-emerald-900 break-all">
              📄 保存名字：{{ sanitizedName }}
            </p>
          </div>
        </div>

        <!-- 第二步：选择视频并上传 -->
        <div class="rounded-3xl border-2 border-stone-200 bg-white p-6 sm:p-7 shadow-md">
          <div class="flex items-center gap-3 mb-4">
            <span
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-600 text-[20px] font-black text-white"
            >
              2
            </span>
            <h2 class="text-[22px] font-extrabold text-stone-900">
              第二步：选手机里的视频上传
            </h2>
          </div>

          <!-- 严禁添加 capture 属性，确保微信内置浏览器拉起手机相册而非相机 -->
          <input
            id="dance-video-file"
            ref="fileInputRef"
            type="file"
            accept="video/*"
            class="sr-only"
            @change="handleFileChange"
          />

          <label
            for="dance-video-file"
            @click="handleSelectVideoClick"
            class="flex w-full min-h-[72px] cursor-pointer items-center justify-center gap-3 rounded-2xl bg-rose-600 px-6 py-5 text-center text-[23px] font-extrabold text-white shadow-lg hover:bg-rose-700 active:bg-rose-800 active:scale-[0.99] transition select-none"
          >
            <span>📹</span>
            <span>选择视频并开始上传</span>
          </label>

          <p class="mt-4 text-center text-[18px] font-medium text-stone-600">
            点上面红按钮，从手机相册选视频即可（最大支持 500M）
          </p>
        </div>
      </section>
    </div>

    <!-- 超大号弹窗提示（如超过 500M 提示） -->
    <DialogModal
      :visible="alertVisible"
      :title="alertTitle"
      :message="alertMessage"
      icon="🎬"
      confirm-text="我知道了"
      @confirm="alertVisible = false"
    />
  </main>
</template>
