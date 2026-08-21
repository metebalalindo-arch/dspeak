let peerConnections = {};
    const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    async function toggleScreenShare() {
      if (!localStream) {
        startScreenShare();
      } else {
        stopScreenShare();
      }
    }

    async function startScreenShare() {
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        addScreenStream(username, localStream);

        // Avisa o servidor e os membros da sala que iniciou a live
        socket.emit('update-streaming-status', { channelId: connectedVoiceChannel, isStreaming: true });

        const shareBtn = document.getElementById('stage-share-btn');
        shareBtn.classList.add('active-share');

        // Envia oferta WebRTC para todos os usuários na mesma sala de voz
        const usersInChannel = voiceChannelUsers[connectedVoiceChannel] || [];
        usersInChannel.forEach(u => {
          if (u.name !== username) {
            createPeerConnection(u.socketId, true);
          }
        });

        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro ao transmitir:", err); }
    }

    function stopScreenShare() {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      removeScreenStream(username);
      socket.emit('update-streaming-status', { channelId: connectedVoiceChannel, isStreaming: false });

      // Fecha conexões WebRTC ativas
      Object.keys(peerConnections).forEach(socketId => {
        peerConnections[socketId].close();
        delete peerConnections[socketId];
      });

      const shareBtn = document.getElementById('stage-share-btn');
      shareBtn.classList.remove('active-share');
    }

    function createPeerConnection(targetSocketId, isInitiator) {
      if (peerConnections[targetSocketId]) return peerConnections[targetSocketId];

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[targetSocketId] = pc;

      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      pc.ontrack = (event) => {
        // Recebe o stream remoto de outro usuário transmitindo
        addScreenStream(targetSocketId, event.streams[0]);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('webrtc-candidate', { targetSocketId, candidate: event.candidate });
        }
      };

      if (isInitiator) {
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer);
        }).then(() => {
          socket.emit('webrtc-offer', { targetSocketId, offer: pc.localDescription, username });
        }).catch(err => console.error("Erro ao criar offer:", err));
      }

      return pc;
    }

    // Ouvintes de sinalização WebRTC via Socket.io
    socket.on('webrtc-offer', async (data) => {
      const pc = createPeerConnection(data.senderSocketId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
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
