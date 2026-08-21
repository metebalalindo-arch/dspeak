// Variáveis WebRTC atualizadas para suporte bidirecional simultâneo
    let peerConnections = {};
    const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    function createPeerConnection(targetSocketId) {
      if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[targetSocketId] = pc;

      // Adiciona o stream local à conexão se o usuário já estiver transmitindo
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
      
      // Tratamento seguro para evitar conflito de SDP simultâneo (Collision)
      if (pc.signalingState !== "stable") {
        await Promise.all([
          pc.setLocalDescription({ type: "rollback" }),
          pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      }
      
      if (localStream && !pc.getSenders().length) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetSocketId: data.senderSocketId, answer });
    });

    socket.on('webrtc-answer', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc && pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on('webrtc-candidate', async (data) => {
      const pc = peerConnections[data.senderSocketId];
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Erro ao adicionar ICE Candidate:", e);
        }
      }
    });

    socket.on('sync-active-streams', (streamingSocketIds) => {
      streamingSocketIds.forEach(targetSocketId => {
        if (targetSocketId !== socket.id && !peerConnections[targetSocketId]) {
          const isInitiator = socket.id > targetSocketId;
          const pc = createPeerConnection(targetSocketId);
          if (isInitiator) {
            if (localStream && !pc.getSenders().length) {
              localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
            }
            pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
              socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription });
            });
          }
        }
      });
    });

    socket.on('user-started-streaming', (targetSocketId) => {
      if (targetSocketId !== socket.id && !peerConnections[targetSocketId]) {
        const isInitiator = socket.id > targetSocketId;
        const pc = createPeerConnection(targetSocketId);
        if (isInitiator) {
          if (localStream && !pc.getSenders().length) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
          }
          pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
            socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription });
          });
        }
      }
    });

    socket.on('user-stopped-streaming', (targetSocketId) => {
      if (peerConnections[targetSocketId]) {
        peerConnections[targetSocketId].close();
        delete peerConnections[targetSocketId];
      }
      const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
      const targetUser = usersInChannel.find(u => u.socketId === targetSocketId);
      if (targetUser) {
        removeScreenStream(targetUser.name);
      }
    });

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
        socket.emit('start-streaming', connectedVoiceChannel);

        const shareBtn = document.getElementById('stage-share-btn');
        shareBtn.classList.add('active-share');
        shareBtn.title = "Encerrar Transmissão";

        document.getElementById('stage-quality-btn').style.display = 'flex';

        // Conecta ativamente com todos os usuários presentes na sala de voz
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        usersInChannel.forEach(u => {
          if (u.socketId !== socket.id) {
            const isInitiator = socket.id > u.socketId;
            const pc = createPeerConnection(u.socketId);
            if (isInitiator) {
              if (!pc.getSenders().length) {
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
              }
              pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
                socket.emit('webrtc-offer', { targetSocketId: u.socketId, offer: pc.localDescription });
              }).catch(err => console.error("Erro no offer:", err));
            }
          }
        });

        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro ao transmitir:", err); }
    }
