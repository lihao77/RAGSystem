# 前端 Nginx 生产镜像
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

# 清空默认内容
RUN rm -rf ./*

# 使用自定义 nginx 配置，将 /api 代理到 backend 服务
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 拷贝 Vite 构建产物
COPY --from=build /app/dist/ ./

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
