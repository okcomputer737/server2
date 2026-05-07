let gameState = {};
let timers = {};
let submissions = {};
let earlySubmitters = {}; // roomCode → Set<userId>

const LETTERS = "ABCDEFGHIJKLMNOPRSTUVYZÇİÖŞÜ"; // Ğ kaldırıldı
const THEMES = {
  classic: ["İsim", "Şehir", "Hayvan", "Bitki", "Eşya"],
  fame: ["Şarkıcı", "Oyuncu", "Sporcu", "İnfluencer", "Ünlü"],
};

function startGame(io, roomCode, room) {
  if (!room || !room.players?.length) return;

  submissions[roomCode] = {};
  earlySubmitters[roomCode] = new Set();

  const settings = room.settings || {};
  const columns = THEMES[settings.theme || "classic"];
  const letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  const nextRound = (gameState[roomCode]?.round || 0) + 1;

  // Geri sayım ekranı için önce countdown eventi gönder
  io.to(roomCode).emit("game_countdown", { letter, columns, round: nextRound });

  // 3 saniye sonra gerçek oyunu başlat
  setTimeout(() => {
    if (!room.players?.length) return;
    gameState[roomCode] = {
      phase: "play",
      letter,
      time: settings.roundTime || 10,
      theme: settings.theme || "classic",
      columns,
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
  if (timers[roomCode]) {
    clearInterval(timers[roomCode]);
    delete timers[roomCode];
  }

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

function startDebate(io, roomCode, room) {
  const state = gameState[roomCode];
  if (!state) return;

  state.phase = "debate";

  const subs = submissions[roomCode] || {};
  const similarCells = {};
  const wrongLetterCells = {};

  state.columns.forEach((col, colIndex) => {
    const colAnswers = [];
    room.players.forEach((p) => {
      const playerSub = subs[p.userId];
      const word = playerSub ? playerSub[colIndex] : "";
      if (!word || word.trim() === "") return;

      if (word.trim()[0]?.toUpperCase() !== state.letter) {
        wrongLetterCells[`${p.userId}_${colIndex}`] = true;
      } else {
        colAnswers.push({ userId: p.userId, word: word.trim().toLowerCase() });
      }
    });
    findSimilarGroups(colAnswers).forEach((group) => {
      group.forEach((userId) => {
        similarCells[`${userId}_${colIndex}`] = true;
      });
    });
  });

  io.to(roomCode).emit("round_end", {
    phase: "debate",
    theme: state.theme,
    letter: state.letter,
    columns: state.columns,
    submissions: submissions[roomCode] || {},
    players: room.players,
    similarCells,
    wrongLetterCells,
  });
}

function calculateScores(roomCode, invalidCells, room) {
  const subs = submissions[roomCode] || {};
  const state = gameState[roomCode];
  if (!state) return {};

  const columns = state.columns;
  const scores = {};
  const bonusIssues = {}; // userId → true if any issue exists

  room.players.forEach((p) => {
    scores[p.userId] = 0;
    bonusIssues[p.userId] = false;
  });

  columns.forEach((col, colIndex) => {
    const validAnswers = [];

    room.players.forEach((p) => {
      const playerSub = subs[p.userId];
      const word = playerSub ? playerSub[colIndex] : "";
      const cellId = p.userId + "_" + colIndex;
      const isInvalid = invalidCells && invalidCells[cellId]?.isInvalid;
      const isWrongLetter = word && word.trim() !== "" && word.trim()[0]?.toUpperCase() !== state.letter;

      if (!word || word.trim() === "" || isInvalid || isWrongLetter) {
        bonusIssues[p.userId] = true;
        return;
      }

      validAnswers.push({ userId: p.userId, word: word.trim().toLowerCase() });
    });

    const similarGroups = findSimilarGroups(validAnswers);

    validAnswers.forEach(({ userId }) => {
      const isSimilar = similarGroups.some(
        (group) => group.length > 1 && group.includes(userId)
      );

      if (isSimilar) bonusIssues[userId] = true;

      const baseScore = isSimilar ? 5 : 10;
      const bonus = (validAnswers.length - 1) * 5;
      scores[userId] = (scores[userId] || 0) + baseScore + bonus;
    });
  });

  // Bonuslu Gönder: +25 veya -10
  const bonusPlayers = earlySubmitters[roomCode] || new Set();
  bonusPlayers.forEach(userId => {
    if (!bonusIssues[userId]) {
      scores[userId] = (scores[userId] || 0) + 25;
    } else {
      scores[userId] = (scores[userId] || 0) - 10;
    }
  });

  return scores;
}

function similarity(a, b) {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  const longerLength = longer.length;
  if (longerLength === 0) return 1;
  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

function editDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
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
      if (similarity(a.word, b.word) >= 0.8) {
        group.push(b.userId);
        used.add(j);
      }
    });
    if (group.length > 1) {
      groups.push(group);
      used.add(i);
    }
  });

  return groups;
}

module.exports = {
  startGame,
  submitWord,
  setEarlySubmitter,
  calculateScores,
};
