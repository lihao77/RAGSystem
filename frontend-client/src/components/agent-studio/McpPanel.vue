<template>
  <PanelFormShell title="MCP 服务" subtitle="将可用 MCP Server 授权给当前 Agent">
    <CheckGrid
      :items="servers.map((s) => ({ key: s.name, label: s.display_name || s.name, title: `${s.transport || 'stdio'} · ${s.status || 'unknown'} · ${s.tool_count || 0} tools` }))"
      :selected="form.mcp.enabled_servers"
      empty-text="当前还没有可用的 MCP 服务，请先在管理端完成 MCP Server 配置。"
      @toggle="toggle"
    />
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
