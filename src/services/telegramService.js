import { config } from '../config.js';

export class TelegramError extends Error {
  constructor(method, status, description) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
  }
}

const endpoint = (method) => `${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`;

/**
 * What the Bot API accepts for a poll's self-closing timer, in seconds.
 *
 * `max` was 600 - ten minutes - until Bot API 9.6 (3 April 2026) raised it to
 * 2628000, about thirty days. That change is the whole reason a 24-hour quiz
 * can now be timed by Telegram itself instead of being stopped by a later job.
 *
 * `legacyMax` is kept because TELEGRAM_API_BASE can point at a self-hosted Bot
 * API server, and an older one still refuses anything above it.
 */
export const OPEN_PERIOD = { min: 5, max: 2628000, legacyMax: 600 };

async function callApi(method, payload = {}, { timeoutMs = 30000 } = {}) {
  let response;
  try {
    response = await fetch(endpoint(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(method, 0, err.message);
  }

  const data = await response.json().catch(() => null);
  if (!data?.ok) {
    throw new TelegramError(method, data?.error_code ?? response.status, data?.description ?? 'unknown error');
  }
  return data.result;
}

export function getMe() {
  return callApi('getMe');
}

export function getChat(chatId = config.telegram.channelId) {
  return callApi('getChat', { chat_id: chatId });
}

/**
 * Public chats get a /username link; private ones get the /c/<id> form.
 * Messages inside a forum topic carry the thread id as an extra path segment,
 * so the link opens the topic rather than the General feed.
 */
export function buildMessageLink(chat, messageId, threadId = null) {
  if (!messageId) return null;
  const path = threadId ? `${threadId}/${messageId}` : String(messageId);
  if (chat?.username) return `https://t.me/${chat.username}/${path}`;
  const numeric = String(chat?.id ?? config.telegram.channelId);
  if (numeric.startsWith('-100')) return `https://t.me/c/${numeric.slice(4)}/${path}`;
  return null;
}

/**
 * Posts a native Telegram quiz poll: subscribers tap an option and Telegram
 * itself marks it right or wrong and reveals the explanation.
 *
 * openPeriodSeconds is the quiz timer, and Telegram runs it - the poll shows a
 * countdown and Telegram closes it server-side when it expires, with no later
 * run of ours involved. Anything outside OPEN_PERIOD means "no timer".
 *
 * isAnonymous false is what puts the "N voted" line with the tappable voter
 * list on the poll. Groups and supergroups allow it; channels do not, so a
 * refusal is retried anonymously rather than costing the day's post.
 *
 * messageThreadId targets one forum topic ("Aptitude", "DSA", ...) inside a
 * forum supergroup. Leave it null to post to General, which is the only place
 * a plain broadcast channel can receive.
 */
export async function sendQuizPoll({
  chatId = config.telegram.channelId,
  messageThreadId = config.telegram.topicThreadId,
  question,
  options,
  correctIndex,
  explanation,
  openPeriodSeconds = config.quiz.openPeriodSeconds,
  isAnonymous = config.quiz.anonymous,
}) {
  const payload = {
    chat_id: chatId,
    question,
    options: options.map((text) => ({ text })),
    type: 'quiz',
    correct_option_id: correctIndex,
    is_anonymous: isAnonymous,
  };

  if (messageThreadId) payload.message_thread_id = messageThreadId;
  if (explanation) payload.explanation = explanation;
  if (openPeriodSeconds >= OPEN_PERIOD.min && openPeriodSeconds <= OPEN_PERIOD.max)
    payload.open_period = openPeriodSeconds;

  // Telegram gives no machine-readable reason for a rejected poll, so rather
  // than matching on its wording, each optional extra is given up in turn on a
  // 400 until one is accepted. A refused extra must never cost the day's
  // question - and the order matters: the timer is the point of a timed quiz,
  // so a channel refusing visible votes must not quietly take the countdown
  // with it. Any other 400 fails the same way at every step and surfaces
  // unchanged from the last one.
  const { open_period: period, ...untimed } = payload;
  // Only a Bot API server older than 9.6 refuses a period this long.
  const periodAtRisk = period > OPEN_PERIOD.legacyMax;

  const attempts = [{ label: 'as configured', payload }];
  if (!isAnonymous) attempts.push({ label: 'anonymously', payload: { ...payload, is_anonymous: true } });
  if (periodAtRisk) {
    attempts.push({ label: `without the ${period}s timer`, payload: untimed });
    if (!isAnonymous)
      attempts.push({
        label: 'anonymously and without the timer',
        payload: { ...untimed, is_anonymous: true },
      });
  }

  for (const [i, attempt] of attempts.entries()) {
    try {
      return await callApi('sendPoll', attempt.payload);
    } catch (err) {
      const next = attempts[i + 1];
      if (!next || !(err instanceof TelegramError) || err.status !== 400) throw err;
      console.warn(`[telegram] sendPoll ${attempt.label} refused (${err.description}); retrying ${next.label}`);
    }
  }
}

/** Closes a poll early. Errors if it is already closed or the message is gone. */
export function stopPoll({ chatId = config.telegram.channelId, messageId }) {
  return callApi('stopPoll', { chat_id: chatId, message_id: messageId });
}

export function sendMessage({
  chatId = config.telegram.channelId,
  messageThreadId = config.telegram.topicThreadId,
  text,
}) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  return callApi('sendMessage', payload);
}

/**
 * Verifies the bot can actually post before we spend a Gemini call finding out.
 * @returns {Promise<{bot: object, chat: object}>}
 */
export async function verifyChannelAccess() {
  const bot = await getMe();
  const chat = await getChat();
  return { bot, chat };
}


/** Long-poll updates for private/group practice commands. */
export function getUpdates({ offset, timeout = 25 } = {}) {
  return callApi('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 10) * 1000 });
}

export function sendInteractiveMessage({ chatId, text, replyMarkup }) {
  return callApi('sendMessage', { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

export function answerCallbackQuery({ callbackQueryId, text }) {
  return callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export function editInteractiveMessage({ chatId, messageId, text, replyMarkup }) {
  return callApi('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
