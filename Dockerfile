# 构建阶段
FROM node:20-alpine AS builder

RUN apk add --no-cache ffmpeg && npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install

WORKDIR /app/backend

RUN pnpm install

# 显式安装缺失的依赖（htmlparser2、dom-serializer 及其类型）
RUN pnpm add -D @types/cors htmlparser2 dom-serializer

RUN node scripts/clean-dist.js 2>/dev/null || true

# 编译 TypeScript（忽略类型错误，强制生成 JS）
RUN ./node_modules/.bin/tsc --noEmitOnError false --skipLibCheck --strict false --noImplicitAny false

# 复制 .json 资源文件
RUN find src -name '*.json' -exec sh -c 'mkdir -p dist/$(dirname $1) && cp $1 dist/$1' _ {} \;

# 生产阶段
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

EXPOSE 3333

CMD ["node", "backend/dist/index.js"]
