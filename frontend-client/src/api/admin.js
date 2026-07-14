import { http } from './http.js';

const BASE = '/api/admin/tenants';

const tenantPath = (tenantId) => `${BASE}/${encodeURIComponent(tenantId)}`;
const memberPath = (tenantId, userId) => `${tenantPath(tenantId)}/members/${encodeURIComponent(userId)}`;

export const listTenants = async () => (await http.get(BASE)).tenants || [];
export const createTenant = async (displayName) => (await http.post(BASE, { displayName })).tenant;
export const listMembers = async (tenantId) => (await http.get(`${tenantPath(tenantId)}/members`)).members || [];
export const inviteMember = async (tenantId, body) => (await http.post(`${tenantPath(tenantId)}/members`, body)).member;
export const updateMemberRole = async (tenantId, userId, role) => (await http.patch(memberPath(tenantId, userId), { role })).member;
export const removeMember = async (tenantId, userId) => http.del(memberPath(tenantId, userId));
