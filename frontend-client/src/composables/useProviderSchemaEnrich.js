import { getProviderModels } from '../utils/modelList.js';

/**
 * SchemaForm 的 provider/model 下拉增强，供系统配置页（内置组）与插件设置页
 * （插件贡献的组）共用。含 provider/model_name 字段的组自动动态化为下拉；
 * 过滤与联动行为由组定义自带的 providerSelect 提示声明（visionOnly /
 * autoSelectModel），本模块不认识任何具体组名。
 *
 * providers 传 ref，选项来自系统模型 Provider 配置；model 选项来自所选
 * Provider 的模型列表；provider_type 由所选 Provider 自动带出。
 */
export function useProviderSchemaEnrich(providers) {
  function findSelectedProvider(groupConfig) {
    const providerName = String(groupConfig?.provider || '').trim();
    const providerType = String(groupConfig?.provider_type || '').trim();
    if (!providerName) return null;
    return providers.value.find((provider) => {
      const identifiers = [provider?.name, provider?.key].map((value) => String(value || '').trim());
      return identifiers.includes(providerName)
        && (!providerType || String(provider?.provider_type || '').trim() === providerType);
    }) || null;
  }

  // 具有 provider 语义的组（含 provider 或 model_name 字段），增强与级联只作用于
  // 这些组，避免给普通组写入 provider/provider_type/model_name 等无关字段。
  function providerGroups(schema) {
    return (schema?.groups ?? [])
      .filter((group) => (group.fields ?? []).some((field) => field.key === 'provider' || field.key === 'model_name'));
  }

  function enrichSchemaWithProviderSelection(schema, config) {
    // Schema data is held by a Vue ref and may contain reactive proxies, which
    // structuredClone cannot clone in the browser.
    const next = JSON.parse(JSON.stringify(schema || { groups: [] }));
    for (const group of next.groups || []) {
      const groupConfig = config?.[group.key];
      if (!groupConfig || typeof groupConfig !== 'object' || Array.isArray(groupConfig)) continue;
      const fields = group.fields || [];
      const hasProviderField = fields.some((field) => field.key === 'provider');
      const hasModelField = fields.some((field) => field.key === 'model_name');
      if (!hasProviderField && !hasModelField) continue;

      const currentProvider = String(groupConfig.provider || '').trim();
      const currentModel = String(groupConfig.model_name || '').trim();
      const visionOnly = group.providerSelect?.visionOnly === true;
      const providerOptions = providers.value
        .filter((provider) => !visionOnly
          || (Array.isArray(provider.models) && provider.models.some((entry) => Array.isArray(entry?.input_modalities) && entry.input_modalities.includes('image'))))
        .map((provider) => ({
          value: provider.name || provider.key || '',
          label: `${provider.name || provider.key || '未命名'}${provider.provider_type ? ` (${provider.provider_type})` : ''}`,
        }))
        .filter((option) => option.value);
      if (currentProvider && !providerOptions.some((option) => option.value === currentProvider)) {
        providerOptions.unshift({ value: currentProvider, label: `${currentProvider} (当前配置)` });
      }
      const selectedProvider = findSelectedProvider(groupConfig);
      const modelOptions = getProviderModels(selectedProvider).map((model) => ({ value: model, label: model }));
      if (currentModel && !modelOptions.some((option) => option.value === currentModel)) {
        modelOptions.unshift({ value: currentModel, label: `${currentModel} (当前配置)` });
      }

      for (const field of fields) {
        if (field.key === 'provider') {
          field.type = 'select';
          field.options = [{ value: '', label: '未设置' }, ...providerOptions];
        } else if (field.key === 'model_name') {
          field.type = 'select';
          field.options = [{ value: '', label: '选择模型' }, ...modelOptions];
        } else if (field.key === 'provider_type') {
          field.type = 'text';
          field.disabled = true;
          field.placeholder = '未设置';
          field.help = '由所选 Provider 自动带出';
        }
      }
    }
    return next;
  }

  // provider 切换/清空的级联，按组定义的 providerSelect 提示联动：
  // autoSelectModel 自动选第一个模型（缺省清空 model_name 等待手选）；
  // 运行参数挂在模型条目上，不再从 provider 回填同名字段。
  // 未涉及的组原样透传；prevConfig 为切换前的完整配置值。
  function applyProviderCascade(prevConfig, nextConfig, schema) {
    let result = nextConfig;
    for (const group of providerGroups(schema)) {
      const groupKey = group.key;
      const hints = group.providerSelect;
      const groupConfig = result?.[groupKey];
      const nextProvider = String(groupConfig?.provider || '').trim();
      if (!nextProvider) {
        // 清空 provider 时重置该组关联字段
        result = {
          ...result,
          [groupKey]: { ...groupConfig, provider: '', provider_type: '', model_name: '' },
        };
        continue;
      }
      const previousProvider = String(prevConfig?.[groupKey]?.provider || '').trim();
      if (nextProvider === previousProvider) continue;
      const selected = providers.value.find((item) => item?.name === nextProvider || item?.key === nextProvider);
      if (!selected) continue;
      const applied = {
        ...groupConfig,
        provider: selected.name || selected.key || '',
        provider_type: selected.provider_type || '',
        model_name: hints?.autoSelectModel ? (getProviderModels(selected)[0] || '') : '',
      };
      result = { ...result, [groupKey]: applied };
    }
    return result;
  }

  return { enrichSchemaWithProviderSelection, applyProviderCascade };
}
