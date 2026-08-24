import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';
import { PlaybackState } from './entities/PlaybackState';
import { ServerFolder } from './entities/ServerFolder';
import { DanmakuTrack } from './entities/DanmakuTrack';
import { RoomDanmakuMeta } from './entities/RoomDanmakuMeta';
import { AuditLog } from './entities/AuditLog';
import { DATABASE_PATH } from './services/paths';

const entities = [
  Room,
  Session,
  User,
  Comment,
  BilibiliCredential,
  Movie,
  UserMount,
  SystemSettings,
  PlaybackState,
  ServerFolder,
  DanmakuTrack,
  RoomDanmakuMeta,
  AuditLog,
];

const isLogging = process.env.NODE_ENV === 'development';

/**
 * 数据源配置：支持两种数据库模式。
 *
 * 1. PostgreSQL 模式（设置了 DATABASE_URL 环境变量）：
 *    适用于 Supabase、RDS 等托管 PostgreSQL，数据持久化不依赖本地 Volume。
 *    Supabase 等云数据库需要 SSL 连接，设置 rejectUnauthorized: false 兼容自签证书。
 *
 * 2. sqljs 模式（未设置 DATABASE_URL，默认）：
 *    WebAssembly 版 SQLite，数据库文件保存在本地 config/dev.sqlite。
 *    适用于单机部署、Docker Volume 挂载等场景。
 */
const isPostgres = !!process.env.DATABASE_URL;

export const AppDataSource = new DataSource(
  isPostgres
    ? {
        type: 'postgres',
        url: process.env.DATABASE_URL,
        synchronize: true,
        logging: isLogging,
        entities,
        migrations: [],
        subscribers: [],
        // Supabase / 云 PostgreSQL 需要 SSL；rejectUnauthorized: false 兼容自签证书
        ssl: { rejectUnauthorized: false },
      }
    : {
        // sqljs（wasm）驱动：纯 JS 实现，无原生模块，单文件版可在任意平台运行
        type: 'sqljs',
        // 数据库文件统一存放在 config/ 目录下，便于升级时整体保留。
        // 路径解析详见 services/paths.ts（支持 DATABASE_URL 环境变量覆盖）。
        location: DATABASE_PATH,
        // 变更后自动保存到文件（Node 环境使用文件系统持久化，而非浏览器 IndexedDB）
        autoSave: true,
        useLocalForage: false,
        synchronize: true,
        logging: isLogging,
        entities,
        migrations: [],
        subscribers: [],
      },
);
