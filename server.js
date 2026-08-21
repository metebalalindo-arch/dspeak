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

        // 1. Avisa a todos na sala de voz que você começou a transmitir
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        usersInChannel.forEach(u => {
          if (u.socketId !== socket.id) {
            createPeerConnection(u.socketId, true);
          }
        });

        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro ao transmitir:", err); }
    }

    function stopScreenShare() {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      removeScreenStream(username);

      // Fecha todas as conexões WebRTC ativas
      Object.keys(peerConnections).forEach(socketId => {
        peerConnections[socketId].close();
        delete peerConnections[socketId];
      });

      const shareBtn = document.getElementById('stage-share-btn');
      shareBtn.classList.remove('active-share');
      shareBtn.title = "Transmitir Tela";

      document.getElementById('stage-quality-btn').style.display = 'none';
    }

    // Gerenciador WebRTC Bidirecional Corrigido
    function createPeerConnection(targetSocketId, isInitiator) {
      if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[targetSocketId] = pc;

      // Se você tiver uma stream local, adiciona ela na conexão para o outro ver
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      // Quando o outro usuário mandar o vídeo dele para você
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

      if (isInitiator) {
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
          socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription });
        }).catch(err => console.error("Erro no offer:", err));
      }

      return pc;
    }

    // Quando alguém te envia uma oferta (ex: ele começou a transmitir)
    socket.on('webrtc-offer', async (data) => {
      const pc = createPeerConnection(data.senderSocketId, false);
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
