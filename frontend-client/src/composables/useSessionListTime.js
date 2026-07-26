import { onScopeDispose, readonly, ref } from 'vue';

const MINUTE_MS = 60_000;
const sharedNow = ref(new Date());
let minuteTimer = null;
let subscribers = 0;

function localDateKey(value) {
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

export function formatSessionTime(value, nowValue = new Date()) {
  const time = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  const now = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue);
  if (Number.isNaN(time.getTime()) || Number.isNaN(now.getTime())) return '';

  const sameDay = localDateKey(time) === localDateKey(now);
  if (sameDay) {
    const diffMs = Math.max(0, now.getTime() - time.getTime());
    const minutes = Math.floor(diffMs / MINUTE_MS);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    return `${Math.floor(minutes / 60)}小时前`;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDateKey(time) === localDateKey(yesterday)) return '昨天';
  if (time.getFullYear() === now.getFullYear()) return `${time.getMonth() + 1}月${time.getDate()}日`;
  const month = String(time.getMonth() + 1).padStart(2, '0');
  const day = String(time.getDate()).padStart(2, '0');
  return `${time.getFullYear()}-${month}-${day}`;
}

function startMinuteTick() {
  subscribers += 1;
  sharedNow.value = new Date();
  if (!minuteTimer) {
    minuteTimer = window.setInterval(() => {
      sharedNow.value = new Date();
    }, MINUTE_MS);
  }
  return () => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && minuteTimer) {
      window.clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

export function useSessionListTime() {
  if (typeof window === 'undefined') return readonly(sharedNow);
  const stop = startMinuteTick();
  onScopeDispose(stop);
  return readonly(sharedNow);
}
