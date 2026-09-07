<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    mobile-content-padding="var(--spacing-sm)"
    title="模型 Provider 管理"
    subtitle="管理自定义模型供应商，配置后可在聊天时选择使用。"
    mobile-title="Provider 管理"
    fill
  >
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" :disabled="loading" :aria-label="loading ? '刷新中' : '刷新'" :title="loading ? '刷新中' : '刷新'" @click="loadProviders">
        <IconRefresh :class="{ spin: loading }" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <IconRefresh :class="{ spin: loading }" />
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <IconPlus />
        添加供应商
      </button>
    </template>

    <Card class="provider-workbench">
      <!-- 加载 / 错误 / 空态 -->
      <div v-if="loading && providers.length === 0" class="provider-workbench__state g-skeleton-rows" aria-busy="true" aria-live="polite">
        <span class="sr-only">加载中...</span>
        <div v-for="n in 5" :key="n" class="g-skeleton-row">
          <div class="g-skeleton-bar g-skeleton-bar--avatar" aria-hidden="true"></div>
          <div class="g-skeleton-bar g-skeleton-bar--title" aria-hidden="true"></div>
          <div class="g-skeleton-bar g-skeleton-bar--sub" aria-hidden="true"></div>
        </div>
      </div>
      <div v-else-if="error" class="provider-workbench__state adm-state adm-state--error">
        <IconWarning :size="36" :stroke-width="1.5" />
        <p>{{ error }}</p>
        <Button variant="secondary" @click="loadProviders">重试</Button>
      </div>
      <div v-else-if="providers.length === 0 && !createOpen" class="provider-workbench__state adm-state adm-state--empty">
        <Box :size="48" :stroke-width="1.5" />
        <p class="adm-state__title">暂无供应商</p>
        <p class="adm-state__hint">添加供应商并配置模型后，即可在聊天中选择使用</p>
        <Button variant="default" size="sm" @click="openCreateDialog"><IconPlus data-icon="inline-start" />添加供应商</Button>
      </div>

      <!-- 主从双栏：左供应商列表 + 右详情面板 -->
      <div v-else class="provider-workbench__body">
        <aside class="provider-side">
          <div class="provider-side__search">
            <Input v-model="searchQuery" aria-label="搜索供应商" placeholder="搜索供应商 / 模型" />
          </div>
          <div class="provider-side__scroll">
            <div v-if="filteredProviders.length === 0" class="provider-side__empty">{{ providers.length === 0 ? '暂无供应商' : '无匹配供应商' }}</div>
            <TransitionGroup v-else name="provider-side-list" tag="ul" class="provider-side__list">
              <li
                v-for="provider in filteredProviders"
                :key="getProviderKey(provider)"
                class="provider-side-item"
                :class="{
                  'provider-side-item--active': selectedProviderKey === getProviderKey(provider),
                  'provider-side-item--dragging': draggingKey === getProviderKey(provider),
                }"
                :data-provider-key="getProviderKey(provider)"
                tabindex="0"
                :aria-current="selectedProviderKey === getProviderKey(provider) ? 'true' : undefined"
                @pointerdown="startProviderDrag($event, provider)"
                @click="onSideItemClick(provider)"
                @keydown.up.prevent="moveProviderByKeyboard(provider, -1)"
                @keydown.down.prevent="moveProviderByKeyboard(provider, 1)"
              >
                <span class="provider-side-item__icon" aria-hidden="true">
                  <Box :size="15" class="provider-side-item__vendor-icon" />
                  <GripVertical :size="15" class="provider-side-item__grip" />
                </span>
                <span class="provider-side-item__name" :title="provider.name || getProviderKey(provider)">{{ provider.name || provider.key }}</span>
                <span
                  class="provider-side-item__dot"
                  :class="sideDotClass(provider)"
                  :title="providerStatus(provider).label"
                ></span>
              </li>
            </TransitionGroup>
            <button
              type="button"
              class="provider-side-item provider-side-item--add"
              :class="{ 'provider-side-item--active': createOpen }"
              :aria-current="createOpen ? 'true' : undefined"
              @click="onSideAddClick"
            >
              <span class="provider-side-item__icon" aria-hidden="true"><IconPlus :size="15" /></span>
              <span class="provider-side-item__name">添加供应商</span>
            </button>
          </div>
        </aside>

        <section class="provider-detail">
          <!-- 内联添加供应商（参考模型服务详情排版，不用弹窗） -->
          <template v-if="createOpen">
            <header class="provider-detail__head">
              <div class="provider-detail__heading">
                <h2 class="provider-detail__name">添加供应商</h2>
              </div>
            </header>
            <div class="provider-detail__scroll">
              <p class="provider-create-intro">配置一个自定义模型供应商，添加后可在聊天中选择使用。</p>

              <section class="provider-detail__section" aria-label="连接配置">
                <div class="pd-field">
                  <label class="pd-field__label" for="create-name">名称 <span class="required">*</span></label>
                  <Input
                    id="create-name"
                    v-model="form.name"
                    :aria-invalid="!!formErrors.name"
                    placeholder="例如：生产环境 OpenAI"
                  />
                  <p class="pd-field__hint">保存后生成 Key：<span class="font-mono">{{ providerKeyPreview || '填写名称并填写厂商后显示' }}</span></p>
                  <p v-if="formErrors.name" class="pd-field__error">{{ formErrors.name }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="create-vendor">厂商 <span class="required">*</span></label>
                  <ComboBox
                    trigger-id="create-vendor"
                    :model-value="form.provider_type"
                    :options="formCatalogVendorOptions"
                    placeholder="输入或选择厂商，如 zhipuai / moonshotai"
                    empty-text="目录无匹配厂商，可继续手动输入"
                    :aria-invalid="!!formErrors.provider_type"
                    @update:model-value="handleVendorInput"
                    @pick="handleCatalogVendorPick($event.value)"
                  />
                  <p class="pd-field__hint">provider type 即厂商：从目录选择自动带出 API 格式与 Endpoint；自建服务直接输入标识。</p>
                  <p v-if="formErrors.provider_type" class="pd-field__error">{{ formErrors.provider_type }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="create-format">API 格式 <span class="required">*</span></label>
                  <CustomSelect
                    trigger-id="create-format"
                    :model-value="form.api_format"
                    :options="apiFormatOptions"
                    placeholder="-- 请选择 --"
                    @update:model-value="handleApiFormatChange"
                  />
                  <p class="pd-field__hint">5 种核心协议；厂商思考形状由目录厂商选择自动声明。</p>
                  <p v-if="formErrors.api_format" class="pd-field__error">{{ formErrors.api_format }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="create-api-key">API Key <span class="required">*</span></label>
                  <Input
                    id="create-api-key"
                    v-model="form.api_key"
                    type="password"
                    :aria-invalid="!!formErrors.api_key"
                    placeholder="sk-... 或 ${ENV_VAR}"
                    autocomplete="new-password"
                  />
                  <p class="pd-field__hint">支持 ${'{'}ENV_VAR{'}'} 形式引用环境变量；列表接口不会回传明文。</p>
                  <p v-if="formErrors.api_key" class="pd-field__error">{{ formErrors.api_key }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="create-endpoint">Base URL</label>
                  <Input
                    id="create-endpoint"
                    v-model="form.api_endpoint"
                    :aria-invalid="!!formErrors.api_endpoint"
                    :placeholder="apiEndpointPlaceholder"
                  />
                  <p class="pd-field__hint">留空时使用该 API 格式的默认 Endpoint。</p>
                  <p v-if="formErrors.api_endpoint" class="pd-field__error">{{ formErrors.api_endpoint }}</p>
                </div>
              </section>

              <section class="provider-detail__section" aria-label="模型列表">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">模型列表</h3>
                </div>
                <div class="provider-detail-models">
                  <div v-for="(model, idx) in modelEntries" :key="`${model.name}:${idx}`" class="provider-model-line">
                    <span class="provider-model-line__name font-mono" :title="model.name">
                      {{ model.name }}
                      <span v-if="idx === 0" class="provider-model-line__default">默认</span>
                    </span>
                    <span v-if="model.max_context_tokens" class="provider-model-line__ctx">{{ fmtContextTokens(model.max_context_tokens) }}</span>
                    <span class="provider-model-line__caps">
                      <span v-for="mark in modelModalityMarks(model)" :key="mark" class="provider-model-line__mark" :title="modelCapabilityTitle(model)">{{ mark }}</span>
                      <span v-if="model.supports_function_calling" class="provider-model-line__mark" :title="modelCapabilityTitle(model)">工</span>
                    </span>
                    <span class="provider-model-line__actions">
                      <Button variant="ghost" size="icon-sm" aria-label="上移模型" title="上移（越靠前越优先）" :disabled="idx === 0" @click="moveModelEntry(idx, -1)">
                        <ChevronUp />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="下移模型" title="下移" :disabled="idx === modelEntries.length - 1" @click="moveModelEntry(idx, 1)">
                        <ChevronDown />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="编辑模型" title="编辑模型" @click="openModelEdit(idx)">
                        <IconEdit />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="删除模型" title="删除模型" @click="removeModelEntry(idx)">
                        <IconTrash />
                      </Button>
                    </span>
                  </div>
                  <p v-if="modelEntries.length === 0" class="provider-create-empty">当前没有配置模型，添加模型后可在聊天中使用。</p>
                </div>
                <Button variant="outline" size="sm" class="provider-model-add" @click="openModelCreate()">
                  <IconPlus data-icon="inline-start" />
                  添加模型
                </Button>
                <p v-if="formErrors.models" class="pd-field__error">{{ formErrors.models }}</p>
              </section>

              <section v-if="resilienceProviderConfigFields.length > 0" class="provider-detail__section" aria-label="超时与重试">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">超时与重试</h3>
                </div>
                <div class="pd-field-grid">
                  <div v-for="field in resilienceProviderConfigFields" :key="field.key" class="pd-field">
                    <template v-if="field.type === 'boolean'">
                      <label class="pd-field__label pd-field__label--switch" :for="`create-extra-${field.key}`">
                        <Switch
                          :id="`create-extra-${field.key}`"
                          :checked="form[field.key] === true"
                          @update:checked="(v) => { form[field.key] = v }"
                        />
                        <span>{{ field.label }}</span>
                      </label>
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                    <template v-else>
                      <label class="pd-field__label" :for="`create-extra-${field.key}`">{{ field.label }}</label>
                      <CustomSelect
                        v-if="field.type === 'select'"
                        :trigger-id="`create-extra-${field.key}`"
                        :model-value="form[field.key] ?? ''"
                        :options="field.options || []"
                        @update:model-value="(v) => { form[field.key] = v }"
                      />
                      <Input
                        v-else-if="field.type === 'number'"
                        :id="`create-extra-${field.key}`"
                        v-model.number="form[field.key]"
                        type="number"
                        :step="field.step || (field.key === 'retry_delay' ? 0.1 : field.key === 'timeout' ? 5 : 1)"
                        :min="field.min"
                        :max="field.max"
                      />
                      <Input
                        v-else
                        :id="`create-extra-${field.key}`"
                        v-model="form[field.key]"
                        :type="field.type === 'password' ? 'password' : 'text'"
                      />
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                  </div>
                </div>
              </section>

              <section v-if="extensionProviderConfigFields.length > 0" class="provider-detail__section" aria-label="Provider 扩展配置">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">扩展配置</h3>
                </div>
                <div class="pd-field-grid">
                  <div v-for="field in extensionProviderConfigFields" :key="field.key" class="pd-field">
                    <template v-if="field.type === 'boolean'">
                      <label class="pd-field__label pd-field__label--switch" :for="`create-extra-${field.key}`">
                        <Switch
                          :id="`create-extra-${field.key}`"
                          :checked="form[field.key] === true"
                          @update:checked="(v) => { form[field.key] = v }"
                        />
                        <span>{{ field.label }}</span>
                      </label>
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                    <template v-else>
                      <label class="pd-field__label" :for="`create-extra-${field.key}`">{{ field.label }}</label>
                      <CustomSelect
                        v-if="field.type === 'select'"
                        :trigger-id="`create-extra-${field.key}`"
                        :model-value="form[field.key] ?? ''"
                        :options="field.options || []"
                        @update:model-value="(v) => { form[field.key] = v }"
                      />
                      <Input
                        v-else-if="field.type === 'number'"
                        :id="`create-extra-${field.key}`"
                        v-model.number="form[field.key]"
                        type="number"
                        :step="field.step || 1"
                        :min="field.min"
                        :max="field.max"
                      />
                      <Input
                        v-else
                        :id="`create-extra-${field.key}`"
                        v-model="form[field.key]"
                        :type="field.type === 'password' ? 'password' : 'text'"
                      />
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                  </div>
                </div>
              </section>

              <p v-if="dialog.error" class="pd-field__error">{{ dialog.error }}</p>

              <div class="provider-create-footer">
                <span class="provider-create-footer__hint">
                  <Info :size="13" />
                  添加供应商前，请至少添加一个模型。
                </span>
                <div class="provider-create-footer__actions">
                  <Button variant="outline" size="sm" :disabled="saving" @click="closeDialog">取消</Button>
                  <Button variant="default" size="sm" :disabled="saving" @click="handleSubmit">
                    <IconRefresh v-if="saving" data-icon="inline-start" class="spin" />
                    {{ saving ? '保存中...' : '添加供应商' }}
                  </Button>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="selectedProvider && detailForm">
            <header class="provider-detail__head">
              <div class="provider-detail__heading">
                <h2 class="provider-detail__name" :title="getProviderKey(selectedProvider)">{{ selectedProvider.name || selectedProvider.key }}</h2>
                <Badge :variant="providerStatus(selectedProvider).variant" :title="providerStatus(selectedProvider).detail">
                  {{ providerStatus(selectedProvider).label }}
                </Badge>
                <span v-if="savingFields.size > 0" class="provider-detail__saving"><IconRefresh class="spin" :size="12" />保存中</span>
              </div>
              <div class="provider-detail__meta">
                <span :class="selectedProvider.api_key_configured ? 'provider-detail__key provider-detail__key--ok' : 'provider-detail__key provider-detail__key--missing'">
                  {{ selectedProvider.api_key_configured ? 'Key 已配置' : '缺少 Key' }}
                </span>
              </div>
              <div class="provider-detail__actions">
                <Button variant="ghost" size="icon-sm" aria-label="删除供应商" title="删除供应商" @click="confirmDelete(selectedProvider)">
                  <IconTrash />
                </Button>
              </div>
            </header>

            <p v-if="reorderError" class="provider-detail__reorder-error">{{ reorderError }}</p>

            <div class="provider-detail__scroll">
              <!-- 连接配置：内联编辑，失焦即保存 -->
              <section class="provider-detail__section" aria-label="连接配置">
                <div class="pd-field">
                  <label class="pd-field__label" for="detail-vendor">厂商</label>
                  <!-- blur.capture 捕获 ComboBox 内部 input 的失焦（blur 不冒泡），兜底保存手输厂商 -->
                  <div @blur.capture="saveDetailVendor">
                    <ComboBox
                      trigger-id="detail-vendor"
                      :model-value="detailForm.provider_type"
                      :options="formCatalogVendorOptions"
                      :disabled="savingFields.has('provider_type')"
                      :aria-invalid="!!fieldErrors.provider_type"
                      placeholder="输入或选择厂商，如 zhipuai / moonshotai"
                      empty-text="目录无匹配厂商，可继续手动输入"
                      @update:model-value="onDetailVendorInput"
                      @pick="onDetailVendorPick"
                    />
                  </div>
                  <p v-if="fieldErrors.provider_type" class="pd-field__error">{{ fieldErrors.provider_type }}</p>
                  <p class="pd-field__hint">provider type 即厂商：从目录选择自动带出 API 格式与 Endpoint；自建服务直接输入标识。</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="detail-endpoint">Base URL</label>
                  <Input
                    id="detail-endpoint"
                    v-model="detailForm.api_endpoint"
                    :aria-invalid="!!fieldErrors.api_endpoint"
                    placeholder="留空使用该 API 格式的默认 Endpoint"
                    @change="saveDetailField('api_endpoint', detailForm.api_endpoint)"
                  />
                  <p v-if="fieldErrors.api_endpoint" class="pd-field__error">{{ fieldErrors.api_endpoint }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="detail-format">API 格式</label>
                  <CustomSelect
                    trigger-id="detail-format"
                    :model-value="detailForm.api_format"
                    :options="apiFormatOptions"
                    :disabled="savingFields.has('api_format')"
                    @update:model-value="onDetailFormatChange"
                  />
                  <p v-if="fieldErrors.api_format" class="pd-field__error">{{ fieldErrors.api_format }}</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="detail-thinking-kind">思考形状</label>
                  <CustomSelect
                    trigger-id="detail-thinking-kind"
                    :model-value="detailForm.thinking_kind || ''"
                    :options="THINKING_KIND_OPTIONS"
                    :disabled="savingFields.has('thinking_kind')"
                    @update:model-value="onDetailThinkingKindChange"
                  />
                  <p v-if="fieldErrors.thinking_kind" class="pd-field__error">{{ fieldErrors.thinking_kind }}</p>
                  <p class="pd-field__hint">目录厂商带入的形状声明可在此覆盖；空 = 跟随 API 格式默认。</p>
                </div>
                <div class="pd-field">
                  <label class="pd-field__label" for="detail-api-key">API Key</label>
                  <div class="pd-key-wrap">
                    <Input
                      id="detail-api-key"
                      v-model="detailForm.api_key"
                      :type="showApiKey ? 'text' : 'password'"
                      :aria-invalid="!!fieldErrors.api_key"
                      :placeholder="selectedProvider.api_key_configured ? '已配置 — 留空保持不变' : 'sk-... 或 ${ENV_VAR}'"
                      autocomplete="new-password"
                      @change="saveDetailApiKey"
                    />
                    <button
                      type="button"
                      class="pd-key-toggle"
                      :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                      :title="showApiKey ? '隐藏' : '显示'"
                      @click="showApiKey = !showApiKey"
                    >
                      <EyeOff v-if="showApiKey" :size="15" />
                      <Eye v-else :size="15" />
                    </button>
                  </div>
                  <p v-if="fieldErrors.api_key" class="pd-field__error">{{ fieldErrors.api_key }}</p>
                  <p class="pd-field__hint">支持 ${'{'}ENV_VAR{'}'} 形式引用环境变量；列表接口不会回传明文。</p>
                </div>
              </section>

              <!-- 模型列表：行内管理，变更即保存 -->
              <section class="provider-detail__section" aria-label="模型列表">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">模型列表</h3>
                  <span v-if="modelListSaving" class="provider-detail__saving"><IconRefresh class="spin" :size="12" />保存中</span>
                </div>
                <div class="provider-detail-models">
                  <template v-for="(model, idx) in selectedModels" :key="model.name">
                    <div class="provider-model-line" :class="{ 'provider-model-line--testing': isModelTesting(model.name) }">
                      <span class="provider-model-line__name font-mono" :title="model.name">{{ model.name }}</span>
                      <span v-if="model.max_context_tokens" class="provider-model-line__ctx">{{ fmtContextTokens(model.max_context_tokens) }}</span>
                      <span class="provider-model-line__caps">
                        <span v-for="mark in modelModalityMarks(model)" :key="mark" class="provider-model-line__mark" :title="modelCapabilityTitle(model)">{{ mark }}</span>
                        <span v-if="model.supports_function_calling" class="provider-model-line__mark" :title="modelCapabilityTitle(model)">工</span>
                      </span>
                      <span class="provider-model-line__actions">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="isModelTesting(model.name) ? '测试中' : '测试模型'"
                          :title="isModelTesting(model.name) ? '测试中...' : '真实调用测试'"
                          :disabled="isModelTesting(model.name)"
                          @click="testModel(model.name)"
                        >
                          <IconRefresh v-if="isModelTesting(model.name)" class="spin" />
                          <Play v-else />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label="编辑模型" title="编辑模型" @click="openModelEdit(idx)">
                          <IconEdit />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label="删除模型" title="删除模型" :disabled="modelListSaving" @click="removeModelDetail(idx)">
                          <IconTrash />
                        </Button>
                      </span>
                    </div>
                    <div
                      v-if="modelTestResult(model.name)"
                      class="provider-model-line-result"
                      :class="modelTestResult(model.name).ok ? 'result--ok' : 'result--err'"
                    >
                      <span class="result-icon"><IconCheck v-if="modelTestResult(model.name).ok" /><IconClose v-else /></span>
                      <span class="result-msg">{{ modelTestResult(model.name).msg }}</span>
                      <button type="button" class="result-dismiss" aria-label="关闭测试结果" title="关闭" @click="dismissModelTestResult(model.name)">
                        <IconClose :size="12" />
                      </button>
                    </div>
                  </template>
                  <p v-if="selectedModels.length === 0" class="provider-detail-models__empty">未配置模型</p>
                </div>
                <Button variant="outline" size="sm" class="provider-model-add" :disabled="modelListSaving" @click="openModelCreate()">
                  <IconPlus data-icon="inline-start" />
                  添加模型
                </Button>
              </section>

              <!-- 连接与扩展配置（按 API 格式 schema 驱动，内联编辑） -->
              <section v-if="detailResilienceFields.length > 0" class="provider-detail__section" aria-label="超时与重试">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">超时与重试</h3>
                </div>
                <div class="pd-field-grid">
                  <div v-for="field in detailResilienceFields" :key="field.key" class="pd-field">
                    <template v-if="field.type === 'boolean'">
                      <label class="pd-field__label pd-field__label--switch" :for="`detail-extra-${field.key}`">
                        <Switch
                          :id="`detail-extra-${field.key}`"
                          :checked="detailForm[field.key] === true"
                          @update:checked="(v) => saveDetailSwitch(field, v)"
                        />
                        <span>{{ field.label }}</span>
                      </label>
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                    <template v-else>
                      <label class="pd-field__label" :for="`detail-extra-${field.key}`">{{ field.label }}</label>
                      <CustomSelect
                        v-if="field.type === 'select'"
                        :trigger-id="`detail-extra-${field.key}`"
                        :model-value="detailForm[field.key] ?? ''"
                        :options="field.options || []"
                        @update:model-value="(v) => saveDetailField(field.key, v)"
                      />
                      <Input
                        v-else-if="field.type === 'number'"
                        :id="`detail-extra-${field.key}`"
                        v-model.number="detailForm[field.key]"
                        type="number"
                        :step="field.step || (field.key === 'retry_delay' ? 0.1 : field.key === 'timeout' ? 5 : 1)"
                        :min="field.min"
                        :max="field.max"
                        @change="saveDetailField(field.key, detailForm[field.key])"
                      />
                      <Input
                        v-else
                        :id="`detail-extra-${field.key}`"
                        v-model="detailForm[field.key]"
                        :type="field.type === 'password' ? 'password' : 'text'"
                        @change="saveDetailField(field.key, detailForm[field.key])"
                      />
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                      <p v-if="fieldErrors[field.key]" class="pd-field__error">{{ fieldErrors[field.key] }}</p>
                    </template>
                  </div>
                </div>
              </section>

              <section v-if="detailExtensionFields.length > 0" class="provider-detail__section" aria-label="Provider 扩展配置">
                <div class="provider-detail__section-head">
                  <h3 class="provider-detail__section-title">扩展配置</h3>
                </div>
                <div class="pd-field-grid">
                  <div v-for="field in detailExtensionFields" :key="field.key" class="pd-field">
                    <template v-if="field.type === 'boolean'">
                      <label class="pd-field__label pd-field__label--switch" :for="`detail-extra-${field.key}`">
                        <Switch
                          :id="`detail-extra-${field.key}`"
                          :checked="detailForm[field.key] === true"
                          @update:checked="(v) => saveDetailSwitch(field, v)"
                        />
                        <span>{{ field.label }}</span>
                      </label>
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                    </template>
                    <template v-else>
                      <label class="pd-field__label" :for="`detail-extra-${field.key}`">{{ field.label }}</label>
                      <CustomSelect
                        v-if="field.type === 'select'"
                        :trigger-id="`detail-extra-${field.key}`"
                        :model-value="detailForm[field.key] ?? ''"
                        :options="field.options || []"
                        @update:model-value="(v) => saveDetailField(field.key, v)"
                      />
                      <Input
                        v-else-if="field.type === 'number'"
                        :id="`detail-extra-${field.key}`"
                        v-model.number="detailForm[field.key]"
                        type="number"
                        :step="field.step || 1"
                        :min="field.min"
                        :max="field.max"
                        @change="saveDetailField(field.key, detailForm[field.key])"
                      />
                      <Input
                        v-else
                        :id="`detail-extra-${field.key}`"
                        v-model="detailForm[field.key]"
                        :type="field.type === 'password' ? 'password' : 'text'"
                        @change="saveDetailField(field.key, detailForm[field.key])"
                      />
                      <p v-if="field.help" class="pd-field__hint">{{ field.help }}</p>
                      <p v-if="fieldErrors[field.key]" class="pd-field__error">{{ fieldErrors[field.key] }}</p>
                    </template>
                  </div>
                </div>
              </section>
            </div>
          </template>

          <div v-else class="provider-detail__placeholder">
            <Box :size="40" :stroke-width="1.5" />
            <p>在左侧选择一个供应商</p>
          </div>
        </section>
      </div>
    </Card>

    <ProviderModelDialog
      :dialog="modelDialog"
      :form="modelForm"
      :form-errors="modelFormErrors"
      :catalog-models="modelDialogModels"
      :catalog-models-loading="modelDialogModelsLoading"
      @close="closeModelDialog"
      @submit="handleModelSubmit"
      @catalog-model-select="handleCatalogModelSelect"
    />

    <ProviderDeleteDialog
      :delete-target="deleteTarget"
      :delete-usage-loading="deleteUsageLoading"
      :delete-usage-error="deleteUsageError"
      :delete-usages="deleteUsages"
      :deleting="deleting"
      :get-provider-key="getProviderKey"
      :usage-kind-label="usageKindLabel"
      @close="deleteTarget = null"
      @confirm="doDelete"
    />
  </PageLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { Box, ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Info, Play } from 'lucide-vue-next';
import {
  getProviderTestTargets,
  providerTestTaskLabel,
  summarizeProviderTestResult,
} from '../utils/providerTestTargets.js';
import CustomSelect from '../components/ui/CustomSelect.vue';
import ComboBox from '../components/ui/ComboBox.vue';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconCheck from '../components/icons/IconCheck.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconWarning from '../components/icons/IconWarning.vue';
import ProviderModelDialog from '../components/provider/ProviderModelDialog.vue';
import ProviderDeleteDialog from '../components/provider/ProviderDeleteDialog.vue';
import '../components/provider/provider-dialogs.css';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useToast } from '../composables/useToast.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useDictionariesStore } from '../stores/dictionaries.js';
import {
  getApiFormats, createProvider, updateProvider,
  checkProviderAvailability, deleteProvider, getProviderUsages, reorderProviders, testProvider,
  getCatalogProviders, getCatalogProviderModels,
} from '../api/modelAdapter.js';
import {
  CORE_API_FORMATS, applyCatalogModel, catalogVendorProfile,
  isCatalogVendorConnectable, modelCapabilityTitle, modelModalityMarks, normalizeModalities,
} from '../utils/modelCatalog.js';
import { normalizeThinkingLevels, THINKING_KIND_OPTIONS } from '../utils/thinkingLevels.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const toast = useToast();
const dictStore = useDictionariesStore();

const apiFormatMeta = ref({});
// 格式下拉固定 4 种核心协议（kernel 封闭清单，纯协议无厂商类型）。
const apiFormatOptions = computed(() => CORE_API_FORMATS.map((value) => ({
  value,
  label: apiFormatMeta.value[value]?.label || value,
})));

const COMMON_PROVIDER_FIELDS = [
  { key: 'timeout', label: '响应超时（秒）', type: 'number', default: 120, min: 5, help: '', options: [] },
  { key: 'retry_attempts', label: '最大重试次数', type: 'number', default: 2, min: 0, help: '', options: [] },
  { key: 'retry_delay', label: '首次重试间隔（秒）', type: 'number', default: 1, min: 0, help: '', options: [] },
  { key: 'retry_backoff_factor', label: '重试间隔倍数', type: 'number', default: 2, min: 1, help: '', options: [] },
];
const PROMPT_CACHE_FIELD =
  { key: 'supports_prompt_caching', label: '启用 Prompt Cache', type: 'boolean', default: true, help: '启用当前 Provider 支持的 Prompt Cache 能力。', options: [] };
const ANTHROPIC_FIELDS = [
  { key: 'cache_ttl_seconds', label: 'Cache TTL (s)', type: 'number', default: 300, help: 'Provider KV cache 的滑动失效阈值。', options: [] },
];
const PROMPT_CACHE_API_FORMATS = new Set(['anthropic']);

// 思考档位不归 provider 配置（在 agent llm_tiers 配置），表单不暴露思考相关字段。
function fallbackConfigFields(apiFormat) {
  const fields = [...COMMON_PROVIDER_FIELDS];
  if (apiFormat === 'anthropic') fields.unshift(...ANTHROPIC_FIELDS);
  if (PROMPT_CACHE_API_FORMATS.has(apiFormat)) fields.unshift(PROMPT_CACHE_FIELD);
  return fields;
}

// API 格式封闭清单兜底（与后端 agent-llm 纯协议清单一致；接口失败时仍可配置）。
const FALLBACK_API_FORMATS = [
  { value: 'openai_resp', label: 'OpenAI Responses', default_endpoint: 'https://api.openai.com/v1' },
  { value: 'openai_chat', label: 'OpenAI Chat (Compatible)', default_endpoint: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', default_endpoint: 'https://api.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', default_endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
].map((item) => ({ ...item, config_fields: fallbackConfigFields(item.value) }));

async function loadApiFormats() {
  try {
    const formats = await getApiFormats();
    apiFormatMeta.value = Object.fromEntries(formats.map((t) => [t.value, { label: t.label, default_endpoint: t.default_endpoint || '', config_fields: t.config_fields || [] }]));
  } catch {
    apiFormatMeta.value = Object.fromEntries(FALLBACK_API_FORMATS.map((t) => [t.value, { label: t.label, default_endpoint: t.default_endpoint, config_fields: t.config_fields || [] }]));
  }
}

const { items: providers, loading, error, refresh: fetchProviders } = useEntityList(
  () => dictStore.ensureProviders(true),
  { errorPrefix: '加载失败', immediate: false },
);

const availabilityByKey = ref({});
const availabilityLoadingKeys = ref(new Set());
const searchQuery = ref('');
const deleteTarget = ref(null);
const deleteUsages = ref([]);
const deleteUsageLoading = ref(false);
const deleteUsageError = ref('');
const reordering = ref(false);
const reorderError = ref('');

function getProviderKey(provider) { return provider.key || `${provider.name}_${provider.provider_type}`; }
function providerModelEntries(provider) {
  if (!Array.isArray(provider.models)) return [];
  return provider.models.filter((model) => model && String(model.name || '').trim());
}
function providerTestTargets(provider) { return getProviderTestTargets(provider); }function getProviderConfigFields(apiFormat) { return apiFormatMeta.value[apiFormat]?.config_fields || []; }

function providerStatus(provider) {
  const key = getProviderKey(provider);
  if (availabilityLoadingKeys.value.has(key)) return { label: '检查中', detail: '正在检查配置完整性', variant: 'secondary' };
  const status = availabilityByKey.value[key];
  if (!status) return { label: '未检查', detail: '刷新页面以检查配置完整性', variant: 'outline' };
  return status.is_available
    ? { label: '已启用', detail: '密钥、Endpoint 和至少一个任务模型均已配置', variant: 'success' }
    : { label: '待完善', detail: status.error || 'Provider 配置不完整', variant: 'warning' };
}
// 侧栏状态点：绿=就绪 / 黄=待完善 / 灰=未检查，检查中闪烁。
function sideDotClass(provider) {
  const key = getProviderKey(provider);
  if (availabilityLoadingKeys.value.has(key)) return 'provider-side-item__dot--checking';
  const status = availabilityByKey.value[key];
  if (!status) return '';
  return status.is_available ? 'provider-side-item__dot--ok' : 'provider-side-item__dot--warn';
}

/* ── 选中供应商 + 详情内联编辑（失焦/切换即保存，PUT 为部分更新） ── */
const selectedProviderKey = ref('');
const detailForm = ref(null);
const showApiKey = ref(false);
const savingFields = ref(new Set());
const fieldErrors = ref({});
const modelListSaving = ref(false);

const selectedProvider = computed(() =>
  providers.value.find((provider) => getProviderKey(provider) === selectedProviderKey.value) || null);
const selectedModels = computed(() => (selectedProvider.value ? providerModelEntries(selectedProvider.value) : []));
const filteredProviders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return providers.value;
  return providers.value.filter((provider) => {
    const modelText = providerModelEntries(provider).map((model) => model.name).join(' ');
    return [provider.name, provider.key, provider.provider_type, provider.api_endpoint, modelText]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
});
// 详情区扩展字段按详情表单的 api_format 渲染（切换格式即时呈现新字段，保存成功后与 provider 对齐）。
const detailResilienceFields = computed(() => {
  const fields = apiFormatMeta.value[detailForm.value?.api_format]?.config_fields || [];
  return fields.filter((field) => RESILIENCE_FIELD_KEYS.has(field.key));
});
const detailExtensionFields = computed(() => {
  const fields = apiFormatMeta.value[detailForm.value?.api_format]?.config_fields || [];
  return fields.filter((field) => !RESILIENCE_FIELD_KEYS.has(field.key));
});

function buildDetailForm(provider) {
  const next = {
    provider_type: provider.provider_type || '',
    api_endpoint: provider.api_endpoint || '',
    api_format: provider.api_format || '',
    thinking_kind: provider.thinking_kind || '',
    api_key: '',
  };
  for (const field of getProviderConfigFields(provider.api_format)) {
    next[field.key] = provider[field.key] ?? field.default ?? '';
  }
  return next;
}
function selectProvider(provider) {
  selectedProviderKey.value = getProviderKey(provider);
}
// 列表变化时兜底选中：无选中或选中已删除 → 选第一个。
watch(providers, (items) => {
  if (items.length === 0) {
    selectedProviderKey.value = '';
    return;
  }
  if (!items.some((provider) => getProviderKey(provider) === selectedProviderKey.value)) {
    selectedProviderKey.value = getProviderKey(items[0]);
  }
});
watch(selectedProviderKey, () => {
  const provider = selectedProvider.value;
  detailForm.value = provider ? buildDetailForm(provider) : null;
  showApiKey.value = false;
  fieldErrors.value = {};
});

function markSaving(field, on) {
  const next = new Set(savingFields.value);
  if (on) next.add(field);
  else next.delete(field);
  savingFields.value = next;
}
function setFieldError(field, message) {
  fieldErrors.value = { ...fieldErrors.value, [field]: message };
}

async function saveDetailField(field, value) {
  const provider = selectedProvider.value;
  if (!provider) return;
  const prev = provider[field] ?? (getProviderConfigFields(provider.api_format).find((item) => item.key === field)?.default ?? '');
  if (String(value ?? '') === String(prev ?? '')) return;
  markSaving(field, true);
  setFieldError(field, '');
  try {
    await updateProvider(getProviderKey(provider), { [field]: value });
    provider[field] = value;
    // 思考形状变化须刷新列表：/providers 响应注入的 thinking descriptor 随 thinking_kind 派生
    if (field === 'thinking_kind') await fetchProviders();
    if (['api_key', 'api_endpoint', 'api_format'].includes(field)) loadProviderAvailability(providers.value);
  } catch (e) {
    setFieldError(field, e?.message || '保存失败');
    toast.error(e?.message || '保存失败');
    detailForm.value = buildDetailForm(provider);
  } finally {
    markSaving(field, false);
  }
}
async function saveDetailApiKey() {
  const provider = selectedProvider.value;
  const value = String(detailForm.value?.api_key || '').trim();
  if (!provider || !value) return;
  markSaving('api_key', true);
  setFieldError('api_key', '');
  try {
    await updateProvider(getProviderKey(provider), { api_key: value });
    provider.api_key_configured = true;
    detailForm.value.api_key = '';
    loadProviderAvailability(providers.value);
  } catch (e) {
    setFieldError('api_key', e?.message || '保存失败');
    toast.error(e?.message || '保存失败');
  } finally {
    markSaving('api_key', false);
  }
}
function saveDetailSwitch(field, checked) {
  detailForm.value[field.key] = checked;
  saveDetailField(field.key, checked);
}

/* 厂商（provider_type）内联编辑：键入只改草稿，失焦保存手输值；
   从目录 pick 则按接入档案带出 API 格式 / 思考形状 / Endpoint 一并保存。 */
function onDetailVendorInput(value) {
  detailForm.value.provider_type = String(value || '');
  setFieldError('provider_type', '');
}
function saveDetailVendor() {
  const provider = selectedProvider.value;
  if (!provider) return;
  const value = String(detailForm.value.provider_type || '').trim();
  if (!value || value === provider.provider_type) return;
  persistDetailVendor({ provider_type: value });
}
/** 目录 pick：ComboBox 发出的是选项对象 {value,label}，取 value（新建弹窗一路由对话框解包，此处直连须自解）。 */
async function onDetailVendorPick(option) {
  const vendorId = String(option?.value ?? '').trim();
  const provider = selectedProvider.value;
  if (!provider || !vendorId) return;
  detailForm.value.provider_type = vendorId;
  const summary = (catalogProviders.value?.providers || []).find((item) => item.id === vendorId);
  const profile = summary ? catalogVendorProfile(summary) : null;
  const payload = { provider_type: vendorId };
  if (profile) {
    if (profile.api_format && profile.api_format !== provider.api_format) {
      payload.api_format = profile.api_format;
      const prevFields = getProviderConfigFields(provider.api_format);
      for (const field of getProviderConfigFields(profile.api_format)) {
        if (!prevFields.some((item) => item.key === field.key)) payload[field.key] = field.default ?? '';
      }
    }
    payload.thinking_kind = profile.thinking_kind || '';
    if (summary?.api_base_url) payload.api_endpoint = summary.api_base_url;
  }
  await persistDetailVendor(payload);
}
async function persistDetailVendor(payload) {
  const provider = selectedProvider.value;
  if (!provider) return;
  markSaving('provider_type', true);
  setFieldError('provider_type', '');
  try {
    await updateProvider(getProviderKey(provider), payload);
    Object.assign(provider, payload);
    detailForm.value = buildDetailForm(provider);
    loadProviderAvailability(providers.value);
  } catch (e) {
    setFieldError('provider_type', e?.message || '保存失败');
    toast.error(e?.message || '保存失败');
    detailForm.value.provider_type = provider.provider_type || '';
  } finally {
    markSaving('provider_type', false);
  }
}
/** 思考形状手动覆盖：单字段即存；变更后由 saveDetailField 刷新列表更新思考 descriptor。 */
function onDetailThinkingKindChange(value) {
  detailForm.value.thinking_kind = value;
  saveDetailField('thinking_kind', value);
}
/** API 格式切换：级联新格式扩展字段默认值，连同格式一起保存。 */
async function onDetailFormatChange(apiFormat) {
  const provider = selectedProvider.value;
  if (!provider || apiFormat === detailForm.value.api_format) return;
  const previousFields = getProviderConfigFields(detailForm.value.api_format);
  const nextFields = getProviderConfigFields(apiFormat);
  const payload = { api_format: apiFormat };
  for (const field of nextFields) {
    if (!previousFields.some((item) => item.key === field.key)) payload[field.key] = field.default ?? '';
  }
  markSaving('api_format', true);
  setFieldError('api_format', '');
  try {
    await updateProvider(getProviderKey(provider), payload);
    provider.api_format = apiFormat;
    for (const key of Object.keys(payload)) {
      if (key !== 'api_format') provider[key] = payload[key];
    }
    detailForm.value = buildDetailForm(provider);
    loadProviderAvailability(providers.value);
  } catch (e) {
    setFieldError('api_format', e?.message || '保存失败');
    toast.error(e?.message || '保存失败');
    detailForm.value.api_format = provider.api_format;
  } finally {
    markSaving('api_format', false);
  }
}

function fmtContextTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000 && n % 1000000 === 0) return `${n / 1000000}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

async function loadProviderAvailability(items) {
  const keys = items.map(getProviderKey);
  availabilityLoadingKeys.value = new Set(keys);
  const entries = await Promise.all(items.map(async (provider) => {
    const key = getProviderKey(provider);
    try {
      return [key, await checkProviderAvailability(key)];
    } catch (e) {
      return [key, { is_available: false, error: e?.message || '配置检查失败', checks: {} }];
    }
  }));
  availabilityByKey.value = Object.fromEntries(entries);
  availabilityLoadingKeys.value = new Set();
}

async function loadProviders() {
  const items = await fetchProviders();
  if (items) await loadProviderAvailability(items);
  return items;
}

/* ── 优先级排序：整行拖拽（6px 阈值区分点击与拖拽）+ 聚焦后方向键 ── */
const RESILIENCE_FIELD_KEYS = new Set(['timeout', 'retry_attempts', 'retry_delay', 'retry_backoff_factor']);
const DRAG_THRESHOLD = 6;
const draggingKey = ref('');
const dragJustDragged = ref(false);
const dragOriginalProviders = ref(null);
const dragOrderChanged = ref(false);
let dragImageEl = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let pendingDrag = null;

function isSameProviderOrder(left, right) {
  if (left.length !== right.length) return false;
  return left.every((p, i) => getProviderKey(p) === getProviderKey(right[i]));
}

async function persistProviderOrder(nextProviders, previousProviders, options = {}) {
  if (reordering.value) return;
  providers.value = nextProviders;
  reordering.value = true;
  reorderError.value = '';
  try {
    await reorderProviders(nextProviders.map(getProviderKey));
    if (!options.silent) toast.success('Provider 顺序已保存');
  } catch (e) {
    providers.value = previousProviders;
    const message = e?.message || '排序保存失败';
    reorderError.value = message;
    toast.error(message);
  } finally {
    reordering.value = false;
    if (!options.skipCleanup) cleanupProviderDrag();
  }
}

async function moveProviderByKeyboard(provider, offset) {
  if (reordering.value) return;
  const fromIndex = providers.value.findIndex((item) => getProviderKey(item) === getProviderKey(provider));
  const toIndex = fromIndex + offset;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= providers.value.length) return;
  const previousProviders = [...providers.value];
  const nextProviders = [...providers.value];
  const [moved] = nextProviders.splice(fromIndex, 1);
  nextProviders.splice(toIndex, 0, moved);
  await persistProviderOrder(nextProviders, previousProviders);
}

function onSideItemClick(provider) {
  if (dragJustDragged.value) return;
  // 新建面板打开时点击列表项 = 离开新建回到详情（v-if createOpen 优先级高于详情，须显式关闭）
  createOpen.value = false;
  selectProvider(provider);
}

/** 左栏“添加供应商”虚拟卡片：进入内联新建面板；已打开时重复点击不重置已填草稿。 */
function onSideAddClick() {
  if (!createOpen.value) openCreateDialog();
}

function startProviderDrag(event, provider) {
  if (reordering.value || event.button !== 0) return;
  // 上一手势未正常收尾（并发指针覆盖 pendingDrag 会令其 pointerup 落空）时先清理，避免影像/隐藏行泄漏
  if (pendingDrag) cancelProviderDrag();
  const item = event.currentTarget.closest('.provider-side-item');
  if (!item) return;
  pendingDrag = {
    provider,
    item,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  window.addEventListener('pointermove', handleProviderDragMove);
  window.addEventListener('pointerup', finishProviderDrag, { once: true });
  window.addEventListener('pointercancel', cancelProviderDrag, { once: true });
}

function activatePendingDrag(event) {
  const { item, provider, pointerId } = pendingDrag;
  pendingDrag.active = true;
  dragJustDragged.value = true;
  item.setPointerCapture?.(pointerId);
  const rect = item.getBoundingClientRect();
  draggingKey.value = getProviderKey(provider);
  dragOriginalProviders.value = [...providers.value];
  dragOrderChanged.value = false;
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  dragImageEl = item.cloneNode(true);
  dragImageEl.removeAttribute('data-provider-key');
  dragImageEl.classList.add('provider-side-drag-image');
  dragImageEl.style.width = `${rect.width}px`;
  dragImageEl.style.position = 'fixed';
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`;
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`;
  dragImageEl.style.zIndex = '2000';
  dragImageEl.style.pointerEvents = 'none';
  dragImageEl.style.transition = 'none';
  document.body.appendChild(dragImageEl);
}

function handleProviderDragMove(event) {
  if (!pendingDrag) return;
  if (!pendingDrag.active) {
    const dist = Math.hypot(event.clientX - pendingDrag.startX, event.clientY - pendingDrag.startY);
    if (dist < DRAG_THRESHOLD) return;
    activatePendingDrag(event);
  }
  if (!draggingKey.value || !dragImageEl) return;
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`;
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`;
  const targetItem = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.provider-side-item');
  if (!targetItem) return;
  const toKey = targetItem.dataset.providerKey;
  const fromKey = draggingKey.value;
  if (!toKey || toKey === fromKey || reordering.value) return;
  const fromIndex = providers.value.findIndex((item) => getProviderKey(item) === fromKey);
  const toIndex = providers.value.findIndex((item) => getProviderKey(item) === toKey);
  if (fromIndex < 0 || toIndex < 0) return;
  const rect = targetItem.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  let targetIndex = insertAfter ? toIndex + 1 : toIndex;
  if (fromIndex < targetIndex) targetIndex -= 1;
  if (targetIndex === fromIndex) return;
  const nextProviders = [...providers.value];
  const [moved] = nextProviders.splice(fromIndex, 1);
  nextProviders.splice(targetIndex, 0, moved);
  providers.value = nextProviders;
  dragOrderChanged.value = true;
}

async function finishProviderDrag() {
  if (!pendingDrag) return;
  // 未超过拖拽阈值 → 视为点击选中（click 事件由 dragJustDragged 之外的正常路径触发）
  if (!pendingDrag.active) {
    pendingDrag = null;
    cleanupProviderDrag();
    return;
  }
  if (!draggingKey.value || reordering.value) { cleanupProviderDrag(); return; }
  const previousProviders = dragOriginalProviders.value ? [...dragOriginalProviders.value] : [...providers.value];
  const nextProviders = [...providers.value];
  setTimeout(() => { dragJustDragged.value = false; }, 120);
  if (!dragOrderChanged.value || isSameProviderOrder(previousProviders, nextProviders)) {
    providers.value = previousProviders;
    cleanupProviderDrag();
    return;
  }
  await animateDragImageToPlaceholder();
  hideDragImage();
  cleanupProviderDrag({ keepImage: true });
  await persistProviderOrder(nextProviders, previousProviders, { skipCleanup: true, silent: true });
}

function cancelProviderDrag() {
  if (pendingDrag && !pendingDrag.active) {
    pendingDrag = null;
    cleanupProviderDrag();
    return;
  }
  dragJustDragged.value = false;
  if (dragOriginalProviders.value) providers.value = dragOriginalProviders.value;
  cleanupProviderDrag();
}

async function animateDragImageToPlaceholder() {
  if (!dragImageEl || !draggingKey.value) return;
  const placeholder = Array.from(document.querySelectorAll('.provider-side-item')).find((item) => item !== dragImageEl && item.dataset.providerKey === draggingKey.value);
  if (!placeholder) return;
  const startRect = dragImageEl.getBoundingClientRect();
  const targetRect = placeholder.getBoundingClientRect();
  const deltaX = targetRect.left - startRect.left;
  const deltaY = targetRect.top - startRect.top;
  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
  dragImageEl.style.left = `${startRect.left}px`;
  dragImageEl.style.top = `${startRect.top}px`;
  dragImageEl.style.width = `${targetRect.width}px`;
  const animation = dragImageEl.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  try { await animation.finished; } catch { /* cancelled */ }
  dragImageEl.style.left = `${targetRect.left}px`;
  dragImageEl.style.top = `${targetRect.top}px`;
  dragImageEl.style.transform = 'none';
}
function hideDragImage() { if (dragImageEl) dragImageEl.style.visibility = 'hidden'; }
function cleanupProviderDrag(options = {}) {
  const imageToRemove = dragImageEl;
  draggingKey.value = '';
  dragOriginalProviders.value = null;
  dragOrderChanged.value = false;
  pendingDrag = null;
  if (imageToRemove && !options.keepImage) imageToRemove.remove();
  else if (imageToRemove) requestAnimationFrame(() => imageToRemove.remove());
  dragImageEl = null;
  window.removeEventListener('pointermove', handleProviderDragMove);
  window.removeEventListener('pointerup', finishProviderDrag);
  window.removeEventListener('pointercancel', cancelProviderDrag);
}

/* ── 模型级真实调用测试：结果按 供应商::模型 记录，行内展示（成功 10s 自动消退） ── */
const testingKeys = ref(new Set());
const testResults = ref({});
const testResultTimers = new Map();
function modelTestKey(modelName) { return `${getProviderKey(selectedProvider.value || {})}::${modelName}`; }
function isModelTesting(modelName) { return testingKeys.value.has(modelTestKey(modelName)); }
function modelTestResult(modelName) { return testResults.value[modelTestKey(modelName)] || null; }
function clearModelTestResult(key) {
  clearTimeout(testResultTimers.get(key));
  testResultTimers.delete(key);
  const next = { ...testResults.value };
  delete next[key];
  testResults.value = next;
}
function dismissModelTestResult(modelName) { clearModelTestResult(modelTestKey(modelName)); }
// 成功结果 10s 后自动消退，失败结果保留待手动关闭
function scheduleTestResultDismiss(key) {
  clearTimeout(testResultTimers.get(key));
  testResultTimers.set(key, setTimeout(() => clearModelTestResult(key), 10000));
}

async function testModel(modelName) {
  const provider = selectedProvider.value;
  if (!provider) return;
  const key = modelTestKey(modelName);
  if (testingKeys.value.has(key)) return;
  testingKeys.value = new Set([...testingKeys.value, key]);
  const nextResults = { ...testResults.value };
  delete nextResults[key];
  testResults.value = nextResults;
  try {
    const target = providerTestTargets(provider).find((item) => item.model === modelName)
      || { task: 'chat', prompt: '请只回复 pong', model: modelName };
    const result = await testProvider(
      getProviderKey(provider),
      target.model,
      target.prompt,
      provider.provider_type || '',
      target.task,
      target.documents,
    );
    if (result.error) throw new Error(result.error);
    const message = summarizeProviderTestResult(target, result);
    testResults.value = {
      ...testResults.value,
      [key]: { ok: true, msg: message, taskLabel: providerTestTaskLabel(target.task), model: target.model },
    };
    scheduleTestResultDismiss(key);
    toast.success(`${modelName} 真实调用成功`);
  } catch (e) {
    const message = e?.message || '测试失败';
    testResults.value = {
      ...testResults.value,
      [key]: { ok: false, msg: message, taskLabel: 'Chat', model: modelName },
    };
    toast.error(`${modelName}：${message}`);
  } finally {
    const next = new Set(testingKeys.value);
    next.delete(key);
    testingKeys.value = next;
  }
}

/* ── 详情区模型列表：变更即保存（PUT models 为整组更新） ── */
function buildEntryFromModelForm() {
  const name = String(modelForm.value.name || '').trim();
  const entry = {
    name,
    supports_function_calling: modelForm.value.supports_function_calling === true,
    input_modalities: toFormModalities(modelForm.value.input_modalities),
    output_modalities: toFormModalities(modelForm.value.output_modalities),
  };
  // 目录 effort 值域（如 deepseek 的 low/high/max）：存在即随条目落盘，运行时据此收缩可选档位
  const thinkingLevels = normalizeThinkingLevels(modelForm.value.thinking_levels);
  if (thinkingLevels.length) entry.thinking_levels = thinkingLevels;
  // 思考线字段声明（interleaved.field）：思考模式补齐跟随方言
  if (modelForm.value.reasoning_field === 'reasoning_content' || modelForm.value.reasoning_field === 'reasoning_details') {
    entry.reasoning_field = modelForm.value.reasoning_field;
  }
  for (const key of ['temperature', 'max_completion_tokens', 'max_context_tokens']) {
    const raw = modelForm.value[key];
    const value = Number(raw);
    if (raw !== '' && raw != null && Number.isFinite(value)) entry[key] = value;
  }
  return entry;
}

async function persistModels(nextEntries, successMessage) {
  const provider = selectedProvider.value;
  if (!provider) return;
  modelListSaving.value = true;
  try {
    await updateProvider(getProviderKey(provider), { models: nextEntries });
    provider.models = nextEntries;
    loadProviderAvailability(providers.value);
    if (successMessage) toast.success(successMessage);
  } catch (e) {
    toast.error(e?.message || '模型保存失败');
    await loadProviders();
  } finally {
    modelListSaving.value = false;
  }
}

async function removeModelDetail(index) {
  if (selectedModels.value.length <= 1) {
    toast.error('至少保留一个模型');
    return;
  }
  const next = selectedModels.value.filter((_, idx) => idx !== index);
  await persistModels(next, '模型已删除');
}

/* ── 添加供应商：详情面板内联表单（编辑走同一面板的字段自动保存） ── */
const createOpen = ref(false);
const dialog = ref({ visible: false, mode: 'create', error: '' });
const editingKey = ref('');
const form = ref({});
// 模型条目（模型级运行参数挂模型上；首个模型即默认模型，数组序即优先级）。
const modelEntries = ref([]);
const formErrors = ref({});
const modelDialog = ref({ visible: false, mode: 'create', index: -1, target: 'detail', error: '' });
const modelForm = ref({});
const modelFormErrors = ref({});

/* ── Models.dev 目录（后端缓存代理；不可用时组合框退化为纯输入，手填不受影响） ── */
const catalogProviders = ref(null);
// 厂商组合框的目录建议只列可接入厂商（原生厂商 + 带 OpenAI 兼容端点的网关厂商），
// bedrock/vertex 等专用 SDK 厂商不进建议列表。
const formCatalogVendorOptions = computed(() => (catalogProviders.value?.providers || [])
  .filter((item) => isCatalogVendorConnectable(item))
  .map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` })));
