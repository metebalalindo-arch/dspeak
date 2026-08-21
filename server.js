const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const voiceUsers = {};

io.on('connection', (socket) => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('chat-message', (data) => {
    if (data.room) {
      io.to(data.room).emit('chat-message', data);
    }
  });

  socket.on('ping-check', (callback) => {
    if (typeof callback === 'function') callback();
  });

  socket.on('join-voice-room', (data) => {
    const { channelId, username, avatarUrl } = data;

    if (!voiceUsers[channelId]) {
      voiceUsers[channelId] = [];
    }

    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);

    voiceUsers[channelId].push({
      socketId: socket.id,
      name: username,
      avatarUrl: avatarUrl || null,
      isStreaming: false
    });

    socket.currentVoiceChannel = channelId;
    socket.join(channelId);
    io.emit('update-voice-users', voiceUsers);
  });

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

  // Sinalização WebRTC para transmissão de vídeo/tela entre os membros da sala
  socket.on('webrtc-offer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer: data.offer,
      username: data.username
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

  socket.on('leave-voice-room', (data) => {
    const channelId = data?.channelId || socket.currentVoiceChannel;
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      delete socket.currentVoiceChannel;
      io.emit('update-voice-users', voiceUsers);
    }
  });

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
  console.log(`Servidor rodando na porta ${PORT}`);
});
