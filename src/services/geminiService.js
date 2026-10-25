import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config.js';

/** Hard limits imposed by the Telegram Bot API on quiz polls. */
export const LIMITS = {
  question: 300,
  option: 100,
  explanation: 200,
};

let client = null;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

const QUIZ_SCHEMA = {
  type: Type.OBJECT,
  required: ['question', 'options', 'correctIndex', 'explanation', 'topic', 'difficulty', 'questionType'],
  // Gemini emits keys in this order, which keeps the raw JSON readable in logs.
  propertyOrdering: ['question', 'options', 'correctIndex', 'explanation', 'topic', 'difficulty', 'questionType'],
  properties: {
    question: {
      type: Type.STRING,
      description: `The full question, self-contained, at most ${LIMITS.question} characters.`,
    },
    options: {
      type: Type.ARRAY,
      description: 'Exactly four distinct answer options, plain text, no A)/B) prefixes.',
      items: { type: Type.STRING },
      minItems: 4,
      maxItems: 4,
    },
    correctIndex: {
      type: Type.INTEGER,
      description: 'Zero-based index into options of the single correct answer.',
    },
    explanation: {
      type: Type.STRING,
      description: `The solving step in at most ${LIMITS.explanation} characters.`,
    },
    topic: { type: Type.STRING },
    difficulty: { type: Type.STRING, enum: ['beginner', 'intermediate', 'advanced'] },
    questionType: { type: Type.STRING, enum: ['conceptual', 'code-output', 'debugging', 'scenario'] },
  },
};

const SYSTEM_PROMPT = `You are a senior full-stack JavaScript interviewer creating accurate interview quizzes for JavaScript, React, Node.js, Express.js, MongoDB and the MERN stack.

Rules you never break:
- Exactly one option is correct and provably so; the other three are wrong but plausible (they should look like the answer a candidate gets from a common mistake).
- The question is fully self-contained plain text. No images, tables, diagrams, LaTeX, markdown or "refer to the passage".
- Questions must target the supplied web-development topic and requested difficulty.
- For code-output questions, include a short, self-contained code snippet in the question and determine its exact output by tracing the code; do not guess. Use plain-text code and keep it readable.
- Cover conceptual, code-output, debugging and practical scenario questions.
- Avoid version-dependent behavior unless the relevant runtime/version is stated.
- A prepared candidate should solve it in about 60 seconds.
- Options are distinct from each other and carry their units.
- The explanation gives the actual working in one or two short sentences, not "option B is correct".
- The explanation never points at an option by letter or position ("option A", "the first choice"). The options are reordered before the question is published, so only the working itself stays true.
- Never reuse a question the user tells you to avoid, and do not merely reword one.`;

