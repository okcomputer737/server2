const LETTERS_TR = "ABCDEFGHIJKLMNOPRSTUVYZÇİÖŞÜ";
const LETTERS_EN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const VOWELS_TR = new Set(['A','E','İ','I','O','Ö','U','Ü']);
const VOWELS_EN = new Set(['A','E','I','O','U']);

const THEMES = {
  classic:   { columns: ["İsim", "Şehir", "Hayvan", "Bitki", "Eşya"],          lang: "TR" },
  fame:      { columns: ["Şarkıcı", "Oyuncu", "Sporcu", "İnfluencer", "Ünlü"],  lang: "TR" },
  football:  { columns: ["Futbolcu", "Takım", "Ülke", "Sporcu", "Jübile"],      lang: "TR" },
  wrestling: { columns: ["Güreşçi", "Eski Güreşçi", "Moveset", "Güreş Ünlüsü"],lang: "EN" },
  dunya:     { columns: ["Şehir", "Ülke", "Yemek", "Eser", "Meslek"],           lang: "TR" },
  aviation:  { columns: ["Airport", "Şehir", "Ülke"],                            lang: "TR" },
};

let gameState = {};
let timers = {};
let submissions = {};
let earlySubmitters = {};
let letterQueues = {}; // roomCode → remaining letters array

