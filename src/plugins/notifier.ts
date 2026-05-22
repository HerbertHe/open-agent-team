import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { PluginRegistry } from "./registry";
import { loadOatConfig } from "../utils/oat-config";
import { logger } from "../utils/logger";
import type { OutboundContext } from "./types";

/**
 * 获取特定渠道和账号的 Session 缓存物理路径
 */
export function getSessionPath(channelId: string, accountId: string): string {
  const cleanChannelId = channelId.replace(/^openclaw-/, "");
  return path.join(os.homedir(), ".oat", "sessions", `${cleanChannelId}_${accountId}.json`);
}

/**
 * 统一通知推送引擎
 */
export class Notifier {
  /**
   * 推送单向通知消息，具备极强容错，错误时仅记录 Warning，绝不阻塞主流程
   */
  public static async sendNotification(params: {
    channel: string;
    account: string;
    text: string;
    media?: {
      type: "image" | "file";
      path: string;
      filename?: string;
    };
    metadata?: Record<string, any>;
  }): Promise<{ ok: boolean; messageId?: string } | null> {
    const { channel, account, text, media, metadata } = params;
    
    // 兼容 friendly 别名，例如 weixin -> openclaw-weixin
    const channelId = channel === "weixin" ? "openclaw-weixin" : channel;
    const channelPlugin = PluginRegistry.getChannel(channelId);
    
    if (!channelPlugin) {
      logger.warn(`Push skipped: Channel plugin '${channelId}' is not loaded/registered.`);
      return null;
    }

    try {
      // 1. 获取全局配置
      const globalConfig = await loadOatConfig();
      const channelConfig = globalConfig.channels?.[channelId];
      const accountConfig = channelConfig?.accounts?.[account];

      if (!accountConfig) {
        logger.warn(`Push skipped: Account '${account}' credentials not found for channel '${channelId}' in oat.json.`);
        return null;
      }

      // 2. 有状态渠道（如微信）在此阶段尝试静默/免扫码登录
      if (typeof channelPlugin.login === "function") {
        const sessionCachePath = getSessionPath(channelId, account);
        const sessionDir = path.dirname(sessionCachePath);
        await fs.mkdir(sessionDir, { recursive: true });
        
        try {
          await channelPlugin.login({
            config: accountConfig,
            sessionCachePath
          });
        } catch (loginErr: any) {
          logger.warn(`Channel '${channelId}' login failed for account '${account}': ${loginErr.message}`);
          // 尽力而为，尝试继续发送，或者直接捕获
        }
      }

      // 3. 构造发送 Payload 上下文
      const context: OutboundContext = {
        config: accountConfig,
        text,
        media,
        metadata
      };

      const outbound = channelPlugin.outbound;
      if (!outbound) {
        logger.warn(`Channel '${channelId}' does not support outbound operations.`);
        return null;
      }

      // 4. 根据媒体类型投递，如无对应接口，自动平滑退化至 sendText 文本发送
      let result: { ok: boolean; messageId?: string };

      if (media?.type === "image" && typeof outbound.sendImage === "function") {
        result = await outbound.sendImage(context);
      } else if (media?.type === "file" && typeof outbound.sendFile === "function") {
        result = await outbound.sendFile(context);
      } else {
        // 富媒体降级发送
        let textPayload = text;
        if (media) {
          textPayload = `${text}\n[Attached ${media.type}: ${media.filename || path.basename(media.path)}]`;
        }
        result = await outbound.sendText({
          ...context,
          text: textPayload
        });
      }

      logger.info(`Notification sent successfully via '${channelId}' (${account}).`);
      return result;
    } catch (err: any) {
      logger.warn(`[Best-effort Push Warning ⚠️] Failed to send notification via '${channelId}' (${account}): ${err.message}`);
      return null;
    }
  }
}
