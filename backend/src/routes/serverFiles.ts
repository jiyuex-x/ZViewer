import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import multer from 'multer';
import { AppDataSource } from '../data-source';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, requireRoot, AuthenticatedRequest } from '../middleware/auth';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { parseRangeHeader, pipeRangeStream, setWildcardCors } from '../services/proxy';
import {
  UPLOADS_ROOT,
  UPLOADS_ROOT_KEY,
  resolveSafePath,
  toPrefixedPath,
  getUploadsRoot,
  basename,
  type RootRegistry,
} from '../services/server-files/pathResolver';
import {
  resolveBilibiliVideo,
  extractBvid,
  normalizeResolveError,
  type ResolveProgress,
} from '../services/bilibili/resolver';
import { VIP_ONLY_QNS } from '../services/bilibili/permission';
import { getUserCookie } from '../routes/stream/helpers';
import {
  checkFfmpeg,
  installFfmpeg,
  installFfmpegFromZip,
  mergeVideoAudio,
  downloadToFile,
  resolveFfmpegPath,
  probeMediaInfo,
  extractSubtitleTrack,
  mapCodecToSubtitleFormat,
  needsAudioTranscode,
  isFfmpegTranscodeCapable,
  createAudioTranscodeStream,
  resetFfmpegCache,
  type InstallProgress,
  type SubtitleStreamInfo,
} from '../services/ffmpeg';
import { getSystemSettings } from '../services/system-settings';
const router = Router();
router.use(authenticateToken);
router.use(
  [
    '/roots',
    '/browse',
    '/browse-system',
    '/upload',
    '/folder',
    '/rename',
    '/file',
    '/ffmpeg-status',
    '/ffmpeg-install',
    '/ffmpeg-upload',
    '/bilibili-download',
  ],
  requireRoot,
);
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;
const folderRepo = () => AppDataSource.getRepository(ServerFolder);
async function loadRootRegistry(): Promise<RootRegistry> {
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await folderRepo().find({ order: { id: 'ASC' } });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  return map;
}
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
    loadRootRegistry()
      .then((roots) => {
        try {
          const { abs, root } = resolveSafePath(targetDir, roots);
          if (root.readonly) {
            cb(new Error('该根目录为只读'), '');
            return;
          }
          if (!fs.existsSync(abs)) {
            fs.mkdirSync(abs, { recursive: true });
          }
          (req as Request & { __targetDirAbs?: string }).__targetDirAbs = abs;
          cb(null, abs);
        } catch (err) {
          cb(err as Error, '');
        }
      })
      .catch((err) => cb(err as Error, ''));
  },
  filename: (req, file, cb) => {
    const dirAbs = (req as Request & { __targetDirAbs?: string }).__targetDirAbs;
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!dirAbs) {
      cb(null, original);
      return;
    }
    cb(null, uniqueFilename(dirAbs, original));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});
