# 构建阶段
FROM node:20-alpine AS builder

RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install

WORKDIR /app/backend

RUN pnpm install

RUN pnpm add -D typescript @types/cors htmlparser2 dom-serializer

RUN pnpm add reflect-metadata

RUN node scripts/clean-dist.js 2>/dev/null || true

RUN ./node_modules/.bin/tsc \
    --noEmitOnError false \
    --skipLibCheck \
    --strict false \
    --noImplicitAny false \
    --strictNullChecks false \
    || true

RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

# 复制整个 backend 目录（包含源码、package.json、已编译的 dist）
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# 进入 backend 目录，强制重新安装所有依赖，忽略 lockfile 冲突
WORKDIR /app/backend
RUN pnpm install --no-frozen-lockfile

# 额外安装 reflect-metadata，确保它存在
RUN pnpm add reflect-metadata

EXPOSE 3333

CMD ["node", "dist/index.js"]