function normalise(text) {
  // Preserve line breaks so code-output snippets remain readable in Telegram.
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function truncate(text, max) {
  const value = normalise(text);
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Rejects anything Telegram would reject, plus the failure modes models actually hit:
 * duplicate options and an out-of-range answer index.
 */
export function validateQuiz(raw) {
  const question = normalise(raw?.question);
  if (!question) throw new Error('question is empty');
  if (question.length > LIMITS.question)
    throw new Error(`question is ${question.length} chars, limit is ${LIMITS.question}`);

  if (!Array.isArray(raw?.options) || raw.options.length !== 4)
    throw new Error('expected exactly 4 options');

  const options = raw.options.map(normalise);
  if (options.some((o) => !o)) throw new Error('an option is empty');
  const tooLong = options.find((o) => o.length > LIMITS.option);
  if (tooLong) throw new Error(`option "${tooLong.slice(0, 30)}…" exceeds ${LIMITS.option} chars`);

  const seen = new Set(options.map((o) => o.toLowerCase()));
  if (seen.size !== options.length) throw new Error('options are not distinct');

  const correctIndex = Number(raw?.correctIndex);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length)
    throw new Error(`correctIndex ${raw?.correctIndex} is out of range`);

  return {
    question,
    options,
    correctIndex,
    // Telegram truncates hard, so trim rather than throw away a good question.
    explanation: truncate(raw?.explanation, LIMITS.explanation),
    topic: normalise(raw?.topic) || 'Aptitude',
    difficulty: ['beginner', 'intermediate', 'advanced'].includes(raw?.difficulty) ? raw.difficulty : 'intermediate',
    questionType: ['conceptual', 'code-output', 'debugging', 'scenario'].includes(raw?.questionType) ? raw.questionType : 'conceptual',
  };
}

/**
 * Fisher-Yates over the options, carrying correctIndex along with the answer
 * it points at.
 *
 * Without this, the answer is A nearly every time. The model writes the correct
 * option first and then invents three distractors around it - the schema even
 * has it emit `options` before `correctIndex`, so by the time it names the index
 * the answer is already sitting at 0. Subscribers spot that pattern long before
 * they run out of questions, and from then on the quiz tests nothing.
 *
 * Shuffling here rather than asking the prompt to vary the position is what
 * makes it uniform by construction: no prompt wording can guarantee it.
 */
export function shuffleOptions({ options, correctIndex, ...rest }) {
  const shuffled = [...options];
  let answer = correctIndex;

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    // randomInt is rejection-sampled, so unlike Math.random()*n it has no
    // modulo bias - which would otherwise show up as a favoured position.
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];

    if (answer === i) answer = j;
    else if (answer === j) answer = i;
  }

  return { ...rest, options: shuffled, correctIndex: answer };
}

function buildUserPrompt({ topic, difficulty, avoid, questionType }) {
  const chosenType = questionType === 'mixed'
    ? ['conceptual', 'code-output', 'debugging', 'scenario'][Math.floor(Math.random() * 4)]
    : questionType;
  const lines = [
    `Write one multiple-choice software-development interview question on: ${topic}.`,
    `Difficulty: ${difficulty === 'mixed' ? 'pick beginner, intermediate or advanced yourself' : difficulty}.`,
    `Question type: ${chosenType}. For code-output questions, ask for exact output and include the code snippet in the question.`,
  ];

  if (avoid.length) {
    lines.push(
      '',
      'Do not repeat or reword any of these already-published questions:',
      ...avoid.map((q, i) => `${i + 1}. ${q}`),
    );
  }

  return lines.join('\n');
}

const turn = (role, text) => ({ role, parts: [{ text }] });

/**
 * Pulls the JSON out of a response, turning a blocked or truncated generation into
 * an error with the reason Gemini actually gave rather than a bare parse failure.
 */
function extractText(response) {
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`prompt blocked: ${blockReason}`);

  const candidate = response?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP')
    throw new Error(`generation stopped early: ${finishReason}`);

  const text = response?.text;
  if (!text) throw new Error('model returned no content');
  return text;
}

/**
 * Asks the model for one question and validates it. Invalid output is retried
 * with the failure reason fed back, which fixes it far more often than a blind retry.
 */
export async function generateQuiz({
  topic,
  difficulty = 'mixed',
  avoid = [],
  questionType = 'mixed',
  model = config.gemini.model,
  attempts = 3,
}) {
  const contents = [turn('user', buildUserPrompt({ topic, difficulty, avoid, questionType }))];

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await getClient().models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: config.gemini.temperature,
        responseMimeType: 'application/json',
        responseSchema: QUIZ_SCHEMA,
      },
    });

    let text = '';
    try {
      text = extractText(response);
      const parsed = JSON.parse(text);
      // Shuffled only after it has passed, so a rejection is always reported
      // against the indexes the model actually produced.
      return { ...shuffleOptions(validateQuiz(parsed)), model };
    } catch (err) {
      lastError = err;
      console.warn(`[gemini] attempt ${attempt} rejected: ${err.message}`);
      contents.push(
        turn('model', text || '{}'),
        turn(
          'user',
          `That was rejected: ${err.message}. Write a different question on ${topic} that fixes it.`,
        ),
      );
    }
  }

  throw new Error(`could not generate a valid quiz after ${attempts} attempts: ${lastError?.message}`);
}