const modelDialogModels = ref([]);
const modelDialogModelsLoading = ref(false);
// 弹窗连续切换厂商时旧响应不得覆盖新列表
let modelDialogModelsSeq = 0;

async function loadCatalogProviders() {
  try {
    catalogProviders.value = await getCatalogProviders();
  } catch {
    catalogProviders.value = null;
  }
}
async function loadModelDialogModels(vendorId) {
  const seq = ++modelDialogModelsSeq;
  if (!vendorId) {
    modelDialogModels.value = [];
    return;
  }
  modelDialogModelsLoading.value = true;
  try {
    const data = await getCatalogProviderModels(vendorId);
    if (seq !== modelDialogModelsSeq) return;
    modelDialogModels.value = Array.isArray(data?.models) ? data.models : [];
  } catch {
    if (seq === modelDialogModelsSeq) modelDialogModels.value = [];
  } finally {
    if (seq === modelDialogModelsSeq) modelDialogModelsLoading.value = false;
  }
}
function openModelCatalogWith(vendorId) {
  modelDialogModels.value = [];
  if (vendorId) loadModelDialogModels(vendorId);
}
function handleCatalogModelSelect(catalogModel) {
  modelForm.value = applyCatalogModel(modelForm.value, catalogModel);
}
/** 厂商组合框键入：更新厂商文本（自建标识等自由输入）；目录带入的思考形状声明随厂商
 * 离开而失效故清空（重新从目录选中会再带出），API 格式与端点不动。 */
