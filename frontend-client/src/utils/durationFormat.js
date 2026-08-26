/**
 * agent 工作时长格式化（"已工作 X 分 X 秒"摘要行用）。
 * ms 缺失/非法返回空串，调用方降级为仅计数摘要。
 */
export function formatWorkDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return '不到 1 秒';
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 时 ${minutes} 分` : `${hours} 时`;
}
