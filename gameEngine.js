let gameState = {};
let timers = {};
let submissions = {};

const LETTERS = "ABCDEFGHIJKLMNOPRSTUVYZÇĞİÖŞÜ";
const THEMES = {
  classic: ["İsim", "Şehir", "Hayvan", "Bitki", "Eşya"],
  fame: ["Şarkıcı", "Oyuncu", "Sporcu", "İnfluencer", "Ünlü"],
};

// =====================
// START GAME
// =====================
function startGame(io, roomCode, room) {
  if (!room || !room.players?.length) return;

  // reset round data
  submissions[roomCode] = {};

  const settings = room.settings || {};
  const columns = THEMES[settings.theme || "classic"];

  // DÜZELTME: letter tanımlanmadığı için hata veriyordu, şimdi rastgele seçiliyor
  const letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];

  gameState[roomCode] = {
    phase: "play",
    letter,
    time: settings.roundTime || 10,
    theme: settings.theme || "classic",
    columns,
    round: (gameState[roomCode]?.round || 0) + 1,
  };

  io.to(roomCode).emit("game_state", gameState[roomCode]);

  startTimer(io, roomCode, room);
}

// =====================
// SUBMIT WORD (PLAY PHASE)
// =====================
function submitWord(roomCode, userId, payload) {
  if (!submissions[roomCode]) submissions[roomCode] = {};
  submissions[roomCode][userId] = payload;
}

// =====================
// TIMER
// =====================
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

// =====================
// DEBATE PHASE
// =====================
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

      // Yanlış harfle başlayan kelimeleri işaretle
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

// =====================
// SCORE HESAPLAMA
// =====================
function calculateScores(roomCode, invalidCells, room) {
  const subs = submissions[roomCode] || {};
  const state = gameState[roomCode];
  if (!state) return {};

  const columns = state.columns;
  const scores = {};

  // Her oyuncuya 0'dan başla
  room.players.forEach((p) => {
    scores[p.userId] = 0;
  });

  // Her sütun için ayrı ayrı hesapla
  columns.forEach((col, colIndex) => {
    // Bu sütundaki geçerli cevapları topla
    const validAnswers = [];

    room.players.forEach((p) => {
      const playerSub = subs[p.userId];
      const word = playerSub ? playerSub[colIndex] : "";
      const cellId = p.userId + "_" + colIndex;
      const isInvalid = invalidCells && invalidCells[cellId]?.isInvalid;
      const isWrongLetter = word.trim() !== "" && word.trim()[0]?.toUpperCase() !== state.letter;

      if (!word || word.trim() === "" || isInvalid || isWrongLetter) return;

      validAnswers.push({ userId: p.userId, word: word.trim().toLowerCase() });
    });

    // Benzerlik kontrolü: %70 benzer kelimeler varsa baz puan 5'e düşer
    const similarGroups = findSimilarGroups(validAnswers);

    validAnswers.forEach(({ userId, word }) => {
      // Bu kelime benzer grup içinde mi?
      const isSimilar = similarGroups.some(
        (group) => group.length > 1 && group.includes(userId)
      );

      const baseScore = isSimilar ? 5 : 10;

      // Geçerli kelime başına ekstra puan: (geçerli kelime sayısı - 1) * 5
      // Yani 2 geçerli varsa 5 ekstra, 3 geçerli varsa 10 ekstra gibi
      const validCount = validAnswers.length;
      const bonus = (validCount - 1) * 5;

      scores[userId] = (scores[userId] || 0) + baseScore + bonus;
    });
  });

  return scores;
}

// İki kelimenin benzerlik oranını hesapla (Levenshtein mesafesi)
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
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
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

// =====================
// EXPORT
// =====================
module.exports = {
  startGame,
  submitWord,
  calculateScores,
};
