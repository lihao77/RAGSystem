<template>
  <AuthLayout>
    <Card>
      <CardHeader>
        <CardTitle>初始化 RAGSystem</CardTitle>
        <CardDescription>创建平台管理员账号并初始化默认租户。本地部署形态免安装，不会进入此页面。</CardDescription>
      </CardHeader>

      <CardContent v-if="restartRequired" class="flex flex-col gap-4">
        <div class="rounded-md border border-input bg-muted p-4">
          <h2 class="font-medium">安装成功</h2>
          <p class="mt-2 text-sm text-muted-foreground">
            多租户认证配置已经写入。请重启后端服务，然后刷新此页面，系统会自动进入登录页。
          </p>
        </div>
        <Button variant="outline" @click="refreshPage">我已重启，刷新页面</Button>
      </CardContent>

      <form v-else @submit.prevent="handleSubmit">
        <CardContent class="flex flex-col gap-5">
          <div class="rounded-md border border-input bg-muted p-4 text-sm text-muted-foreground">
            安装完成后将启用密码认证。此向导仅用于 SaaS 部署的首次初始化，安装完成后不可重复执行。
          </div>

          <label class="flex flex-col gap-2 text-sm font-medium" for="tenant-display-name">
            租户显示名
            <Input id="tenant-display-name" v-model.trim="form.tenantDisplayName" autocomplete="organization" required />
          </label>
          <label class="flex flex-col gap-2 text-sm font-medium" for="admin-username">
            管理员用户名
            <Input id="admin-username" v-model.trim="form.username" autocomplete="username" required />
          </label>
          <label class="flex flex-col gap-2 text-sm font-medium" for="admin-password">
            管理员密码
            <Input id="admin-password" v-model="form.password" type="password" autocomplete="new-password" required />
          </label>
          <label class="flex flex-col gap-2 text-sm font-medium" for="admin-password-confirm">
            确认密码
            <Input id="admin-password-confirm" v-model="form.confirmPassword" type="password" autocomplete="new-password" required />
          </label>

          <p v-if="validationError || error" class="text-sm text-destructive" role="alert">
            {{ validationError || error }}
          </p>
        </CardContent>
        <CardFooter>
          <Button class="w-full" type="submit" :disabled="loading">
            {{ loading ? '安装中...' : '开始安装' }}
          </Button>
        </CardFooter>
      </form>
    </Card>
  </AuthLayout>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import AuthLayout from '../layouts/AuthLayout.vue';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { install } from '../api/auth.ts';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';

const router = useRouter();
const bootstrapStore = useBootstrapStore();
const restartRequired = ref(false);
const validationError = ref('');
const form = reactive({
  tenantDisplayName: '',
  username: '',
  password: '',
  confirmPassword: '',
});

const { run, loading, error } = useAsyncAction(
  (payload) => install(payload),
  { successMessage: '安装完成', errorPrefix: '安装失败' },
);

function buildPayload() {
  validationError.value = '';

  if (!form.tenantDisplayName || !form.username || !form.password) {
    validationError.value = '请完整填写租户与管理员信息';
    return null;
  }
  if (form.password !== form.confirmPassword) {
    validationError.value = '两次输入的密码不一致';
    return null;
  }

  return {
    tenantDisplayName: form.tenantDisplayName,
    admin: { username: form.username, password: form.password },
  };
}

async function handleSubmit() {
  const payload = buildPayload();
  if (!payload) return;

  const result = await run(payload);
  if (!result) return;

  if (result.restart_required) {
    restartRequired.value = true;
    return;
  }

  await bootstrapStore.load(true);
  await router.replace('/');
}

function refreshPage() {
  window.location.reload();
}
</script>
