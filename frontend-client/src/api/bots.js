import { http } from './http.js';

const API_BASE = '/api/bots';

const botPath = botId => `${API_BASE}/${encodeURIComponent(botId)}`;

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
