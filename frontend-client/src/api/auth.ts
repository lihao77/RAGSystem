import type { AuthIdentity } from '@ragsystem/api-contracts';
import { http } from './http.js';

export function getMe(): Promise<AuthIdentity> {
  return http.get('/api/auth/me');
}
