const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
// pingTimeout mais alto do que o padrão: dá mais tempo pro cliente responder antes de
// ser considerado desconectado — ajuda bastante em celular (tela travada/app em
// segundo plano, que o navegador desacelera bastante) e Wi-Fi instável.
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

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
const WAITING_VOICE_ROOM = 'waiting-room';
const WAITING_TEXT_ROOM = 'waiting-room-text';
const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'geral', type: 'text', undeletable: true, locked: true },
  { id: WAITING_TEXT_ROOM, name: 'sala-de-espera', type: 'text', undeletable: true, locked: true },
  { id: WAITING_VOICE_ROOM, name: 'Sala de Espera', type: 'voice', undeletable: true, locked: true },
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

// Se o servidor já tinha um channels.json de antes (sem a Sala de Espera), acrescenta
// os canais fixos que estiverem faltando, sem mexer no resto que já existia.
DEFAULT_CHANNELS.forEach(defCh => {
  if (!channels.some(c => c.id === defCh.id)) channels.push({ ...defCh });
});

// Corrige a ordem em servidores que já tinham channels.json salvo de antes: a Sala de
// Espera (voz) sempre deve aparecer ACIMA do Lobby na lista.
(function reorderWaitingRoomBeforeLobby() {
  const waitIdx = channels.findIndex(c => c.id === WAITING_VOICE_ROOM);
  const lobbyIdx = channels.findIndex(c => c.id === 'lobby');
  if (waitIdx !== -1 && lobbyIdx !== -1 && waitIdx > lobbyIdx) {
    const [waitingRoomChannel] = channels.splice(waitIdx, 1);
    const newLobbyIdx = channels.findIndex(c => c.id === 'lobby');
    channels.splice(newLobbyIdx, 0, waitingRoomChannel);
  }
})();

function saveChannels() {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
  } catch (e) {
    console.error('Não foi possível salvar channels.json', e);
  }
}
saveChannels();

// ---------- Cargos (Owner / Moderador / Membro / Guest) ----------
// Guest é travado na Sala de Espera até um Moderador ou Owner dar um cargo a ele.
// Pra virar Owner, a pessoa digita "!owner SEU_CODIGO" em qualquer chat — sem precisar
// ser o primeiro a se cadastrar (isso causava confusão em testes: uma conta de teste
// qualquer virava Owner sem querer).
const ROLES_FILE = path.join(__dirname, 'roles.json');

// IMPORTANTE: troque esse código (ou, melhor ainda, defina a variável de ambiente
// OWNER_CLAIM_CODE no seu serviço de hospedagem) antes de divulgar o servidor —
// quem souber o código digitado no chat vira Owner na hora.
const OWNER_CLAIM_CODE = process.env.OWNER_CLAIM_CODE || '08&Das!\\75';
if (!process.env.OWNER_CLAIM_CODE) {
  console.log(`[DSpeak] Nenhuma variável de ambiente OWNER_CLAIM_CODE definida — usando o código padrão "${OWNER_CLAIM_CODE}". Recomendo definir a sua própria.`);
}

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

