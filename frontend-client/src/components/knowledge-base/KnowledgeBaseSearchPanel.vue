<template>
  <div v-if="activeTab === 'search'" class="flex flex-col gap-6">
    <Card>
      <CardHeader class="flex-row items-start justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-1.5">
          <CardTitle>检索工作台</CardTitle>
          <CardDescription>用同一条查询验证召回、融合与重排序效果，并查看实际执行链路。</CardDescription>
        </div>
        <UiBadge size="sm" tone="info">{{ activeSearchModeLabel }}</UiBadge>
      </CardHeader>

      <CardContent class="flex flex-col gap-5">
        <div class="flex flex-col gap-3 sm:flex-row">
          <Input
            v-model="searchQuery"
            class="h-11 flex-1"
            placeholder="输入问题、关键词或一段待匹配文本…"
            aria-label="搜索查询"
            @keyup.enter="handleSearch"
          />
          <Button class="w-full sm:w-auto" size="lg" :disabled="searchLoading" @click="handleSearch">
            <SearchIcon data-icon="inline-start" />
            {{ searchLoading ? '正在检索' : '开始检索' }}
          </Button>
        </div>

        <FieldGroup class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field>
            <FieldLabel for="knowledge-search-top-k">返回数量</FieldLabel>
            <Input id="knowledge-search-top-k" v-model="searchTopK" type="number" min="1" max="100" />
            <FieldDescription>最终返回的结果数量，范围 1–100。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel>检索模式</FieldLabel>
            <CustomSelect v-model="searchMode" :options="searchModeOptions" />
            <FieldDescription>混合模式会同时计算关键词融合分。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel for="knowledge-search-collection">集合范围</FieldLabel>
            <Input id="knowledge-search-collection" v-model="searchCollection" placeholder="全部集合" />
            <FieldDescription>留空会跨全部集合检索。</FieldDescription>
          </Field>

          <Field
            orientation="horizontal"
            class="min-h-20 items-center rounded-lg border p-3"
            :data-disabled="searchRerankerOptions.length === 0 ? true : undefined"
          >
            <FieldContent>
              <FieldTitle>结果重排序</FieldTitle>
              <FieldDescription>
                {{ searchRerankerOptions.length ? '向量与混合模式均可使用。' : '请先配置可用的重排序器。' }}
              </FieldDescription>
            </FieldContent>
            <Switch
              v-model:checked="searchRerank"
              :disabled="searchRerankerOptions.length === 0"
              aria-label="启用结果重排序"
            />
          </Field>
        </FieldGroup>

        <Field v-if="searchRerank">
          <FieldLabel>重排序器</FieldLabel>
          <CustomSelect
            v-model="searchRerankSelection"
            :options="searchRerankerOptions"
            placeholder="使用当前激活的重排序器"
          />
          <FieldDescription>不选择时使用当前激活配置；失败时会保留召回结果并显示降级原因。</FieldDescription>
        </Field>

        <Separator />

        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">高级过滤</span>
              <span class="text-sm text-muted-foreground">按 chunk metadata 做 JSON 包含匹配。</span>
            </div>
            <Button variant="ghost" size="sm" @click="advancedFiltersOpen = !advancedFiltersOpen">
              <SlidersHorizontalIcon data-icon="inline-start" />
              {{ advancedFiltersOpen ? '收起过滤' : '配置过滤' }}
              <UiBadge v-if="hasSearchFilters" size="sm" tone="success">已设置</UiBadge>
            </Button>
          </div>

          <Field v-if="advancedFiltersOpen">
            <FieldLabel for="knowledge-search-filters">元数据过滤 JSON</FieldLabel>
            <Input
              id="knowledge-search-filters"
              v-model="searchFiltersText"
              placeholder='例如 {"category":"guide","tags":["rag"]}'
            />
            <FieldDescription>对象和数组使用包含语义；输入非法 JSON 时不会发起请求。</FieldDescription>
          </Field>
        </div>
      </CardContent>

      <CardFooter v-if="searchResponse" class="flex-col items-stretch gap-3 border-t pt-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge size="sm" tone="info">
              {{ searchResponse.collection_scope === 'all' ? '全部集合' : searchResponse.collection_name }}
            </UiBadge>
            <UiBadge size="sm">候选 {{ searchResponse.diagnostics?.candidate_count ?? 0 }}</UiBadge>
            <UiBadge v-if="searchResponse.diagnostics?.vectorizer" size="sm">
              Embedding · {{ searchResponse.diagnostics.vectorizer.model_name }}
            </UiBadge>
            <UiBadge
              v-if="searchResponse.rerank_mode !== 'none'"
              size="sm"
              :tone="searchResponse.rerank_mode === 'degraded' ? 'warning' : 'success'"
            >
              Rerank · {{ searchResponse.rerank_mode }}
            </UiBadge>
          </div>
          <span class="text-sm text-muted-foreground">
            总耗时 {{ formatScore(searchResponse.diagnostics?.timings_ms?.total) }} ms
          </span>
        </div>

        <div v-if="searchResponse.rerank_error" class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <UiBadge size="sm" tone="warning">重排序未完成</UiBadge>
          <span>{{ searchResponse.rerank_error }}</span>
        </div>
      </CardFooter>
    </Card>

    <section v-if="searchResults.length > 0" class="flex flex-col gap-4">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h3 class="text-base font-semibold">检索结果</h3>
          <p class="text-sm text-muted-foreground">主得分已按向量、融合或重排阶段明确标注。</p>
        </div>
        <UiBadge size="sm" tone="info">{{ searchResults.length }} 条</UiBadge>
      </div>

      <Card
        v-for="(result, index) in searchResults"
        :key="result.id || `${result.document_id}-${index}`"
        :data-result-id="result.id"
      >
        <CardHeader class="flex-row items-start justify-between gap-4">
          <div class="flex min-w-0 flex-col gap-1.5">
            <CardTitle class="truncate text-base">{{ resultSource(result) }}</CardTitle>
            <CardDescription class="flex flex-wrap items-center gap-2">
              <span>{{ result.collection }}</span>
              <span v-if="result.metadata?.section_path || result.metadata?.heading_path">
                · {{ result.metadata.section_path || result.metadata.heading_path }}
              </span>
            </CardDescription>
          </div>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <UiBadge size="sm">#{{ result.final_rank || index + 1 }}</UiBadge>
            <UiBadge size="sm" :tone="resultScoreTone(resultSimilarity(result))">
              {{ resultSimilarityLabel(result) }}
            </UiBadge>
          </div>
        </CardHeader>

        <CardContent class="flex flex-col gap-4">
          <div class="flex flex-wrap gap-2">
            <UiBadge v-if="result.vector_score != null" size="sm">Vector {{ formatScore(result.vector_score) }}</UiBadge>
            <UiBadge v-if="result.keyword_score != null" size="sm">Keyword {{ formatScore(result.keyword_score) }}</UiBadge>
            <UiBadge v-if="result.hybrid_score != null" size="sm">Hybrid {{ formatScore(result.hybrid_score) }}</UiBadge>
            <UiBadge v-if="result.rerank_score != null" size="sm" tone="info">Rerank {{ formatScore(result.rerank_score) }}</UiBadge>
            <UiBadge v-if="result.vector_rank != null" size="sm">Vector #{{ result.vector_rank }}</UiBadge>
            <UiBadge v-if="result.keyword_rank != null" size="sm">Keyword #{{ result.keyword_rank }}</UiBadge>
            <UiBadge v-if="result.rerank_rank != null" size="sm">Rerank #{{ result.rerank_rank }}</UiBadge>
            <UiBadge v-for="source in (result.retrieval_sources || [])" :key="source" size="sm" tone="info">
              召回 · {{ source }}
            </UiBadge>
          </div>

          <div class="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 text-sm leading-7">
            {{ result.content || result.text }}
          </div>
        </CardContent>

        <CardFooter v-if="result.metadata?.chunk_index != null" class="border-t pt-4 text-sm text-muted-foreground">
          分块 {{ Number(result.metadata.chunk_index) + 1 }}
          <span v-if="result.metadata?.chunk_total != null"> / {{ result.metadata.chunk_total }}</span>
        </CardFooter>
      </Card>
    </section>

    <EmptyState v-else-if="searchPerformed && !searchLoading" title="未找到相关结果，尝试调整关键词、集合或过滤条件">
      <template #icon>
        <SearchIcon />
      </template>
    </EmptyState>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Search as SearchIcon, SlidersHorizontal as SlidersHorizontalIcon } from 'lucide-vue-next';

