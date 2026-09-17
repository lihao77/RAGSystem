<template>
  <component :is="embedded ? 'section' : Card" class="skill-navigator">
    <CardHeader class="skill-navigator__head">
      <CardTitle class="sr-only">Skill 列表</CardTitle>
      <Input
        :model-value="state.searchQuery.value"
        class="skill-navigator__search"
        placeholder="搜索 Skill"
        aria-label="搜索 Skill"
        @update:model-value="setSearchQuery"
      />
    </CardHeader>

    <CardContent class="skill-navigator__body">
      <div v-if="state.loading.value && !state.skills.value.length" class="adm-state">
        <Spinner />
        <span>加载中</span>
      </div>
      <div v-else-if="state.listError.value" class="adm-state adm-state--error" role="alert">
        <p class="adm-state__title">加载失败</p>
        <p class="adm-state__hint">{{ state.listError.value }}</p>
        <Button variant="outline" size="sm" @click="handleRefresh">重试</Button>
      </div>

      <template v-else>
        <Empty v-if="!state.filteredSkillGroups.value.length" class="navigator-empty">
          <EmptyHeader>
            <EmptyTitle>{{ state.searchQuery.value ? '没有匹配的 Skill' : '暂无可用 Skill' }}</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <div v-for="group in state.filteredSkillGroups.value" v-else :key="group.key" class="wb-nav-group">
          <div class="wb-nav-group__label">
            <span class="wb-nav-group__name wb-nav-group__name--caps">{{ group.label }}</span>
            <Badge variant="secondary">{{ group.items.length }}</Badge>
          </div>
          <NavigatorRow
            v-for="skill in group.items"
            :key="skill.name"
            :title="skill.display_name || skill.name"
            :description="skill.description"
            :active="state.activeSkill.value?.name === skill.name"
            :aria-disabled="state.loading.value || state.busy.value"
            @click="selectSkill(skill)"
          >
            <template #title-trailing>
              <Badge variant="outline">{{ sourceLabel(skill.source_type) }}</Badge>
            </template>
          </NavigatorRow>
        </div>
      </template>
    </CardContent>
  </component>
</template>

<script setup>
// Skill 库左栏：按来源分组。
// state 为 composables/skill-library/state.js 产出的共享响应式状态。
import NavigatorRow from '../admin/NavigatorRow.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '../ui/empty';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';
import { sourceLabel } from '../../utils/skillPresentation.js';

defineProps({
  embedded: { type: Boolean, default: false },
  state: { type: Object, required: true },
  selectSkill: { type: Function, required: true },
  handleRefresh: { type: Function, required: true },
  setSearchQuery: { type: Function, required: true },
});
</script>

<style scoped>
.skill-navigator {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.skill-navigator__head {
  flex-shrink: 0;
  flex-direction: column;
  gap: var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
}

.skill-navigator__search {
  height: 34px;
}

.skill-navigator__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-md) !important;
}

.navigator-empty {
  min-height: 260px;
}

</style>
