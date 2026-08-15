<template>
  <PageLayout
    title="Agent 编排"
    subtitle="Team 与 Agent 配置"
    mobile-title="Agent 编排"
    fill
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
  >
    <template #header-actions>
      <span class="run-default-pill" title="当前对话实际运行的 Team">
        <StatusDot tone="success" size="sm" />运行时默认：<strong>{{ activeTeam || '—' }}</strong>
      </span>
      <Button variant="outline" size="sm" :disabled="loading" @click="loadAll(true)">
        <RefreshCw data-icon="inline-start" :class="{ 'animate-spin': loading }" />
        刷新
      </Button>
    </template>

    <div class="wb-workbench wb-workbench--fill">
      <!-- 左：导航树 -->
      <StudioNavigator :core="core" :team-admin="teamAdmin" :agent-admin="agentAdmin" />

      <!-- 右：配置工作区 -->
      <Card class="wb-workbench__main">
        <main class="studio-panel">
          <div v-if="detailLoading" class="adm-state">
            <Spinner />
            <span>加载 Agent 配置</span>
          </div>
          <Empty v-else-if="!selectedAgent" class="adm-state">
            <EmptyHeader><EmptyTitle>选择一个 Agent</EmptyTitle></EmptyHeader>
          </Empty>

          <template v-else>
            <header class="wb-workspace-header">
              <div class="wb-workspace-header__identity">
                <div class="wb-workspace-header__title-row">
                  <h2>{{ displayMap[selectedAgent] || selectedAgent }}</h2>
                  <Badge variant="outline">{{ selectedTeam }}</Badge>
                </div>
                <p class="wb-workspace-header__desc">{{ form.description || selectedAgent }}</p>
              </div>
              <div class="wb-workspace-header__actions">
                <Button variant="ghost" size="icon-sm" title="导出配置" aria-label="导出配置" @click="handleExport">
                  <Download data-icon="inline-start" />
                </Button>
                <Button variant="ghost" size="icon-sm" title="删除 Agent" aria-label="删除 Agent" @click="handleDeleteAgent">
                  <Trash2 data-icon="inline-start" />
                </Button>
              </div>
            </header>

            <div class="wb-workspace-tabbar">
              <SegmentedControl
                :model-value="activeTab"
                :options="tabOptions"
                aria-label="Agent 配置分区"
                @update:model-value="handleTabChange"
              />
            </div>

            <div class="workspace-body">
              <div v-show="activeTab === 'config'" class="workspace-pane">
                <MainConfigForm
                  :form="form"
                  :agent-name="selectedAgent"
                  :tools="tools"
                  :peer-agents="peerAgents"
                  :display-map="displayMap"
                  :provider-options="providerOptions"
                  :providers="providers"
                />
              </div>
              <div v-show="activeTab === 'skills'" class="workspace-pane">
                <SkillsPanel :form="form" :skills="skills" />
              </div>
              <div v-show="activeTab === 'memory'" class="workspace-pane">
                <MemoryPanel :form="form" :scope-meta="memoryScopeMeta" />
              </div>
              <div v-show="activeTab === 'mcp'" class="workspace-pane">
                <McpPanel :form="form" :servers="mcpServers" />
              </div>
              <div v-show="activeTab === 'knowledge'" class="workspace-pane">
                <KnowledgePanel :form="form" />
              </div>
            </div>

            <div class="workspace-savebar">
              <span v-if="dirty[activeTab]" class="workspace-savebar__state workspace-savebar__state--dirty">
                <StatusDot tone="warning" size="sm" />本页有未保存修改
              </span>
              <span v-else class="workspace-savebar__state workspace-savebar__state--saved">✓ 已保存</span>
              <span class="workspace-savebar__spacer"></span>
              <Button variant="outline" size="sm" :disabled="!dirty[activeTab] || saving" @click="resetTab(activeTab)">放弃</Button>
              <Button size="sm" :disabled="!dirty[activeTab] || saving" @click="handleSave(activeTab)">
                <Spinner v-if="saving" data-icon="inline-start" />
                <Save v-else data-icon="inline-start" />
                保存
              </Button>
            </div>
          </template>
        </main>
      </Card>
    </div>

    <!-- 新建 Team -->
    <FormDialog
      :open="createTeamDialogOpen"
      title="新建 Team"
      description="可基于现有 Team 复制，或创建空白 Team。"
      :busy="teamBusy"
      confirm-text="创建"
      :confirm-disabled="!createTeamForm.teamName"
      content-class="max-w-[440px]"
      @update:open="(v) => { if (!v) createTeamDialogOpen = false }"
      @submit="handleCreateTeam"
    >
      <FieldGroup>
        <Field>
          <FieldLabel for="new-team-name">名称</FieldLabel>
          <Input id="new-team-name" v-model.trim="createTeamForm.teamName" placeholder="仅限英文、数字、下划线" />
        </Field>
        <Field>
          <FieldLabel for="new-team-source">复制自</FieldLabel>
          <select id="new-team-source" v-model="createTeamForm.sourceTeam" class="form-control">
            <option value="">空白 Team</option>
            <option v-for="t in teamCopySources()" :key="t.team_name" :value="t.team_name">{{ t.team_name }}</option>
          </select>
        </Field>
      </FieldGroup>
    </FormDialog>

    <!-- 新建 Agent -->
    <FormDialog
      :open="createVisible"
      :title="`在「${selectedTeam}」新建 Agent`"
      :busy="agentBusy"
      confirm-text="创建"
      :confirm-disabled="!createAgentForm.agentName"
      content-class="max-w-[480px]"
      @update:open="(v) => { if (!v) createVisible = false }"
      @submit="handleCreateAgent"
    >
      <FieldGroup>
        <Field>
          <FieldLabel for="new-agent-name">Agent 名称</FieldLabel>
          <Input id="new-agent-name" v-model.trim="createAgentForm.agentName" placeholder="仅限英文、数字和下划线" />
        </Field>
        <Field>
          <FieldLabel for="new-agent-display">显示名称</FieldLabel>
          <Input id="new-agent-display" v-model.trim="createAgentForm.displayName" placeholder="可选" />
        </Field>
        <Field>
          <FieldLabel for="new-agent-desc">描述</FieldLabel>
          <Input id="new-agent-desc" v-model.trim="createAgentForm.description" placeholder="可选" />
        </Field>
      </FieldGroup>
    </FormDialog>
  </PageLayout>
