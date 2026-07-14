import { http } from './http.js';

const BASE = '/api/auth';

export const install = async (payload) => http.post('/api/install', payload);
export const login = async ({ username, password }) => http.post(`${BASE}/login`, { username, password });
export const getMe = async () => http.get(`${BASE}/me`);
export const logout = async () => http.post(`${BASE}/logout`);
export const switchTenant = async (tenantId) => http.post(`${BASE}/switch-tenant`, { tenantId });
