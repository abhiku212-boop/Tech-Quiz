import mongoose from 'mongoose';

/**
 * A deliberately thin record of what has already been posted.
 *
 * The poll itself lives in Telegram - this stores what is needed to stop the
 * next question being a repeat (the text, its fingerprint, the topic) plus the
 * address of the message, which is the only way to close the poll later.
 * Answers, options and vote counts are not kept. The collection is pruned to
 * the newest `QUIZ_HISTORY_LIMIT` documents after every post.
 */
const quizSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    /** sha256 of the normalised question text - the repeat guard */
    fingerprint: { type: String, required: true, unique: true },
    topic: { type: String, index: true },
    postedAt: { type: Date, default: Date.now, index: true },
    /** Where the poll lives, so a later run can call stopPoll on it. */
    chatId: { type: String, default: null },
    messageId: { type: Number, default: null },
    /** Set once the poll has been closed, or found already closed. */
    closedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

export const Quiz = mongoose.models.Quiz || mongoose.model('Quiz', quizSchema);
