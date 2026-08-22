FROM node:20-alpine
WORKDIR /app

# 复制后端依赖
COPY package*.json ./
RUN npm install

# 复制全部后端源码
COPY . .

# 编译TS项目
RUN npm run build

# 启动后端服务
CMD ["node", "dist/index.js"]
