console.log("SERVER STARTED");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const { createRoom, addPlayer, removePlayer, getRoom, addScore } = require("./roomManager");
const { startGame, submitWord, calculateScores } = require("./gameEngine");
const { handleVote, getFinalVotes, clearVotes } = require("./voteEngine");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Debate ready takibi
const debateReady = {}; // roomCode → Set<userId>

function broadcastRoomUpdate(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit("room_update", {
    code: room.code,
    type: room.type,
    players: room.players,
    settings: room.settings,
    readyPlayers: Array.from(room.readyPlayers || []),
  });
}

io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);

  // ── ODA OLUŞTUR ──
  socket.on("create_room", ({ username, type, theme, roundTime, scoreLimit, userId }) => {
    if (!username || username.trim().length === 0) { socket.emit("error", { message: "Kullanıcı adı boş olamaz" }); return; }
    if (username.trim().length > 16) { socket.emit("error", { message: "Kullanıcı adı en fazla 16 karakter olabilir" }); return; }
    const uid = userId || socket.id;
    socket.data.userId = uid;
    socket.data.username = username.trim();
    const room = createRoom(socket, username, type, uid);
    room.settings = { theme: theme || "classic", roundTime: roundTime || 10, scoreLimit: scoreLimit || 100 };
    socket.join(room.code);
    console.log(`🏠 Room created: ${room.code} by "${username}"`);
    socket.emit("room_created", { code: room.code, type: room.type });
    broadcastRoomUpdate(room.code);
  });

  // ── ODAYA KATIL ──
  socket.on("join_room", ({ username, code, userId }) => {
    if (!username || username.trim().length === 0) { socket.emit("error", { message: "Kullanıcı adı boş olamaz" }); return; }
    if (username.trim().length > 16) { socket.emit("error", { message: "Kullanıcı adı en fazla 16 karakter olabilir" }); return; }
    const room = getRoom(code);
    if (!room) { socket.emit("error", { message: "Oda bulunamadı: " + code }); return; }
    const uid = userId || socket.id;
    socket.data.userId = uid;
    socket.data.username = username.trim();
    addPlayer(room, socket, username, uid);
    room.settings = room.settings || { theme: "classic", roundTime: 10, scoreLimit: 100 };
    socket.join(code);
    console.log(`🚪 "${username}" joined ${code} | players: ${room.players.map(p => p.username)}`);
    socket.emit("room_joined", { code: room.code, type: room.type, settings: room.settings });
    broadcastRoomUpdate(code);
  });

  // ── ROOM STATE İSTE ──
  socket.on("request_room_state", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    console.log(`🔄 request_room_state for ${roomCode} by ${socket.id}`);
    socket.emit("room_update", {
      code: room.code, type: room.type, players: room.players,
      settings: room.settings, readyPlayers: Array.from(room.readyPlayers || []),
    });
  });

  // ── LOBBY READY ──
  socket.on("toggle_ready", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const uid = socket.data.userId;
    if (room.readyPlayers.has(uid)) room.readyPlayers.delete(uid);
    else room.readyPlayers.add(uid);
    console.log(`✅ ready toggle: ${uid} | ready: ${Array.from(room.readyPlayers)}`);
    broadcastRoomUpdate(roomCode);
    if (room.players.length >= 1 && room.players.every(p => room.readyPlayers.has(p.userId))) {
      console.log(`🚀 All ready in ${roomCode}, auto-starting...`);
      setTimeout(() => startGame(io, roomCode, room), 800);
    }
  });

  // ── MANUEL BAŞLAT ──
  socket.on("start_game", (roomCode) => {
    console.log(`🎮 start_game for ${roomCode}`);
    const room = getRoom(roomCode);
    if (!room) return;
    startGame(io, roomCode, room);
  });

  // ── KELİME GÖNDER (her değişiklikte çağrılır, üzerine yazar) ──
  socket.on("submit_words", ({ roomCode, words }) => {
    const userId = socket.data.userId;
    if (!userId) return;
    submitWord(roomCode, userId, words); // submitWord zaten üzerine yazıyor
    // Sadece boş olmayan submit'leri logla
    if (words.some(w => w)) console.log(`📝 words uid="${userId}": ${JSON.stringify(words)}`);
  });

  // ── OY VER ──
  socket.on("vote_cell", ({ roomCode, targetPlayerId, columnIndex }) => {
    console.log(`🗳️  vote: ${socket.id} → ${targetPlayerId}_${columnIndex}`);
    const room = getRoom(roomCode);
    if (!room) return;
    handleVote(io, room, roomCode, socket, targetPlayerId, columnIndex);
  });

  // ── DEBATE READY ──
  socket.on("debate_ready", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const uid = socket.data.userId;
    if (!debateReady[roomCode]) debateReady[roomCode] = new Set();
    debateReady[roomCode].add(uid);
    console.log(`🏁 debate_ready: ${uid} | ready: ${debateReady[roomCode].size}/${room.players.length}`);

    // Hazır sayısını herkese bildir
    io.to(roomCode).emit("debate_ready_update", {
      readyCount: debateReady[roomCode].size,
      totalCount: room.players.length,
      readyPlayers: Array.from(debateReady[roomCode]),
    });

    // Herkes hazırsa puanla ve sonraki round'a geç
    if (debateReady[roomCode].size >= room.players.length) {
      console.log(`✅ All debate ready in ${roomCode}, calculating scores...`);
      debateReady[roomCode] = new Set(); // sıfırla

      // Oylamaları bitir ve puanla
      _finishAndScore(io, roomCode, room);
    }
  });

  // ── DEBATE BİTTİ (manuel buton) ──
  socket.on("finish_debate", ({ roomCode }) => {
    console.log(`🏁 finish_debate for ${roomCode}`);
    const room = getRoom(roomCode);
    if (!room) return;
    if (debateReady[roomCode]) debateReady[roomCode] = new Set();
    _finishAndScore(io, roomCode, room);
  });

  // ── SONRAKI ROUND ──
  socket.on("next_round", (roomCode) => {
    console.log(`⏭️  next_round for ${roomCode}`);
    const room = getRoom(roomCode);
    if (!room) { console.log(`❌ room not found: ${roomCode}`); return; }
    room.readyPlayers = new Set();
    if (debateReady[roomCode]) debateReady[roomCode] = new Set();
    startGame(io, roomCode, room);
  });

  // ── CHAT ──
  socket.on("chat_message", ({ roomCode, message }) => {
    const username = socket.data.username || "?";
    console.log(`💬 [${roomCode}] ${username}: ${message}`);
    io.to(roomCode).emit("chat_message", { username, message, timestamp: Date.now() });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    removePlayer(socket);
  });
});

