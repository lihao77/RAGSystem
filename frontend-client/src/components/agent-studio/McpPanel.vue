<template>
  <PanelFormShell
    title="MCP 服务"
    :subtitle="servers.length > 0 ? '将可用 MCP Server 授权给当前 Agent' : '暂无可用 MCP Server'"
  >
    <CheckGrid
      v-if="servers.length > 0"
      icon="Plug"
      :items="servers.map((s) => ({ key: s.name, label: s.display_name || s.name, title: `${s.transport || 'stdio'} · ${s.status || 'unknown'} · ${s.tool_count || 0} tools` }))"
      :selected="form.mcp.enabled_servers"
      empty-text="当前还没有可用的 MCP 服务，请先在管理端完成 MCP Server 配置。"
      @toggle="toggle"
    />
    <!-- 空态收敛为一行提示，不再整块占位 -->
    <p v-else class="panel-empty">当前租户尚未配置 MCP Server；在管理端完成配置后，可在此将其授权给 Agent。</p>
  </PanelFormShell>
</template>

<script setup>
import PanelFormShell from './PanelFormShell.vue';
import CheckGrid from './CheckGrid.vue';
import { toggleListItem } from '../../utils/listToggle.js';

const props = defineProps({
  form: { type: Object, required: true },
  servers: { type: Array, default: () => [] },
});

function toggle(name) {
  toggleListItem(props.form.mcp.enabled_servers, name);
}
</script>
