const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const voiceUsers = {};
const activeRoomStreams = {};

// ---------- Item 4: Cargos (Owner / Moderador / Membro / Guest) ----------
// A "sala de espera" é fixa: todo Guest cai nela e não sai até ganhar um cargo.
const WAITING_VOICE_ROOM = 'waiting-room';
const WAITING_TEXT_ROOM = 'waiting-room-text';
const ROLES_FILE = path.join(__dirname, 'roles.json');

let roles = {}; // chave: username em minúsculas -> 'owner' | 'moderator' | 'member' | 'guest'
try {
  if (fs.existsSync(ROLES_FILE)) {
    roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Não foi possível ler roles.json, começando do zero.', e);
  roles = {};
}

function saveRoles() {
  try {
    fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
  } catch (e) {
    console.error('Não foi possível salvar roles.json', e);
  }
}

function keyOf(username) {
  return String(username || '').trim().toLowerCase();
}

function hasOwner() {
  return Object.values(roles).includes('owner');
}

// Retorna o cargo de um usuário, criando-o como 'owner' (se ainda não existe dono)
// ou 'guest' (padrão para gente nova) na primeira vez que aparece.
function resolveRole(username) {
  const key = keyOf(username);
  if (!key) return 'guest';
  if (roles[key]) return roles[key];
  const role = hasOwner() ? 'guest' : 'owner';
  roles[key] = role;
  saveRoles();
  return role;
}

function findSocketsByUsername(username) {
  const key = keyOf(username);
  const found = [];
  for (const [, s] of io.sockets.sockets) {
    if (s.usernameKey === key) found.push(s);
  }
  return found;
}

// Atualiza o campo "role" de um usuário em todas as listas de voz que ele estiver.
function syncRoleIntoVoiceLists(usernameKey, newRole) {
  Object.keys(voiceUsers).forEach(channelId => {
    voiceUsers[channelId] = voiceUsers[channelId].map(u =>
      keyOf(u.name) === usernameKey ? { ...u, role: newRole } : u
    );
  });
}

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('register-user', (data) => {
    socket.username = data.username;
    socket.avatarUrl = data.avatarUrl;
    socket.usernameKey = keyOf(data.username);

    const role = resolveRole(data.username);
    socket.role = role;

    socket.emit('your-role', { role, username: data.username });
  });

  socket.on('join-room', (roomId) => {
    // Guest só pode acompanhar o texto da sala de espera.
    if (socket.role === 'guest' && roomId !== WAITING_TEXT_ROOM) return;
    socket.join(roomId);
  });

  // Eco simples para medição de ping real (RTT) de cada cliente.
  // O cliente manda o timestamp e recebe de volta via callback (ack) do socket.io.
  socket.on('ping-check', (clientTime, callback) => {
    if (typeof callback === 'function') callback(clientTime);
  });

  socket.on('chat-message', (data) => {
    // Guest só pode falar na sala de espera.
    if (socket.role === 'guest' && data.room !== WAITING_TEXT_ROOM) return;
    io.to(data.room).emit('chat-message', { ...data, role: socket.role });
  });

  socket.on('join-voice-room', (data) => {
    let { channelId, username, avatarUrl } = data;

    // Guest é travado na sala de espera até alguém dar um cargo a ele.
    if (socket.role === 'guest' && channelId !== WAITING_VOICE_ROOM) {
      channelId = WAITING_VOICE_ROOM;
      socket.emit('guest-locked', {
        message: 'Você está como Guest e precisa aguardar na Sala de Espera até um Moderador ou Owner liberar seu acesso.'
      });
    }

    if (!voiceUsers[channelId]) voiceUsers[channelId] = [];

    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    voiceUsers[channelId].push({ socketId: socket.id, name: username, avatarUrl, role: socket.role });

    socket.currentVoiceChannel = channelId;
    socket.join(channelId);
    io.emit('update-voice-users', voiceUsers);

    // Se o cliente foi redirecionado à força pra sala de espera, avisa qual sala ele realmente entrou.
    if (channelId !== data.channelId) {
      socket.emit('voice-room-redirect', { channelId });
    }

    // Sincroniza transmissões ativas para quem acabou de entrar ou atualizar a página
    if (activeRoomStreams[channelId] && activeRoomStreams[channelId].length > 0) {
      socket.emit('sync-active-streams', activeRoomStreams[channelId]);
    }
  });

  socket.on('leave-voice-room', (data) => {
    const channelId = data.channelId || socket.currentVoiceChannel;
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      io.emit('update-voice-users', voiceUsers);
    }
  });

  socket.on('start-streaming', (channelId) => {
    if (!activeRoomStreams[channelId]) activeRoomStreams[channelId] = [];
    if (!activeRoomStreams[channelId].includes(socket.id)) {
      activeRoomStreams[channelId].push(socket.id);
    }
    socket.to(channelId).emit('user-started-streaming', socket.id);
  });

  socket.on('stop-streaming', (channelId) => {
    if (activeRoomStreams[channelId]) {
      activeRoomStreams[channelId] = activeRoomStreams[channelId].filter(id => id !== socket.id);
    }
    socket.to(channelId).emit('user-stopped-streaming', socket.id);
  });

  // Item 6: a live não abre sozinha para quem está assistindo.
  // O espectador só pede pra "entrar" na transmissão quando clica em "Assistir Live",
  // e é só nesse momento que quem está transmitindo manda as faixas de vídeo/áudio pra ele.
  socket.on('request-watch-stream', (data) => {
    io.to(data.targetSocketId).emit('watch-stream-requested', { requesterSocketId: socket.id });
  });

  socket.on('webrtc-offer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer: data.offer
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer: data.answer
    });
  });

  socket.on('webrtc-candidate', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-candidate', {
      senderSocketId: socket.id,
      candidate: data.candidate
    });
  });

  // ---------- Item 4: gestão de cargos ----------
  // Owner: pode dar qualquer cargo (guest / member / moderator) a qualquer um.
  // Moderador: só pode promover Guest -> Membro.
  socket.on('assign-role', ({ targetUsername, newRole }) => {
    const validRoles = ['guest', 'member', 'moderator'];
    if (!validRoles.includes(newRole)) return;

    const targetKey = keyOf(targetUsername);
    if (!targetKey) return;
    const currentTargetRole = roles[targetKey] || 'guest';

    const isOwner = socket.role === 'owner';
    const isModPromotingGuestToMember =
      socket.role === 'moderator' && newRole === 'member' && currentTargetRole === 'guest';

    if (!isOwner && !isModPromotingGuestToMember) return;
    if (currentTargetRole === 'owner') return; // ninguém rebaixa o Owner por aqui

    roles[targetKey] = newRole;
    saveRoles();
    syncRoleIntoVoiceLists(targetKey, newRole);
    io.emit('update-voice-users', voiceUsers);

    findSocketsByUsername(targetUsername).forEach(s => {
      s.role = newRole;
      s.emit('your-role', { role: newRole, username: s.username });
    });
  });

  // Owner/Moderador "puxam" alguém pra sala de voz em que estão agora.
  socket.on('pull-user-to-room', ({ targetSocketId, channelId }) => {
    if (socket.role !== 'owner' && socket.role !== 'moderator') return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('force-join-voice', { channelId });
    }
  });

  socket.on('disconnect', () => {
    Object.keys(activeRoomStreams).forEach(channelId => {
      activeRoomStreams[channelId] = activeRoomStreams[channelId].filter(id => id !== socket.id);
      socket.to(channelId).emit('user-stopped-streaming', socket.id);
    });

    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    });
    io.emit('update-voice-users', voiceUsers);
  });
});

server.listen(3000, () => console.log('Servidor DSpeak rodando na porta 3000'));