function _finishAndScore(io, roomCode, room) {
  const finalVotes = getFinalVotes(roomCode);
  const invalidCells = {};
  Object.keys(finalVotes).forEach((cellId) => {
    const votes = Array.from(finalVotes[cellId]);
    const isInvalid = votes.length >= Math.floor(room.players.length / 2) + 1;
    invalidCells[cellId] = { votes, isInvalid };
  });

  const roundScores = calculateScores(roomCode, invalidCells, room);
  console.log(`📊 Round scores: ${JSON.stringify(roundScores)}`);
  Object.entries(roundScores).forEach(([uid, pts]) => addScore(roomCode, uid, pts));
  clearVotes(roomCode);

  const winner = room.players.find(p => p.score >= (room.settings?.scoreLimit || 100));
  if (winner) {
    console.log(`🏆 Winner: ${winner.username}`);
    io.to(roomCode).emit("game_over", {
      winner: winner.username,
      scores: room.players.map(p => ({ username: p.username, score: p.score })),
    });
  } else {
    const totalScores = room.players.map(p => ({ userId: p.userId, username: p.username, score: p.score }));
    console.log(`📈 Scores: ${JSON.stringify(totalScores)}`);
    io.to(roomCode).emit("score_update", { roundScores, totalScores });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Running on ${PORT}`));