function handleVendorInput(vendorId) {
  form.value.provider_type = String(vendorId || '').trim();
  form.value.thinking_kind = '';
  formErrors.value = { ...formErrors.value, provider_type: '' };
}
/**
 * 厂商组合框从目录选中：按接入档案带出 API 格式与思考形状声明
 * （如 qwen 系 toggle），并预填兼容 Endpoint。
 */
function handleCatalogVendorPick(vendorId) {
  handleVendorInput(vendorId);
  const summary = (catalogProviders.value?.providers || []).find((item) => item.id === vendorId);
  const profile = summary ? catalogVendorProfile(summary) : null;
  if (!profile) return;
  if (profile.api_format && form.value.api_format !== profile.api_format) {
    handleApiFormatChange(profile.api_format);
  }
  form.value.thinking_kind = profile.thinking_kind || '';
  if (summary?.api_base_url) {
    form.value.api_endpoint = summary.api_base_url;
    formErrors.value = { ...formErrors.value, api_endpoint: '' };
  }
}

const apiEndpointPlaceholder = computed(() => (
  apiFormatMeta.value[form.value.api_format]?.default_endpoint || '由后端返回默认 API Endpoint'
));
const resilienceProviderConfigFields = computed(() => {
  const fields = apiFormatMeta.value[form.value.api_format]?.config_fields || [];
  return fields.filter((field) => RESILIENCE_FIELD_KEYS.has(field.key));
});
const extensionProviderConfigFields = computed(() => {
  const fields = apiFormatMeta.value[form.value.api_format]?.config_fields || [];
  return fields.filter((field) => !RESILIENCE_FIELD_KEYS.has(field.key));
});
const providerKeyPreview = computed(() => {
  const name = String(form.value.name || '').trim().toLowerCase().replace(/\s+/g, '_');
  const providerType = String(form.value.provider_type || '').trim().toLowerCase();
  return name && providerType ? `${name}_${providerType}` : '';
});

