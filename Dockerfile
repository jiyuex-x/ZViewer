# 构建阶段
FROM node:20-alpine AS builder

# 安装 ffmpeg（流处理需要）和 pnpm
RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

# 复制整个项目（必须包含根目录的 pnpm-workspace.yaml 和 package.json）
COPY . .

# 安装所有依赖（monorepo 会自动链接）
RUN pnpm install

# 只构建后端
WORKDIR /app/backend
RUN pnpm run build

# 复制 .json 等非 ts 资源到 dist（tsc 不会复制它们）
RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# ------------------------------
# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# 只复制后端的构建产物和依赖
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# （可选）保留根目录的配置文件（某些运行时可能需要）
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# 暴露后端端口（默认 3333）
EXPOSE 3333

# 启动后端
CMD ["node", "backend/dist/index.js"]
