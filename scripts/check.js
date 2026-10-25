/**
 * Confirms the setup without spending a Gemini call or posting anything:
 * the bot token works, the bot can see the chat, and the configured forum
 * topic makes sense for that chat.
 *
 *   node scripts/check.js
 */
import { assertConfig, config } from '../src/config.js';
import { OPEN_PERIOD, verifyChannelAccess } from '../src/services/telegramService.js';

/** 86400 -> "24h", 5400 -> "1h 30m", 600 -> "10m". */
function duration(seconds) {
  const parts = [
    [Math.floor(seconds / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
    [seconds % 60, 's'],
  ].filter(([value]) => value > 0);
  return parts.map(([value, unit]) => `${value}${unit}`).join(' ');
}

try {
  assertConfig();

  const { bot, chat } = await verifyChannelAccess();
  const thread = config.telegram.topicThreadId;

  const { anonymous, openPeriodSeconds, closeAfterHours } = config.quiz;
  const timed = openPeriodSeconds >= OPEN_PERIOD.min && openPeriodSeconds <= OPEN_PERIOD.max;

  console.log(`bot     @${bot.username}`);
  console.log(`chat    ${chat.title} (${chat.type}${chat.is_forum ? ', forum' : ''})`);
  console.log(`topic   ${thread ?? 'General'}`);
  console.log(`votes   ${anonymous ? 'anonymous' : 'visible'}`);
  console.log(`timer   ${timed ? `${duration(openPeriodSeconds)}, counted down by Telegram` : 'none - stays open'}`);
  if (closeAfterHours > 0) console.log(`backstop stops anything still open after ${closeAfterHours}h`);

  // A value like 86400000 would otherwise be silently dropped, and the quiz
  // would go out with no timer at all.
  if (openPeriodSeconds !== 0 && !timed)
    console.warn(
      `\nWarning: QUIZ_OPEN_PERIOD=${openPeriodSeconds} is outside Telegram's ` +
        `${OPEN_PERIOD.min}-${OPEN_PERIOD.max}s range, so the quiz will have no timer.`,
    );

  if (!anonymous && chat.type === 'channel')
    console.warn('\nWarning: channels only allow anonymous polls - the post will fall back to anonymous.');

  if (thread && !chat.is_forum)
    console.warn('\nWarning: TELEGRAM_TOPIC_ID is set but this chat has no topics - posts land in the main feed.');

  // The Bot API cannot list a forum's topics, so an id can only be proven by
  // posting. Say so rather than implying this check validated it.
  if (thread && chat.is_forum)
    console.log('\nNote: Telegram offers no way to verify a topic id without posting.');
} catch (err) {
  console.error(`Failed: ${err.message}`);
  // Not process.exit(): forcing exit while fetch's keep-alive socket is still
  // closing trips a libuv assertion and reports failure after a good run.
  process.exitCode = 1;
}
