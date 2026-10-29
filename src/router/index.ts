import { createRouter, createWebHistory } from 'vue-router';
import UploadView from '../views/UploadView.vue';
import AdminView from '../views/AdminView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'upload',
      component: UploadView,
      meta: { title: '广场舞视频上传' },
    },
    {
      path: '/admin',
      name: 'admin',
      component: AdminView,
      meta: { title: '广场舞视频管理与下载' },
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

router.afterEach((to) => {
  if (typeof document !== 'undefined' && typeof to.meta.title === 'string') {
    document.title = to.meta.title;
  }
});

export default router;
