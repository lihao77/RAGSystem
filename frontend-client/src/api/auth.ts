import type {
  AuthIdentity,
  AuthSession,
  InstallRequest,
  LoginRequest,
  LogoutResponse,
} from '@ragsystem/api-contracts';

import { http } from './http.js';

const BASE = '/api/auth';

export const install = async (payload: InstallRequest) => http.post('/api/install', payload);

export function login(payload: LoginRequest): Promise<AuthSession> {
  return http.post(`${BASE}/login`, payload);
}

export function getMe(): Promise<AuthIdentity> {
  return http.get(`${BASE}/me`);
}

export function logout(): Promise<LogoutResponse> {
  return http.post(`${BASE}/logout`);
}

export function switchTenant(tenantId: string): Promise<AuthSession> {
  return http.post(`${BASE}/switch-tenant`, { tenantId });
}
