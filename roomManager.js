let rooms = {};

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function createRoom(socket, username, type, userId, theme = "classic", roundTime = 30) {
  const code = generateRoomCode();

  rooms[code] = {
    code,
    type,
    players: [],
    scores: {},   // round'lar arası birikimli skor
    readyPlayers: new Set(),
    settings: {
      theme,
      roundTime,
      scoreLimit: 100,   // varsayılan kazanma skoru
    },
  };

  addPlayer(rooms[code], socket, username, userId);

  return rooms[code];
}

function addPlayer(room, socket, username, userId) {
  // Aynı userId varsa güncelle (reconnect durumu)
  room.players = room.players.filter((p) => p.userId !== userId);

  room.players.push({
    id: socket.id,
    userId,
    username,
    score: 0,
  });

  // Skor tablosuna da ekle
  if (room.scores[userId] === undefined) {
    room.scores[userId] = 0;
  }
}

function removePlayer(socket) {
  const userId = socket.data.userId;
  if (!userId) return;

  for (let code in rooms) {
    const room = rooms[code];
    if (!room) continue;

    const isInRoom = room.players.some((p) => p.userId === userId);
    if (!isInRoom) continue;

    // 30 saniye bekle — telefon kapandı/bağlantı koptu durumunda reconnect için süre tanı
    setTimeout(() => {
      const room = rooms[code];
      if (!room) return;

      room.players = room.players.filter((p) => p.userId !== userId);

      if (room.players.length === 0) {
        delete rooms[code];
      }
    }, 30000);
  }
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter((r) => r.type === "public")
    .map((r) => ({
      code: r.code,
      playerCount: r.players.length,
      players: r.players.map((p) => p.username),
      theme: r.settings?.theme || "classic",
      roundTime: r.settings?.roundTime || 10,
      scoreLimit: r.settings?.scoreLimit || 100,
    }));
}

function getRoom(code) {
  return rooms[code];
}

// Oyuncunun birikimli skorunu güncelle
function addScore(roomCode, userId, points) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.scores[userId] === undefined) room.scores[userId] = 0;
  room.scores[userId] += points;

  // players listesindeki score'u da güncelle
  const player = room.players.find((p) => p.userId === userId);
  if (player) player.score = room.scores[userId];
}

module.exports = {
  createRoom,
  addPlayer,
  removePlayer,
  getRoom,
  addScore,
  getPublicRooms,
  rooms,
};
