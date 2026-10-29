<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatFileSizeMB, formatUploadTime, type VideoItem } from '../../shared/dance';
import DialogModal from '../components/DialogModal.vue';
import {
  PinCancelledError,
  deleteVideos,
  fetchVideoList,
  requestDownloadUrl,
} from '../utils/api';
import { promptForAccessPin } from '../utils/auth-modal';
import {
  currentPinRef,
  isVideoDownloaded,
  markVideoDownloaded,
  pruneStaleDownloadedRecords,
} from '../utils/storage';

const videos = ref<VideoItem[]>([]);
const loading = ref(false);
const loadError = ref('');

const downloadingKeys = ref<Set<string>>(new Set());
const batchDownloading = ref(false);
const batchProgressText = ref('');
const deletingKeys = ref<Set<string>>(new Set());
const batchDeleting = ref(false);

const toastMessage = ref('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const activeDownloadFrames: HTMLIFrameElement[] = [];

// 确认删除弹窗状态
const confirmModal = ref<{
  visible: boolean;
  title: string;
  message: string;
  confirmText: string;
  onConfirm: (() => void) | null;
}>({
  visible: false,
  title: '',
  message: '',
  confirmText: '确认删除',
  onConfirm: null,
});

const unreadVideos = computed(() => videos.value.filter((v) => !isVideoDownloaded(v)));
const downloadedVideos = computed(() => videos.value.filter((v) => isVideoDownloaded(v)));
const totalSizeBytes = computed(() => videos.value.reduce((acc, cur) => acc + cur.size, 0));

function showToast(msg: string) {
  toastMessage.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMessage.value = '';
  }, 3500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 使用独立隐藏 iframe 触发带 Content-Disposition: attachment 的预签名下载链接，
 * 避免批量顺序下载（500ms 间隔）时前一个请求尚未收到响应头就被后一个顶层导航取消。
 */
function triggerBrowserDownload(downloadUrl: string) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.src = downloadUrl;
  document.body.appendChild(iframe);
  activeDownloadFrames.push(iframe);

  setTimeout(() => {
    iframe.remove();
    const idx = activeDownloadFrames.indexOf(iframe);
    if (idx !== -1) activeDownloadFrames.splice(idx, 1);
  }, 120_000);
}

async function loadVideos() {
  loading.value = true;
  loadError.value = '';
  try {
    const list = await fetchVideoList();
    videos.value = list;
    pruneStaleDownloadedRecords(list);
  } catch (err) {
    if (err instanceof PinCancelledError) {
      loadError.value = '需要验证访问口令才能查看管理端列表';
    } else {
      loadError.value = err instanceof Error ? err.message : '加载视频列表失败';
    }
  } finally {
    loading.value = false;
  }
}

async function handleDownloadSingle(video: VideoItem) {
  if (downloadingKeys.value.has(video.key)) return;

  const nextSet = new Set(downloadingKeys.value);
  nextSet.add(video.key);
  downloadingKeys.value = nextSet;

  try {
    const res = await requestDownloadUrl(video.key);
    triggerBrowserDownload(res.downloadUrl);
    markVideoDownloaded(video);
    showToast(`已开始下载：${res.fileName}`);
  } catch (err) {
    if (!(err instanceof PinCancelledError)) {
      const msg = err instanceof Error ? err.message : '获取下载链接失败';
      showToast(`⚠️ ${msg}`);
    }
  } finally {
    const updated = new Set(downloadingKeys.value);
    updated.delete(video.key);
    downloadingKeys.value = updated;
  }
}

/**
 * 一键下载全部未读：顺序触发所有未标记“已下载”视频的浏览器下载任务（间隔 500ms 防止浏览器拦截）
 */
async function handleBatchDownloadUnread() {
  const targets = [...unreadVideos.value];
  if (targets.length === 0 || batchDownloading.value) return;

  batchDownloading.value = true;
  let successCount = 0;

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      batchProgressText.value = `正在下载 (${i + 1}/${targets.length})...`;

      const res = await requestDownloadUrl(item.key);
      triggerBrowserDownload(res.downloadUrl);
      markVideoDownloaded(item);
      successCount += 1;

      if (i < targets.length - 1) {
        await sleep(500);
      }
    }
    showToast(`已顺序触发 ${successCount} 个视频下载（若浏览器提示允许下载多个文件，请点允许）`);
  } catch (err) {
    if (!(err instanceof PinCancelledError)) {
      const msg = err instanceof Error ? err.message : '批量下载中断';
      showToast(`⚠️ ${msg}`);
    }
  } finally {
    batchDownloading.value = false;
    batchProgressText.value = '';
  }
}

function askDeleteSingle(video: VideoItem) {
  const downloaded = isVideoDownloaded(video);
  confirmModal.value = {
    visible: true,
    title: downloaded ? '删除已下载视频' : '该视频尚未下载！',
    message: downloaded
      ? `确定要从云端永久删除「${video.fileName}」吗？`
      : `「${video.fileName}」还未标记为已下载，确定要直接从云端永久删除吗？`,
    confirmText: '确认删除',
    onConfirm: () => executeDeleteKeys([video.key], false),
  };
}

