import { http } from './http.js';

const BASE = '/api/platform';

export const listPlatformTenants = async (params = {}) => http.get(`${BASE}/tenants`, { params });
export const setPlatformTenantStatus = async (tenantId, status) => http.patch(`${BASE}/tenants/${encodeURIComponent(tenantId)}/status`, { status });
export const listPlatformUsers = async (params = {}) => http.get(`${BASE}/users`, { params });
export const listPlatformBots = async () => (await http.get(`${BASE}/bots`)).bots || [];
export const setPlatformUserStatus = async (userId, status) => http.patch(`${BASE}/users/${encodeURIComponent(userId)}/status`, { status });
export const setPlatformUserRole = async (userId, platformRole) => http.patch(`${BASE}/users/${encodeURIComponent(userId)}/platform-role`, { platformRole });
