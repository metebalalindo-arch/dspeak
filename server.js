// ... (mantenha o código anterior até a função startScreenShare)

    async function startScreenShare() {
      let width = selectedResolution === '1080' ? 1920 : 1280;
      let height = selectedResolution === '1080' ? 1080 : 720;
      let fps = parseInt(selectedFps, 10);

      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ 
          video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } }, 
          audio: true 
        });
        
        addScreenStream(username, localStream);
        // Avisa a todos que você começou a transmitir
        socket.emit('start-streaming', connectedVoiceChannel);

        const shareBtn = document.getElementById('stage-share-btn');
        shareBtn.classList.add('active-share');
        shareBtn.title = "Encerrar Transmissão";
        document.getElementById('stage-quality-btn').style.display = 'flex';

        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro ao transmitir:", err); }
    }

    function stopScreenShare() {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      removeScreenStream(username);
      if (connectedVoiceChannel) {
        socket.emit('stop-streaming', connectedVoiceChannel);
      }
      
      // Fecha todas as conexões ativas ao parar
      Object.keys(peerConnections).forEach(socketId => {
        peerConnections[socketId].close();
        delete peerConnections[socketId];
      });

      const shareBtn = document.getElementById('stage-share-btn');
      shareBtn.classList.remove('active-share');
      shareBtn.title = "Transmitir Tela";
      document.getElementById('stage-quality-btn').style.display = 'none';
    }

    // CRÍTICO: Esta função cria a conexão e lida com o track
    function createPeerConnection(targetSocketId) {
      if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[targetSocketId] = pc;

      // Adiciona o stream local caso já esteja transmitindo
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      pc.ontrack = (event) => {
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        const targetUser = usersInChannel.find(u => u.socketId === targetSocketId);
        if (targetUser) addScreenStream(targetUser.name, event.streams[0]);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('webrtc-candidate', { targetSocketId, candidate: event.candidate });
        }
      };

      return pc;
    }

    // Eventos de Sincronização
    socket.on('user-started-streaming', (targetSocketId) => {
      // Quando alguém avisa que começou, quem é "initiator" cria a oferta
      const pc = createPeerConnection(targetSocketId);
      if (socket.id > targetSocketId) {
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
          socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription });
        });
      }
    });

    socket.on('user-stopped-streaming', (targetSocketId) => {
      if (peerConnections[targetSocketId]) {
        peerConnections[targetSocketId].close();
        delete peerConnections[targetSocketId];
      }
      const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
      const targetUser = usersInChannel.find(u => u.socketId === targetSocketId);
      if (targetUser) removeScreenStream(targetUser.name);
    });

    // Ao recarregar, o servidor envia quem está transmitindo
    socket.on('sync-active-streams', (streamingSocketIds) => {
      streamingSocketIds.forEach(targetSocketId => {
        if (targetSocketId !== socket.id) {
          const pc = createPeerConnection(targetSocketId);
          if (socket.id > targetSocketId) {
            pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
              socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription });
            });
          }
        }
      });
    });

    socket.on('webrtc-offer', async (data) => {
      const pc = createPeerConnection(data.senderSocketId);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetSocketId: data.senderSocketId, answer });
    });

    socket.on('webrtc-answer', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('webrtc-candidate', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    });
