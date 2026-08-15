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
            class="wb-nav-group__label wb-nav-group__label--collapsible"
            @click="core.toggleTeamCollapse(team.team_name)"
          >
            <ChevronDown
              class="wb-nav-group__caret"
              :class="{ 'wb-nav-group__caret--collapsed': core.isTeamCollapsed(team.team_name) }"
            />
            <Hammer v-if="team.team_name === BUILDER_TEAM" class="wb-nav-group__icon" />
            <Users v-else class="wb-nav-group__icon" />
            <span class="wb-nav-group__name">{{ team.team_name === BUILDER_TEAM ? 'Agent Builder' : team.team_name }}</span>
            <Badge v-if="team.team_name === BUILDER_TEAM" variant="secondary">系统</Badge>
            <Badge v-else-if="team.team_name === core.activeTeam.value" variant="success" class="studio-nav__runtime-badge">
              <StatusDot tone="success" size="sm" pulse />运行时
            </Badge>
            <span v-else class="wb-nav-group__count">{{ team.agents?.length || 0 }}</span>
            <button
              v-if="team.team_name !== BUILDER_TEAM"
              type="button"
              class="wb-nav-group__action"
              title="新建 Agent"
              aria-label="新建 Agent"
              @click.stop="agentAdmin.openCreateAgent(team.team_name)"
            ><Plus :size="14" /></button>
            <DropdownMenu v-if="team.team_name !== BUILDER_TEAM">
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="wb-nav-group__action"
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

          <div v-show="!core.isTeamCollapsed(team.team_name)" class="wb-nav-group__items wb-nav-group__items--guide">
            <NavigatorRow
              v-if="team.team_name === BUILDER_TEAM"
              variant="static"
              class="studio-nav__builder-row"
              description="通过调研、设计、评估和调优生成业务 Team"
            />
            <NavigatorRow
              v-for="agent in team.agents || []"
              :key="`${team.team_name}-${agent}`"
              :title="core.displayMap.value[agent] || agent"
              :active="core.selectedTeam.value === team.team_name && core.selectedAgent.value === agent"
              @click="core.onSelectAgent(team.team_name, agent)"
            >
              <template #leading>
                <Bot :size="15" />
              </template>
              <template #title-trailing>
                <span
                  v-if="core.isEntryAgent(team.team_name, agent)"
                  class="studio-nav__entry-tag"
                  title="Team 入口 Agent"
                ><LogIn :size="11" />入口</span>
              </template>
              <template v-if="core.displayMap.value[agent] && core.displayMap.value[agent] !== agent">{{ agent }}</template>
            </NavigatorRow>
          </div>
        </div>
      </template>
    </CardContent>
  </Card>
</template>

<script setup>
// AgentStudio 左栏导航树：Team 分组（折叠/下拉操作）+ Agent 行。
// core/teamAdmin/agentAdmin 为 composables/agent-studio/ 的 composable 返回值。
import { Bot, ChevronDown, Hammer, LogIn, MoreHorizontal, Plus, Users } from 'lucide-vue-next';

import NavigatorRow from '../admin/NavigatorRow.vue';
import StatusDot from '../admin/StatusDot.vue';
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

/* Agent Builder 说明区块：虚线描边 + 弱化实底，明确是信息区而非可点 Agent 行 */
.studio-nav__builder-row,
.studio-nav__builder-row:hover {
  border: 1px dashed var(--color-border);
  background: var(--color-bg-secondary);
}

/* 「入口」标记：图标 + 小字弱化呈现，不与行选中态的描边争抢 */
.studio-nav__entry-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.wb-nav-row--active .studio-nav__entry-tag {
  color: var(--color-brand-accent);
}

/* 运行时 Badge 内脉冲状态点与文字的间距 */
.studio-nav__runtime-badge {
  gap: 5px;
}
</style>
