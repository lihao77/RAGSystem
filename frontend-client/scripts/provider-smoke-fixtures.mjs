// 每个浏览器场景独立的内存 API：CRUD 和模型测试均不访问真实服务。
export function createProviderSmokeApi({ fallback = false } = {}) {
  const providers = [{
    key: 'demo-openai', name: 'Demo OpenAI', provider_type: 'openai', api_format: 'openai_chat',
    api_endpoint: 'https://api.demo.example.com/v1', api_key_configured: true,
    models: [{ name: 'demo-chat', thinking_kind: 'none', input_modalities: ['text'], output_modalities: ['text'] }],
  }];
  return (request) => {
    const path = new URL(request.url).pathname;
    const method = request.method;
    const input = JSON.parse(request.postData || '{}');
    const ok = (data) => ({ success: true, data });
    if (path === '/api/bootstrap') return { auth: 'local', ui: 'local', deployment: 'local', installed: true, capabilities: {} };
    if (path === '/api/auth/me') return {
      user: { id: 'smoke-user', displayName: 'Demo User' }, tenantId: 'smoke-tenant', role: 'owner', platformRole: 'admin',
    };
    if (path === '/api/agent/runtime-core/status') return ok({ llm: {
      provider: 'Demo OpenAI', provider_type: 'openai', model_name: 'demo-chat',
      source: 'system_config.llm', fallback_reason: fallback ? 'agent_default_tier_unresolved' : null,
    } });
    if (path === '/api/model-adapter/providers') {
      if (method === 'GET') return { success: true, providers };
      if (method === 'POST') {
        const key = `${input.name.trim().toLowerCase().replace(/\s+/g, '_')}_${input.provider_type}`;
        const { api_key: _apiKey, ...config } = input;
        providers.push({ ...config, key, api_key_configured: true });
        return ok({ provider_key: key });
      }
    }
    const providerMatch = path.match(/^\/api\/model-adapter\/providers\/([^/]+)$/);
    if (providerMatch && method === 'PUT') {
      const provider = providers.find(item => item.key === decodeURIComponent(providerMatch[1]));
      if (!provider) throw new Error(`Unknown demo provider: ${providerMatch[1]}`);
      Object.assign(provider, input);
      return ok({});
    }
    if (providerMatch && method === 'DELETE') {
      const index = providers.findIndex(item => item.key === decodeURIComponent(providerMatch[1]));
      if (index < 0) throw new Error(`Unknown demo provider: ${providerMatch[1]}`);
      providers.splice(index, 1);
      return ok({});
    }
    if (path.endsWith('/usages')) return ok({ usages: [] });
    if (path.endsWith('/check')) return ok({ is_available: true });
    if (path === '/api/model-adapter/test') return ok({ content: 'pong', latency: 0.1 });
    if (path === '/api/model-adapter/api-formats') return ok([
      { value: 'openai_chat', label: 'OpenAI', default_endpoint: 'https://api.demo.example.com/v1', config_fields: [] },
    ]);
    if (path === '/api/model-adapter/catalog/providers') return ok({ available: false, providers: [] });
    if (path.startsWith('/api/model-adapter/catalog/')) return ok({ models: [] });
    if (path === '/api/agent-config/teams') return ok({ active_team: 'demo', teams: [{ name: 'demo' }] });
    if (path === '/api/agent-config/configs') return ok({});
    if (path === '/api/local/scenes') return { scenes: [], activeTenantId: 'smoke-tenant' };
    if (path === '/api/plugins/ui-manifests') return ok([]);
    if (path === '/api/plugins') return ok([]);
    if (method !== 'GET') throw new Error(`Unexpected smoke mutation: ${method} ${path}`);
    return ok({ items: [], groups: [], teams: [], plugins: [] });
  };
}