function buildLetterQueue(lang) {
  const letters = lang === "EN" ? LETTERS_EN : LETTERS_TR;
  const vowels  = lang === "EN" ? VOWELS_EN  : VOWELS_TR;
  const pool = [];
  for (const l of letters) {
    pool.push(l);
    if (vowels.has(l)) pool.push(l); // vowels appear twice → higher pick rate
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Remove duplicates keeping first occurrence → no-repeat sequence with vowel bias
  const seen = new Set();
  return pool.filter(l => !seen.has(l) && seen.add(l));
}

function getNextLetter(roomCode, lang) {
  if (!letterQueues[roomCode] || letterQueues[roomCode].length === 0) {
    letterQueues[roomCode] = buildLetterQueue(lang);
  }
  return letterQueues[roomCode].pop();
}

function startGame(io, roomCode, room) {
  if (!room || !room.players?.length) return;

  submissions[roomCode] = {};
  earlySubmitters[roomCode] = new Set();

  const settings = room.settings || {};
  const themeKey = settings.theme || "classic";
  const theme = THEMES[themeKey] || THEMES.classic;
  const columns = theme.columns;
  const lang = settings.lang || theme.lang;
  const letter = getNextLetter(roomCode, lang);
  const nextRound = (gameState[roomCode]?.round || 0) + 1;

  io.to(roomCode).emit("game_countdown", { letter, columns, round: nextRound });

  setTimeout(() => {
    if (!room.players?.length) return;
    gameState[roomCode] = {
      phase: "play",
      letter,
      time: settings.roundTime || 10,
      theme: themeKey,
      columns,
      lang,
      round: nextRound,
    };
    io.to(roomCode).emit("game_state", gameState[roomCode]);
    startTimer(io, roomCode, room);
  }, 3000);
}

function submitWord(roomCode, userId, payload) {
  if (!submissions[roomCode]) submissions[roomCode] = {};
  submissions[roomCode][userId] = payload;
}

function setEarlySubmitter(roomCode, userId) {
  if (!earlySubmitters[roomCode]) earlySubmitters[roomCode] = new Set();
  earlySubmitters[roomCode].add(userId);
}

function startTimer(io, roomCode, room) {
  if (timers[roomCode]) { clearInterval(timers[roomCode]); delete timers[roomCode]; }

  timers[roomCode] = setInterval(() => {
    const state = gameState[roomCode];
    if (!state) return;
    state.time--;
    io.to(roomCode).emit("game_state", state);
    if (state.time <= 0) {
      clearInterval(timers[roomCode]);
      delete timers[roomCode];
      startDebate(io, roomCode, room);
    }
  }, 1000);
}

function buildDuplicateCells(state, subs, players) {
  const usedWords = {};
  const duplicateCells = {};
  players.forEach(p => { usedWords[p.userId] = new Set(); });

  state.columns.forEach((col, colIndex) => {
    players.forEach((p) => {
      const word = subs[p.userId]?.[colIndex];
      if (!word || word.trim() === "") return;
      const w = word.trim().toLowerCase();
      if (usedWords[p.userId].has(w)) {
        duplicateCells[`${p.userId}_${colIndex}`] = true;
      } else {
        usedWords[p.userId].add(w);
      }
    });
  });
  return duplicateCells;
}

function startDebate(io, roomCode, room) {
  const state = gameState[roomCode];
  if (!state) return;
  state.phase = "debate";

  const subs = submissions[roomCode] || {};
  const similarCells = {};
  const wrongLetterCells = {};
  const duplicateCells = buildDuplicateCells(state, subs, room.players);
  state.duplicateCells = duplicateCells;

  state.columns.forEach((col, colIndex) => {
    const colAnswers = [];
    room.players.forEach((p) => {
      const word = subs[p.userId]?.[colIndex];
      if (!word || word.trim() === "") return;
      const cellId = `${p.userId}_${colIndex}`;
      if (word.trim()[0]?.toUpperCase() !== state.letter) {
        wrongLetterCells[cellId] = true;
      } else if (!duplicateCells[cellId]) {
        colAnswers.push({ userId: p.userId, word: word.trim().toLowerCase() });
      }
    });
    findSimilarGroups(colAnswers).forEach((group) => {
      group.forEach((userId) => { similarCells[`${userId}_${colIndex}`] = true; });
    });
  });

  io.to(roomCode).emit("round_end", {
    phase: "debate",
    theme: state.theme,
    letter: state.letter,
    columns: state.columns,
    submissions: subs,
    players: room.players,
    similarCells,
    wrongLetterCells,
    duplicateCells,
  });
}

function calculateScores(roomCode, invalidCells, room) {
  const subs = submissions[roomCode] || {};
  const state = gameState[roomCode];
  if (!state) return {};

  const columns = state.columns;
  const scores = {};
  const bonusIssues = {};
  const duplicateCells = state.duplicateCells || {};

  room.players.forEach((p) => { scores[p.userId] = 0; bonusIssues[p.userId] = false; });

  columns.forEach((col, colIndex) => {
    const validAnswers = [];
    let nonValidCount = 0;

    room.players.forEach((p) => {
      const word = subs[p.userId]?.[colIndex];
      const cellId = `${p.userId}_${colIndex}`;
      const isInvalid    = invalidCells?.[cellId]?.isInvalid;
      const isWrongLetter = word && word.trim() !== "" && word.trim()[0]?.toUpperCase() !== state.letter;
      const isDuplicate  = duplicateCells[cellId];

      if (!word || word.trim() === "" || isInvalid || isWrongLetter || isDuplicate) {
        bonusIssues[p.userId] = true;
        nonValidCount++;
        return;
      }
      validAnswers.push({ userId: p.userId, word: word.trim().toLowerCase() });
    });

    const similarGroups = findSimilarGroups(validAnswers);

    validAnswers.forEach(({ userId }) => {
      const isSimilar = similarGroups.some(g => g.length > 1 && g.includes(userId));
      if (isSimilar) bonusIssues[userId] = true;

      const baseScore    = isSimilar ? 5 : 10;
      const invalidBonus = nonValidCount * 5; // +5 per blank/invalid in this column only
      scores[userId] = (scores[userId] || 0) + baseScore + invalidBonus;
    });
  });

  // Bonuslu Gönder: +25 or -10
  const bonusPlayers = earlySubmitters[roomCode] || new Set();
  bonusPlayers.forEach(userId => {
    scores[userId] = (scores[userId] || 0) + (bonusIssues[userId] ? -10 : 25);
  });

  return scores;
}

function similarity(a, b) {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  const len = longer.length;
  if (len === 0) return 1;
  return (len - editDistance(longer, shorter)) / len;
}

function editDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i-1] === a[j-1]
        ? matrix[i-1][j-1]
        : Math.min(matrix[i-1][j-1]+1, matrix[i][j-1]+1, matrix[i-1][j]+1);
    }
  }
  return matrix[b.length][a.length];
}

function findSimilarGroups(answers) {
  const groups = [];
  const used = new Set();
  answers.forEach((a, i) => {
    if (used.has(i)) return;
    const group = [a.userId];
    answers.forEach((b, j) => {
      if (i === j || used.has(j)) return;
      if (similarity(a.word, b.word) >= 0.8) { group.push(b.userId); used.add(j); }
    });
    if (group.length > 1) { groups.push(group); used.add(i); }
  });
  return groups;
}

function getGameState(roomCode) {
  return gameState[roomCode] || null;
}

function resetGame(roomCode) {
  if (timers[roomCode]) { clearInterval(timers[roomCode]); delete timers[roomCode]; }
  delete gameState[roomCode];
  delete submissions[roomCode];
  delete earlySubmitters[roomCode];
  delete letterQueues[roomCode];
}

module.exports = {
  startGame,
  submitWord,
  setEarlySubmitter,
  calculateScores,
  getGameState,
  resetGame,
};
