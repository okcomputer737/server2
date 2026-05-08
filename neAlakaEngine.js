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

// Returns ordered question keys: ["kim", ...middles..., "ne_yapiyor"]
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
  if (!room || !room.players?.length || room.players.length < 2) return;

  room.readyPlayers = new Set();

  const lang = room.settings?.lang || "TR";
  const questionKeys = buildQuestions(room.players.length); // e.g. ["kim", "nerede", "ne_yapiyor"]
  const letter = getNextLetter(roomCode, lang);
  const round = (roundData[roomCode]?.round || 0) + 1;
  const labels = getLabels(lang);

  // Shuffle player order → each gets a unique question slot
  const shuffledPlayers = [...room.players].sort(() => Math.random() - 0.5);
  const assignments = {}; // userId → questionIndex (slot in questionKeys)
  shuffledPlayers.forEach((p, i) => { assignments[p.userId] = i; });

  roundData[roomCode] = {
    questionKeys, assignments, letter, submissions: {},
    round, lang, totalPlayers: room.players.length,
  };

  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); }

  // Send each player their own question only
  room.players.forEach(player => {
    const qIndex = assignments[player.userId];
    const qLabel = labels[questionKeys[qIndex]];
    io.to(player.id).emit("ne_alaka_state", {
      letter,
      question: qLabel,      // single question for this player
      questionIndex: qIndex,
      round,
      lang,
      totalPlayers: room.players.length,
    });
  });

  // Fallback: 60s in case someone disconnects without submitting
  roundTimers[roomCode] = setTimeout(() => revealResults(io, roomCode, room), 60000);
}

function submitAnswers(io, roomCode, room, userId, answers) {
  if (!roundData[roomCode]) return;
  // answers is a single-element array or string; normalize to string
  const answer = Array.isArray(answers) ? (answers[0] || "") : (answers || "");
  roundData[roomCode].submissions[userId] = answer;

  const submittedCount = Object.keys(roundData[roomCode].submissions).length;
  const totalCount = room.players.length;

  io.to(roomCode).emit("ne_alaka_submissions", { count: submittedCount, total: totalCount });

  if (submittedCount >= totalCount) {
    if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); delete roundTimers[roomCode]; }
    revealResults(io, roomCode, room);
  }
}

function revealResults(io, roomCode, room) {
  if (roundTimers[roomCode]) { clearTimeout(roundTimers[roomCode]); delete roundTimers[roomCode]; }

  const data = roundData[roomCode];
  if (!data) return;

  const { questionKeys, assignments, letter, submissions, lang: dataLang } = data;
  const labels = getLabels(dataLang || "TR");

  // Each card corresponds to a question slot; the answer is from the assigned player
  const cards = questionKeys.map((qKey, i) => {
    const questionLabel = labels[qKey];
    // Find which player was assigned to slot i
    const assignedUserId = Object.entries(assignments).find(([, idx]) => idx === i)?.[0];
    const player = room.players.find(p => p.userId === assignedUserId);
    const answer = (submissions[assignedUserId] || "").toString().trim();
    return {
      question: questionLabel,
      answer: answer || "—",
      answeredBy: player?.username || "?",
    };
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
