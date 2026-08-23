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

# 复制 backend 的 package.json（用于安装生产依赖）
COPY --from=builder /app/backend/package*.json ./backend/

# 复制构建产物
COPY --from=builder /app/backend/dist ./backend/dist

# 复制根目录的 workspace 配置（如果需要）
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# 在最终镜像中安装生产依赖（包括 reflect-metadata）
WORKDIR /app/backend
RUN pnpm install --prod

EXPOSE 3333

CMD ["node", "dist/index.js"]