function uniqueFilename(dirAbs: string, filename: string): string {
  const target = path.join(dirAbs, filename);
  if (!fs.existsSync(target)) return filename;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dirAbs, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
router.get('/roots', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const list = Array.from(roots.values()).map((r) => ({
      key: r.key,
      name: r.name,
      absPath: r.absPath,
      readonly: r.readonly,
      exists: fs.existsSync(r.absPath),
    }));
    res.json({ success: true, roots: list });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '加载根目录失败',
    });
  }
});
router.post('/roots', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const absPath = typeof req.body.absPath === 'string' ? req.body.absPath.trim() : '';
    const readonly = req.body.readonly === true;
    if (!name) {
      res.status(400).json({ success: false, message: '名称不能为空' });
      return;
    }
    if (!absPath) {
      res.status(400).json({ success: false, message: '目录路径不能为空' });
      return;
    }
    const resolved = path.resolve(absPath);
    if (resolved === UPLOADS_ROOT) {
      res.status(400).json({ success: false, message: '该目录已是默认空间' });
      return;
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ success: false, message: '路径不是目录' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, message: '目录不存在或无访问权限' });
      return;
    }
    const existing = await folderRepo().findOne({ where: { absPath: resolved } });
    if (existing) {
      res.status(400).json({ success: false, message: '该目录已添加' });
      return;
    }
    const entity = folderRepo().create({ name, absPath: resolved, readonly });
    const saved = await folderRepo().save(entity);
    res.json({
      success: true,
      root: {
        key: `custom:${saved.id}`,
        name: saved.name,
        absPath: saved.absPath,
        readonly: saved.readonly,
        exists: true,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '添加根目录失败',
    });
  }
});
router.delete('/roots/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '无效的 ID' });
      return;
    }
    const entity = await folderRepo().findOne({ where: { id } });
    if (!entity) {
      res.status(404).json({ success: false, message: '根目录不存在' });
      return;
    }
    await folderRepo().remove(entity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '删除根目录失败',
    });
  }
});
router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const { abs, root } = resolveSafePath(req.query.path as string | undefined, roots);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    if (!stat.isDirectory()) {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    const items = await fsp.readdir(abs, { withFileTypes: true });
    const filtered = items.filter((item) => !item.name.startsWith('.'));
    const entries = await Promise.all(
      filtered.map(async (item) => {
        const childAbs = path.join(abs, item.name);
        let childStat;
        try {
          childStat = await fsp.stat(childAbs);
        } catch {
          return null;
        }
        return {
          name: item.name,
          path: toPrefixedPath(root, childAbs),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? childStat.size : undefined,
          modifiedAt: childStat.mtime.toISOString(),
        };
      }),
    );
    const sortedEntries = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    res.json({
      success: true,
      entries: sortedEntries,
      currentPath: toPrefixedPath(root, abs),
      readonly: root.readonly,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览目录失败',
    });
  }
});
router.get('/browse-system', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rawPath = typeof req.query.absPath === 'string' ? req.query.absPath.trim() : '';
    const isWindows = process.platform === 'win32';
    if (!rawPath) {
      if (isWindows) {
        const drives: Array<{ name: string; absPath: string }> = [];
        for (let code = 65; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          try {
            if (fs.statSync(drivePath).isDirectory()) {
              drives.push({ name: `${letter}:`, absPath: drivePath });
            }
          } catch {
          }
        }
        res.json({ success: true, entries: drives, currentPath: '', isRoot: true });
        return;
      }
      const items = fs.readdirSync('/', { withFileTypes: true });
      const entries = items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => ({ name: item.name, absPath: path.join('/', item.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      res.json({ success: true, entries, currentPath: '/', isRoot: true });
      return;
    }
    const resolved = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(400).json({ success: false, message: '路径不存在或无访问权限' });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ success: false, message: '路径不是目录' });
      return;
    }
    const items = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => ({ name: item.name, absPath: path.join(resolved, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    let parentPath = '';
    if (isWindows) {
      const parsed = path.parse(resolved);
      if (parsed.dir && parsed.dir !== resolved) {
        parentPath = parsed.dir;
      }
    } else {
      if (resolved !== '/') {
        parentPath = path.dirname(resolved);
      }
    }
    res.json({
      success: true,
      entries,
      currentPath: resolved,
      parentPath,
      isRoot: false,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览系统目录失败',
    });
  }
});
router.post('/upload', upload.array('files', 50), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: '未接收到文件' });
    return;
  }
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
  try {
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    const uploaded = files.map((f) => {
      const name = path.basename(f.path);
      const childAbs = path.join(dirAbs, name);
      return {
        name,
        path: toPrefixedPath(root, childAbs),
        size: f.size,
      };
    });
    res.json({ success: true, files: uploaded });
  } catch (err) {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '上传失败',
    });
  }
});
router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '/';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ success: false, message: '文件夹名称不能为空' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      res.status(400).json({ success: false, message: '文件夹名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: parentAbs, root } = resolveSafePath(parent, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    const targetAbs = path.join(parentAbs, name);
    if (targetAbs !== root.absPath && !targetAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(targetAbs)) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.mkdirSync(targetAbs, { recursive: true });
    res.json({ success: true, path: toPrefixedPath(root, targetAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '新建文件夹失败',
    });
  }
});
router.post('/rename', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const oldPath = typeof req.body.path === 'string' ? req.body.path : '';
    const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
    if (!oldPath || !newName) {
      res.status(400).json({ success: false, message: '缺少 path 或 newName 参数' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      res.status(400).json({ success: false, message: '名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: oldAbs, root } = resolveSafePath(oldPath, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (!fs.existsSync(oldAbs)) {
      res.status(404).json({ success: false, message: '原文件不存在' });
      return;
    }
    const parentDir = path.dirname(oldAbs);
    const newAbs = path.join(parentDir, newName);
    if (newAbs !== root.absPath && !newAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(newAbs) && oldAbs !== newAbs) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.renameSync(oldAbs, newAbs);
    res.json({ success: true, path: toPrefixedPath(root, newAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '重命名失败',
    });
  }
});
router.delete('/file', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target || target === '/' || target.endsWith(':/') || target.endsWith(':')) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs, root } = resolveSafePath(target, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (targetAbs === root.absPath) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    if (!fs.existsSync(targetAbs)) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    fs.rmSync(targetAbs, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '删除失败',
    });
  }
});
router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const name = basename(targetAbs);
    const format = detectMediaFormat(name);
    const proxyUrl = `/api/server-files/proxy?path=${encodeURIComponent(target)}`;
    let audioCodec: string | null = null;
    let duration: number | null = null;
    let subtitleTracks: SubtitleStreamInfo[] = [];
    try {
      const probe = await probeMediaInfo(targetAbs);
      audioCodec = probe.audioCodec;
      duration = probe.duration;
      subtitleTracks = probe.subtitleStreams || [];
    } catch {
    }
    res.json({
      success: true,
      title: name,
      videoUrl: proxyUrl,
      format,
      audioCodec,
      duration,
      subtitleTracks,
      size: fs.statSync(targetAbs).size,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '解析文件失败',
    });
  }
});
router.get('/extract-subtitle', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    const streamIndex = parseInt(String(req.query.index), 10);
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    if (!Number.isFinite(streamIndex) || streamIndex < 0) {
      res.status(400).json({ success: false, message: '缺少或无效的 index 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const probe = await probeMediaInfo(targetAbs);
    const subStream = (probe.subtitleStreams || []).find(s => s.index === streamIndex);
    if (!subStream) {
      res.status(400).json({ success: false, message: '未找到指定的字幕轨道' });
      return;
    }
    const format = mapCodecToSubtitleFormat(subStream.codecName);
    const content = await extractSubtitleTrack(targetAbs, streamIndex, format);
    const label = subStream.title || subStream.language || `轨道 ${streamIndex}`;
    res.json({
      success: true,
      content,
      format,
      label,
      language: subStream.language,
    });
  } catch (err) {
    console.error('[server-files] extract-subtitle error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '提取字幕失败',
    });
  }
});
router.head('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).end();
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).end();
      return;
    }
    const format = detectMediaFormat(target);
    const stat = fs.statSync(targetAbs);
    setWildcardCors(res);
    res.setHeader('Content-Type', getContentType(format));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size.toString());
    try {
      const probe = await probeMediaInfo(targetAbs);
      if (probe.duration && probe.duration > 0) {
        res.setHeader('X-Content-Duration', probe.duration.toFixed(3));
      }
    } catch {
    }
    res.status(200).end();
  } catch {
    if (!res.headersSent) {
      res.status(400).end();
    }
  }
});
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const stat = fs.statSync(targetAbs);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;
    const format = detectMediaFormat(target);
    let transcodeNeeded = false;
    let probeDuration: number | null = null;
    if (format === 'mkv' || format === 'avi' || format === 'wmv' || format === 'ts') {
      const { audioTranscodeEnabled } = await getSystemSettings();
      if (audioTranscodeEnabled) {
        try {
          const probe = await probeMediaInfo(targetAbs);
          probeDuration = probe.duration;
          if (needsAudioTranscode(probe.audioCodec)) {
            const capable = await isFfmpegTranscodeCapable();
            if (capable) {
              transcodeNeeded = true;
              console.log(`[server-files] 音频转码: ${probe.audioCodec} → AAC, 文件: ${targetAbs}`);
            } else {
              console.warn(`[server-files] 音频需转码 (${probe.audioCodec}) 但 FFmpeg 不支持 AAC 编码，使用直接传输（可能无声音）`);
            }
          }
        } catch {
        }
      }
    }
    if (transcodeNeeded) {
      let seekTime = 0;
      if (rangeHeader && probeDuration && fileSize > 0) {
        const parsed = parseRangeHeader(rangeHeader, fileSize);
        if (parsed !== 'invalid' && parsed) {
          seekTime = (parsed.start / fileSize) * probeDuration;
        }
      }
      let transcodeResult;
      try {
        transcodeResult = createAudioTranscodeStream(targetAbs, seekTime);
      } catch (err) {
        console.warn('[server-files] FFmpeg 转码不可用，回退到直接传输:', err);
        transcodeNeeded = false;
      }
      if (transcodeNeeded && transcodeResult) {
        const { stream, process: ffmpegProc } = transcodeResult;
        const firstChunk = await new Promise<Buffer | null>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(null); }
          }, 5000);
          stream.once('data', (chunk: Buffer) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(chunk); }
          });
          ffmpegProc.once('exit', (code) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
            if (code !== 0 && code !== null) {
              console.error(`[server-files] FFmpeg 启动失败，退出码 ${code}`);
            }
          });
          ffmpegProc.once('error', () => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
          });
        });
        if (firstChunk) {
          setWildcardCors(res);
          res.setHeader('Content-Type', 'video/mp4');
          if (probeDuration && probeDuration > 0) {
            res.setHeader('X-Content-Duration', probeDuration.toFixed(3));
          }
          res.status(200);
          res.on('close', () => {
            if (!res.writableFinished) {
              try { ffmpegProc.kill('SIGKILL'); } catch { /* ignore */ }
            }
          });
          let stderrBuffer = '';
          ffmpegProc.stderr?.on('data', (chunk: Buffer) => {
            stderrBuffer += chunk.toString();
            if (stderrBuffer.length > 4096) {
              stderrBuffer = stderrBuffer.slice(-2048);
            }
          });
          ffmpegProc.on('error', (err) => {
            console.error('[server-files] FFmpeg 进程错误:', err);
            if (!res.writableFinished) { res.destroy(); }
          });
          ffmpegProc.on('exit', (code) => {
            if (code !== 0 && code !== null) {
              console.error(`[server-files] FFmpeg 退出码 ${code}: ${stderrBuffer.slice(-500)}`);
              if (!res.writableFinished) { res.destroy(); }
            }
          });
          res.write(firstChunk);
          stream.pipe(res);
          return;
        } else {
          console.warn('[server-files] FFmpeg 转码未产生数据，回退到直接传输');
          try { ffmpegProc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
    }
    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      if (parsed === 'invalid') {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
      const start = parsed?.start ?? 0;
      const end = parsed?.end ?? fileSize - 1;
      const stream = fs.createReadStream(targetAbs, { start, end });
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        start,
        end,
        ranged: true,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    } else {
      const stream = fs.createReadStream(targetAbs);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        ranged: false,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '代理播放失败',
      });
    }
  }
});
router.get('/ffmpeg-status', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (req.query.force === 'true') {
      resetFfmpegCache();
    }
    const status = await checkFfmpeg();
    const transcodeCapable = status.available
      ? await isFfmpegTranscodeCapable()
      : false;
    const manualDownloadUrls = [
      {
        platform: 'win32' as const,
        label: 'Windows（zip）',
        url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      },
      {
        platform: 'linux64' as const,
        label: 'Linux x64（tar.xz）',
        url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
      },
    ];
    res.json({
      success: true,
      ...status,
      transcodeCapable,
      platform: process.platform,
      manualDownloadUrls,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      available: false,
      transcodeCapable: false,
      platform: process.platform,
      message: err instanceof Error ? err.message : '检测 FFmpeg 失败',
    });
  }
});
router.post('/ffmpeg-install', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  try {
    await installFfmpeg((p: InstallProgress) => {
      send({ status: p.stage, ...p });
    });
    send({ success: true, status: 'done', message: 'FFmpeg 安装完成' });
    res.end();
  } catch (err) {
    send({
      success: false,
      status: 'error',
      message: err instanceof Error ? err.message : '安装 FFmpeg 失败',
    });
    res.end();
  }
});
const ffmpegUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(os.tmpdir(), 'ffmpeg-upload');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (_req, file, cb) => {
      cb(null, `ffmpeg-${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.tar.xz') || name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .zip、.tar.xz 或 .tar.gz 格式的 FFmpeg 压缩包'));
    }
  },
});
router.post('/ffmpeg-upload', ffmpegUpload.single('file'), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: '未收到文件' });
      return;
    }
    const zipPath = req.file.path;
    console.log(`[ffmpeg-upload] 收到上传文件: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    await installFfmpegFromZip(zipPath);
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    const status = await checkFfmpeg();
    const transcodeCapable = status.available
      ? await isFfmpegTranscodeCapable()
      : false;
    res.json({
      success: status.available,
      message: status.available
        ? `FFmpeg 安装成功${transcodeCapable ? '（完整版，支持音频转码）' : '（精简版，不支持音频转码）'}`
        : '安装后仍未检测到 FFmpeg，请检查压缩包内容',
      available: status.available,
      source: status.source,
      version: status.version,
      transcodeCapable,
    });
  } catch (err) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    console.error('[ffmpeg-upload] 安装失败:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '安装失败',
    });
  }
});
router.post('/bilibili-download', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir.trim() : '';
  const filename = typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  const qn =
    typeof req.body.qn === 'number' && Number.isFinite(req.body.qn)
      ? req.body.qn
      : undefined;
  const page =
    typeof req.body.page === 'number' && Number.isFinite(req.body.page)
      ? req.body.page
      : undefined;
  const mode = req.body.mode === 'dash' ? 'dash' : 'mp4';
  const userId = req.user?.userId;
  if (!url) {
    res.status(400).json({ success: false, message: '缺少视频链接或 BV 号' });
    return;
  }
  // 短链接（b23.tv）需要先跟随重定向才能获取 BV 号，跳过提前校验，由后续解析逻辑处理
  if (!/b23\.tv/i.test(url) && !extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }
  if (!targetDir) {
    res.status(400).json({ success: false, message: '缺少目标目录' });
    return;
  }
  if (mode === 'dash') {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      res.status(400).json({
        success: false,
        message: 'DASH 模式需要 FFmpeg，请先在下载面板中点击「下载 FFmpeg」',
      });
      return;
    }
  }
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  const fail = (message: string, code?: string): void => {
    send({ success: false, status: 'error', message, code });
    res.end();
  };
  const tempFiles: string[] = [];
  const cleanupTemps = (): void => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };
  try {
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    if (root.readonly) {
      fail('该根目录为只读');
      return;
    }
    if (!fs.existsSync(dirAbs)) {
      fs.mkdirSync(dirAbs, { recursive: true });
    }
    const cookie = (await getUserCookie(userId)) || undefined;
    send({ status: 'parsing', step: 'resolve', message: '正在解析视频地址...' });
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      preferMp4: mode === 'mp4',
      page,
      skipCdnCheck: true,
      onProgress: (msg: ResolveProgress) => {
        send({ status: 'parsing', step: msg.step, message: msg.message });
      },
    });
    if (!result.videoUrl) {
      fail('解析失败：未获取到视频直链');
      return;
    }
    if (qn && VIP_ONLY_QNS.includes(qn) && result.vipStatus !== 1) {
      fail(
        '该清晰度需要大会员账号，请先在个人中心绑定大会员账号后重试，或选择 1080P 及以下清晰度',
        'VIP_REQUIRED',
      );
      return;
    }
    const title = (filename || result.title || `bilibili_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = uniqueFilename(dirAbs, `${title}.mp4`);
    const targetPath = path.join(dirAbs, finalName);
    const downloadHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com',
      Origin: 'https://www.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    };
    if (mode === 'mp4') {
      send({ status: 'downloading', phase: 'video', message: '开始下载...', received: 0, total: 0, percent: 0 });
      try {
        await downloadToFile(result.videoUrl, targetPath, downloadHeaders, (received, total, percent) => {
          send({ status: 'downloading', phase: 'video', received, total, percent });
        });
      } catch (err) {
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        fail(`下载失败：${err instanceof Error ? err.message : '写入文件失败'}`);
        return;
      }
    } else {
      const videoTmp = `${targetPath}.video.m4s`;
      const audioTmp = `${targetPath}.audio.m4s`;
      tempFiles.push(videoTmp, audioTmp);
      send({ status: 'downloading', phase: 'video', message: '开始下载视频流和音频流...', received: 0, total: 0, percent: 0 });
      const downloadVideo = async () => {
        try {
          await downloadToFile(result.videoUrl, videoTmp, downloadHeaders, (received, total, percent) => {
            send({ status: 'downloading', phase: 'video', received, total, percent });
          });
          return true;
        } catch (err) {
          console.error('[server-files] 视频流下载失败:', err);
          return false;
        }
      };
      const downloadAudio = async (): Promise<boolean> => {
        if (!result.audioUrl) return true;
        try {
          await downloadToFile(result.audioUrl, audioTmp, downloadHeaders, (received, total, percent) => {
            send({ status: 'downloading', phase: 'audio', received, total, percent });
          });
          return true;
        } catch (err) {
          console.error('[server-files] 音频流下载失败:', err);
          return false;
        }
      };
      const [videoOk, audioOk] = await Promise.all([downloadVideo(), downloadAudio()]);
      if (!videoOk) {
        cleanupTemps();
        fail('视频流下载失败，请检查网络连接或稍后重试');
        return;
      }
      if (!audioOk && result.audioUrl) {
        cleanupTemps();
        fail('音频流下载失败，请检查网络连接或稍后重试');
        return;
      }
      send({ status: 'merging', percent: 0, message: '正在合并音视频流...' });
      try {
        await mergeVideoAudio({
          videoPath: videoTmp,
          audioPath: result.audioUrl ? audioTmp : undefined,
          outputPath: targetPath,
          duration: result.duration > 0 ? result.duration : undefined,
          onProgress: (percent, message) => {
            send({ status: 'merging', percent, message });
          },
        });
      } catch (err) {
        cleanupTemps();
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        fail(`合并失败：${err instanceof Error ? err.message : 'FFmpeg 合并失败'}`);
        return;
      }
      cleanupTemps();
    }
    const size = fs.statSync(targetPath).size;
    send({
      success: true,
      status: 'done',
      file: {
        name: finalName,
        path: toPrefixedPath(root, targetPath),
        size,
      },
    });
    res.end();
  } catch (err) {
    console.error('[server-files] bilibili-download error:', err);
    cleanupTemps();
    const normalized = normalizeResolveError(err);
    fail(normalized.message, normalized.code);
  }
});
export default router;