// Retorna o cargo de um usuário, criando-o como 'guest' (padrão pra gente nova) na
// primeira vez que aparece.
function resolveRole(username) {
  const key = keyOf(username);
  if (!key) return 'guest';
  if (roles[key]) return roles[key];
  roles[key] = 'guest';
  saveRoles();
  return 'guest';
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
    socket.usernameKey = keyOf(data.username);

    const role = resolveRole(data.username);
    socket.role = role;
    socket.emit('your-role', { role, username: data.username });

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
    // Guest só pode acompanhar o texto da sala de espera.
    if (socket.role === 'guest' && roomId !== WAITING_TEXT_ROOM) return;
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
    // Comando secreto pra virar Owner: "!owner SEU_CODIGO". Nunca é salvo no
    // histórico nem retransmitido pro chat — só o autor recebe a confirmação —
    // assim o código não fica exposto pra quem ler o chat depois.
    const claimMatch = /^!owner\s+(.+)$/i.exec(String(data.message || '').trim());
    if (claimMatch) {
      if (claimMatch[1].trim() === OWNER_CLAIM_CODE) {
        const key = socket.usernameKey;
        if (key) {
          roles[key] = 'owner';
          saveRoles();
          socket.role = 'owner';
          syncRoleIntoVoiceLists(key, 'owner');
          io.emit('update-voice-users', voiceUsers);
          socket.emit('your-role', { role: 'owner', username: socket.username });
        }
      } else {
        socket.emit('owner-claim-failed');
      }
      return; // nunca vira mensagem de chat de verdade
    }

    // Guest só pode falar na sala de espera.
    if (socket.role === 'guest' && data.room !== WAITING_TEXT_ROOM) return;

    const entry = { ...data, role: socket.role, timestamp: Date.now() };
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

  // ---------- Criar / renomear / excluir canais (só o Owner pode) ----------
  socket.on('create-channel', (data) => {
    if (socket.role !== 'owner') return;
    const name = String(data && data.name || '').trim();
    const type = data && data.type;
    if (!name || (type !== 'text' && type !== 'voice')) return;

    const id = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    const channel = { id, name, type };
    if (type === 'voice') {
      const userLimit = parseInt(data && data.userLimit, 10);
      channel.userLimit = (Number.isFinite(userLimit) && userLimit > 0) ? userLimit : 0; // 0 = sem limite
      channel.noAudio = !!(data && data.noAudio); // sala silenciosa (tipo "AFK")
    }
    channels.push(channel);
    saveChannels();
    io.emit('channels-sync', channels);
  });

  // Renomeia e/ou ajusta limite de pessoas e "sala silenciosa" de um canal.
  socket.on('rename-channel', (data) => {
    if (socket.role !== 'owner') return;
    const channelId = data && data.channelId;
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return;

    const newName = String(data && data.newName || '').trim();
    if (newName && !ch.locked) ch.name = newName; // canais travados (ex: "geral") não podem ser renomeados

    if (ch.type === 'voice') {
      if (data && Object.prototype.hasOwnProperty.call(data, 'userLimit')) {
        const userLimit = parseInt(data.userLimit, 10);
        ch.userLimit = (Number.isFinite(userLimit) && userLimit > 0) ? userLimit : 0;
      }
      if (data && Object.prototype.hasOwnProperty.call(data, 'noAudio')) {
        ch.noAudio = !!data.noAudio;
      }
    }

    saveChannels();
    io.emit('channels-sync', channels);
  });

  socket.on('delete-channel', (channelId) => {
    if (socket.role !== 'owner') return;
    const ch = channels.find(c => c.id === channelId);
    if (!ch || ch.undeletable) return; // "geral" e "Lobby" nunca podem ser excluídos
    if (channels.length <= 1) return;

    channels = channels.filter(c => c.id !== channelId);
    delete messages[channelId];
    saveChannels();
    saveMessages();
    io.emit('channels-sync', channels);
  });

  // ---------- Gestão de cargos ----------
  // Owner: pode dar qualquer cargo (guest / member / moderator) a qualquer um.
  // Moderador: só pode promover Guest -> Membro.
  socket.on('assign-role', (data) => {
    const targetUsername = data && data.targetUsername;
    const newRole = data && data.newRole;
    const validRoles = ['guest', 'member', 'moderator', 'owner'];
    if (!validRoles.includes(newRole)) return;

    const targetKey = keyOf(targetUsername);
    if (!targetKey) return;
    const currentTargetRole = roles[targetKey] || 'guest';

    const isOwner = socket.role === 'owner';
    const isModPromotingGuestToMember =
      socket.role === 'moderator' && newRole === 'member' && currentTargetRole === 'guest';

    if (!isOwner && !isModPromotingGuestToMember) return;
    // Só o próprio Owner pode mexer em outro Owner (inclusive dar ou tirar o cargo).
    if (currentTargetRole === 'owner' && !isOwner) return;
    // Só o Owner pode conceder o cargo de Owner (Mod nunca, mesmo que a checagem
    // acima já bloqueie isso indiretamente — reforça a intenção explicitamente).
    if (newRole === 'owner' && !isOwner) return;

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
  socket.on('pull-user-to-room', (data) => {
    if (socket.role !== 'owner' && socket.role !== 'moderator') return;
    const targetSocketId = data && data.targetSocketId;
    const channelId = data && data.channelId;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    // Moderador não pode puxar um Owner — só o próprio Owner mexe em outro Owner.
    if (targetSocket.role === 'owner' && socket.role !== 'owner') return;
    targetSocket.emit('force-join-voice', { channelId });
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

    const alreadyThere = voiceUsers[channelId].some(u => u.socketId === socket.id);
    const channelDef = channels.find(c => c.id === channelId);
    const limit = channelDef ? (channelDef.userLimit || 0) : 0;

    if (!alreadyThere && limit > 0 && voiceUsers[channelId].length >= limit) {
      socket.emit('voice-room-full', { channelId, name: channelDef ? channelDef.name : channelId, limit });
      return;
    }

    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    voiceUsers[channelId].push({
      socketId: socket.id,
      name: username,
      avatarUrl,
      muted: !!socket.currentMuted,
      deafened: !!socket.currentDeafened,
      role: socket.role
    });

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
    if (socket.role === 'guest' || channelId === WAITING_VOICE_ROOM) return;
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
