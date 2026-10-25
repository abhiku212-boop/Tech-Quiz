# Daily Full-Stack Interview Quiz Bot

A free-to-run Telegram group bot that automatically posts **one interview practice question per day**. No `/start`, `/quiz`, leaderboard, score tracking, or per-member answer tracking is required. Members simply open the group, vote in the native Telegram quiz poll, and read the explanation Telegram reveals after they answer.

## What members practise

- JavaScript, React, Node.js, Express.js, MongoDB/Mongoose and MERN Stack.
- Beginner, intermediate and advanced levels.
- Conceptual MCQs, code-output questions, debugging and practical scenarios.
- The correct answer and a short explanation are attached to each poll. When configured, Gemini generates fresh questions; a local curated bank is the automatic fallback.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. Add the bot to your Telegram group and grant permission to send messages and polls. If the group uses forum topics, optionally set `TELEGRAM_TOPIC_ID` to the topic where the daily question should appear.
3. Create a MongoDB database (the free Atlas tier is sufficient for a small question-history collection) or use another MongoDB instance.
4. Copy `.env.example` to `.env` and configure:

   ```env
   MONGODB_URI=your_mongodb_connection_string
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_CHANNEL_ID=-1001234567890
   QUIZ_DIFFICULTY=mixed
   QUIZ_OPEN_PERIOD=86400
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-2.5-flash
   ```

   Despite the legacy variable name `TELEGRAM_CHANNEL_ID`, use your group's/supergroup's chat ID. The bot must be a member and have permission to send polls. Keep `.env` private and never commit your bot token.

5. Install dependencies and test a single post:

   ```bash
   npm ci
   npm run check
   npm run post:force
   ```

## Automatic daily posting — no always-on computer needed

The included `.github/workflows/daily-quiz.yml` posts one question daily using GitHub Actions. In your GitHub repository, open **Settings → Secrets and variables → Actions → Secrets** and add:

- `MONGODB_URI`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`

Also add `GEMINI_API_KEY` under **Secrets** to enable AI-generated questions (get a key from [Google AI Studio](https://aistudio.google.com/apikey)). Without this secret, the bot uses the built-in question bank. Optional repository variables: `TELEGRAM_TOPIC_ID`, `QUIZ_DIFFICULTY`, `QUIZ_TOPICS`.

The workflow is scheduled for **09:00 India Standard Time** (`03:30 UTC`). GitHub scheduled workflows can run late, and the workflow must be enabled in the repository. You can also run it manually from **Actions → Daily quiz → Run workflow**. The daily workflow runs independently; no bot process needs to stay running on your computer.

## How the poll works

- Each scheduled run posts one native Telegram quiz poll.
- Members tap an answer; Telegram indicates whether their choice was correct and displays the explanation.
- The poll closes after 24 hours by default.
- The bot stores only question-posting history in MongoDB to reduce repeats. It does **not** store member scores or create a leaderboard.
- If `GEMINI_API_KEY` is configured, the bot asks Gemini for one fresh question per day and validates the result before posting. Free-tier availability and quotas depend on the model and Google account.
- If Gemini is not configured, temporarily unavailable, over quota, or returns invalid content, the bot falls back to the curated local bank. This prevents an AI outage from stopping the daily quiz.

## AI-generated questions and fallback

Set the `GEMINI_API_KEY` GitHub Actions secret (or `GEMINI_API_KEY` in your local `.env`) to enable Gemini. The code requests structured JSON, validates the four distinct options and correct-answer index, shuffles answer positions, and includes recent questions in the prompt to reduce repeats. If generation fails, the curated question bank is used instead. Keep API keys private; never commit `.env`.

## Add or improve questions

Edit `src/services/questionBank.js`. Each entry contains `topic`, `family`, `difficulty`, `type`, `question`, four `options`, `correctIndex`, and `explanation`. Before adding code-output questions, run the snippet yourself and confirm the exact output. The question bank is finite, so add fresh questions periodically.

## Cost notes

Telegram bot messaging and the curated question bank have no per-question fee. GitHub Actions and MongoDB Atlas have free tiers with quotas and terms that may change; check the current limits for your accounts. This setup does not require a paid AI plan; you can run from the curated bank without an AI key. Gemini free-tier usage is subject to Google's current model quotas and terms. No continuously running server is required.
