/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov/mkv）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * Chrome 91+ 支持 MKV 容器（需 H.264/AAC 编码）。
 *
 * 代理策略由 url-proxy.ts 统一控制（分离式架构）：
 * - B站 DASH m4s / 带防盗链 headers 的源走服务器代理
 * - 其他源（B站 MP4 直连 / webdav / ftp / 用户直链）直连，不回退代理
 *
 * attach 在 metadata 就绪后 resolve，cleanup 无需额外操作
 * （video 元素本身由调用方管理）。
 *
 * 对于转码流（fragmented MP4），video.duration 可能为 Infinity。
 * 引擎会先发 HEAD 请求获取 X-Content-Duration header，
 * 并存储到 video.dataset.serverDuration 供 useVideoDuration 回退使用。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement } from '../utils'
import { resolveProxyUrl } from '../services/url-proxy'
/**
 * 等待 video metadata 就绪或 error 事件，支持超时。
 *
 * 与 utils.waitForMetadata 不同，本函数同时监听 error 事件，
 * 加载失败时 reject 而非永久 pending。
 *
 * 超时机制：部分视频加载失败时（如防盗链 403、CORS 限制）不会触发 error 事件，
 * 只是静默黑屏/卡住，导致永久 pending。设置超时后，超时也视为失败，
 * 直接报错（不回退代理）。
 *
 * @param video video 元素
 * @param timeoutMs 超时毫秒数，默认 6000（6 秒）。传 0 或负数表示不超时。
 */
function waitForMetadataOrError(video: HTMLVideoElement, timeoutMs = 6000): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      if (timeoutId) clearTimeout(timeoutId)
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      const code = video.error?.code
      reject(new Error(`video load error (code=${code ?? 'unknown'})`))
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error(`video load timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    }
  })
}
export const directEngine: PlayerEngine = {
  type: 'direct',
  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式决定
    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)
    // 先发 HEAD 请求尝试获取 X-Content-Duration（转码流场景）。
    // HEAD 与正式加载并行执行且带 5s 超时：慢代理/挂起的 HEAD 不推迟首帧，
    // 失败或超时静默跳过（转码流时长回退由 X-Content-Duration header 探测路径兜底）。
    // 相对路径直接使用（浏览器用当前页面 origin 解析，同域请求携带 cookie）
    const headPromise = (async () => {
      try {
        const headRes = await fetch(targetUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        })
        const contentDuration = headRes.headers.get('X-Content-Duration')
        if (contentDuration) {
          const d = parseFloat(contentDuration)
          if (Number.isFinite(d) && d > 0) {
            video.dataset.serverDuration = d.toString()
          }
        }
      } catch {
        // HEAD 请求失败（CORS 限制 / 超时），静默跳过
      }
    })()
    // 直连模式：不回退代理，失败直接报错（B站 MP4 必须直连，不耗服务器流量）
    // 超时设为 15 秒，给网络较慢的视频足够加载时间
    const loadOnce = async (url: string, timeoutMs: number): Promise<void> => {
      video.src = url
      video.load()
      await waitForMetadataOrError(video, timeoutMs)
    }

    await loadOnce(targetUrl, 15000)
    // 等待 HEAD 结算（超时上限 5s，不显著阻塞；结果仅写 dataset）
    await headPromise

    return {
      cleanup: () => {
        delete video.dataset.serverDuration
      },
    }
  },
}