function buildFormDefaults() {
  return { name: '', provider_type: '', api_key: '', api_endpoint: '', api_format: '', thinking_kind: '' };
}
function buildModelDefaults() {
  return {
    name: '',
    temperature: 0.7,
    max_completion_tokens: 4096,
    max_context_tokens: 128000,
    supports_function_calling: false,
    input_modalities: ['text'],
    output_modalities: ['text'],
    thinking_levels: [],
  };
}
/** 表单/条目里的模态数组归一；空值按纯文本对话模型处理。 */
function toFormModalities(value) {
  const normalized = normalizeModalities(value);
  return normalized.length ? [...normalized] : ['text'];
}
function openCreateDialog() {
  form.value = buildFormDefaults();
  modelEntries.value = [];
  formErrors.value = {};
  dialog.value = { visible: false, mode: 'create', error: '' };
  editingKey.value = '';
  createOpen.value = true;
}
/** API 格式切换：级联该格式的扩展配置字段默认值（超时/重试/缓存开关等）。 */
function handleApiFormatChange(apiFormat) {
  const previousFields = getProviderConfigFields(form.value.api_format);
  const nextFields = getProviderConfigFields(apiFormat);
  form.value.api_format = apiFormat;
  formErrors.value = { ...formErrors.value, api_format: '' };
  for (const field of previousFields) { if (!nextFields.some((item) => item.key === field.key)) delete form.value[field.key]; }
  for (const field of nextFields) {
    const prevDef = previousFields.find((item) => item.key === field.key)?.default;
    if (form.value[field.key] === undefined || form.value[field.key] === prevDef) form.value[field.key] = field.default ?? '';
  }
}
function closeDialog() { createOpen.value = false; formErrors.value = {}; }

