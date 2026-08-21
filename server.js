const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Permite envio de fotos de perfil via Base64 (até 10MB)
});

// Serve os arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Armazena usuários nos canais de voz
const voiceUsers = {};

io.on('connection', (socket) => {
  console.log(`Usuário conectado: ${socket.id}`);

  // Entrar em uma sala de texto
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  // Mensagens do chat de texto
  socket.on('chat-message', (data) => {
    if (data.room) {
      io.to(data.room).emit('chat-message', data);
    }
  });

  // Teste de Ping / Latência
  socket.on('ping-check', (callback) => {
    if (typeof callback === 'function') callback();
  });

  // Entrar em um canal de voz
  socket.on('join-voice-room', (data) => {
    const { channelId, username, gradient, avatar } = data;

    if (!voiceUsers[channelId]) {
      voiceUsers[channelId] = [];
    }

    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);

    voiceUsers[channelId].push({
      socketId: socket.id,
      name: username,
      gradient: gradient,
      avatar: avatar || null,
      isStreaming: false
    });

    socket.currentVoiceChannel = channelId;
    io.emit('update-voice-users', voiceUsers);
  });

  // Atualizar status de transmissão ao vivo (AO VIVO)
  socket.on('update-streaming-status', (statusData) => {
    const { channelId, isStreaming } = statusData;
    if (channelId && voiceUsers[channelId]) {
      const user = voiceUsers[channelId].find(u => u.socketId === socket.id);
      if (user) {
        user.isStreaming = isStreaming;
        io.emit('update-voice-users', voiceUsers);
      }
    }
  });

  // Relay de sinalização WebRTC para vídeo/transmissão na sala
  socket.on('webrtc-signal', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-signal', {
      senderSocketId: socket.id,
      signal: data.signal
    });
  });

  // Sair de um canal de voz
  socket.on('leave-voice-room', (data) => {
    const channelId = data?.channelId || socket.currentVoiceChannel;
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      delete socket.currentVoiceChannel;
      io.emit('update-voice-users', voiceUsers);
    }
  });

  // Desconexão geral
  socket.on('disconnect', () => {
    console.log(`Usuário desconectado: ${socket.id}`);
    if (socket.currentVoiceChannel && voiceUsers[socket.currentVoiceChannel]) {
      voiceUsers[socket.currentVoiceChannel] = voiceUsers[socket.currentVoiceChannel].filter(
        u => u.socketId !== socket.id
      );
      io.emit('update-voice-users', voiceUsers);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor DSpeak rodando na porta ${PORT}`);
});
