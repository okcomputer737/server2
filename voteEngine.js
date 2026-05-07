let voteBuffer = {};
let voteTimers = {};

function handleVote(io, room, roomCode, socket, targetPlayerId, columnIndex) {
  const cellId = targetPlayerId + "_" + columnIndex;

  if (!voteBuffer[roomCode]) voteBuffer[roomCode] = {};
  if (!voteBuffer[roomCode][cellId]) {
    voteBuffer[roomCode][cellId] = new Set();
  }

  const votes = voteBuffer[roomCode][cellId];

  // Aynı kişi tekrar basarsa oyunu geri alır (toggle)
  if (votes.has(socket.id)) {
    votes.delete(socket.id);
  } else {
    votes.add(socket.id);
  }

  // DÜZELTME: timer zaten varsa yeniden oluşturma, bekle
  if (voteTimers[roomCode]) return;

  voteTimers[roomCode] = setTimeout(() => {
    // DÜZELTME: flush başlamadan önce timer'ı temizle
    voteTimers[roomCode] = null;
    flushVotes(io, room, roomCode);
  }, 1000);
}

function flushVotes(io, room, roomCode) {
  const buffer = voteBuffer[roomCode];
  if (!buffer) return;

  const result = {};

  Object.keys(buffer).forEach((cellId) => {
    const votes = Array.from(buffer[cellId]);

    // Çoğunluk oylarsa geçersiz: oyuncu sayısının yarısından fazlası
    const isInvalid =
      votes.length >= Math.floor(room.players.length / 2) + 1;

    result[cellId] = {
      votes,
      isInvalid,
    };
  });

  io.to(roomCode).emit("vote_update", result);
}

// Oylamanın son halini döndür (score hesaplaması için)
function getFinalVotes(roomCode) {
  return voteBuffer[roomCode] || {};
}

// Round bitince buffer'ı temizle
function clearVotes(roomCode) {
  voteBuffer[roomCode] = {};
  if (voteTimers[roomCode]) {
    clearTimeout(voteTimers[roomCode]);
    voteTimers[roomCode] = null;
  }
}

module.exports = {
  handleVote,
  getFinalVotes,
  clearVotes,
};
