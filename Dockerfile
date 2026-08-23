# 构建阶段
FROM node:20-alpine AS builder

# 安装系统依赖（ffmpeg 用于流处理）
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制后端依赖文件
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci

# 复制后端源码
COPY backend/ ./

# 构建 TypeScript（编译到 dist/）
RUN npm run build

# 复制所有 .json 资源文件到 dist 对应路径（因为 tsc 不会复制非 .ts 文件）
RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# ------------------------------
# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制构建产物和依赖
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules

# 暴露后端端口（默认 3333）
EXPOSE 3333

# 启动后端
CMD ["node", "dist/index.js"]
