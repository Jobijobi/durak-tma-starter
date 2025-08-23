import 'dotenv/config';
import { Telegraf } from 'telegraf';

const { BOT_TOKEN, WEBAPP_URL } = process.env;
if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('Set BOT_TOKEN and WEBAPP_URL in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Добавляем обход баннера + анти-кеш
function withBypass(url) {
  const u = new URL(url);
  u.searchParams.set('ngrok-skip-browser-warning', '1');
  u.searchParams.set('t', String(Date.now())); // каждая кнопка со свежим URL
  return u.toString();
}

bot.start((ctx) => {
  const url = withBypass(WEBAPP_URL);
  return ctx.reply('Открой игру:', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть «Дурак»', web_app: { url } }]]
    }
  });
});

bot.command('play', (ctx) => {
  const url = withBypass(WEBAPP_URL);
  return ctx.reply('Открой игру:', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть «Дурак»', web_app: { url } }]]
    }
  });
});

bot.launch();
