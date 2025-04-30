/**
 * This plugin is based on/inspired by koishi-plugin-pictures-time by Alin-sky.
 * Licensed under the MIT License.
 *
 * The original MIT license text is included in the LICENSE file.
 *
 * Modifications and additional code Copyright (c) yi03
 * Also licensed under the MIT License.
 */

import { Context, Schema, Logger, h } from 'koishi';
import fs from 'fs';
import path from 'path';

// --- 插件元信息 ---
export const name = 'pictime';

export const usage = '## 使用指令“pictime”或“图图time”来记录指令调用者发的图图\n' +
  "### 启用后发送“over”或“停止”来终止记录图图\n" +
  "安装后即可启用，路径缺省时将会在data文件夹内新建image-time文件夹来存储";

// --- 配置定义 ---
export interface Config {
  paths: string;
}

export const Config: Schema<Config> = Schema.object({
  paths: Schema.string()
    .description('存储路径（相对于 Koishi 根目录下的 data 文件夹）')
    .default('image-time'), // 默认存储在 data/image-time
});

// --- ★★★ 依赖声明 ★★★ ---
export const inject = ['database', 'http']; // 声明依赖 database 和 http 服务

// --- 日志记录器 ---
const log1 = "pictime";
const logger: Logger = new Logger(log1);

// --- 数据库表定义 ---
declare module 'koishi' {
  interface Tables {
    pictime: Pictime;
  }
}

export interface Pictime {
  id: number;     // 用户 ID (主键)
  uname: string;  // 用户名
  guildid: number;// 群 ID
  sum: number;    // 累计发图数量
}

