<template>
  <Card class="wb-workbench__nav">
    <CardHeader class="studio-nav__head">
      <CardTitle class="studio-nav__title">Team / Agent</CardTitle>
      <Button variant="outline" size="icon-sm" title="新建 Team" aria-label="新建 Team" @click="teamAdmin.openCreateTeamDialog()">
        <Plus data-icon="inline-start" />
      </Button>
    </CardHeader>

    <CardContent class="studio-nav__body">
      <div v-if="core.loading.value" class="adm-state">
        <Spinner />
        <span>加载中</span>
      </div>
      <div v-else-if="core.error.value" class="adm-state adm-state--error" role="alert">
        <p class="adm-state__title">加载失败</p>
        <p class="adm-state__hint">{{ core.error.value }}</p>
        <Button variant="outline" size="sm" @click="core.loadAll(true)">重试</Button>
      </div>
      <Empty v-else-if="!core.teams.value.length" class="navigator-empty">
        <EmptyHeader><EmptyTitle>暂无 Team</EmptyTitle></EmptyHeader>
      </Empty>

      <template v-else>
        <div v-for="team in core.teams.value" :key="team.team_name" class="wb-nav-group">
          <div
            class="wb-nav-group__label"
            :class="{ 'wb-nav-group__label--collapsible': team.team_name !== BUILDER_TEAM }"
            @click="core.toggleTeamCollapse(team.team_name)"
          >
            <ChevronDown
              v-if="team.team_name !== BUILDER_TEAM"
              class="wb-nav-group__caret"
              :class="{ 'wb-nav-group__caret--collapsed': core.isTeamCollapsed(team.team_name) }"
            />
            <span class="wb-nav-group__name">{{ team.team_name === BUILDER_TEAM ? 'Agent Builder' : team.team_name }}</span>
            <Badge v-if="team.team_name === BUILDER_TEAM" variant="secondary">系统</Badge>
            <Badge v-else-if="team.team_name === core.activeTeam.value" variant="success">运行时</Badge>
            <span v-else class="wb-nav-group__count">{{ team.agents?.length || 0 }}</span>
            <DropdownMenu v-if="team.team_name !== BUILDER_TEAM">
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="wb-nav-group__more"
                  title="团队操作"
                  aria-label="团队操作"
                  :disabled="teamAdmin.teamBusy.value"
                  @click.stop
                ><MoreHorizontal :size="15" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" :side-offset="4" class="min-w-[160px]">
                <DropdownMenuItem
                  v-if="team.team_name !== core.activeTeam.value"
                  @click="teamAdmin.handleActivateTeam(team.team_name)"
                >设为运行时默认</DropdownMenuItem>
                <DropdownMenuItem
                  v-if="team.team_name === 'default'"
                  @click="teamAdmin.handleResetDefault"
                >恢复默认配置</DropdownMenuItem>
                <DropdownMenuSeparator v-if="team.team_name !== core.activeTeam.value || team.team_name === 'default'" />
                <DropdownMenuItem
                  class="wb-nav-group__menu-danger"
                  :disabled="team.team_name === core.activeTeam.value || core.teams.value.length <= 1"
                  @click="teamAdmin.handleDeleteTeam(team.team_name)"
                >删除 Team</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <template v-if="team.team_name === BUILDER_TEAM">
            <NavigatorRow variant="static" description="通过调研、设计、评估和调优生成业务 Team" />
          </template>
          <template v-else>
            <div v-show="!core.isTeamCollapsed(team.team_name)" class="wb-nav-group__items">
              <NavigatorRow
                v-for="agent in team.agents || []"
                :key="`${team.team_name}-${agent}`"
                :title="core.displayMap.value[agent] || agent"
                :active="core.selectedTeam.value === team.team_name && core.selectedAgent.value === agent"
                @click="core.onSelectAgent(team.team_name, agent)"
              >
                <template #title-trailing>
                  <span v-if="core.isEntryAgent(team.team_name, agent)" class="wb-nav-row__tag">入口</span>
                </template>
                <template v-if="core.displayMap.value[agent] && core.displayMap.value[agent] !== agent">{{ agent }}</template>
              </NavigatorRow>
              <NavigatorRow variant="add" @click="agentAdmin.openCreateAgent(team.team_name)">
                <Plus :size="13" />
                <span>新建 Agent</span>
              </NavigatorRow>
            </div>
          </template>
        </div>
      </template>
    </CardContent>
  </Card>
</template>

<script setup>
// AgentStudio 左栏导航树：Team 分组（折叠/下拉操作）+ Agent 行。
// core/teamAdmin/agentAdmin 为 composables/agent-studio/ 的 composable 返回值。
import { ChevronDown, MoreHorizontal, Plus } from 'lucide-vue-next';

import NavigatorRow from '../admin/NavigatorRow.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Empty, EmptyHeader, EmptyTitle } from '../ui/empty';
import { Spinner } from '../ui/spinner';
import { BUILDER_TEAM } from '../../composables/agent-studio/useAgentStudioCore.js';

defineProps({
  core: { type: Object, required: true },
  teamAdmin: { type: Object, required: true },
  agentAdmin: { type: Object, required: true },
});
</script>

<style scoped>
.studio-nav__head {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.studio-nav__title {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text-primary);
}

.studio-nav__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.navigator-empty {
  min-height: 200px;
}
</style>
