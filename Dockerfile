# 构建阶段
FROM node:20-alpine AS builder

RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install

WORKDIR /app/backend

RUN pnpm install

# 安装 esbuild（用于快速构建）
RUN pnpm add -D esbuild

# 使用 esbuild 打包（忽略类型错误，直接编译）
RUN ./node_modules/.bin/esbuild src/index.ts --bundle --platform=node --target=node20 --outfile=dist/index.js --external:pg-native --external:sqlite3 --external:bufferutil --external:utf-8-validate

# 复制 .json 资源文件（esbuild 不会自动复制，需手动）
RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制构建产物和依赖
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# 可选：保留根目录配置
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

EXPOSE 3333

CMD ["node", "backend/dist/index.js"]
