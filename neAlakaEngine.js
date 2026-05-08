const LETTERS_TR = "ABCDEFGHIJKLMNOPRSTUVYZÇİÖŞÜ";
const VOWELS_TR = new Set(['A','E','İ','I','O','Ö','U','Ü']);

const QUESTION_LABELS = {
  kim:        "Kim?",
  kiminle:    "Kiminle?",
  nerede:     "Nerede?",
  nasil:      "Nasıl?",
  ne_yapiyor: "Ne Yapıyor?",
};

const MIDDLE_KEYS = ["kiminle", "nerede", "nasil"];

let roundData  = {};
let roundTimers = {};
let letterQueue = [];

function buildQueue() {
  const pool = [];
  for (const l of LETTERS_TR) {
    pool.push(l);
    if (VOWELS_TR.has(l)) pool.push(l);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const seen = new Set();
  return pool.filter(l => !seen.has(l) && seen.add(l));
}

function getNextLetter() {
  if (letterQueue.length === 0) letterQueue = buildQueue();
  return letterQueue.pop();
}

function buildQuestions(playerCount) {
  const n = Math.max(2, Math.min(playerCount, 5));
  const questions = ["kim"];
  const middleCount = n - 2;
  if (middleCount > 0) {
    const shuffled = [...MIDDLE_KEYS].sort(() => Math.random() - 0.5);
    questions.push(...shuffled.slice(0, middleCount));
  }
  questions.push("ne_yapiyor");
  return questions;
}

function startRound(io, roomCode, room) {
  if (!room || !room.players?.length) return;

  const questionKeys = buildQuestions(room.players.length);
  const letter = getNextLetter();
  const round = (roundData[roomCode]?.round || 0) + 1;

  roundData[roomCode] = { questionKeys, letter, submissions: {}, round };

  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); }

  io.to(roomCode).emit("ne_alaka_state", {
    letter,
    questions: questionKeys.map(k => QUESTION_LABELS[k]),
    questionKeys,
    round,
  });

  // 13s total: 3s countdown + 10s game
  roundTimers[roomCode] = setTimeout(() => revealResults(io, roomCode, room), 13000);
}

function submitAnswers(roomCode, userId, answers) {
  if (!roundData[roomCode]) return;
  roundData[roomCode].submissions[userId] = answers;
}

function revealResults(io, roomCode, room) {
  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); delete roundTimers[roomCode]; }

  const data = roundData[roomCode];
  if (!data) return;

  const { questionKeys, letter, submissions } = data;

  const cards = questionKeys.map((qKey, i) => {
    const questionLabel = QUESTION_LABELS[qKey];
    const playerAnswers = room.players
      .map(p => ({ userId: p.userId, username: p.username, answer: (submissions[p.userId]?.[i] || "").trim() }))
      .filter(a => a.answer !== "");

    const picked = playerAnswers.length > 0
      ? playerAnswers[Math.floor(Math.random() * playerAnswers.length)]
      : { answer: "???", username: "?" };

    return { question: questionLabel, answer: picked.answer, answeredBy: picked.username, all: playerAnswers };
  });

  io.to(roomCode).emit("ne_alaka_result", {
    cards,
    sentence: cards.map(c => c.answer).join(" "),
    letter,
    round: data.round,
  });
}

function resetRound(roomCode) {
  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); delete roundTimers[roomCode]; }
  delete roundData[roomCode];
}

module.exports = { startRound, submitAnswers, revealResults, resetRound };