// --- 主逻辑 ---
export async function apply(ctx: Context, config: Config) {

  // --- 路径设置 ---
  const dataDir = path.join(ctx.baseDir, 'data');
  const saveBaseDir = path.resolve(dataDir, config.paths); // 解析为绝对路径

  // --- 数据库模型扩展 ---
  ctx.model.extend('pictime', {
    id: 'unsigned',
    uname: 'string',
    guildid: 'unsigned',
    sum: 'unsigned'
  }, {
    primary: 'id' // 明确 id 为主键
  });

  // --- 辅助函数 ---
  async function loadImageFromUrl(url: string): Promise<Buffer> { // 返回类型是 Buffer，没问题
    try {
      // 使用注入的 http 服务获取 ArrayBuffer
      const responseArrayBuffer = await ctx.http.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 20000 // 设置 20 秒超时
      });
      // ★★★ 将 ArrayBuffer 转换为 Buffer ★★★
      return Buffer.from(responseArrayBuffer);
    } catch (error) {
      logger.error(`[Helper] Failed to load image from URL: ${url}`, error);
      throw new Error(`Failed to download image: ${error.message}`);
    }
  }

  function createDir(dirPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.mkdir(dirPath, { recursive: true }, (err) => {
        if (err && err.code !== 'EEXIST') { // 如果错误不是"目录已存在"
          logger.error(`[Helper] Failed to create directory: ${dirPath}`, err);
          reject(err);
        } else {
          if (!err) logger.debug(`[Helper] Directory confirmed/created: ${dirPath}`); // 改为 debug 级别
          resolve();
        }
      });
    });
  }

  // 修改 saveImage 接受 URL 和可选的原始文件名
  async function saveImage(imageUrl: string, imageFileName: string | undefined, savePath: string): Promise<void> {
    // 如果没有提供文件名，生成一个基于时间戳的
    let fileName = imageFileName || `image_${Date.now()}`;
    // 清理文件名并确保有 .png 后缀 (简化处理，未做mime检查)
    fileName = fileName.replace(/[<>:"/\\|?*]+/g, '_').replace(/\.[^/.]+$/, "") + '.png';

    try {
      await createDir(savePath); // 确保目标目录存在
      const imageBuffer = await loadImageFromUrl(imageUrl); // 下载图片
      if (imageBuffer.byteLength === 0) {
        throw new Error("Downloaded image data is empty.");
      }
      const filePath = path.join(savePath, fileName);
      fs.writeFileSync(filePath, imageBuffer); // 写入文件
    } catch (error) {
      // 捕获 loadImageFromUrl 或 writeFileSync 的错误
      logger.error(`[Helper] Failed to save image from URL ${imageUrl} to ${savePath}`, error);
      throw error; // 将错误向上抛出，以便中间件能捕获
    }
  }

  // --- 状态管理 ---
  // key: userId, value: { count: number, errors: number, dispose: Function }
  const recordingUsers = new Map<number, { count: number, errors: number, dispose: () => void }>();

  // --- 插件启动时创建根目录 ---
  try {
    await createDir(saveBaseDir);
  } catch (error) {
    logger.error(`无法初始化图片存储根目录: ${saveBaseDir}`, error);
    // 可以考虑阻止插件加载
  }

  // --- 指令: pictime ---
  ctx.command('pictime', '图图时间')
    .alias('图图time')
    .action(async ({ session }) => {
      const userId = Number(session.userId);
      const guildId = Number(session.guildId);
      const userName = session.author?.name || session.author?.nickname || String(userId);

      if (!guildId) return '请在群聊中使用此功能。';
      if (!userId) return '无法获取用户信息。';

      if (recordingUsers.has(userId)) {
        return h('at', { id: userId }) + ' 你已经在记录图图了，发送 "over" 或 "停止" 来结束。';
      }

      session.send(h('at', { id: userId }) + ' 开始记录啦，请发送图片。说 "over"或 "停止" 来结束。');

      const userState = { count: 0, errors: 0, dispose: () => { } };

      // --- 核心中间件逻辑 ---
      const dispose = ctx.middleware(async (middlewareSession, next) => {
        // 1. 检查是否是目标用户的消息
        if (String(middlewareSession.userId) !== String(userId)) {
          return next(); // 不是，交给下一个中间件
        }

        // 是目标用户的消息
        const content = middlewareSession.content;

        // 2. 尝试用 h.select 提取 img 元素
        const imageElements = h.select(content, 'img');
        const isOverCommand = ['over', '停止'].includes(content?.trim() || '');


        // 3. 处理图片消息 (使用 h.select)
        if (imageElements.length > 0) {
          let imagesProcessedInThisMessage = 0;
          let errorsInThisMessage = 0;

          // 遍历找到的所有图片元素
          for (const element of imageElements) {
            const imageUrlRaw = element.attrs.src;
            const imageFileRaw = element.attrs.file; // 获取原始文件名

            if (!imageUrlRaw) {
              logger.warn(`[Pictime Middleware] User ${userId} - Found <img> tag without 'src' attribute.`);
              errorsInThisMessage++;
              continue; // 跳过这个无效元素
            }

            const imageUrl = imageUrlRaw.replace(/&/g, '&'); // 解码 URL 中的 &
            const imageFileName = imageFileRaw; // 直接使用原始文件名，可能为 undefined


            try {
              // 构建保存路径：根目录/群号/用户ID
              const userGuildPath = path.join(saveBaseDir, String(guildId), String(userId));
              await saveImage(imageUrl, imageFileName, userGuildPath); // 调用 saveImage
              imagesProcessedInThisMessage++; // 成功计数
            } catch (error) {
              errorsInThisMessage++; // 失败计数
              // 错误已在 saveImage 中记录，这里可以只记录上下文
              logger.error(`[Pictime Middleware] User ${userId} - Failed processing image (${imageUrl}) in message.`);
            }
          }

          // 更新本次会话的总状态
          userState.count += imagesProcessedInThisMessage;
          userState.errors += errorsInThisMessage;

          // 图片消息处理完成，继续传递给下一个中间件（如果有的话）
          return next();

          // 4. 处理结束命令
        } else if (isOverCommand) {

          // 清理中间件和状态
          const state = recordingUsers.get(userId);
          if (state) {
            state.dispose(); // 调用 dispose 函数移除中间件监听
            recordingUsers.delete(userId); // 从 Map 中移除记录
          }

          // 如果本次没有发送任何图片（成功或失败都没有）
          if (userState.count === 0 && userState.errors === 0) {
            logger.warn(`[Pictime Middleware] User ${userId} ended with count=0 and errors=0.`);
            return h('at', { id: userId }) + ' 你本次没有发送图片。';
          }

          // 保存到数据库
          try {
            // 使用已注入的 ctx.database
            const existingData = await ctx.database.get('pictime', { id: userId });
            const previousSum = existingData.length > 0 ? existingData[0].sum : 0;
            // 只累加本次成功保存的数量
            const newTotalSum = previousSum + userState.count;

            await ctx.database.upsert('pictime', [{
              id: userId,
              uname: userName, // 更新用户名
              guildid: guildId,
              sum: newTotalSum // 保存新的总数
            }], ['id']); // 使用 id 作为 upsert 的键


            // 构建并返回最终结果消息
            let resultMessage = `记录结束！\n本次成功保存 ${userState.count} 张图图。\n`;
            if (userState.errors > 0) {
              resultMessage += `${userState.errors} 张图图处理出错。\n`;
            }
            resultMessage += `你一共发过 ${newTotalSum} 张图图！`;
            return h('at', { id: userId }) + ' ' + resultMessage; // 返回最终消息

          } catch (dbError) {
            logger.error(`[Pictime Middleware] Database operation failed for user ${userId}:`, dbError);
            return h('at', { id: userId }) + ' 记录结束，但保存数据时遇到错误。';
          }

          // 5. 其他消息 (非图片，非结束命令)
        } else {
          logger.debug(`[Pictime Middleware] User ${userId} - Not an image or 'over' command. Passing to next.`);
          return next(); // 交给其他中间件处理
        }
      }, true); // true 表示前置中间件，优先处理

      // 存储状态和 dispose 函数，以便结束时移除中间件
      userState.dispose = dispose;
      recordingUsers.set(userId, userState);

    }); // pictime 命令定义结束

  // --- 指令: pictime.rankings ---
  ctx.command('pictime.rankings', '查看本群发图排行榜')
    .alias('图图排行')
    .action(async ({ session }) => {
      const currentGuildId = Number(session.guildId);
      if (!currentGuildId) {
        return '请在群聊中使用此功能查看排名。';
      }

      try {
        // 使用已注入的 ctx.database
        const data = await ctx.database.get('pictime', { guildid: currentGuildId }, {
          sort: { sum: 'desc' }, // 按 sum 降序排序
          limit: 10 // 最多显示前 10 名
        });

        if (!data || data.length === 0) {
          return '呜呜，本群还没有人发过图图记录。';
        }

        // 构建排名消息
        let messages = [`本群发图数量排名 (Top ${data.length})：\n`];
        data.forEach((userRecord, index) => {
          // 尝试提及用户，如果失败则只显示名字
          const mention = h('at', { id: userRecord.id, name: userRecord.uname });
          messages.push(`第 ${index + 1} 名: ${mention} (${userRecord.uname})\n🖼️ 发图：${userRecord.sum} 张`);
        });

        return messages.join('\n\n'); // 使用两个换行符分隔排名条目，更清晰

      } catch (dbError) {
        logger.error(`[Rankings Command] Failed to fetch rankings for guild ${currentGuildId}`, dbError);
        return '查询排名时出错，请稍后再试。';
      }
    }); // pictime.rankings 命令定义结束

} // apply 函数结束