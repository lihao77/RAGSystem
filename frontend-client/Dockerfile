# 前端 Nginx 生产镜像。构建必须从 monorepo 根执行，以解析本地 workspace 包。
FROM node:22.5-alpine AS build
WORKDIR /app

COPY . .
RUN npm ci && npm run build:frontend

FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# 清空默认内容
RUN rm -rf ./*

# 使用自定义 nginx 配置，将 /api 代理到 backend 服务
COPY frontend-client/nginx.conf /etc/nginx/conf.d/default.conf

# 拷贝 Vite 构建产物
COPY --from=build /app/frontend-client/dist/ ./

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