/* ── 模型条目弹窗（新增/编辑）：目标 = 新建 Provider 弹窗内嵌列表 or 详情面板（差异只在保存去向） ── */
/** 模型弹窗默认目录厂商 = 目标 Provider 的厂商 id（存在于目录时；自定义厂商不预选）。
 * 目标为详情面板时取当前选中供应商（新建弹窗的 form 草稿与其无关）。 */
function modelDialogDefaultVendor() {
  const source = modelDialog.value.target === 'detail'
    ? selectedProvider.value?.provider_type
    : form.value.provider_type;
  const vendor = String(source || '').trim();
  const known = (catalogProviders.value?.providers || []).some((item) => item.id === vendor);
  return known ? vendor : '';
}
function openModelCreate() {
  // 新建供应商面板内触发 → 挂其内嵌列表（弹窗内编辑）；否则挂详情面板（保存即 PUT）。
  modelDialog.value.target = createOpen.value ? 'form' : 'detail';
  modelForm.value = buildModelDefaults();
  modelFormErrors.value = {};
  modelDialog.value = { ...modelDialog.value, visible: true, mode: 'create', index: -1, error: '' };
  openModelCatalogWith(modelDialogDefaultVendor());
}
function openModelEdit(index) {
  modelDialog.value.target = createOpen.value ? 'form' : 'detail';
  const entry = modelDialog.value.target === 'form' ? modelEntries.value[index] : selectedModels.value[index];
  modelForm.value = {
    ...entry,
    input_modalities: toFormModalities(entry.input_modalities),
    output_modalities: toFormModalities(entry.output_modalities),
  };
  modelFormErrors.value = {};
  modelDialog.value = { ...modelDialog.value, visible: true, mode: 'edit', index, error: '' };
  openModelCatalogWith(modelDialogDefaultVendor());
}
function closeModelDialog() { modelDialog.value.visible = false; modelFormErrors.value = {}; }
function handleModelSubmit() {
  const name = String(modelForm.value.name || '').trim();
  const errors = {};
  const existingNames = modelDialog.value.target === 'form'
    ? modelEntries.value.map((entry) => entry.name)
    : selectedModels.value.map((entry) => entry.name);
  if (!name) errors.name = '请填写模型名';
  else if (existingNames.some((entryName, idx) => idx !== modelDialog.value.index && entryName === name)) errors.name = '模型名已存在';
  const inputModalities = toFormModalities(modelForm.value.input_modalities);
  const outputModalities = toFormModalities(modelForm.value.output_modalities);
  if (!inputModalities.includes('text')) errors.input_modalities = '输入模态需包含文本';
  if (!outputModalities.includes('text')) errors.output_modalities = '输出模态需包含文本';
  modelFormErrors.value = errors;
  if (Object.values(errors).some(Boolean)) return;
  const entry = buildEntryFromModelForm();
  if (modelDialog.value.target === 'form') {
    if (modelDialog.value.mode === 'edit') modelEntries.value.splice(modelDialog.value.index, 1, entry);
    else modelEntries.value.push(entry);
  } else {
    const current = [...selectedModels.value];
    if (modelDialog.value.mode === 'edit') current.splice(modelDialog.value.index, 1, entry);
    else current.push(entry);
    persistModels(current, modelDialog.value.mode === 'edit' ? '模型已更新' : '模型已添加');
  }
  closeModelDialog();
}
function removeModelEntry(index) { modelEntries.value.splice(index, 1); }
function moveModelEntry(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= modelEntries.value.length) return;
  const next = [...modelEntries.value];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  modelEntries.value = next;
}
function normalizeProviderPayload(payload) {
  for (const field of getProviderConfigFields(payload.api_format)) {
    if (payload[field.key] === '' || payload[field.key] === null || payload[field.key] === undefined) delete payload[field.key];
  }
  return payload;
}

