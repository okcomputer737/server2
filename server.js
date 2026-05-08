console.log("SERVER STARTED");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const { createRoom, addPlayer, removePlayer, getRoom, addScore, getPublicRooms, rooms } = require("./roomManager");
const { startGame, submitWord, setEarlySubmitter, calculateScores, getGameState, resetGame } = require("./gameEngine");
const { handleVote, getFinalVotes, clearVotes } = require("./voteEngine");
const neAlaka = require("./neAlakaEngine");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "web")));
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "index.html"));
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const debateReady  = {};
const scoreReady   = {};
const nextRoundLock = {};

function sysMsg(roomCode, text) {
  io.to(roomCode).emit("chat_message", { username: "", message: text, type: "system" });
}

function broadcastPublicRooms() {
  io.to("__public_lobby__").emit("public_rooms", getPublicRooms());
}

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
  broadcastPublicRooms();
}

io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);

  // ── PUBLIC LOBBY ──
  socket.on("join_public_lobby", () => {
    socket.join("__public_lobby__");
    socket.emit("public_rooms", getPublicRooms());
  });
  socket.on("leave_public_lobby", () => socket.leave("__public_lobby__"));

  // ── RECONNECT ──
  socket.on("reconnect_to_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) { socket.emit("reconnect_failed", { message: "Oda bulunamadı veya süresi doldu" }); return; }
    const player = room.players.find(p => p.userId === userId);
    if (!player) { socket.emit("reconnect_failed", { message: "Oyuncu bulunamadı" }); return; }

    socket.data.userId = userId;
    socket.data.username = player.username;
    player.id = socket.id;
    socket.join(roomCode);

    const gs = getGameState(roomCode);
    socket.emit("reconnect_success", { roomCode, gameState: gs, roomType: room.type, settings: room.settings });
    if (gs?.phase === "play") socket.emit("game_state", gs);
    broadcastRoomUpdate(roomCode);
    sysMsg(roomCode, `${player.username} geri döndü.`);
    console.log(`🔄 Reconnect: "${player.username}" → ${roomCode}`);
  });

  // ── ODA OLUŞTUR ──
  socket.on("create_room", ({ username, type, theme, roundTime, scoreLimit, userId }) => {
    if (!username?.trim()) { socket.emit("error", { message: "Kullanıcı adı boş olamaz" }); return; }
    if (username.trim().length > 16) { socket.emit("error", { message: "Kullanıcı adı en fazla 16 karakter" }); return; }
    const uid = userId || socket.id;
    socket.data.userId = uid;
    socket.data.username = username.trim();
    const room = createRoom(socket, username, type, uid);
    room.settings = { theme: theme || "classic", roundTime: roundTime || 10, scoreLimit: scoreLimit || 250 };
    socket.join(room.code);
    console.log(`🏠 Room created: ${room.code} by "${username}" (${type})`);
    socket.emit("room_created", { code: room.code, type: room.type });
    broadcastRoomUpdate(room.code);
  });

  // ── ODAYA KATIL ──
  socket.on("join_room", ({ username, code, userId }) => {
    if (!username?.trim()) { socket.emit("error", { message: "Kullanıcı adı boş olamaz" }); return; }
    if (username.trim().length > 16) { socket.emit("error", { message: "Kullanıcı adı en fazla 16 karakter" }); return; }
    const room = getRoom(code);
    if (!room) { socket.emit("error", { message: "Oda bulunamadı: " + code }); return; }

    const gs = getGameState(code);
    if (gs && (gs.phase === "play" || gs.phase === "debate")) {
      socket.emit("error", { message: "Bu odada oyun devam ediyor, şu an katılamazsın." });
      return;
    }
    if (room.type === "ne_alaka" && room.players.length >= 5) {
      socket.emit("error", { message: "Bu odaya en fazla 5 kişi katılabilir." });
      return;
    }

    const uid = userId || socket.id;
    socket.data.userId = uid;
    socket.data.username = username.trim();
    addPlayer(room, socket, username, uid);
    room.settings = room.settings || { theme: "classic", roundTime: 10, scoreLimit: 250 };
    socket.join(code);
    console.log(`🚪 "${username}" joined ${code}`);
    socket.emit("room_joined", { code: room.code, type: room.type, settings: room.settings });
    broadcastRoomUpdate(code);
    sysMsg(code, `${username.trim()} odaya katıldı.`);
  });

  // ── ROOM STATE ──
  socket.on("request_room_state", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    socket.emit("room_update", {
      code: room.code, type: room.type, players: room.players,
      settings: room.settings, readyPlayers: Array.from(room.readyPlayers || []),
    });
  });

  // ── ODADAN ÇIKIŞ (kasıtlı) ──
  socket.on("leave_room", ({ roomCode }) => {
    const uid = socket.data.userId;
    const uname = socket.data.username || "?";
    const room = getRoom(roomCode);
    if (!room) return;
    room.players = room.players.filter(p => p.userId !== uid);
    room.readyPlayers?.delete(uid);
    if (room.scores) delete room.scores[uid];
    socket.leave(roomCode);
    sysMsg(roomCode, `${uname} odadan ayrıldı.`);
    if (room.players.length === 0) {
      setTimeout(() => {
        const r = getRoom(roomCode);
        if (r && r.players.length === 0) delete rooms[roomCode];
        broadcastPublicRooms();
      }, 10000);
    } else {
      broadcastRoomUpdate(roomCode);
    }
    broadcastPublicRooms();
  });

  // ── TEKRAR OYNA ──
  socket.on("play_again", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    room.players.forEach(p => { p.score = 0; if (room.scores) room.scores[p.userId] = 0; });
    room.readyPlayers = new Set();
    if (debateReady[roomCode]) debateReady[roomCode] = new Set();
    if (scoreReady[roomCode]) scoreReady[roomCode] = new Set();
    resetGame(roomCode);
    io.to(roomCode).emit("room_reset", { code: roomCode });
    broadcastRoomUpdate(roomCode);
    console.log(`🔄 play_again: ${roomCode}`);
  });

  // ── LOBBY READY ──
  socket.on("toggle_ready", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const uid = socket.data.userId;
    if (room.readyPlayers.has(uid)) room.readyPlayers.delete(uid);
    else room.readyPlayers.add(uid);
    broadcastRoomUpdate(roomCode);

    if (room.players.length >= 1 && room.players.every(p => room.readyPlayers.has(p.userId))) {
      console.log(`🚀 All ready in ${roomCode}, auto-starting (type=${room.type})...`);
      setTimeout(() => {
        if (room.type === "ne_alaka") neAlaka.startRound(io, roomCode, room);
        else startGame(io, roomCode, room);
      }, 800);
    }
  });

  // ── MANUEL BAŞLAT ──
  socket.on("start_game", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.type === "ne_alaka") neAlaka.startRound(io, roomCode, room);
    else startGame(io, roomCode, room);
  });

  // ── KELİME GÖNDER ──
  socket.on("submit_words", ({ roomCode, words }) => {
    const userId = socket.data.userId;
    if (!userId) return;
    submitWord(roomCode, userId, words);
    if (words.some(w => w)) console.log(`📝 words uid="${userId}": ${JSON.stringify(words)}`);
  });

  // ── BONUSLU GÖNDER ──
  socket.on("bonus_submit", ({ roomCode, words }) => {
    const userId = socket.data.userId;
    if (!userId) return;
    submitWord(roomCode, userId, words);
    setEarlySubmitter(roomCode, userId);
    console.log(`⭐ bonus_submit uid="${userId}": ${JSON.stringify(words)}`);
  });

  // ── NE ALAKA SUBMIT ──
  socket.on("ne_alaka_submit", ({ roomCode, answers }) => {
    const userId = socket.data.userId;
    if (!userId) return;
    neAlaka.submitAnswers(roomCode, userId, answers);
  });

  // ── OY VER ──
  socket.on("vote_cell", ({ roomCode, targetPlayerId, columnIndex }) => {
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

    io.to(roomCode).emit("debate_ready_update", {
      readyCount: debateReady[roomCode].size,
      totalCount: room.players.length,
      readyPlayers: Array.from(debateReady[roomCode]),
    });

    if (debateReady[roomCode].size >= room.players.length) {
      debateReady[roomCode] = new Set();
      _finishAndScore(io, roomCode, room);
    }
  });

  // ── DEBATE BİTTİ ──
  socket.on("finish_debate", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (debateReady[roomCode]) debateReady[roomCode] = new Set();
    _finishAndScore(io, roomCode, room);
  });

  // ── SKOR READY ──
  socket.on("score_ready", (roomCode) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const uid = socket.data.userId;
    if (!scoreReady[roomCode]) scoreReady[roomCode] = new Set();
    scoreReady[roomCode].add(uid);

    console.log(`🏁 score_ready: ${uid} | ${scoreReady[roomCode].size}/${room.players.length}`);
    io.to(roomCode).emit("score_ready_update", {
      readyCount: scoreReady[roomCode].size,
      totalCount: room.players.length,
    });

    if (scoreReady[roomCode].size >= room.players.length) {
      if (nextRoundLock[roomCode]) return;
      nextRoundLock[roomCode] = true;
      setTimeout(() => { delete nextRoundLock[roomCode]; }, 3000);
      scoreReady[roomCode] = new Set();
      room.readyPlayers = new Set();
      if (debateReady[roomCode]) debateReady[roomCode] = new Set();
      startGame(io, roomCode, room);
    }
  });

  // ── CHAT ──
  socket.on("chat_message", ({ roomCode, message }) => {
    const username = socket.data.username || "?";
    io.to(roomCode).emit("chat_message", { username, message, timestamp: Date.now() });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    const userId = socket.data.userId;
    const username = socket.data.username;
    if (userId && username) {
      for (const code of Object.keys(rooms)) {
        const room = rooms[code];
        if (room?.players.some(p => p.userId === userId)) {
          sysMsg(code, `${username} bağlantısı kesildi.`);
          break;
        }
      }
    }
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

  const scoreLimit = room.settings?.scoreLimit || 250;
  const qualified = room.players.filter(p => p.score >= scoreLimit);
  const winner = qualified.sort((a, b) => b.score - a.score)[0];

  if (winner) {
    console.log(`🏆 Winner: ${winner.username}`);
    io.to(roomCode).emit("game_over", {
      winner: winner.username,
      scores: room.players.map(p => ({ username: p.username, score: p.score })),
    });
  } else {
    const totalScores = room.players.map(p => ({ userId: p.userId, username: p.username, score: p.score }));
    io.to(roomCode).emit("score_update", { roundScores, totalScores });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Running on ${PORT}`));
