const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Permite envio de fotos de perfil via Base64 (até 10MB)
});

// Serve os arquivos estáticos (HTML, CSS, JS) da pasta public
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal apontando corretamente para o index.html dentro da pasta public
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Armazena a lista de usuários conectados em cada canal de voz
const voiceUsers = {};

io.on('connection', (socket) => {
  console.log(`Usuário conectado: ${socket.id}`);

  // Entrar em uma sala de texto ou canal
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  // Transmissão de mensagens do chat
  socket.on('chat-message', (data) => {
    if (data.room) {
      io.to(data.room).emit('chat-message', data);
    }
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
      avatar: avatar || null
    });

    socket.currentVoiceChannel = channelId;
    socket.join(channelId);
    io.emit('update-voice-users', voiceUsers);
  });

  // Sair de um canal de voz
  socket.on('leave-voice-room', (data) => {
    const channelId = data.channelId || socket.currentVoiceChannel;
    
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      delete socket.currentVoiceChannel;
      
      io.emit('update-voice-users', voiceUsers);
    }
  });

  // --- SINALIZAÇÃO WEBRTC (Para a live aparecer para os outros) ---
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

  // Limpeza quando o usuário fecha a aba ou desconecta
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
  console.log(`\n==============================================`);
  console.log(` Servidor DSpeak rodando com sucesso!`);
  console.log(` Acesse em: http://localhost:${PORT}`);
  console.log(`==============================================\n`);
});
