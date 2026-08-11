/**
 * AgentStudio 表单编辑状态机：form/rawConfig/pristine/dirty/activeTab + 脏检测 + 放弃。
 * 纯逻辑、与 API 无关；视图负责加载与保存，这里只管「当前编辑态与脏标记」。
 */
import { reactive, ref, watch } from 'vue';
import { createEmptyForm } from './agentFormModel.js';

const MAIN_KEYS = ['skills', 'memory', 'mcp', 'knowledge_base'];
const TAB_FORM_KEYS = { skills: 'skills', memory: 'memory', mcp: 'mcp', knowledge: 'knowledge_base' };

export function useAgentForm() {
  const form = ref(createEmptyForm());
  const rawConfig = ref(createEmptyForm());
  const pristine = ref(null);
  const dirty = reactive({ config: false, skills: false, memory: false, mcp: false, knowledge: false });
  const activeTab = ref('config');

  function resetDirty() {
    for (const k of Object.keys(dirty)) dirty[k] = false;
  }

  /** 载入一份新配置：重置 form/raw、冻结 pristine 快照、清脏、回到 config tab。 */
  function applyConfig(nextForm, nextRaw) {
    form.value = nextForm;
    rawConfig.value = nextRaw;
    pristine.value = JSON.stringify(nextForm);
    resetDirty();
    activeTab.value = 'config';
  }

  /** 保存成功后原位刷新：不重置 activeTab，避免打断用户当前所在页。 */
  function applyConfigInPlace(nextForm, nextRaw) {
    form.value = nextForm;
    rawConfig.value = nextRaw;
    pristine.value = JSON.stringify(nextForm);
    resetDirty();
  }

  /** 清空（无选中 Agent 时）。 */
  function clearForm() {
    form.value = createEmptyForm();
    pristine.value = null;
    resetDirty();
  }

  /** 放弃某 tab 的改动，回滚到 pristine 快照对应分区。 */
  function resetTab(tab) {
    if (pristine.value === null) return;
    const snap = JSON.parse(pristine.value);
    if (tab === 'config') {
      const keep = {};
      for (const k of MAIN_KEYS) keep[k] = form.value[k];
      Object.assign(form.value, snap, keep);
      dirty.config = false;
      return;
    }
    const key = TAB_FORM_KEYS[tab];
    if (key) {
      form.value[key] = snap[key];
      dirty[tab] = false;
    }
  }

  watch(form, () => {
    if (pristine.value === null) return;
    const snap = JSON.parse(pristine.value);
    dirty.skills = JSON.stringify(form.value.skills) !== JSON.stringify(snap.skills);
    dirty.memory = JSON.stringify(form.value.memory) !== JSON.stringify(snap.memory);
    dirty.mcp = JSON.stringify(form.value.mcp) !== JSON.stringify(snap.mcp);
    dirty.knowledge = JSON.stringify(form.value.knowledge_base) !== JSON.stringify(snap.knowledge_base);
    const cur = { ...form.value };
    const base = { ...snap };
    for (const k of MAIN_KEYS) { delete cur[k]; delete base[k]; }
    dirty.config = JSON.stringify(cur) !== JSON.stringify(base);
  }, { deep: true });

  return {
    form, rawConfig, pristine, dirty, activeTab,
    applyConfig, applyConfigInPlace, clearForm, resetTab, resetDirty,
  };
}
