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

// ---------- Canais persistidos no servidor (compartilhados por todo mundo) ----------
// Antes, os canais só existiam localmente no navegador de cada pessoa: cada um via uma
// lista diferente e tudo sumia ao dar F5. Agora o servidor é a fonte da verdade: guarda
// em disco e manda a mesma lista pra todo mundo, sempre atualizada.
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'geral', type: 'text', undeletable: true, locked: true },
  { id: 'lobby', name: 'Lobby', type: 'voice', undeletable: true }
];

let channels = DEFAULT_CHANNELS;
try {
  if (fs.existsSync(CHANNELS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    if (Array.isArray(loaded) && loaded.length > 0) channels = loaded;
  }
} catch (e) {
  console.error('Não foi possível ler channels.json, usando os padrões.', e);
}

function saveChannels() {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
  } catch (e) {
    console.error('Não foi possível salvar channels.json', e);
  }
}

// ---------- Histórico de chat persistido, com expiração de 7 dias ----------
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

let messages = {}; // channelId -> [{ room, message, user, avatarUrl, time, date, timestamp }]
try {
  if (fs.existsSync(MESSAGES_FILE)) {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Não foi possível ler messages.json, começando do zero.', e);
  messages = {};
}

function saveMessages() {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (e) {
    console.error('Não foi possível salvar messages.json', e);
  }
}

function pruneChannelMessages(channelId) {
  if (!messages[channelId]) return;
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  messages[channelId] = messages[channelId].filter(m => m.timestamp >= cutoff);
}

function pruneAllMessages() {
  Object.keys(messages).forEach(pruneChannelMessages);
  saveMessages();
}

pruneAllMessages(); // limpa mensagens vencidas assim que o servidor sobe
setInterval(pruneAllMessages, 60 * 60 * 1000); // e a cada hora, mesmo sem mensagens novas

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('register-user', (data) => {
    socket.username = data.username;
    socket.avatarUrl = data.avatarUrl;

    // Manda pro cliente que acabou de entrar o retrato atual de quem já está
    // conectado nas salas de voz. Sem isso, ele só ficava sabendo quando alguém
    // MAIS entrava ou saía depois — por isso a lista ficava vazia até você mesmo
    // entrar numa sala (o que aí sim disparava uma atualização).
    socket.emit('update-voice-users', voiceUsers);

    // Manda a lista de canais atual (a mesma pra todo mundo, persistida em disco).
    socket.emit('channels-sync', channels);
  });

  // Atualiza apelido/avatar em tempo real pra todo mundo, sem precisar de F5.
  // Sem isso, só o rodapé de quem mudou o perfil atualizava (feito localmente);
  // a lista de voz e os cards do palco ficavam com os dados antigos até reconectar.
  socket.on('change-profile', (data) => {
    const { newName, avatarUrl } = data;
    socket.username = newName;
    socket.avatarUrl = avatarUrl;

    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, name: newName, avatarUrl } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
  });

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  // Avisa todo mundo quando alguém muta/desmuta ou ensurdece/desensurdece, pra
  // aparecer o iconezinho certo no avatar dessa pessoa pros outros também.
  socket.on('update-voice-status', (data) => {
    const muted = !!(data && data.muted);
    const deafened = !!(data && data.deafened);
    socket.currentMuted = muted;
    socket.currentDeafened = deafened;
    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, muted, deafened } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
  });

  // Eco simples para medição de ping real (RTT) de cada cliente.
  // O cliente manda o timestamp e recebe de volta via callback (ack) do socket.io.
  socket.on('ping-check', (clientTime, callback) => {
    if (typeof callback === 'function') callback(clientTime);
  });

  socket.on('chat-message', (data) => {
    const entry = { ...data, timestamp: Date.now() };
    if (!messages[data.room]) messages[data.room] = [];
    messages[data.room].push(entry);
    pruneChannelMessages(data.room);
    saveMessages();
    io.to(data.room).emit('chat-message', entry);
  });

  // Manda o histórico (até 7 dias) daquele canal só pra quem pediu, quando ele
  // entra ou troca de canal — é assim que o chat "individual por sala" sobrevive
  // a atualizações de página e é o mesmo pra todo mundo.
  socket.on('get-channel-history', (channelId) => {
    pruneChannelMessages(channelId);
    socket.emit('channel-history', { room: channelId, messages: messages[channelId] || [] });
  });

  // ---------- Criar / renomear / excluir canais (compartilhado com todo mundo) ----------
  socket.on('create-channel', (data) => {
    const name = String(data && data.name || '').trim();
    const type = data && data.type;
    if (!name || (type !== 'text' && type !== 'voice')) return;

    const id = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    channels.push({ id, name, type });
    saveChannels();
    io.emit('channels-sync', channels);
  });

  socket.on('rename-channel', (data) => {
    const channelId = data && data.channelId;
    const newName = String(data && data.newName || '').trim();
    if (!newName) return;

    const ch = channels.find(c => c.id === channelId);
    if (!ch || ch.locked) return; // canais travados (ex: "geral") não podem ser renomeados

    ch.name = newName;
    saveChannels();
    io.emit('channels-sync', channels);
  });

  socket.on('delete-channel', (channelId) => {
    const ch = channels.find(c => c.id === channelId);
    if (!ch || ch.undeletable) return; // "geral" e "Lobby" nunca podem ser excluídos
    if (channels.length <= 1) return;

    channels = channels.filter(c => c.id !== channelId);
    delete messages[channelId];
    saveChannels();
    saveMessages();
    io.emit('channels-sync', channels);
  });

  socket.on('join-voice-room', (data) => {
    const { channelId, username, avatarUrl } = data;
    if (!voiceUsers[channelId]) voiceUsers[channelId] = [];

    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    voiceUsers[channelId].push({
      socketId: socket.id,
      name: username,
      avatarUrl,
      muted: !!socket.currentMuted,
      deafened: !!socket.currentDeafened
    });

    socket.currentVoiceChannel = channelId;
    socket.join(channelId);
    io.emit('update-voice-users', voiceUsers);

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
