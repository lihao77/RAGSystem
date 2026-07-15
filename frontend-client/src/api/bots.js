import { http } from './http.js';

const API_BASE = '/api/bots';

const botPath = botId => `${API_BASE}/${encodeURIComponent(botId)}`;
const cronPath = (botId, suffix = '') => `${botPath(botId)}/cron/tasks${suffix}`;

export async function listBots() {
  const result = await http.get(API_BASE);
  return result.bots || [];
}

export async function listTenantBots() {
  const result = await http.get(API_BASE, { params: { tenant: 1 } });
  return result.bots || [];
}

export async function createBot(displayName) {
  const result = await http.post(API_BASE, { display_name: displayName });
  return result.bot;
}

export async function getBot(botId) {
  return http.get(botPath(botId));
}

export async function updateBot(botId, displayName) {
  return http.put(botPath(botId), { display_name: displayName });
}

export async function deleteBot(botId) {
  return http.del(botPath(botId));
}

export async function getBotConfig(botId) {
  return http.get(`${botPath(botId)}/config`);
}

export async function updateBotConfig(botId, config) {
  return http.put(`${botPath(botId)}/config`, config);
}

export async function testBot(botId, input) {
  return http.post(`${botPath(botId)}/test`, input);
}

export async function sendBotMessage(botId, input) {
  return http.post(`${botPath(botId)}/send`, input);
}

export async function listBotCronTasks(botId) {
  return http.get(cronPath(botId));
}

export async function createBotCronTask(botId, task) {
  return http.post(cronPath(botId), task);
}

export async function updateBotCronTask(botId, taskId, updates) {
  return http.put(cronPath(botId, `/${encodeURIComponent(taskId)}`), updates);
}

export async function deleteBotCronTask(botId, taskId) {
  return http.del(cronPath(botId, `/${encodeURIComponent(taskId)}`));
}

export async function triggerBotCronTask(botId, taskId) {
  return http.post(cronPath(botId, `/${encodeURIComponent(taskId)}/trigger`));
}

export async function getBotCronHistory(botId, taskId, limit = 20) {
  return http.get(cronPath(botId, `/${encodeURIComponent(taskId)}/history`), { params: { limit } });
}
