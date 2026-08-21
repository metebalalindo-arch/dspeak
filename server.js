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

        const shareBtn = document.getElementById('stage-share-btn');
        shareBtn.classList.add('active-share');
        shareBtn.title = "Encerrar Transmissão";

        document.getElementById('stage-quality-btn').style.display = 'flex';

        // Garante conexão bidirecional com todos na sala de voz
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        usersInChannel.forEach(u => {
          if (u.socketId !== socket.id) {
            // Usamos uma ordenação simples de socketId para definir quem cria a offer (evita colisão de oferta simultânea)
            const isInitiator = socket.id > u.socketId;
            const pc = createPeerConnection(u.socketId);
            if (isInitiator) {
              localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
              pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
                socket.emit('webrtc-offer', { targetSocketId: u.socketId, offer: pc.localDescription });
              }).catch(err => console.error("Erro no offer:", err));
            }
          }
        });

        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro ao transmitir:", err); }
    }

    function stopScreenShare() {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      removeScreenStream(username);

      Object.keys(peerConnections).forEach(socketId => {
        peerConnections[socketId].close();
        delete peerConnections[socketId];
      });

      const shareBtn = document.getElementById('stage-share-btn');
      shareBtn.classList.remove('active-share');
      shareBtn.title = "Transmitir Tela";

      document.getElementById('stage-quality-btn').style.display = 'none';
    }

    function createPeerConnection(targetSocketId) {
      if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[targetSocketId] = pc;

      // Se já estiver transmitindo, adiciona os tracks à nova conexão
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      pc.ontrack = (event) => {
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        const targetUser = usersInChannel.find(u => u.socketId === targetSocketId);
        const targetName = targetUser ? targetUser.name : "Amigo";
        addScreenStream(targetName, event.streams[0]);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('webrtc-candidate', { targetSocketId, candidate: event.candidate });
        }
      };

      return pc;
    }

    socket.on('webrtc-offer', async (data) => {
      const pc = createPeerConnection(data.senderSocketId);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      
      if (localStream && !pc.getSenders().length) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetSocketId: data.senderSocketId, answer });
    });

    socket.on('webrtc-answer', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on('webrtc-candidate', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    socket.on('update-voice-users', (data) => {
      voiceChannelUsers = data;
      renderChannels();
      renderStageUsers();

      // Sincroniza conexões com novos usuários que entrarem na sala
      if (connectedVoiceChannel) {
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        usersInChannel.forEach(u => {
          if (u.socketId !== socket.id && !peerConnections[u.socketId]) {
            const isInitiator = socket.id > u.socketId;
            const pc = createPeerConnection(u.socketId);
            if (isInitiator && localStream) {
              localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
              pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
                socket.emit('webrtc-offer', { targetSocketId: u.socketId, offer: pc.localDescription });
              });
            }
          }
        });
      }
    });