function askClearAllDownloaded() {
  const targets = downloadedVideos.value;
  if (targets.length === 0) return;

  confirmModal.value = {
    visible: true,
    title: '清空所有已下载视频',
    message: `确定从云端物理删除全部 ${targets.length} 个已下载视频吗？删除前请确认文件已拷入 U 盘。`,
    confirmText: `确认清空 (${targets.length} 个)`,
    onConfirm: () => executeDeleteKeys(targets.map((v) => v.key), true),
  };
}

function handleConfirmModalAction() {
  const action = confirmModal.value.onConfirm;
  confirmModal.value.visible = false;
  confirmModal.value.onConfirm = null;
  if (action) action();
}

async function executeDeleteKeys(keys: string[], isBatch: boolean) {
  if (keys.length === 0) return;

  if (isBatch) {
    batchDeleting.value = true;
  } else {
    const next = new Set(deletingKeys.value);
    keys.forEach((k) => next.add(k));
    deletingKeys.value = next;
  }

  try {
    const res = await deleteVideos(keys);
    const removedSet = new Set(keys);
    videos.value = videos.value.filter((v) => !removedSet.has(v.key));
    pruneStaleDownloadedRecords(videos.value);
    showToast(`🗑️ 已从 R2 云端物理删除 ${res.deletedCount} 个视频`);
  } catch (err) {
    if (!(err instanceof PinCancelledError)) {
      const msg = err instanceof Error ? err.message : '删除失败';
      showToast(`⚠️ ${msg}`);
    }
  } finally {
    if (isBatch) {
      batchDeleting.value = false;
    } else {
      const next = new Set(deletingKeys.value);
      keys.forEach((k) => next.delete(k));
      deletingKeys.value = next;
    }
  }
}

async function handleChangePin() {
  const updated = await promptForAccessPin('');
  if (updated) {
    await loadVideos();
  }
}

async function copyMomUploadLink() {
  const pin = currentPinRef.value;
  const link = pin
    ? `${window.location.origin}/?pin=${encodeURIComponent(pin)}`
    : `${window.location.origin}/`;

  try {
    await navigator.clipboard.writeText(link);
    showToast('✅ 已复制老妈专属上传链接，可直接粘贴到微信发给老妈！');
  } catch {
    showToast(`上传链接：${link}`);
  }
}

