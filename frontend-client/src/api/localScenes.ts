import type {
  ActivateLocalSceneResponse,
  CreateLocalSceneRequest,
  CreateLocalSceneResponse,
  DeleteLocalSceneResponse,
  ListLocalScenesResponse,
  RenameLocalSceneRequest,
  RenameLocalSceneResponse,
} from '@ragsystem/api-contracts';

import { http } from './http.js';

const BASE = '/api/local/scenes';

export function listScenes(): Promise<ListLocalScenesResponse> {
  return http.get(BASE);
}

export function createScene(payload: CreateLocalSceneRequest): Promise<CreateLocalSceneResponse> {
  return http.post(BASE, payload);
}

export function activateScene(sceneId: string): Promise<ActivateLocalSceneResponse> {
  return http.post(`${BASE}/${sceneId}/activate`);
}

export function renameScene(sceneId: string, payload: RenameLocalSceneRequest): Promise<RenameLocalSceneResponse> {
  return http.patch(`${BASE}/${sceneId}`, payload);
}

export function deleteScene(sceneId: string): Promise<DeleteLocalSceneResponse> {
  return http.del(`${BASE}/${sceneId}`);
}
