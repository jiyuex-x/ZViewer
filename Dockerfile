# 构建阶段
FROM node:20-alpine AS builder

# 安装系统依赖（ffmpeg）和 pnpm
RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

# 复制后端所有文件（包括 package.json, tsconfig.json, src/ 等）
COPY backend/ ./backend/

WORKDIR /app/backend

# 使用 pnpm 安装依赖（会自动生成 pnpm-lock.yaml 或使用已有的）
RUN pnpm install

# 构建 TypeScript（输出到 dist/）
RUN pnpm run build

# 复制 .json 等资源文件到 dist 对应位置（tsc 不会复制它们）
RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# ------------------------------
# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制构建产物和依赖
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules

# 暴露端口（后端默认 3333）
EXPOSE 3333

# 启动后端
CMD ["node", "dist/index.js"]