function validateProviderForm() {
  const errors = {};
  if (!form.value.provider_type?.trim()) errors.provider_type = '请填写厂商（provider type）';
  if (!form.value.api_format) errors.api_format = '请选择 API 格式';
  if (dialog.value.mode === 'create') {
    if (!form.value.name?.trim()) errors.name = '请填写 Provider 名称';
    if (!form.value.api_key?.trim()) errors.api_key = '请填写 API Key 或环境变量引用';
  }
  const endpoint = String(form.value.api_endpoint || '').trim();
  if (endpoint && !endpoint.includes('${')) {
    try { new URL(endpoint); } catch { errors.api_endpoint = '请输入完整的 http:// 或 https:// 地址'; }
  }
  if (modelEntries.value.length === 0) errors.models = '至少配置一个模型';
  return errors;
}

const { run: runSubmit, loading: saving } = useAsyncAction(
  async () => {
    if (!form.value.provider_type?.trim()) throw new Error('请填写厂商');
    if (!form.value.api_format) throw new Error('请选择 API 格式');
    if (!form.value.name?.trim()) throw new Error('请填写名称');
    if (!form.value.api_key?.trim()) throw new Error('请填写 API Key');
    const models = modelEntries.value
      .map((entry) => ({ ...entry, name: String(entry.name || '').trim() }))
      .filter((entry) => entry.name);
    if (models.length === 0) throw new Error('请至少配置一个模型');
    const payload = normalizeProviderPayload({ ...form.value, models });
    const resp = await createProvider(payload);
    closeDialog();
    await loadProviders();
    const newKey = resp?.provider_key || resp?.data?.provider_key;
    if (newKey && providers.value.some((provider) => getProviderKey(provider) === newKey)) {
      selectedProviderKey.value = newKey;
    }
    return 'create';
  },
  {
    successMessage: 'Provider 创建成功',
    errorPrefix: '操作失败',
    showErrorToast: false,
    onError: (e) => { dialog.value.error = e?.message || '操作失败'; },
  },
);
function handleSubmit() {
  dialog.value.error = '';
  formErrors.value = validateProviderForm();
  if (Object.values(formErrors.value).some(Boolean)) return;
  runSubmit();
}

