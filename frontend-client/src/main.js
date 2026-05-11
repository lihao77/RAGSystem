import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import './styles/main.css'
import './styles/page-layout.css'
import './styles/admin-console.css'

createApp(App).use(router).mount('#app')
