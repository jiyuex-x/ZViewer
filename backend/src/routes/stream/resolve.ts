import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getVideoInfo } from '../../services/bilibili/video';
import { getDanmaku } from '../../services/bilibili/danmaku';
import {
  resolveBilibiliVideo,
  extractBvid,
  normalizeResolveError,
  type ResolveProgress,
  type ResolvePageInfo,
} from '../../services/bilibili/resolver';
import { getUserCookie } from './helpers';
import { getSystemSettings } from '../../services/system-settings';
const router = Router();
interface ResolveProgressMessage {
  success?: boolean;
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
  code?: string;
  title?: string;
  duration?: number;
  cid?: number;
  videoUrl?: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format?: 'dash' | 'mp4';
  loggedIn?: boolean;
  vipStatus?: number;
  currentQn?: number;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
  pages?: ResolvePageInfo[];
  currentPage?: number;
}
class NdjsonWriter {
  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  send(payload: ResolveProgressMessage): void {
    this.res.write(JSON.stringify(payload) + '\n');
    const flushable = this.res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') {
      flushable.flush();
    }
  }
  fail(message: string, code?: string): void {
    this.send({ success: false, status: 'error', message, code });
    this.res.end();
  }
  end(): void {
    this.res.end();
  }
}
router.get('/resolve-bilibili', async (req: AuthenticatedRequest, res) => {
  const url = req.query.url;
  const userId = req.user?.userId;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少视频链接' });
    return;
  }
  // 提前校验 BV 号，避免进入流式响应后才返回 400
  // 短链接（b23.tv）需要先跟随重定向才能获取 BV 号，跳过提前校验，由 resolveBilibiliVideo 内部处理
  if (!/b23\.tv/i.test(url) && !extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }
  const qn =
    typeof req.query.qn === 'string' && req.query.qn.trim()
      ? Number(req.query.qn.trim())
      : undefined;
  const codec =
    typeof req.query.codec === 'string' && req.query.codec.trim()
      ? req.query.codec.trim()
      : undefined;
  const preferMp4Param = req.query.preferMp4 === 'true' || req.query.preferMp4 === '1';
  const forceDashParam = req.query.forceDash === 'true' || req.query.forceDash === '1';
  const settings = await getSystemSettings();
  const dashDisabled = settings.dashDisabled;
  const preferMp4 = dashDisabled || preferMp4Param;
  const forceDash = !dashDisabled && forceDashParam;
  const page =
    typeof req.query.page === 'string' && req.query.page.trim()
      ? Number(req.query.page.trim())
      : undefined;
  const writer = new NdjsonWriter(res);
  const cookie = (await getUserCookie(userId)) || undefined;
  const resolveStartTime = Date.now();
  console.log(
    `[bilibili] resolve-bilibili start preferMp4=${preferMp4} forceDash=${forceDash} qn=${qn ?? 'auto'} cookie=${!!cookie} url=${url.slice(0, 60)}`,
  );
  try {
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      codec,
      preferMp4,
      forceDash,
      page,
      onProgress: (msg: ResolveProgress) => {
        writer.send({ status: msg.status, step: msg.step, message: msg.message });
      },
    });
    console.log(
      `[bilibili] resolve-bilibili done format=${result.format} qn=${result.currentQn} ${Date.now() - resolveStartTime}ms url=${url.slice(0, 60)}`,
    );
    writer.send({
      success: true,
      status: 'done',
      title: result.title,
      duration: result.duration,
      cid: result.cid,
      videoUrl: result.videoUrl,
      audioUrl: result.audioUrl,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      format: result.format,
      loggedIn: result.loggedIn,
      vipStatus: result.vipStatus,
      currentQn: result.currentQn,
      acceptQuality: result.acceptQuality,
      pages: result.pages,
      currentPage: result.currentPage,
    });
    writer.end();
  } catch (err) {
    console.error('[bilibili] resolve-bilibili error:', err);
    const normalized = normalizeResolveError(err);
    writer.fail(normalized.message, normalized.code);
  }
});
router.get('/bilibili/danmaku', async (req: AuthenticatedRequest, res) => {
  const cid = req.query.cid;
  const bvidRaw = req.query.bvid;
  let effectiveCid: number | undefined;
  if (typeof cid === 'string' && cid.trim()) {
    effectiveCid = Number(cid);
  } else if (typeof bvidRaw === 'string' && bvidRaw.trim()) {
    const bvid = extractBvid(bvidRaw.trim());
    if (!bvid) {
      res.status(400).json({ success: false, message: '无法解析 BV 号' });
      return;
    }
    try {
      const info = await getVideoInfo(bvid);
      if (!info) {
        res.status(500).json({ success: false, message: '获取视频信息失败' });
        return;
      }
      effectiveCid = info.cid;
    } catch (err) {
      console.error('[bilibili] danmaku video info error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '获取 B站 视频信息失败',
      });
      return;
    }
  }
  if (!effectiveCid) {
    res.status(400).json({ success: false, message: '缺少 cid 或 bvid 参数' });
    return;
  }
  try {
    const danmaku = await getDanmaku(effectiveCid);
    res.json({ success: true, danmaku });
  } catch (err) {
    console.error('[bilibili] danmaku fetch error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '解析 B站 弹幕失败',
    });
  }
});
export default router;