</template>

<script setup>
/**
 * Agent 编排页 —— 薄组装层。
 * 状态与逻辑：composables/agent-studio/（core + teamAdmin + agentAdmin + tierModels）
 * UI 区块：components/agent-studio/（StudioNavigator + 各 panel）
 */
import { computed, onMounted } from 'vue';
import { Download, RefreshCw, Save, Trash2 } from 'lucide-vue-next';

import PageLayout from '../components/PageLayout.vue';
import FormDialog from '../components/admin/FormDialog.vue';
import StatusDot from '../components/admin/StatusDot.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import MainConfigForm from '../components/agent-studio/MainConfigForm.vue';
import SkillsPanel from '../components/agent-studio/SkillsPanel.vue';
import MemoryPanel from '../components/agent-studio/MemoryPanel.vue';
import McpPanel from '../components/agent-studio/McpPanel.vue';
import KnowledgePanel from '../components/agent-studio/KnowledgePanel.vue';
import StudioNavigator from '../components/agent-studio/StudioNavigator.vue';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { useAgentAdmin } from '../composables/agent-studio/useAgentAdmin.js';
import { useAgentStudioCore } from '../composables/agent-studio/useAgentStudioCore.js';
import { useTeamAdmin } from '../composables/agent-studio/useTeamAdmin.js';
import { useConfirm } from '../composables/useConfirm.js';
import { showToast } from '../composables/useToast.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const { confirm } = useConfirm();

const core = useAgentStudioCore({ confirm, showToast });
const teamAdmin = useTeamAdmin(core, { confirm, showToast });
const agentAdmin = useAgentAdmin(core, { confirm, showToast });

// 视图模板直接使用的内容（解构后仍是 ref/reactive，模板自动解包）
const {
  loading, activeTeam, displayMap, selectedTeam, selectedAgent, detailLoading, saving,
  form, dirty, activeTab, resetTab,
  tools, skills, mcpServers, providers, memoryScopeMeta, pluginAvailability,
  providerOptions, peerAgents,
  loadAll, handleTabChange, handleSave,
} = core;

// 配置分区切换项：插件不可用时隐藏对应分区；dot 为该分区存在未保存修改。
const tabOptions = computed(() => [
  { value: 'config', label: '配置', dot: dirty.config },
  ...(pluginAvailability.skills ? [{ value: 'skills', label: '技能', dot: dirty.skills }] : []),
  ...(pluginAvailability.memory ? [{ value: 'memory', label: '记忆', dot: dirty.memory }] : []),
  ...(pluginAvailability.mcp ? [{ value: 'mcp', label: 'MCP', dot: dirty.mcp }] : []),
  ...(pluginAvailability.knowledge ? [{ value: 'knowledge', label: '知识库', dot: dirty.knowledge }] : []),
]);

const { teamBusy, createTeamDialogOpen, createTeamForm, handleCreateTeam, teamCopySources } = teamAdmin;
const { agentBusy, createVisible, createAgentForm, handleCreateAgent, handleDeleteAgent, handleExport } = agentAdmin;

onMounted(() => { loadAll(); });
</script>

<style scoped>
/* 页面专属样式；导航树/工作区头部/tabbar 等共享骨架见 styles/admin-workbench.css */
.studio-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.studio-panel > .adm-state {
  flex: 1;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.workspace-pane {
  padding: var(--spacing-xl);
}

.workspace-savebar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-xl);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.workspace-savebar__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
}

.workspace-savebar__state--dirty {
  color: var(--color-warning);
}

.workspace-savebar__state--saved {
  color: var(--color-text-muted);
}

.workspace-savebar__spacer {
  flex: 1;
}

.run-default-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 4px 12px;
}

@media (max-width: 1024px) {
  .wb-workspace-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