onMounted(() => {
  loadVideos();
});

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer);
  while (activeDownloadFrames.length > 0) {
    const frame = activeDownloadFrames.pop();
    frame?.remove();
  }
});
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900 pb-16">
    <!-- 顶部管理栏 -->
    <header class="border-b border-slate-200 bg-white shadow-sm">
      <div class="mx-auto max-w-5xl px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div class="flex items-center gap-2.5">
            <span class="text-2xl">📼</span>
            <h1 class="text-xl sm:text-2xl font-extrabold text-slate-900">
              广场舞视频中转站 · 子女下载管理端
            </h1>
          </div>
          <p class="mt-1 text-sm text-slate-500">
            下载落地自动保留老妈填写的中文舞名，可直接拖入 U 盘；云端文件 14 天到期自动清理
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            @click="copyMomUploadLink"
            class="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100 transition"
          >
            <span>📋</span>
            <span>复制老妈微信上传链接</span>
          </button>
          <RouterLink
            to="/"
            class="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
          >
            <span>📱</span>
            <span>长辈上传页</span>
          </RouterLink>
          <button
            type="button"
            @click="handleChangePin"
            class="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
          >
            <span>🔑</span>
            <span>口令</span>
          </button>
          <button
            type="button"
            @click="loadVideos"
            :disabled="loading"
            class="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition"
          >
            <span :class="loading ? 'animate-spin' : ''">🔄</span>
            <span>刷新</span>
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 sm:px-6 pt-6 space-y-6">
      <!-- 顶部浮动通知提示 -->
      <div
        v-if="toastMessage"
        class="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900 shadow-sm flex items-center justify-between"
      >
        <span>{{ toastMessage }}</span>
        <button
          type="button"
          @click="toastMessage = ''"
          class="ml-3 text-emerald-700 hover:text-emerald-950 font-bold"
        >
          ✕
        </button>
      </div>

      <!-- 统计与批量操作工具栏 -->
      <section class="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
        <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <!-- 概览统计 -->
          <div class="flex flex-wrap items-center gap-3 sm:gap-5 text-sm">
            <div class="flex items-center gap-2 rounded-xl bg-blue-50 px-3.5 py-2 text-blue-900">
              <span class="h-2.5 w-2.5 rounded-full bg-blue-600"></span>
              <span>待下载未读：</span>
              <strong class="text-base font-extrabold">{{ unreadVideos.length }}</strong>
              <span>个</span>
            </div>

            <div class="flex items-center gap-2 rounded-xl bg-slate-100 px-3.5 py-2 text-slate-700">
              <span>✅ 已下载：</span>
              <strong class="text-base font-extrabold">{{ downloadedVideos.length }}</strong>
              <span>个</span>
            </div>

            <div class="text-slate-500">
              共 {{ videos.length }} 个视频（占用 {{ formatFileSizeMB(totalSizeBytes) }}）
            </div>
          </div>

          <!-- 批量操作按钮 -->
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              @click="handleBatchDownloadUnread"
              :disabled="unreadVideos.length === 0 || batchDownloading || loading"
              class="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 transition"
            >
              <span>⬇️</span>
              <span>
                {{
                  batchDownloading
                    ? batchProgressText
                    : `一键下载全部未读 (${unreadVideos.length})`
                }}
              </span>
            </button>

            <button
              type="button"
              @click="askClearAllDownloaded"
              :disabled="downloadedVideos.length === 0 || batchDeleting || loading"
              class="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 transition"
            >
              <span>🗑️</span>
              <span>
                {{
                  batchDeleting
                    ? '正在清理...'
                    : `清空所有已下载视频 (${downloadedVideos.length})`
                }}
              </span>
            </button>
          </div>
        </div>
      </section>

      <!-- 错误提示 -->
      <section
        v-if="loadError"
        class="rounded-2xl border border-red-200 bg-red-50 p-6 text-center space-y-3"
      >
        <p class="text-base font-bold text-red-800">⚠️ {{ loadError }}</p>
        <div class="flex justify-center gap-3">
          <button
            type="button"
            @click="loadVideos"
            class="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700"
          >
            重新加载
          </button>
          <button
            type="button"
            @click="handleChangePin"
            class="rounded-xl border border-red-300 bg-white px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50"
          >
            输入访问口令
          </button>
        </div>
      </section>

      <!-- 加载骨架 -->
      <section
        v-else-if="loading && videos.length === 0"
        class="rounded-2xl border border-slate-200 bg-white p-12 text-center text-slate-500"
      >
        <div class="inline-block text-3xl animate-spin mb-3">⏳</div>
        <p class="text-base font-medium">正在拉取 R2 云端待拷贝视频列表...</p>
      </section>

      <!-- 空列表状态 -->
      <section
        v-else-if="videos.length === 0"
        class="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center"
      >
        <div class="text-5xl mb-3">📭</div>
        <h2 class="text-lg font-bold text-slate-800">当前没有待拷贝的广场舞视频</h2>
        <p class="mt-1 text-sm text-slate-500">
          老妈上传新视频后会自动出现在这里，也可以点击上方“复制老妈微信上传链接”发给老妈。
        </p>
      </section>

      <!-- 视频列表（按上传时间倒序排列） -->
      <section
        v-else
        class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <div class="divide-y divide-slate-200">
          <div
            v-for="video in videos"
            :key="video.key"
            :class="[
              'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-5 py-4 transition-colors',
              isVideoDownloaded(video)
                ? 'bg-slate-50/90 text-slate-400'
                : 'bg-white hover:bg-blue-50/30',
            ]"
          >
            <!-- 左侧：文件名 + 状态标签 + 体积 & 上传时间 -->
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="flex flex-wrap items-center gap-2.5">
                <span
                  v-if="isVideoDownloaded(video)"
                  class="inline-flex shrink-0 items-center rounded-lg bg-emerald-100/80 px-2.5 py-0.5 text-xs font-bold text-emerald-800"
                >
                  ✅ 已下载
                </span>
                <span
                  v-else
                  class="inline-flex shrink-0 items-center rounded-lg bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-800"
                >
                  ● 待拷U盘
                </span>

                <h3
                  :class="[
                    'text-base sm:text-lg font-bold break-all',
                    isVideoDownloaded(video) ? 'text-slate-500' : 'text-slate-900',
                  ]"
                >
                  {{ video.fileName }}
                </h3>
              </div>

              <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                <span class="tabular-nums font-medium">
                  📦 {{ formatFileSizeMB(video.size) }}
                </span>
                <span class="tabular-nums" :title="video.uploadedAt">
                  🕒 {{ formatUploadTime(video.uploadedAt) }}
                </span>
              </div>
            </div>

            <!-- 右侧：下载视频 & 单个删除 -->
            <div class="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                @click="handleDownloadSingle(video)"
                :disabled="downloadingKeys.has(video.key)"
                :class="[
                  'inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold transition shadow-sm disabled:opacity-50',
                  isVideoDownloaded(video)
                    ? 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700',
                ]"
              >
                <span>⬇️</span>
                <span>
                  {{
                    downloadingKeys.has(video.key)
                      ? '准备中...'
                      : '下载视频'
                  }}
                </span>
              </button>

              <button
                type="button"
                @click="askDeleteSingle(video)"
                :disabled="deletingKeys.has(video.key)"
                class="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-red-600 hover:border-red-200 hover:bg-red-50 disabled:opacity-50 transition"
              >
                {{ deletingKeys.has(video.key) ? '删除中...' : '删除' }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- 删除确认弹窗 -->
    <DialogModal
      :visible="confirmModal.visible"
      :title="confirmModal.title"
      :message="confirmModal.message"
      icon="🗑️"
      :confirm-text="confirmModal.confirmText"
      cancel-text="取消"
      :show-cancel="true"
      :danger="true"
      @confirm="handleConfirmModalAction"
      @cancel="confirmModal.visible = false"
    />
  </div>
</template>
