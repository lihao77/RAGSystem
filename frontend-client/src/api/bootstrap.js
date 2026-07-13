import { http } from './http.js';

export const getBootstrap = async () => http.get('/api/bootstrap');
