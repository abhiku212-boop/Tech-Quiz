import 'dotenv/config';

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

const list = (value, fallback) => {
  if (!value) return fallback;
  const parsed = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
};

/** A forum topic id is a positive integer; anything else means "no topic". */
export const threadId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Interview syllabus used by scheduled channel quizzes and interactive practice. */
export const DEFAULT_TOPICS = [
  'JavaScript fundamentals',
  'JavaScript output questions',
  'JavaScript closures and scope',
  'JavaScript promises and event loop',
  'React hooks and rendering',
  'React state and props',
  'React output questions',
  'Node.js event loop and modules',
  'Node.js asynchronous programming',
  'Express.js routing and middleware',
  'Express.js error handling and REST APIs',
  'MongoDB and Mongoose',
  'MERN stack authentication and JWT',
  'MERN stack API integration',
  'MERN stack debugging scenarios',
];

export const INTERVIEW_TOPICS = {
  javascript: ['JavaScript fundamentals', 'JavaScript output questions', 'JavaScript closures and scope', 'JavaScript promises and event loop'],
  react: ['React hooks and rendering', 'React state and props', 'React output questions'],
  node: ['Node.js event loop and modules', 'Node.js asynchronous programming'],
  express: ['Express.js routing and middleware', 'Express.js error handling and REST APIs'],
  mern: ['MongoDB and Mongoose', 'MERN stack authentication and JWT', 'MERN stack API integration', 'MERN stack debugging scenarios'],
};

export const config = {
  mongoUri: process.env.MONGODB_URI || '',

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    temperature: Number(process.env.GEMINI_TEMPERATURE ?? 0.9),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    // Forum topic (message thread) to post into. Only forum supergroups have
    // these; null means the General topic, which is also what plain channels get.
    topicThreadId: threadId(process.env.TELEGRAM_TOPIC_ID),
    apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  },

  quiz: {
    topics: list(process.env.QUIZ_TOPICS, DEFAULT_TOPICS),
    difficulty: process.env.QUIZ_DIFFICULTY || 'mixed',
    // How long the quiz stays open, counted by Telegram from the moment it is
    // posted. Telegram shows the countdown and closes the poll itself when it
    // runs out, so this needs nothing running afterwards. The Bot API accepts
    // 5-2628000 seconds (see OPEN_PERIOD); 0 means no timer.
    openPeriodSeconds: int(process.env.QUIZ_OPEN_PERIOD, 24 * 60 * 60),
    // Safety net only, and off by default: stops any poll still open this many
    // hours after posting, on the next run. Telegram's timer above is what
    // actually ends a quiz. 0 = never.
    closeAfterHours: int(process.env.QUIZ_CLOSE_AFTER_HOURS, 0),
    // false shows "N voted" with a tappable voter list. Channels force true.
    anonymous: bool(process.env.QUIZ_ANONYMOUS, false),
    maxGenerationAttempts: int(process.env.QUIZ_MAX_ATTEMPTS, 4),
    // Keep a rolling history of posted questions to reduce repeats. Older rows are pruned away.
    historyLimit: int(process.env.QUIZ_HISTORY_LIMIT, 20),
    // Refuse a second post inside this window (hours). 0 disables the guard.
    minGapHours: int(process.env.QUIZ_MIN_GAP_HOURS, 20),
  },
};

const REQUIRED = [
  ['MONGODB_URI', config.mongoUri],
  ['TELEGRAM_BOT_TOKEN', config.telegram.botToken],
  ['TELEGRAM_CHANNEL_ID', config.telegram.channelId],
];

/** @returns {string[]} names of env vars that must be set before anything can run */
export function missingConfig() {
  return REQUIRED.filter(([, value]) => !value).map(([name]) => name);
}

export function assertConfig() {
  const missing = missingConfig();
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy server/.env.example to server/.env and fill them in.',
    );
  }
}
