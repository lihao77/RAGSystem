<template>
  <div class="panel-form"><section class="form-section">
    <div class="section-head"><h2>MCP 服务</h2><span>将可用 MCP Server 授权给当前 Agent</span></div>
    <div class="section-body">
      <p v-if="!servers.length" class="form-empty">当前还没有可用的 MCP 服务，请先在管理端完成 MCP Server 配置。</p>
      <div v-else class="check-grid">
        <label
          v-for="server in servers"
          :key="server.name"
          class="check-item"
          :title="`${server.transport || 'stdio'} · ${server.status || 'unknown'} · ${server.tool_count || 0} tools`"
        >
          <input
            type="checkbox"
            :checked="form.mcp.enabled_servers.includes(server.name)"
            @change="toggle(server.name)"
          />
          <span class="check-item__text">{{ server.display_name || server.name }}</span>
        </label>
      </div>
    </div>
  </section></div>
</template>

<script setup>
const props = defineProps({
  form: { type: Object, required: true },
  servers: { type: Array, default: () => [] },
});

function toggle(name) {
  const list = props.form.mcp.enabled_servers;
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
}
</script>

<style scoped>
.form-section { gap: var(--spacing-sm); padding: 0; }
.section-head { padding-bottom: var(--spacing-sm); margin-bottom: 0; border-bottom: 1px solid var(--color-border); }
.section-head h2, .section-head h4 { font-size: var(--font-size-md); }
.section-body { gap: var(--spacing-md); }
.form-empty { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0; }
</style>
