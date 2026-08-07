const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_]+$/u;
const MEDIA_IMAGE_PATTERN = /^image\//u;

export function artifactAssetUrl(artifactId, assetId) {
  if (!ARTIFACT_ID_PATTERN.test(String(artifactId)) || !assetId) return '';
  return `/api/artifacts/${encodeURIComponent(artifactId)}/assets/${encodeURIComponent(assetId)}/content`;
}

export function normalizeArtifactManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('产物结构异常：Manifest 必须是对象');
  }
  if (value.schema_version !== 2) {
    throw new Error('暂不支持旧版 Artifact，当前需要 schema_version 2');
  }
  if (!ARTIFACT_ID_PATTERN.test(String(value.artifact_id || ''))) {
    throw new Error('产物结构异常：artifact_id 无效');
  }
  if (!Array.isArray(value.assets) || !Array.isArray(value.presentations)) {
    throw new Error('产物结构异常：缺少 assets 或 presentations');
  }
  const assets = value.assets.map((asset) => normalizeAsset(asset, value.artifact_id));
  const presentations = value.presentations.map(normalizePresentation);
  const presentation = selectPresentation(presentations);
  const primaryAsset = selectPrimaryAsset(assets, presentation);
  const displayKind = inferDisplayKind(presentation, primaryAsset);
  if (displayKind === 'chart' && !presentation) {
    throw new Error(`产物结构异常：${displayKind} 类型缺少 presentation`);
  }
  if (displayKind === 'unsupported' && !primaryAsset) {
    throw new Error(`暂不支持展示此产物类型: ${value.kind || 'unknown'}`);
  }
  return {
    ...value,
    subtype: typeof value.subtype === 'string' ? value.subtype : 'default',
    title: typeof value.title === 'string' ? value.title : '',
    assets,
    presentations,
    presentation,
    config: presentation?.config ?? {},
    displayKind,
    primaryAsset,
    content_url: primaryAsset?.content_url ?? null,
    mime_type: primaryAsset?.media_type ?? null,
    asset: primaryAsset
      ? { filename: primaryAsset.filename, mime_type: primaryAsset.media_type }
      : null,
  };
}

function normalizeAsset(value, artifactId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('产物结构异常：Asset 必须是对象');
  }
  if (!value.asset_id || !value.role || !value.filename || !value.media_type) {
    throw new Error('产物结构异常：Asset 缺少 asset_id、role、filename 或 media_type');
  }
  const expectedUrl = artifactAssetUrl(artifactId, value.asset_id);
  if (value.content_url !== expectedUrl) {
    throw new Error(`产物结构异常：Asset ${value.asset_id} 的 content_url 无效`);
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0 || typeof value.sha256 !== 'string') {
    throw new Error(`产物结构异常：Asset ${value.asset_id} 的内容元数据无效`);
  }
  return value;
}

function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('产物结构异常：Presentation 必须是对象');
  }
  if (!value.presentation_id || !value.surface || !value.renderer) {
    throw new Error('产物结构异常：Presentation 缺少 presentation_id、surface 或 renderer');
  }
  return {
    ...value,
    assets: value.assets && typeof value.assets === 'object' && !Array.isArray(value.assets) ? value.assets : {},
    config: value.config && typeof value.config === 'object' ? value.config : {},
  };
}

function selectPresentation(presentations) {
  return presentations.find((item) => {
    const renderer = String(item.renderer).toLowerCase();
    const surface = String(item.surface).toLowerCase();
    return surface === 'chart' || renderer.startsWith('chart.');
  }) ?? presentations[0] ?? null;
}

function selectPrimaryAsset(assets, presentation) {
  if (!assets.length) return null;
  const refs = presentation?.assets && typeof presentation.assets === 'object'
    ? Object.values(presentation.assets)
    : [];
  const referenced = assets.find((asset) => refs.includes(asset.asset_id));
  return referenced
    ?? assets.find((asset) => asset.role === 'preview' || asset.role === 'image')
    ?? assets[0];
}

function inferDisplayKind(presentation, primaryAsset) {
  const surface = String(presentation?.surface || '').toLowerCase();
  const renderer = String(presentation?.renderer || '').toLowerCase();
  if (surface === 'chart' || renderer.startsWith('chart.')) return 'chart';
  if (MEDIA_IMAGE_PATTERN.test(primaryAsset?.media_type || '')) return 'image';
  return primaryAsset ? 'file' : 'unsupported';
}
