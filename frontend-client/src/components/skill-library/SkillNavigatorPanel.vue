<template>
  <Card class="wb-workbench__nav">
    <CardHeader class="skill-navigator__head">
      <div class="navigator-heading">
        <CardTitle>Skill 管理</CardTitle>
        <CardDescription>选择 Draft 编辑，或查看系统可用 Skill。</CardDescription>
      </div>
      <ToggleGroup
        type="single"
        variant="segment"
        size="segment"
        :model-value="state.navigatorTab.value"
        class="segmented-track w-full [&>*]:flex-1"
        aria-label="Skill 列表类型"
        @update:model-value="changeNavigatorTab"
      >
        <ToggleGroupItem value="drafts">Draft</ToggleGroupItem>
        <ToggleGroupItem value="library">Skill 库</ToggleGroupItem>
      </ToggleGroup>
      <Input
        :model-value="state.searchQuery.value"
        class="skill-navigator__search"
        :placeholder="state.navigatorTab.value === 'drafts' ? '搜索 Draft' : '搜索 Skill'"
        @update:model-value="setSearchQuery"
      />
    </CardHeader>

    <CardContent class="skill-navigator__body">
      <div v-if="state.navigatorLoading.value" class="adm-state">
        <Spinner />
        <span>加载中</span>
      </div>
      <div v-else-if="state.navigatorError.value" class="adm-state adm-state--error" role="alert">
        <p class="adm-state__title">加载失败</p>
        <p class="adm-state__hint">{{ state.navigatorError.value }}</p>
        <Button variant="outline" size="sm" @click="handleRefresh">重试</Button>
      </div>

      <template v-else-if="state.navigatorTab.value === 'drafts'">
        <Empty v-if="!state.filteredDrafts.value.length" class="navigator-empty">
          <EmptyHeader>
            <EmptyTitle>{{ state.searchQuery.value ? '没有匹配的 Draft' : '暂无 Skill Draft' }}</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <NavigatorRow
          v-for="draft in state.filteredDrafts.value"
          v-else
          :key="draft.id"
          :title="draft.name"
          :description="draft.description"
          :active="state.activeKind.value === 'draft' && state.activeKey.value === draft.id"
          @click="selectDraft(draft)"
        >
          <template #title-trailing>
            <Badge :variant="draftStatusVariant(draft)">{{ draftStatusLabel(draft) }}</Badge>
          </template>
          <template #meta>
            <span>修订 {{ draft.revision }}</span>
            <span>{{ formatCompactDate(draft.updated_at) }}</span>
          </template>
        </NavigatorRow>
      </template>

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
            :active="state.activeKind.value === 'skill' && state.activeKey.value === skill.name"
            @click="selectSkill(skill)"
          >
            <template #title-trailing>
              <Badge variant="outline">{{ sourceLabel(skill.source_type) }}</Badge>
            </template>
          </NavigatorRow>
        </div>
      </template>
    </CardContent>
  </Card>
</template>

<script setup>
// Skill 库左栏导航：列表类型切换、搜索、Draft/已发布分组列表。
// state 为 composables/skill-library/state.js 产出的共享响应式状态。
import NavigatorRow from '../admin/NavigatorRow.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '../ui/empty';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { formatCompactDate, draftStatusLabel, draftStatusVariant, sourceLabel } from '../../utils/skillPresentation.js';

defineProps({
  state: { type: Object, required: true },
  selectDraft: { type: Function, required: true },
  selectSkill: { type: Function, required: true },
  changeNavigatorTab: { type: Function, required: true },
  handleRefresh: { type: Function, required: true },
  setSearchQuery: { type: Function, required: true },
});
</script>

<style scoped>
.skill-navigator__head {
  flex-direction: column;
  gap: var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
}

.navigator-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-navigator__search {
  height: 34px;
}

.skill-navigator__body {
  max-height: calc(100vh - 212px);
  overflow-y: auto;
  padding: var(--spacing-md) !important;
}

.navigator-empty {
  min-height: 260px;
}

@media (max-width: 1024px) {
  .skill-navigator__body {
    max-height: 340px;
  }
}
</style>