function usageKindLabel(kind) {
  return { agent: 'Agent', vectorizer: '向量化器', reranker: 'Reranker' }[kind] || kind;
}
async function confirmDelete(provider) {
  deleteTarget.value = provider;
  deleteUsages.value = [];
  deleteUsageError.value = '';
  deleteUsageLoading.value = true;
  try {
    deleteUsages.value = await getProviderUsages(getProviderKey(provider));
  } catch (e) {
    deleteUsageError.value = e?.message || '无法检查 Provider 引用关系';
  } finally {
    deleteUsageLoading.value = false;
  }
}
const { run: runDelete, loading: deleting } = useAsyncAction(
  async () => {
    if (!deleteTarget.value) return;
    const key = getProviderKey(deleteTarget.value);
    await deleteProvider(key);
    deleteTarget.value = null;
    deleteUsages.value = [];
    await loadProviders();
  },
  { successMessage: 'Provider 删除成功', errorPrefix: '删除失败' },
);
function doDelete() { runDelete(); }

onMounted(() => { Promise.all([loadApiFormats(), loadProviders(), loadCatalogProviders()]); });
onBeforeUnmount(() => {
  cleanupProviderDrag();
  for (const timer of testResultTimers.values()) clearTimeout(timer);
  testResultTimers.clear();
});
</script>