import EmptyState from '../EmptyState.vue';
import CustomSelect from '../ui/CustomSelect.vue';
import { UiBadge } from '../ui';
import { Button } from '../ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import { Switch } from '../ui/switch';

const props = defineProps({ context: { type: Object, required: true } });
const {
  activeTab,
  searchCollection,
  searchResults,
  searchResponse,
  searchQuery,
  handleSearch,
  searchLoading,
  searchTopK,
  searchMode,
  searchModeOptions,
  searchRerank,
  searchRerankerOptions,
  searchRerankSelection,
  searchFiltersText,
  resultSimilarity,
  resultSimilarityLabel,
  searchPerformed,
  formatScore,
} = props.context;

const advancedFiltersOpen = ref(false);
const hasSearchFilters = computed(() => Boolean(searchFiltersText.value?.trim()));
const activeSearchModeLabel = computed(() => (
  searchModeOptions.find(option => option.value === searchMode.value)?.label || '检索'
));

function resultSource(result) {
  return result.metadata?.source
    || result.metadata?.source_file
    || result.metadata?.original_filename
    || result.document_id
    || '未知来源';
}

function resultScoreTone(score) {
  if (score == null) return 'neutral';
  if (score >= 0.75) return 'success';
  if (score >= 0.45) return 'info';
  return 'warning';
}
</script>
