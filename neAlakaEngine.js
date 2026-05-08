const LETTERS_TR = "ABCDEFGHIJKLMNOPRSTUVYZÇİÖŞÜ";
const LETTERS_EN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const VOWELS_TR = new Set(['A','E','İ','I','O','Ö','U','Ü']);
const VOWELS_EN = new Set(['A','E','I','O','U']);

const QUESTION_LABELS_TR = {
  kim: "Kim?", kiminle: "Kiminle?", nerede: "Nerede?",
  nasil: "Nasıl?", ne_yapiyor: "Ne Yapıyor?",
};
const QUESTION_LABELS_EN = {
  kim: "Who?", kiminle: "With Whom?", nerede: "Where?",
  nasil: "How?", ne_yapiyor: "Doing What?",
};

function getLabels(lang) {
  return lang === "EN" ? QUESTION_LABELS_EN : QUESTION_LABELS_TR;
}

const MIDDLE_KEYS = ["kiminle", "nerede", "nasil"];

let roundData  = {};
let roundTimers = {};
let letterQueues = {};

function buildQueue(lang) {
  const letters = lang === "EN" ? LETTERS_EN : LETTERS_TR;
  const vowels  = lang === "EN" ? VOWELS_EN  : VOWELS_TR;
  const pool = [];
  for (const l of letters) {
    pool.push(l);
    if (vowels.has(l)) pool.push(l);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const seen = new Set();
  return pool.filter(l => !seen.has(l) && seen.add(l));
}

function getNextLetter(roomCode, lang) {
  if (!letterQueues[roomCode] || letterQueues[roomCode].length === 0) {
    letterQueues[roomCode] = buildQueue(lang);
  }
  return letterQueues[roomCode].pop();
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

  // Clear ready state for the new round
  room.readyPlayers = new Set();

  const lang = room.settings?.lang || "TR";
  const questionKeys = buildQuestions(room.players.length);
  const letter = getNextLetter(roomCode, lang);
  const round = (roundData[roomCode]?.round || 0) + 1;

  const labels = getLabels(lang);
  roundData[roomCode] = { questionKeys, letter, submissions: {}, round, lang };

  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); }

  io.to(roomCode).emit("ne_alaka_state", {
    letter,
    questions: questionKeys.map(k => labels[k]),
    questionKeys,
    round,
    lang,
  });

  // 15s total: 3s countdown + 10s game + 2s submission buffer
  roundTimers[roomCode] = setTimeout(() => revealResults(io, roomCode, room), 15000);
}

function submitAnswers(roomCode, userId, answers) {
  if (!roundData[roomCode]) return;
  roundData[roomCode].submissions[userId] = answers;
}

function revealResults(io, roomCode, room) {
  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); delete roundTimers[roomCode]; }

  const data = roundData[roomCode];
  if (!data) return;

  const { questionKeys, letter, submissions, lang: dataLang } = data;
  const labels = getLabels(dataLang || "TR");

  const cards = questionKeys.map((qKey, i) => {
    const questionLabel = labels[qKey];
    const playerAnswers = room.players
      .map(p => ({ userId: p.userId, username: p.username, answer: (submissions[p.userId]?.[i] || "").trim() }))
      .filter(a => a.answer !== "");

    const picked = playerAnswers.length > 0
      ? playerAnswers[Math.floor(Math.random() * playerAnswers.length)]
      : { answer: "—", username: "?" };

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
  delete letterQueues[roomCode];
}

module.exports = { startRound, submitAnswers, revealResults, resetRound };
