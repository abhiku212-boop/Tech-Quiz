import crypto from 'node:crypto';
import { config } from '../config.js';
import { Quiz } from '../models/Quiz.js';
import { chooseQuestion, QUESTION_BANK } from './questionBank.js';
import { generateQuiz } from './geminiService.js';
import { buildMessageLink, getChat, sendQuizPoll, stopPoll } from './telegramService.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Strips everything that can differ between two versions of the same question -
 * spacing, punctuation, capitalisation - so a reworded repeat still collides.
 */
export function fingerprintQuestion(question) {
  const normalised = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/**
 * Least-recently-used topic rotation, jittered across the three coldest topics
 * so the channel does not follow an obvious repeating cycle.
 *
 * Only the retained history is visible here, so any topic that has fallen out
 * of the window counts as unused - which is exactly the behaviour we want.
 */
export async function pickTopic(pool = config.quiz.topics) {
  const used = await Quiz.aggregate([{ $group: { _id: '$topic', lastUsed: { $max: '$postedAt' } } }]);
  const lastUsedByTopic = new Map(used.map((row) => [row._id, row.lastUsed]));

  const unused = pool.filter((topic) => !lastUsedByTopic.has(topic));
  if (unused.length) return unused[Math.floor(Math.random() * unused.length)];

  const coldest = [...pool]
    .sort((a, b) => new Date(lastUsedByTopic.get(a)) - new Date(lastUsedByTopic.get(b)))
    .slice(0, 3);
  return coldest[Math.floor(Math.random() * coldest.length)];
}

/**
 * The safety net behind Telegram's own timer, and nothing more.
 *
 * `QUIZ_OPEN_PERIOD` is what actually ends a quiz: Telegram counts it down on
 * the poll and closes it server-side, with no run of ours involved. This exists
 * for polls posted before that was configured, or by a Bot API server that
 * refused the period - it stops anything still open after `closeAfterHours`.
 * Defaults to 0, i.e. off, because Telegram is doing the job.
 *
 * @returns {Promise<number>} how many polls were closed
 */
export async function closeExpiredPolls() {
  const { closeAfterHours } = config.quiz;
  if (closeAfterHours <= 0) return 0;

  const cutoff = new Date(Date.now() - closeAfterHours * HOUR_MS);
  // `closedAt: null` also matches rows written before this field existed; those
  // have no messageId either, so the second clause skips them.
  const expired = await Quiz.find({
    closedAt: null,
    messageId: { $ne: null },
    postedAt: { $lte: cutoff },
  }).lean();

  let closed = 0;
  for (const quiz of expired) {
    let settled = true;
    try {
      await stopPoll({ chatId: quiz.chatId, messageId: quiz.messageId });
      closed += 1;
    } catch (err) {
      // A 4xx is Telegram's final answer - closed by hand, already expired, or
      // the message was deleted. The poll is not open either way, so record it
      // rather than retry every day. Timeouts and 5xx get another chance.
      settled = err.status >= 400 && err.status < 500;
      console.warn(
        `[pipeline] could not close poll ${quiz.messageId}: ${err.description ?? err.message}` +
          (settled ? '' : ' - will retry next run'),
      );
    }
    if (settled) await Quiz.updateOne({ _id: quiz._id }, { closedAt: new Date() });
  }

  if (closed) console.log(`[pipeline] closed ${closed} poll${closed === 1 ? '' : 's'} older than ${closeAfterHours}h`);
  return closed;
}

/** Keeps the newest `historyLimit` questions and deletes the rest. */
async function pruneHistory() {
  const keep = await Quiz.find()
    .sort({ postedAt: -1 })
    .limit(config.quiz.historyLimit)
    .select('_id')
    .lean();

  const { deletedCount } = await Quiz.deleteMany({ _id: { $nin: keep.map((d) => d._id) } });
  if (deletedCount) console.log(`[pipeline] pruned ${deletedCount} old question${deletedCount === 1 ? '' : 's'}`);
}

/**
 * The whole job: close what expired, pick a topic, generate, reject repeats,
 * post, record, prune.
 *
 * @param {{force?: boolean}} options force skips the "posted recently" guard.
 */
export async function runQuizJob({ force = false } = {}) {
  const { minGapHours, historyLimit, difficulty, openPeriodSeconds, anonymous } = config.quiz;

  // Ahead of the gap guard: a run that decides not to post should still retire
  // yesterday's poll, otherwise a single skip leaves it open indefinitely.
  await closeExpiredPolls();

  if (!force && minGapHours > 0) {
    const since = new Date(Date.now() - minGapHours * HOUR_MS);
    const recent = await Quiz.findOne({ postedAt: { $gte: since } }).sort({ postedAt: -1 }).lean();
    if (recent) {
      const reason = `already posted ${new Date(recent.postedAt).toISOString()}, inside the ${minGapHours}h guard`;
      console.log(`[pipeline] skipped - ${reason}`);
      return { ok: true, skipped: true, reason };
    }
  }

  let topic = await pickTopic();
  const history = await Quiz.find().sort({ postedAt: -1 }).limit(historyLimit).select('question').lean();

  const avoid = history.map((q) => q.question);
  console.log(`[pipeline] generating "${topic}", avoiding ${avoid.length} recent question(s)`);

  // Prefer Gemini when a free-tier API key is configured. If it is missing,
  // the quota is exhausted, or generation fails validation, use the local bank
  // so the daily post can still go out.
  let draft;
  if (config.gemini.apiKey) {
    const questionTypes = ['conceptual', 'code-output', 'debugging', 'scenario'];
    const questionType = questionTypes[Math.floor(Math.random() * questionTypes.length)];
    try {
      draft = await generateQuiz({ topic, difficulty, avoid, questionType });
      console.log(`[pipeline] generated with Gemini (${draft.model})`);
    } catch (err) {
      console.warn(`[pipeline] Gemini generation failed; using curated bank: ${err.message}`);
    }
  } else {
    console.log('[pipeline] GEMINI_API_KEY not set; using curated question bank');
  }

  if (!draft) {
    draft = chooseQuestion({ topic, difficulty, avoid });
  }
  topic = draft.topic || topic;
  const fingerprint = fingerprintQuestion(draft.question);

  // Guard against a collision in retained history, including minor punctuation
  // differences. If Gemini repeats a recent question, use a curated fallback.
  const duplicate = await Quiz.findOne({ fingerprint }).lean();
  if (duplicate) {
    console.warn('[pipeline] generated a recent duplicate; using curated bank instead');
    const recentFingerprints = new Set(
      (await Quiz.find().select('fingerprint').lean()).map((row) => row.fingerprint),
    );
    const freshBankQuestions = QUESTION_BANK.filter(
      (item) => !recentFingerprints.has(fingerprintQuestion(item.question)),
    );
    if (freshBankQuestions.length) {
      const fallback = chooseQuestion({ topic, difficulty, avoid });
      draft = freshBankQuestions.find((item) => item.question === fallback.question)
        ?? freshBankQuestions[Math.floor(Math.random() * freshBankQuestions.length)];
      topic = draft.topic || topic;
    } else {
      throw new Error('All curated fallback questions are already in recent history; add more questions or increase history capacity.');
    }
  }
  const finalFingerprint = fingerprintQuestion(draft.question);

  const chat = await getChat();
  const thread = config.telegram.topicThreadId;
  const message = await sendQuizPoll({
    chatId: chat.id,
    messageThreadId: thread,
    question: draft.question,
    options: draft.options,
    correctIndex: draft.correctIndex,
    explanation: draft.explanation,
    openPeriodSeconds,
    isAnonymous: anonymous,
  });

  // Telegram echoes the thread back; trust its answer over our request.
  const postedThread = message.message_thread_id ?? thread;

  // Recorded only after Telegram accepted it, so a failed send never burns
  // the question - the next run can still use it.
  await Quiz.create({
    question: draft.question,
    fingerprint: finalFingerprint,
    topic,
    postedAt: new Date(),
    chatId: String(chat.id),
    messageId: message.message_id,
  });
  await pruneHistory();

  const link = buildMessageLink(chat, message.message_id, postedThread);
  console.log(`[pipeline] posted ${link ?? `#${message.message_id}`}: ${draft.question.slice(0, 70)}…`);

  return { ok: true, skipped: false, question: draft.question, topic, link };
}
