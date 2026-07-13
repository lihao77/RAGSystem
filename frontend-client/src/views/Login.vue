<template>
  <AuthLayout>
    <Card>
      <CardHeader>
        <CardTitle>登录工作台</CardTitle>
        <CardDescription>使用安装时创建的管理员账号登录。</CardDescription>
      </CardHeader>
      <form @submit.prevent="handleSubmit">
        <CardContent class="flex flex-col gap-4">
          <label class="flex flex-col gap-2 text-sm font-medium" for="login-username">
            用户名
            <Input id="login-username" v-model.trim="form.username" autocomplete="username" required autofocus />
          </label>
          <label class="flex flex-col gap-2 text-sm font-medium" for="login-password">
            密码
            <Input id="login-password" v-model="form.password" type="password" autocomplete="current-password" required />
          </label>
          <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        </CardContent>
        <CardFooter>
          <Button class="w-full" type="submit" :disabled="loading">
            {{ loading ? '登录中...' : '登录' }}
          </Button>
        </CardFooter>
      </form>
    </Card>
  </AuthLayout>
</template>

<script setup>
import { reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AuthLayout from '../layouts/AuthLayout.vue';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { login } from '../api/auth.js';
import { useAuthStore } from '../stores/auth.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const form = reactive({ username: '', password: '' });

const { run, loading, error } = useAsyncAction(
  () => login(form),
  { errorPrefix: '登录失败' },
);

async function handleSubmit() {
  const session = await run();
  if (!session) return;

  authStore.setSession(session);
  const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
    ? route.query.redirect
    : '/';
  await router.replace(redirect);
}
</script>