<style scoped>
/* ══ 主从工作台外壳（高度随内容自适应，至多占满可用高度、超出转内部滚动——内容少时不强行撑满） ══ */
.provider-workbench { display: flex; flex-direction: column; flex: 0 1 auto; max-height: 100%; min-height: 0; overflow: hidden; padding: 0; }
.provider-workbench__state { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 24px; }
.provider-workbench__body { display: grid; flex: 1; grid-template-columns: 240px minmax(0, 1fr); min-height: 0; }

/* ══ 左栏：供应商列表 ══ */
.provider-side { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--color-border); background: var(--color-bg-secondary); }
.provider-side__search { padding: 12px 12px 8px; }
.provider-side__scroll { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 12px; }
.provider-side__list { position: relative; display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.provider-side-item { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; padding: 6px 10px; border: none; border-radius: var(--radius-md); background: transparent; color: var(--color-text-primary); font-size: 13px; font-weight: 500; text-align: left; cursor: pointer; user-select: none; transition: background var(--transition-fast); }
.provider-side-item:focus-visible { outline: 2px solid var(--color-brand-accent); outline-offset: -2px; }
.provider-side-item--active { background: var(--color-active-bg); font-weight: 600; }
.provider-side-item--dragging { opacity: 0; }
.provider-side-item__icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink: 0; border-radius: var(--radius-sm); color: var(--color-text-secondary); }
.provider-side-item--active .provider-side-item__icon { color: var(--color-brand-accent); }
/* 行 hover：图标换为 6 点抓取手柄（整行可拖拽排序），拖拽影像也呈现手柄 */
.provider-side-item__grip { display: none; color: var(--color-text-muted); cursor: grab; }
.provider-side__list .provider-side-item:hover .provider-side-item__vendor-icon,
.provider-side-drag-image .provider-side-item__vendor-icon { display: none; }
.provider-side__list .provider-side-item:hover .provider-side-item__grip,
.provider-side-drag-image .provider-side-item__grip { display: inline-flex; }
.provider-side-item__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-side-item__dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 999px; background: var(--color-text-muted); opacity: 0.45; }
.provider-side-item__dot--ok { background: var(--color-success); opacity: 1; }
.provider-side-item__dot--warn { background: var(--color-warning); opacity: 1; }
.provider-side-item__dot--checking { background: var(--color-text-muted); opacity: 1; animation: side-dot-pulse 1s ease-in-out infinite; }
@keyframes side-dot-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.provider-side__empty { padding: 24px 12px; text-align: center; color: var(--color-text-muted); font-size: 12px; }
/* 添加供应商：列表尾部虚线虚拟卡片，打开新建面板时呈选中态 */
.provider-side-item--add { margin-top: 4px; border: 1px dashed var(--color-border); color: var(--color-text-secondary); font-weight: 500; transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast); }
.provider-side-item--add:hover { border-color: var(--color-brand-accent); color: var(--color-text-primary); }
.provider-side-item--add:focus-visible { outline: 2px solid var(--color-brand-accent); outline-offset: -2px; }
.provider-side-item--add.provider-side-item--active,
.provider-side-item--add.provider-side-item--active:hover { border-style: solid; border-color: var(--color-brand-accent); background: var(--color-active-bg); color: var(--color-brand-accent); font-weight: 600; }
/* 拖拽影像：行原样（侧栏实底）+ 描边区分，无悬停高亮/投影 */
.provider-side-drag-image { margin: 0; list-style: none; background: var(--color-bg-secondary); border: 1px solid var(--color-brand-accent); }
.provider-side-list-move { transition: transform 0.22s cubic-bezier(.2,.8,.2,1); will-change: transform; }
.provider-side-list-enter-active { transition: opacity 0.16s ease, transform 0.22s cubic-bezier(.2,.8,.2,1); }
.provider-side-list-leave-active { position: absolute; width: 100%; pointer-events: none; transition: opacity 0.14s ease, transform 0.14s ease; }
.provider-side-list-enter-from, .provider-side-list-leave-to { opacity: 0; transform: translateY(6px); }

/* ══ 右栏：详情面板 ══ */
.provider-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.provider-detail__head { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; padding: 16px 20px 12px; border-bottom: 1px solid var(--color-border); }
.provider-detail__heading { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }
.provider-detail__name { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-detail__saving { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.provider-detail__meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 12px; color: var(--color-text-secondary); }
.provider-detail__key--ok { color: var(--color-success); }
.provider-detail__key--missing { color: var(--color-error); font-weight: 600; }
.provider-detail__actions { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }
.provider-detail__reorder-error { margin: 8px 20px 0; font-size: 12px; color: var(--color-error); }
.provider-detail__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 24px; padding: 18px 20px 24px; }
.provider-detail__section { display: flex; flex-direction: column; gap: 12px; }
.provider-detail__section-head { display: flex; align-items: center; gap: 8px; min-height: 18px; }
.provider-detail__section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--color-text-primary); }
.provider-detail__placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 48px 16px; color: var(--color-text-muted); }
.provider-detail__placeholder p { margin: 0; font-size: 13px; }

/* 内联字段 */
.pd-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pd-field__label { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
.pd-field__label--switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--color-text-primary); cursor: pointer; }
.pd-field__hint { margin: 0; font-size: 11px; line-height: 1.5; color: var(--color-text-muted); }
.pd-field__error { margin: 0; font-size: 12px; color: var(--color-error); }
.pd-field-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px 16px; }
.pd-key-wrap { position: relative; display: flex; align-items: center; }
.pd-key-wrap input { padding-right: 38px; }
.pd-key-toggle { position: absolute; right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; transition: color var(--transition-fast), background var(--transition-fast); }
.pd-key-toggle:hover { color: var(--color-text-primary); background: var(--color-hover-overlay); }

/* 模型行 */
.provider-detail-models { display: flex; flex-direction: column; gap: 6px; }
.provider-model-line { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-elevated); }
.provider-model-line__name { flex: 1; min-width: 0; font-size: 13px; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-model-line__ctx { flex-shrink: 0; padding: 1px 8px; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-secondary); font-size: 11px; }
.provider-model-line__caps { display: inline-flex; flex-shrink: 0; gap: 3px; }
.provider-model-line__mark { color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
.provider-model-line__actions { display: inline-flex; flex-shrink: 0; gap: 2px; }
.provider-detail-models__empty { margin: 0; color: var(--color-text-muted); font-size: 12px; }
.provider-model-add { align-self: flex-start; border-style: dashed; }

/* 内联添加供应商面板 */
.provider-create-intro { margin: 0; font-size: 13px; color: var(--color-text-secondary); }
.provider-create-empty { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 14px; border: 1px dashed var(--color-border); border-radius: var(--radius-lg); color: var(--color-text-secondary); font-size: 12px; }
.provider-model-line__default { flex-shrink: 0; margin-left: 6px; padding: 0 6px; border-radius: var(--radius-sm); background: var(--color-hover-overlay-md); color: var(--color-text-secondary); font-size: 10px; font-weight: 500; }
.provider-create-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--color-border); }
.provider-create-footer__hint { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 12px; }
.provider-create-footer__actions { display: inline-flex; flex-shrink: 0; gap: 8px; }

/* 模型行内真实测试结果 */
.provider-model-line--testing .provider-model-line__name { color: var(--color-text-muted); }
.provider-model-line__actions--busy { opacity: 1; }
.provider-model-line-result { display: flex; align-items: flex-start; gap: var(--spacing-sm); margin: -2px 0 0 10px; padding: 6px 10px; border: 1px solid transparent; border-radius: var(--radius-md); font-size: 12px; line-height: 1.5; word-break: break-word; }
.result--ok { background: var(--color-success-bg); border-color: rgba(var(--color-success-rgb), 0.18); color: var(--color-success); }
.result--err { background: var(--color-error-bg); border-color: rgba(var(--color-error-rgb), 0.18); color: var(--color-error); }
.result-icon { flex-shrink: 0; }
.result-msg { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
.result-dismiss { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: none; border-radius: var(--radius-sm); background: transparent; color: inherit; opacity: 0.6; cursor: pointer; transition: opacity var(--transition-fast); }
.result-dismiss:hover { opacity: 1; }

/* ══ 响应式：窄屏单列，列表在上详情在下；fill 模式下由 body 统一滚动 ══ */
@media (max-width: 960px) {
  .provider-workbench__body { grid-template-columns: 1fr; overflow-y: auto; }
  .provider-side { border-right: 0; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .provider-side__scroll { max-height: 220px; }
  .provider-detail__head { padding: 14px 16px 12px; }
  .provider-detail__scroll { padding: 14px 16px 20px; overflow: visible; }
  .provider-detail__reorder-error { margin-left: 16px; margin-right: 16px; }
}
</style>
