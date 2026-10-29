import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { capturePinFromUrl, setStoredPin } from './utils/storage';

// 首次访问 /?pin=mom666 时立即捕获并写入 localStorage
capturePinFromUrl();

router.beforeEach((to) => {
  const queryPin = to.query.pin;
  if (typeof queryPin === 'string' && queryPin.trim()) {
    setStoredPin(queryPin.trim());
  }
});

createApp(App).use(router).mount('#app');
