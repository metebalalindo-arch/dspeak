const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const voiceUsers = {}; 
const activeRoomStreams = {};

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('register-user', (data) => {
    socket.username = data.username;
    socket.avatarUrl = data.avatarUrl;
  });

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('chat-message', (data) => {
    io.to(data.room).emit('chat-message', data);
  });

  socket.on('join-voice-room', (data) => {
    const { channelId, username, avatarUrl } = data;
    if (!voiceUsers[channelId]) voiceUsers[channelId] = [];
    
    voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    voiceUsers[channelId].push({ socketId: socket.id, name: username, avatarUrl });
    
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
