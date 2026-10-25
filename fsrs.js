/**
 * NoteRecall FSRS-5.0 Scheduler Engine
 * Exact mathematical parity with NoteRecall Desktop FSRS-5.
 * Zero external dependencies. Works in browser, PWA, and Node.js.
 */

// Official FSRS-5 default weights (Jarrett Ye / Open-Spaced-Repetition)
const DEFAULT_FSRS_W = [
  0.4025, 1.1838, 3.1730, 15.6910, 7.1949, 0.5345, 1.4604, 0.0046,
  1.5457, 0.1192, 1.0192, 1.9395, 0.1100, 0.2960, 2.2698, 0.2315,
  2.9898, 0.5165, 0.6621
];

const FSRS_DECAY = -0.5;
const FSRS_FACTOR = Math.pow(0.9, 1 / FSRS_DECAY) - 1; // ~19.428

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function getFsrsWeights(fsrsParameters) {
  if (fsrsParameters) {
    const parsed = String(fsrsParameters)
      .split(',')
      .map(x => parseFloat(x.trim()))
      .filter(x => !isNaN(x));
    if (parsed.length >= 19) {
      return parsed.slice(0, 19);
    }
  }
  return DEFAULT_FSRS_W;
}

function retrievability(elapsedDays, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + FSRS_FACTOR * elapsedDays / stability, FSRS_DECAY);
}

function intervalFromStability(s, requestRetention) {
  const days = (s / FSRS_FACTOR) * (Math.pow(requestRetention || 0.9, 1 / FSRS_DECAY) - 1);
  return clamp(days, 0.0007, 36500);
}

function applyFuzz(intervalDays, cardId) {
  if (intervalDays <= 2.5) return intervalDays;
  let hash = 0;
  const str = String(cardId || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  const norm = (Math.abs(hash) % 1000) / 1000;
  const fuzzFactor = 0.95 + norm * 0.10;
  return intervalDays * fuzzFactor;
}

function getCutoffTimestamp(now, daysAhead, cutoffHour = 4) {
  const d = new Date(now);
  if (d.getHours() < cutoffHour) {
    d.setDate(d.getDate() - 1);
  }
  d.setHours(cutoffHour, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  return d.getTime();
}

/**
 * Calculates updated card scheduling state after a review grade.
 *
 * @param {Object} card Current card object { state, difficulty, stability, reps, lapses, lastReview }
 * @param {number} grade 1=Again, 2=Hard, 3=Good, 4=Easy
 * @param {number} now Timestamp in milliseconds of the review
 * @param {Object} options Configuration options
 * @returns {Object} { difficulty, stability, intervalDays, due, state, reps, lapses }
 */
function scheduleCard(card, grade, now, options = {}) {
  const multipliers = options.multipliers || { 1: 1, 2: 1, 3: 1, 4: 1 };
  const mult = multipliers[grade] || 1;
  const ret = options.requestRetention || 0.9;
  const w = getFsrsWeights(options.fsrsParameters);
  const maxInterval = options.maxIntervalDays || 30;
  const cutoffHour = options.dayCutoffHour !== undefined ? options.dayCutoffHour : 4;

  function initStability(g) {
    return clamp(w[g - 1], 0.01, 36500);
  }

  function initDifficulty(g) {
    const d = w[4] - Math.exp(w[5] * (g - 1)) + 1;
    return clamp(d, 1, 10);
  }

  function nextDifficulty(d, g) {
    const deltaD = -w[6] * (g - 3);
    const dPrime = d + deltaD * (10 - d) / 9;
    const result = w[7] * initDifficulty(4) + (1 - w[7]) * dPrime;
    return clamp(result, 1, 10);
  }

  function nextStabilitySuccess(d, s, r, g) {
    const hardPenalty = g === 2 ? w[15] : 1;
    const easyBonus = g === 4 ? w[16] : 1;
    const sInc = Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus;
    return clamp(s * (1 + sInc), 0.01, 36500);
  }

  function nextStabilityFail(d, s, r) {
    const sLapse = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
    return clamp(sLapse, 0.01, 36500);
  }

  // Handle NEW cards
  if (card.state === 'new') {
    const difficulty = initDifficulty(grade);
    const stability = initStability(grade);
    let intervalDays = intervalFromStability(stability, ret) * mult;
    intervalDays = applyFuzz(intervalDays, card.id);

    if (grade === 1) {
      // Intra-session retry for failed card (1m)
      return {
        difficulty,
        stability,
        intervalDays: 0,
        due: now + (1 * 60 * 1000),
        state: 'review',
        reps: 1,
        lapses: 1
      };
    }

    const finalInterval = clamp(Math.max(1, Math.round(intervalDays)), 1, maxInterval);
    const dueTime = getCutoffTimestamp(now, finalInterval, cutoffHour);
    return {
      difficulty,
      stability,
      intervalDays: finalInterval,
      due: dueTime,
      state: 'review',
      reps: 1,
      lapses: 0
    };
  }

  // Handle REVIEW cards
  const elapsedDays = card.lastReview ? Math.max(0, (now - card.lastReview) / 86400000) : 0;
  const r = retrievability(elapsedDays, card.stability);
  let stability;
  let lapses = card.lapses || 0;

  if (grade === 1) {
    stability = nextStabilityFail(card.difficulty, card.stability, r);
    lapses += 1;
    // Failed review card: intra-session retry (10m)
    return {
      difficulty: nextDifficulty(card.difficulty, grade),
      stability,
      intervalDays: 0,
      due: now + (10 * 60 * 1000),
      state: 'review',
      reps: (card.reps || 0) + 1,
      lapses
    };
  }

  stability = nextStabilitySuccess(card.difficulty, card.stability, r, grade);
  const difficulty = nextDifficulty(card.difficulty, grade);
  let intervalDays = intervalFromStability(stability, ret) * mult;
  intervalDays = applyFuzz(intervalDays, card.id);

  const finalInterval = clamp(Math.max(1, Math.round(intervalDays)), 1, maxInterval);
  const dueTime = getCutoffTimestamp(now, finalInterval, cutoffHour);

  return {
    difficulty,
    stability,
    intervalDays: finalInterval,
    due: dueTime,
    state: 'review',
    reps: (card.reps || 0) + 1,
    lapses
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_FSRS_W,
    scheduleCard,
    retrievability,
    intervalFromStability,
    applyFuzz,
    getCutoffTimestamp
  };
} else {
  window.NoteRecallFSRS = {
    DEFAULT_FSRS_W,
    scheduleCard,
    retrievability,
    intervalFromStability,
    applyFuzz,
    getCutoffTimestamp
  };
}
