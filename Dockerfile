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

RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制 package.json 以便安装依赖
COPY --from=builder /app/backend/package*.json ./backend/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# 复制构建产物
COPY --from=builder /app/backend/dist ./backend/dist

# 安装生产依赖（包括 reflect-metadata）
WORKDIR /app/backend
RUN pnpm install --prod

# 额外安装一次 reflect-metadata（确保存在）
RUN pnpm add reflect-metadata

EXPOSE 3333

CMD ["node", "dist/index.js"]
