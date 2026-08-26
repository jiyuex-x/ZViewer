import type { ResolvedSource } from './types'

const BV_REGEX = /BV[0-9A-Za-z]{10}/

/**
 * 从任意文本中提取第一个 URL。
 *
 * B站客户端分享出来的链接通常带文字前缀，例如：
 *   【三年前的小众沙雕游戏隐藏关卡被我发现并通关了！-哔哩哔哩】 https://b23.tv/E4e4f8S
 *
 * 此函数用正则匹配 http/https 开头的 URL，提取纯链接部分。
 * 若文本中不含 URL，返回原字符串（由后续逻辑判断是否为纯 BV 号）。
 */
export function extractUrlFromText(input: string): string {
  if (!input) return input
  const match = input.match(/https?:\/\/[^\s【】\[\]（）()"'<>]+/i)
  return match ? match[0] : input.trim()
}

/**
 * 从 B站 完整 URL 或 BV 号字符串中提取 BV 号。
 */
export function extractBvid(url: string): string | null {
  if (!url) return null
  const match = url.match(BV_REGEX)
  return match ? match[0] : null
}

/**
 * 将任意 URL 包装为 CLI 本地代理 URL。
 * CLI 代理会注入正确的 Referer/Origin/User-Agent 头，绕过 B站 CDN 防盗链。
 *
 * 若 targetUrl 本身已是该 CLI 代理地址，则直接返回避免双重包装。
 */
export function buildCliProxyUrl(proxyUrl: string, targetUrl: string): string {