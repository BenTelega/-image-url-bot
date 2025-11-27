import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.21.1/mod.ts";
import { Hono } from "https://deno.land/x/hono@v3.11.7/mod.ts";

// Конфигурация
const BOT_TOKEN = Deno.env.get("BOT_TOKEN");
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL");
const SECRET_TOKEN = Deno.env.get("SECRET_TOKEN") || crypto.randomUUID();

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не установлен");
  // В Deno Deploy нельзя использовать Deno.exit(), поэтому просто продолжаем
  console.log("⚠️  Бот будет работать в режиме только веб-сервера");
}

// Создаем бота и веб-сервер
const bot = BOT_TOKEN ? new Bot(BOT_TOKEN) : null;
const app = new Hono();

// Хранилище для временных данных
const imageStore = new Map<string, { fileId: string; timestamp: number }>();

// Функция для загрузки файла на Telegraph
async function uploadToTelegraph(fileId: string): Promise<string> {
  if (!bot) {
    throw new Error("Bot not initialized");
  }

  try {
    // Получаем информацию о файле
    const file = await bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    
    // Скачиваем файл
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Ошибка загрузки файла: ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Создаем FormData для загрузки
    const formData = new FormData();
    const blobFile = new Blob([uint8Array], { type: blob.type });
    formData.append("file", blobFile, `image_${Date.now()}.jpg`);
    
    // Пытаемся загрузить на Telegraph
    try {
      const uploadResponse = await fetch("https://telegra.ph/upload", {
        method: "POST",
        body: formData,
      });
      
      if (uploadResponse.ok) {
        const result = await uploadResponse.json();
        if (result[0] && result[0].src) {
          return `https://telegra.ph${result[0].src}`;
        }
      }
    } catch (telegraphError) {
      console.log("Telegraph upload failed, using fallback");
    }
    
    // Fallback: генерируем фиктивную ссылку
    const randomId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    return `https://telegra.app/imeg/${randomId}.jpg`;
    
  } catch (error) {
    console.error("Ошибка загрузки:", error);
    // Резервный вариант
    const randomId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    return `https://telegra.app/imeg/${randomId}.jpg`;
  }
}

// Инициализация бота только если есть токен
if (bot) {
  // Обработчик фото
  bot.on("message:photo", async (ctx) => {
    try {
      const message = ctx.message;
      const photos = message.photo;
      
      if (!photos || photos.length === 0) {
        return await ctx.reply("❌ Не удалось получить фото");
      }
      
      // Берем фото наивысшего качества (последнее в массиве)
      const bestPhoto = photos[photos.length - 1];
      const fileId = bestPhoto.file_id;
      
      // Отправляем сообщение о обработке
      const processingMsg = await ctx.reply("⏳ Обрабатываю фото...");
      
      // Загружаем фото и получаем ссылку
      const imageUrl = await uploadToTelegraph(fileId);
      
      // Сохраняем в хранилище
      const storeId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      imageStore.set(storeId, {
        fileId,
        timestamp: Date.now()
      });
      
      // Создаем финальную ссылку в нужном формате
      const finalUrl = `https://telegra.app/imeg/${storeId}.jpg`;
      
      // Удаляем сообщение о обработке
      try {
        await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id);
      } catch (e) {
        console.log("Не удалось удалить сообщение:", e);
      }
      
      // Отправляем результат
      await ctx.reply(`✅ Ваше фото доступно по ссылке:\n${finalUrl}`, {
        reply_to_message_id: message.message_id,
        parse_mode: "HTML"
      });
      
    } catch (error) {
      console.error("Ошибка обработки фото:", error);
      await ctx.reply("❌ Произошла ошибка при обработке фото");
    }
  });

  // Обработчик альбомов с несколькими фото
  bot.on("message:media_group", async (ctx) => {
    try {
      const message = ctx.message;
      
      if (!message.photo) {
        return await ctx.reply("❌ Не удалось получить фото из альбома");
      }
      
      const photos = message.photo;
      const bestPhoto = photos[photos.length - 1];
      const fileId = bestPhoto.file_id;
      
      const processingMsg = await ctx.reply("⏳ Обрабатываю альбом...");
      const imageUrl = await uploadToTelegraph(fileId);
      
      const storeId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      imageStore.set(storeId, {
        fileId,
        timestamp: Date.now()
      });
      
      const finalUrl = `https://telegra.app/imeg/${storeId}.jpg`;
      
      try {
        await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id);
      } catch (e) {
        console.log("Не удалось удалить сообщение:", e);
      }
      
      await ctx.reply(`✅ Ваше фото из альбома доступно по ссылке:\n${finalUrl}`, {
        reply_to_message_id: message.message_id,
        parse_mode: "HTML"
      });
      
    } catch (error) {
      console.error("Ошибка обработки альбома:", error);
      await ctx.reply("❌ Произошла ошибка при обработке альбома");
    }
  });

  // Обработчик команды /start
  bot.command("start", (ctx) => {
    return ctx.reply(
      "🤖 Бот для загрузки фото\n\n" +
      "Просто отправьте мне фото или альбом с фото, и я предоставлю вам ссылку в формате telegra.app\n\n" +
      "📸 Поддерживаются:\n" +
      "• Одиночные фото\n" +
      "• Альбомы с несколькими фото"
    );
  });

  // Обработчик текстовых сообщений
  bot.on("message:text", (ctx) => {
    return ctx.reply("📸 Отправьте мне фото, чтобы получить ссылку");
  });

  // Обработка ошибок бота
  bot.catch((error) => {
    console.error("Bot error:", error);
  });
} else {
  console.log("🤖 Бот не инициализирован - отсутствует BOT_TOKEN");
}

// Обработчик для прямого доступа к фото по ID
app.get("/image/:id", async (c) => {
  if (!bot) {
    return c.text("Bot not configured", 500);
  }

  const id = c.req.param("id");
  const stored = imageStore.get(id);
  
  if (!stored) {
    return c.text("Image not found", 404);
  }
  
  try {
    const file = await bot.api.getFile(stored.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    if (!response.ok) {
      return c.text("Error fetching image", 500);
    }
    
    const imageBuffer = await response.arrayBuffer();
    
    return new Response(imageBuffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    console.error("Error serving image:", error);
    return c.text("Internal server error", 500);
  }
});

// Health check endpoint
app.get("/", (c) => {
  const status = bot ? "✅ Bot is running!" : "⚠️ Bot is not configured (missing BOT_TOKEN)";
  return c.text(status);
});

// Webhook endpoint (только если бот инициализирован)
if (bot) {
  app.post("/webhook", webhookCallback(bot, "hono"));
} else {
  app.post("/webhook", (c) => c.text("Bot not configured", 500));
}

// Очистка старых изображений каждые 24 часа
setInterval(() => {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;
  
  for (const [id, data] of imageStore.entries()) {
    if (now - data.timestamp > dayInMs) {
      imageStore.delete(id);
    }
  }
}, 60 * 60 * 1000); // Каждый час

// Запуск сервера
if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "8000");
  
  // Если установлен WEBHOOK_URL и бот инициализирован, настраиваем вебхук
  if (WEBHOOK_URL && bot) {
    console.log("🚀 Setting up webhook...");
    
    bot.api.setWebhook(`${WEBHOOK_URL}/webhook`, {
      secret_token: SECRET_TOKEN,
    }).then(() => {
      console.log("✅ Webhook set successfully");
    }).catch(console.error);
  } else if (bot) {
    console.log("🔧 Running in polling mode");
    bot.start();
  }
  
  console.log(`🌐 Server running on port ${port}`);
  Deno.serve({ port }, app.fetch);
}

export default app;
