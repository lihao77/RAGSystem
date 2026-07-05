import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'
import './styles/main.css'
import './styles/page-layout.css'
import './styles/forms.css'
import './styles/markdown.css'
import '@fontsource-variable/inter/index.css'

createApp(App).use(createPinia()).use(router).mount('#app')
