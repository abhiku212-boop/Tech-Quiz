/**
 * Generates one quiz and posts it, then exits. This is the whole application.
 *
 * Point a system crontab, GitHub Actions, or any serverless cron at it:
 *
 *   node scripts/postNow.js          respects the 20h gap guard
 *   node scripts/postNow.js --force  posts regardless
 */
import { assertConfig } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { runQuizJob } from '../src/services/quizPipeline.js';

const force = process.argv.includes('--force');

try {
  assertConfig();
  await connectDb();

  const result = await runQuizJob({ force });

  if (result.skipped) console.log(`Skipped: ${result.reason}`);
  else console.log(`Posted: ${result.question}`);

  await disconnectDb();
} catch (err) {
  console.error(`Failed: ${err.message}`);
  await disconnectDb().catch(() => {});
  // Not process.exit(): forcing exit while fetch's keep-alive socket is still
  // closing trips a libuv assertion and would report failure after a good post.
  process.exitCode = 1;
}
