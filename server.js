<script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    
    let registeredUsersDb = [
      { email: "daniel@dspeak.gg", pass: "123456", firstname: "Daniel", lastname: "Silva", handle: "daniel", dob: "1995-05-10" }
    ];
    let bannedUsersList = [];

    let username = "Daniel";
    let handle = "@daniel";
    let statusText = "Conectado na matrix";
    let userRole = "Owner";
    let avatarUrl = null;
    let hasUnsavedChanges = false;
    let pendingTabElem = null;

    let selectedResolution = "720";
    let selectedFps = "30";

    let editingChannelId = null;
    let activeFriendTarget = null;
    let activeDmFriend = null;
    let contextTargetUser = null;

    let currentFriendsTab = 'online';
    let friendsSearchQuery = '';

    let friendsList = [
      { name: 'Ciroc', subtext: '🎮 Palworld +1', color: '#00ffcc', status: 'online' },
      { name: 'Edu', subtext: 'Disponível', color: '#ff5500', status: 'online' },
      { name: 'FaLLouT', subtext: '🎮 AikaClient', color: '#ffaa00', status: 'online' },
      { name: 'José Magno', subtext: 'Ausente', color: '#eb459e', status: 'idle' },
      { name: 'Kah', subtext: 'Não perturbar', color: '#ff3333', status: 'dnd' }
    ];

    let pttKey = 'ControlLeft';
    let pttKeyLabel = 'Ctrl (Esq.)';
    let isRecordingPttKey = false;

    // Variáveis de fluxo contínuo de áudio (Palco, Sala e Configurações)
    let globalAudioCtx = null;
    let globalAnalyser = null;
    let globalGainNode = null;
    let globalStream = null;
    let globalAnimationId = null;
    let isTestingMic = false;

    // Inicializa captura contínua do microfone ao entrar na voz
    async function initGlobalAudioStream() {
      if (globalStream) return;
      try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = globalAudioCtx.createMediaStreamSource(globalStream);
        globalAnalyser = globalAudioCtx.createAnalyser();
        globalGainNode = globalAudioCtx.createGain();
        globalGainNode.gain.value = 2.0; // Ganho de sensibilidade
        globalAnalyser.fftSize = 64;
        source.connect(globalGainNode);
        globalGainNode.connect(globalAnalyser);
        runGlobalVoiceDetection();
      } catch (err) {
        console.error("Microfone não detectado ou permissão negada:", err);
      }
    }

    function stopGlobalAudioStream() {
      if (globalAnimationId) cancelAnimationFrame(globalAnimationId);
      if (globalStream) {
        globalStream.getTracks().forEach(t => t.stop());
        globalStream = null;
      }
      if (globalAudioCtx) {
        globalAudioCtx.close();
        globalAudioCtx = null;
      }
      resetMicMeter();
    }

    // Monitora a voz e acende o anel laranja (Estilo Discord)
    function runGlobalVoiceDetection() {
      if (!globalAnalyser) return;
      const dataArray = new Uint8Array(globalAnalyser.frequencyBinCount);
      globalAnalyser.getByteFrequencyData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) { sum += dataArray[i]; }
      const average = sum / dataArray.length;
      
      // Atualiza o painel de barras das configurações
      const activeBarsCount = Math.round((average / 60) * 35);
      const bars = document.querySelectorAll('.meter-bar');
      bars.forEach((bar, idx) => {
        if (idx < activeBarsCount) bar.classList.add('active');
        else bar.classList.remove('active');
      });

      // Elementos do Palco e Rodapé
      const avatarFooter = document.getElementById('footer-user-avatar');
      const stageAvatar = document.getElementById(`stage-avatar-${username}`);
      
      // Quando detectar voz acima do ruído (limiar 2) e não estiver mutado
      if (average > 2 && !isMuted) {
        if (avatarFooter) avatarFooter.classList.add('speaking');
        if (stageAvatar) stageAvatar.classList.add('speaking');
      } else {
        if (avatarFooter) avatarFooter.classList.remove('speaking');
        if (stageAvatar) stageAvatar.classList.remove('speaking');
      }

      globalAnimationId = requestAnimationFrame(runGlobalVoiceDetection);
    }

    // Funções de Autenticação & Registro
    function switchAuthTab(tab) {
      document.getElementById('tab-login-btn').classList.toggle('active', tab === 'login');
      document.getElementById('tab-register-btn').classList.toggle('active', tab === 'register');
      document.getElementById('auth-form-login').style.display = tab === 'login' ? 'flex' : 'none';
      document.getElementById('auth-form-register').style.display = tab === 'register' ? 'flex' : 'none';
      document.getElementById('auth-form-verify').style.display = 'none';
      document.getElementById('auth-form-complete').style.display = 'none';
    }

    function handleLogin() {
      const email = document.getElementById('login-email').value.trim();
      const pass = document.getElementById('login-password').value.trim();
      const found = registeredUsersDb.find(u => u.email === email && u.pass === pass);
      if (found) {
        username = found.firstname;
        handle = `@${found.handle}`;
        document.getElementById('auth-overlay').style.display = 'none';
        initAppInterface();
      } else {
        alert("E-mail ou senha incorretos, ou cadastro não encontrado.");
      }
    }

    function handleSendVerificationLink() {
      const email = document.getElementById('reg-email').value.trim();
      const pass = document.getElementById('reg-password').value.trim();
      if (!email || !pass) { alert("Preencha e-mail e senha."); return; }
      document.getElementById('auth-form-register').style.display = 'none';
      document.getElementById('auth-form-verify').style.display = 'flex';
      document.getElementById('verify-msg-box').textContent = `Enviamos um link de confirmação para ${email}. Clique no botão abaixo para verificar sua credencial.`;
    }

    function handleOpenProfileCompletion() {
      document.getElementById('auth-form-verify').style.display = 'none';
      document.getElementById('auth-form-complete').style.display = 'flex';
    }

    function checkHandleAvailability(val) {
      const cleanVal = val.trim().toLowerCase().replace(/[@\s]/g, '');
      const msgSpan = document.getElementById('handle-availability-msg');
      const btnFin = document.getElementById('btn-finalize-reg');
      if (!cleanVal) { msgSpan.textContent = ""; btnFin.disabled = true; return; }

      const exists = registeredUsersDb.some(u => u.handle === cleanVal);
      if (exists) {
        msgSpan.style.color = '#ff3333';
        msgSpan.textContent = "Nome de usuário indisponível (já em uso).";
        btnFin.disabled = true;
      } else {
        msgSpan.style.color = '#00ffcc';
        msgSpan.textContent = "Nome de usuário disponível!";
        btnFin.disabled = false;
      }
    }

    function handleFinalizeRegistration() {
      const fname = document.getElementById('reg-firstname').value.trim();
      const lname = document.getElementById('reg-lastname').value.trim();
      const hndl = document.getElementById('reg-handle-input').value.trim().toLowerCase().replace(/[@\s]/g, '');
      const dob = document.getElementById('reg-dob').value;
      const email = document.getElementById('reg-email').value.trim();
      const pass = document.getElementById('reg-password').value.trim();

      if (!fname || !hndl || !dob) { alert("Preencha todos os campos obrigatórios."); return; }

      registeredUsersDb.push({ email, pass, firstname: fname, lastname: lname, handle: hndl, dob });
      username = fname;
      handle = `@${hndl}`;
      userRole = "Guest";

      document.getElementById('auth-overlay').style.display = 'none';
      initAppInterface();
      alert("Cadastro concluído com sucesso!");
    }

    function initAppInterface() {
      document.getElementById('user-display-name').textContent = username;
      document.getElementById('user-handle-name').textContent = handle;
      document.getElementById('user-initial').textContent = username.charAt(0).toUpperCase();
      document.getElementById('user-role-tag').textContent = userRole;
      document.getElementById('fp-role-badge').textContent = userRole === 'Owner' ? '👑 Owner' : (userRole === 'Moderador' ? '🛡️ Moderador' : (userRole === 'Membro' ? '✓ Membro' : '👤 Guest'));
      applyAvatarToElement(document.getElementById('footer-user-avatar'), avatarUrl, username);
      renderServers();
      renderFriendsList();
      renderDmUsersList();
      openHomeView();
    }

    function getUserAvatarGradient(name) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); }
      const c1 = Math.abs(hash) % 360;
      return `linear-gradient(135deg, hsl(${c1}, 80%, 45%), #ff5500)`;
    }

    function getUserGradient(name) {
      return 'linear-gradient(135deg, #181b24, #221c2e)';
    }

    function applyAvatarToElement(elem, url, name, textElemId = null) {
      if (!elem) return;
      if (url) {
        elem.style.backgroundImage = `url('${url}')`;
        elem.style.backgroundSize = 'cover';
        elem.style.backgroundPosition = 'center';
        if (textElemId) {
          const tElem = document.getElementById(textElemId);
          if (tElem) tElem.style.display = 'none';
        }
      } else {
        elem.style.backgroundImage = 'none';
        elem.style.background = getUserAvatarGradient(name || username);
        if (textElemId) {
          const tElem = document.getElementById(textElemId);
          if (tElem) {
            tElem.style.display = 'block';
            tElem.textContent = name ? name.charAt(0).toUpperCase() : username.charAt(0).toUpperCase();
          }
        }
      }
    }

    const miniPopover = document.getElementById('mini-profile-popover');
    const friendOptionsPopover = document.getElementById('friend-options-popover');
    const userContextMenu = document.getElementById('user-context-menu');

    function toggleStatusSelector(e) {
      e.stopPropagation();
      const pop = document.getElementById('status-selector-popover');
      pop.style.display = pop.style.display === 'block' ? 'none' : 'block';
    }

    function setUserStatus(statusKey, colorHex, labelText) {
      document.getElementById('footer-status-dot').style.background = colorHex;
      document.getElementById('status-selector-popover').style.display = 'none';
      statusText = labelText;
    }

    function openAddFriendModal() {
      document.getElementById('add-friend-input').value = '';
      openModal('add-friend-modal');
    }

    function submitAddFriend() {
      const val = document.getElementById('add-friend-input').value.trim();
      if (!val) { alert("Insira um nome de usuário válido!"); return; }
      friendsList.push({ name: val, subtext: 'Disponível', color: '#00ffcc', status: 'online' });
      closeModal('add-friend-modal');
      renderFriendsList();
      renderDmUsersList();
      alert(`Pedido enviado para ${val}!`);
    }

    function switchFriendsTab(tab, elem) {
      currentFriendsTab = tab;
      document.querySelectorAll('.friends-tab').forEach(el => el.classList.remove('active'));
      if (elem) elem.classList.add('active');
      renderFriendsList();
    }

    function filterFriendsList(query) {
      friendsSearchQuery = query.toLowerCase();
      renderFriendsList();
    }

    function renderFriendsList() {
      const container = document.getElementById('friends-list-container');
      const titleEl = document.getElementById('friends-section-title');
      container.innerHTML = '';

      let filtered = friendsList.filter(f => {
        const matchesQuery = f.name.toLowerCase().includes(friendsSearchQuery);
        if (!matchesQuery) return false;
        if (currentFriendsTab === 'online') {
          return f.status === 'online' || f.status === 'idle' || f.status === 'dnd';
        }
        return true;
      });

      titleEl.textContent = `${currentFriendsTab.toUpperCase()} — ${filtered.length}`;

      if (filtered.length === 0) {
        container.innerHTML = `<div style="color: #8a8f9d; font-size: 13px; padding: 12px;">Nenhum registro encontrado nesta aba.</div>`;
        return;
      }

      filtered.forEach(f => {
        let dotClass = 'status-online';
        if (f.status === 'idle') dotClass = 'status-idle';
        if (f.status === 'dnd') dotClass = 'status-dnd';

        const row = document.createElement('div');
        row.className = 'friend-row';
        row.id = `friend-row-${f.name}`;
        row.onclick = () => openDirectMessage(f.name, f.subtext, f.color);
        row.innerHTML = `
          <div class="friend-info">
            <div class="friend-avatar-wrapper">
              <div class="friend-avatar" style="background: ${f.color};">${f.name.charAt(0).toUpperCase()}</div>
              <div class="friend-status-dot ${dotClass}"></div>
            </div>
            <div class="friend-details">
              <span class="friend-name">${f.name}</span>
              <span class="friend-subtext">${f.subtext}</span>
            </div>
          </div>
          <div class="friend-actions">
            <button class="friend-action-btn" title="Mensagem" onclick="event.stopPropagation(); openDirectMessage('${f.name}', '${f.subtext}', '${f.color}')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button class="friend-action-btn" title="Mais" onclick="openFriendOptions(event, '${f.name}')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
            </button>
          </div>
        `;
        container.appendChild(row);
      });
    }

    function renderDmUsersList() {
      const container = document.getElementById('dm-users-list');
      if (!container) return;
      container.innerHTML = '';

      friendsList.forEach(f => {
        let dotClass = 'status-online';
        if (f.status === 'idle') dotClass = 'status-idle';
        if (f.status === 'dnd') dotClass = 'status-dnd';

        const item = document.createElement('div');
        item.className = 'dm-user-item';
        item.id = `dm-item-${f.name}`;
        item.onclick = () => openDirectMessage(f.name, f.subtext, f.color);
        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="dm-user-avatar-wrapper">
              <div class="dm-user-avatar" style="background: ${f.color};">${f.name.charAt(0).toUpperCase()}</div>
              <div class="dm-status-dot ${dotClass}"></div>
            </div>
            <div style="display: flex; flex-direction: column;">
              <span style="font-size: 14px; font-weight: 600; color: #f2f3f5;">${f.name}</span>
              <span style="font-size: 11px; color: #8a8f9d;">${f.subtext}</span>
            </div>
          </div>
        `;
        container.appendChild(item);
      });
    }

    function openFriendOptions(event, friendName) {
      event.stopPropagation();
      activeFriendTarget = friendName;
      const rect = event.currentTarget.getBoundingClientRect();
      let left = rect.left - 150;
      let top = rect.bottom + 6;
      if (left < 10) left = 10;
      if (top + 90 > window.innerHeight) top = rect.top - 90;

      friendOptionsPopover.style.left = `${left}px`;
      friendOptionsPopover.style.top = `${top}px`;
      friendOptionsPopover.style.display = 'block';
    }

    function startVoiceCallWithFriend() {
      friendOptionsPopover.style.display = 'none';
      if (activeFriendTarget) {
        openDirectMessage(activeFriendTarget);
        startDirectVoiceCall();
      }
    }

    function confirmRemoveFriendModal() {
      friendOptionsPopover.style.display = 'none';
      if (activeFriendTarget) {
        document.getElementById('remove-friend-modal-title').textContent = `Desfazer amizade com ${activeFriendTarget}`;
        document.getElementById('remove-friend-modal-text').textContent = `Tem certeza que deseja remover ${activeFriendTarget} da rede?`;
        openModal('remove-friend-modal');
      }
    }

    function executeRemoveFriend() {
      closeModal('remove-friend-modal');
      if (activeFriendTarget) {
        friendsList = friendsList.filter(f => f.name !== activeFriendTarget);
        renderFriendsList();
        renderDmUsersList();
        activeFriendTarget = null;
      }
    }

    function blockFriendAction() {
      friendOptionsPopover.style.display = 'none';
      if (activeFriendTarget) {
        friendsList = friendsList.filter(f => f.name !== activeFriendTarget);
        renderFriendsList();
        renderDmUsersList();
        alert(`Usuário ${activeFriendTarget} bloqueado com sucesso.`);
        activeFriendTarget = null;
      }
    }

    function openUserContextMenu(event, userName, userRoleTag) {
      event.preventDefault();
      event.stopPropagation();
      contextTargetUser = { name: userName, role: userRoleTag || 'Guest' };

      const rect = event.currentTarget.getBoundingClientRect();
      userContextMenu.style.left = `${rect.left + 20}px`;
      userContextMenu.style.top = `${rect.bottom + 5}px`;

      const isSelf = userName === username;
      const myRank = userRole === 'Owner' ? 3 : (userRole === 'Moderador' ? 2 : 1);
      const targetRank = userRoleTag === 'Owner' ? 3 : (userRoleTag === 'Moderador' ? 2 : (userRoleTag === 'Membro' ? 1 : 0));

      document.getElementById('ctx-role-owner').style.display = (userRole === 'Owner' && !isSelf) ? 'flex' : 'none';
      document.getElementById('ctx-role-mod').style.display = (myRank > targetRank && userRole !== 'Membro') ? 'flex' : 'none';
      document.getElementById('ctx-role-member').style.display = (myRank > targetRank) ? 'flex' : 'none';

      const canBan = (userRole === 'Owner' || userRole === 'Moderador') && myRank > targetRank && !isSelf;
      document.getElementById('ctx-ban-btn').style.display = canBan ? 'flex' : 'none';

      userContextMenu.style.display = 'block';
    }

    function toggleMuteUserLocal() {
      userContextMenu.style.display = 'none';
      if (contextTargetUser) {
        alert(`Usuário ${contextTargetUser.name} mutado localmente para você.`);
      }
    }

    function changeUserVolume(val) {
      document.getElementById('ctx-vol-text').textContent = `Volume: ${val}%`;
    }

    function assignUserRole(newRole) {
      userContextMenu.style.display = 'none';
      if (contextTargetUser) {
        alert(`Cargo de ${contextTargetUser.name} alterado para ${newRole}.`);
      }
    }

    function banUserAction() {
      userContextMenu.style.display = 'none';
      if (contextTargetUser) {
        bannedUsersList.push(contextTargetUser.name);
        Object.keys(voiceChannelUsers).forEach(chId => {
          voiceChannelUsers[chId] = voiceChannelUsers[chId].filter(u => u.name !== contextTargetUser.name);
        });
        renderChannels();
        renderStageUsers();
        alert(`Usuário ${contextTargetUser.name} foi banido do cluster.`);
      }
    }

    function openBannedUsersModal() {
      const container = document.getElementById('banned-users-list');
      container.innerHTML = '';
      if (bannedUsersList.length === 0) {
        container.innerHTML = `<div style="color: #8a8f9d; font-size: 13px; padding: 10px;">Nenhum usuário banido registrado.</div>`;
      } else {
        bannedUsersList.forEach(bUser => {
          const item = document.createElement('div');
          item.className = 'channel';
          item.innerHTML = `<span>${bUser}</span><button class="btn-action-gray" onclick="unbanUser('${bUser}')" style="padding: 2px 8px; font-size: 11px;">Desbanir</button>`;
          container.appendChild(item);
        });
      }
      openModal('banned-users-modal');
    }

    function unbanUser(bName) {
      bannedUsersList = bannedUsersList.filter(b => b !== bName);
      openBannedUsersModal();
      alert(`Usuário ${bName} desbanido.`);
    }

    function openRolesModal() {
      openModal('roles-modal');
    }

    function openDirectMessage(friendName, subtext = 'Disponível', avatarColor = '#ff5500') {
      activeChannel = `dm-${friendName.toLowerCase()}`;
      activeDmFriend = { name: friendName, subtext, color: avatarColor };

      document.getElementById('chat-header-voice').style.display = 'none';
      document.getElementById('dm-back-to-friends-btn').style.display = 'flex';
      document.getElementById('chat-header-actions').style.display = 'flex';

      const userInfoBox = document.getElementById('chat-header-user-info');
      userInfoBox.innerHTML = `
        <div class="dm-header-avatar-wrapper">
          <div class="dm-header-avatar" style="background: ${avatarColor};">${friendName.charAt(0).toUpperCase()}</div>
          <div class="dm-header-status-dot status-online"></div>
        </div>
        <span class="dm-header-username">${friendName}</span>
      `;
      
      const welcomeCircle = document.getElementById('welcome-avatar-circle');
      if (welcomeCircle) {
        welcomeCircle.textContent = friendName.charAt(0).toUpperCase();
        welcomeCircle.style.background = avatarColor;
      }
      
      const welcomeTitle = document.getElementById('welcome-title-text');
      const welcomeSub = document.getElementById('welcome-subtitle-text');
      if (welcomeTitle) welcomeTitle.textContent = friendName;
      if (welcomeSub) welcomeSub.textContent = `Início do canal seguro com ${friendName}.`;

      document.getElementById('home-view').style.display = 'none';
      document.getElementById('voice-room-view').style.display = 'none';
      document.getElementById('text-room-view').style.display = 'flex';

      document.getElementById('dm-nav-friends-btn').classList.remove('active');
      document.querySelectorAll('.dm-user-item').forEach(el => el.classList.remove('active'));
      const dmItem = document.getElementById(`dm-item-${friendName}`);
      if (dmItem) dmItem.classList.add('active');

      socket.emit('join-room', activeChannel);
    }

    function startDirectVoiceCall() {
      if (!activeDmFriend) return;
      connectVoice({ id: activeChannel, name: activeDmFriend.name, type: 'voice' });
      document.getElementById('dm-header-call-btn').classList.add('active');
      document.getElementById('dm-header-share-btn').style.display = 'flex';
    }

    function showMiniProfile(event, dName, uHandle, customStatus = 'Conectado') {
      event.stopPropagation();
      document.getElementById('popover-display-name').textContent = dName;
      document.getElementById('popover-user-handle').textContent = uHandle;
      applyAvatarToElement(document.getElementById('popover-avatar-img'), (dName === username ? avatarUrl : null), dName);
      document.getElementById('popover-status-bubble-text').textContent = customStatus;
      document.getElementById('popover-custom-status').textContent = customStatus;

      const voiceBox = document.getElementById('popover-voice-status-box');
      if (connectedVoiceChannel) {
        voiceBox.style.display = 'block';
        const srv = servers.find(s => s.id === activeServerId);
        const ch = srv ? srv.channels.find(c => c.id === connectedVoiceChannel) : null;
        document.getElementById('popover-voice-channel-name').textContent = ch ? ch.name : (activeDmFriend ? activeDmFriend.name : 'Lobby');
      } else {
        voiceBox.style.display = 'none';
      }

      const rect = event.currentTarget.getBoundingClientRect();
      let left = rect.left + 10;
      let top = rect.top - 280;
      if (top < 10) top = rect.bottom + 10;
      if (left + 300 > window.innerWidth) left = window.innerWidth - 310;

      miniPopover.style.left = `${left}px`;
      miniPopover.style.top = `${top}px`;
      miniPopover.style.display = 'block';
    }

    function openFullProfileModal() {
      miniPopover.style.display = 'none';
      document.getElementById('fp-display-name').textContent = username;
      document.getElementById('fp-handle').textContent = handle;
      document.getElementById('fp-status').textContent = statusText;
      applyAvatarToElement(document.getElementById('fp-avatar'), avatarUrl, username);

      document.getElementById('edit-display-name-input').value = username;
      document.getElementById('edit-handle-input').value = handle.replace('@', '');
      document.getElementById('edit-status-input').value = statusText;

      switchFpTab('mural');
      openModal('full-profile-modal');
    }

    function switchFpTab(tabName) {
      const tabs = ['mural', 'atividade', 'editar'];
      tabs.forEach(t => {
        const el = document.getElementById(`fp-tab-${t}`);
        if (!el) return;
        if (t === tabName) {
          el.style.display = 'block';
          setTimeout(() => el.classList.add('active-fade'), 10);
        } else {
          el.classList.remove('active-fade');
          el.style.display = 'none';
        }
      });
      document.getElementById('tab-btn-mural').classList.toggle('active', tabName === 'mural');
      document.getElementById('tab-btn-atividade').classList.toggle('active', tabName === 'atividade');
      document.getElementById('tab-btn-editar').classList.toggle('active', tabName === 'editar');
    }

    function saveProfileChanges() {
      const newDName = document.getElementById('edit-display-name-input').value.trim();
      const newHandleInput = document.getElementById('edit-handle-input').value.trim();
      const newStatus = document.getElementById('edit-status-input').value.trim();

      if (newDName) { username = newDName; document.getElementById('user-display-name').textContent = username; document.getElementById('fp-display-name').textContent = username; }
      if (newHandleInput) { handle = newHandleInput.startsWith('@') ? newHandleInput : `@${newHandleInput.toLowerCase()}`; document.getElementById('user-handle-name').textContent = handle; document.getElementById('fp-handle').textContent = handle; }
      if (newStatus !== "") { statusText = newStatus; document.getElementById('fp-status').textContent = statusText; }

      applyAvatarToElement(document.getElementById('footer-user-avatar'), avatarUrl, username);
      alert('Perfil atualizado com sucesso!');
      switchFpTab('mural');
    }

    function triggerDirectAvatarSelect() { document.getElementById('global-avatar-file-input').click(); }

    function handleDirectAvatarUpload(event) {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
          avatarUrl = e.target.result;
          applyAvatarToElement(document.getElementById('settings-modal-avatar'), avatarUrl, username, 'settings-avatar-text-initial');
          applyAvatarToElement(document.getElementById('footer-user-avatar'), avatarUrl, username);
          markAsModified();
        };
        reader.readAsDataURL(file);
      }
    }

    document.addEventListener('click', (e) => { 
      if (!miniPopover.contains(e.target)) miniPopover.style.display = 'none';
      if (!friendOptionsPopover.contains(e.target)) friendOptionsPopover.style.display = 'none';
      if (!userContextMenu.contains(e.target)) userContextMenu.style.display = 'none';
      const statusPop = document.getElementById('status-selector-popover');
      if (!document.getElementById('user-profile-bar').contains(e.target) && !statusPop.contains(e.target)) statusPop.style.display = 'none';
    });

    let servers = [{ id: 'dspeak', name: 'DSPEAK', initials: 'DS', channels: [{ id: 'geral', name: 'geral', type: 'text' }, { id: 'lobby', name: 'Lobby', type: 'voice', status: '' }] }];
    let activeServerId = null;
    let activeChannel = null;
    let connectedVoiceChannel = null;
    let localStream = null;
    let isMuted = false;
    let isDeafened = false;
    let voiceChannelUsers = {};

    const serverHeaderBtn = document.getElementById('server-header-btn');
    const serverMenu = document.getElementById('server-menu');
    serverHeaderBtn.addEventListener('click', () => serverMenu.style.display = serverMenu.style.display === 'block' ? 'none' : 'block');
    document.addEventListener('click', (e) => { if (!serverHeaderBtn.contains(e.target) && !serverMenu.contains(e.target)) serverMenu.style.display = 'none'; });

    function openModal(id) { serverMenu.style.display = 'none'; document.getElementById(id).style.display = 'flex'; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }
    function openCreateServerModal() { document.getElementById('new-server-name-input').value = `Cluster ${username}`; openModal('create-server-modal'); }

    function confirmCreateServer() {
      const name = document.getElementById('new-server-name-input').value.trim();
      if (!name) return;
      const id = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
      servers.push({ id, name, initials: name.substring(0,2).toUpperCase(), channels: [{ id: 'geral-'+id, name: 'geral', type: 'text' }, { id: 'lobby-'+id, name: 'Lobby', type: 'voice', status: '' }] });
      switchServer(id);
      closeModal('create-server-modal');
    }

    function openCreateChannel(type) {
      document.getElementById('new-channel-type').value = type;
      document.getElementById('new-channel-name').value = '';
      openModal('channel-modal');
    }

    function confirmCreateChannel() {
      const name = document.getElementById('new-channel-name').value.trim();
      const type = document.getElementById('new-channel-type').value;
      if (!name) return;
      const srv = servers.find(s => s.id === activeServerId);
      if (srv) {
        srv.channels.push({ id: name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(), name, type, status: '' });
        renderChannels();
      }
      closeModal('channel-modal');
    }

    function openAppSettings() {
      document.getElementById('settings-modal-name').textContent = username;
      document.getElementById('settings-modal-handle').textContent = handle;
      document.getElementById('input-edit-display-name').value = username;
      document.getElementById('input-edit-handle').value = handle;
      applyAvatarToElement(document.getElementById('settings-modal-avatar'), avatarUrl, username, 'settings-avatar-text-initial');

      hasUnsavedChanges = false;
      document.getElementById('unsaved-bar').style.display = 'none';
      document.getElementById('btn-save-profile').style.display = 'none';
      
      populateAudioDevices();
      createMicMeterBars();
      switchAppSettingsTab('conta', document.querySelector('.settings-menu-item'));
      
      const modal = document.getElementById('app-settings-modal');
      modal.style.display = 'flex';
      setTimeout(() => modal.classList.add('show'), 10);
    }

    function markAsModified() {
      hasUnsavedChanges = true;
      document.getElementById('btn-save-profile').style.display = 'flex';
    }

    function attemptSwitchTab(tabName, elem) {
      if (hasUnsavedChanges) {
        pendingTabElem = { type: 'tab', tabName, elem };
        document.getElementById('unsaved-bar').style.display = 'flex';
        return;
      }
      switchAppSettingsTab(tabName, elem);
    }

    function switchAppSettingsTab(tabName, elem) {
      const tabs = ['conta', 'privacidade', 'seguranca', 'conexoes', 'textovoz'];
      tabs.forEach(t => {
        const el = document.getElementById(`settings-tab-${t}`);
        if (!el) return;
        if (t === tabName) {
          el.style.display = 'block';
          setTimeout(() => el.classList.add('active-fade'), 10);
        } else {
          el.classList.remove('active-fade');
          el.style.display = 'none';
        }
      });

      if (elem) {
        document.querySelectorAll('.settings-menu-item').forEach(i => i.classList.remove('active'));
        elem.classList.add('active');
      }
    }

    function attemptCloseAppSettings() {
      if (hasUnsavedChanges) {
        pendingTabElem = { type: 'close' };
        document.getElementById('unsaved-bar').style.display = 'flex';
        return;
      }
      closeAppSettings();
    }

    function closeAppSettings() {
      const modal = document.getElementById('app-settings-modal');
      modal.classList.remove('show');
      setTimeout(() => { modal.style.display = 'none'; }, 150);
    }

    function discardChanges() {
      hasUnsavedChanges = false;
      document.getElementById('unsaved-bar').style.display = 'none';
      document.getElementById('btn-save-profile').style.display = 'none';
      document.getElementById('input-edit-display-name').value = username;
      document.getElementById('input-edit-handle').value = handle;

      if (pendingTabElem) {
        if (pendingTabElem.type === 'tab') switchAppSettingsTab(pendingTabElem.tabName, pendingTabElem.elem);
        else if (pendingTabElem.type === 'close') closeAppSettings();
        pendingTabElem = null;
      }
    }

    function saveAppSettingsProfile() {
      const newDName = document.getElementById('input-edit-display-name').value.trim();
      const newHandleInput = document.getElementById('input-edit-handle').value.trim();

      if (newDName) { username = newDName; document.getElementById('user-display-name').textContent = username; document.getElementById('settings-modal-name').textContent = username; }
      if (newHandleInput) { handle = newHandleInput.startsWith('@') ? newHandleInput : `@${newHandleInput.toLowerCase()}`; document.getElementById('user-handle-name').textContent = handle; document.getElementById('settings-modal-handle').textContent = handle; }

      hasUnsavedChanges = false;
      document.getElementById('unsaved-bar').style.display = 'none';
      document.getElementById('btn-save-profile').style.display = 'none';
      alert('Configurações aplicadas com sucesso na rede!');

      if (pendingTabElem) {
        if (pendingTabElem.type === 'tab') switchAppSettingsTab(pendingTabElem.tabName, pendingTabElem.elem);
        else if (pendingTabElem.type === 'close') closeAppSettings();
        pendingTabElem = null;
      }
    }

    async function populateAudioDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSelect = document.getElementById('audio-input-select');
        const speakerSelect = document.getElementById('audio-output-select');
        if (!micSelect || !speakerSelect) return;

        micSelect.innerHTML = '';
        speakerSelect.innerHTML = '';
        let micCount = 0, speakerCount = 0;

        devices.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          if (device.kind === 'audioinput') {
            micCount++;
            option.textContent = device.label || `Microfone ${micCount}`;
            micSelect.appendChild(option);
          } else if (device.kind === 'audiooutput') {
            speakerCount++;
            option.textContent = device.label || `Alto-falante ${speakerCount}`;
            speakerSelect.appendChild(option);
          }
        });
      } catch (err) { console.error("Erro áudio:", err); }
    }

    function createMicMeterBars() {
      const container = document.getElementById('mic-meter-container');
      if (!container || container.children.length > 0) return;
      container.innerHTML = '';
      for (let i = 0; i < 35; i++) {
        const bar = document.createElement('div');
        bar.className = 'meter-bar';
        container.appendChild(bar);
      }
    }

    document.getElementById('mic-volume-slider').addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value) / 100;
      if (globalGainNode) globalGainNode.gain.value = vol * 2;
    });

    document.getElementById('speaker-volume-slider').addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value) / 100;
      document.querySelectorAll('audio, video').forEach(m => m.volume = vol);
    });

    async function toggleMicTest() {
      const btn = document.getElementById('btn-mic-test');
      if (isTestingMic) {
        stopGlobalAudioStream();
        isTestingMic = false;
        btn.textContent = "Teste do microfone";
        btn.style.background = "#ff5500";
      } else {
        await initGlobalAudioStream();
        isTestingMic = true;
        btn.textContent = "Parar teste";
        btn.style.background = "#ff3333";
      }
    }

    function resetMicMeter() {
      document.querySelectorAll('.meter-bar').forEach(bar => bar.classList.remove('active'));
      const avatarFooter = document.getElementById('footer-user-avatar');
      const stageAvatar = document.getElementById(`stage-avatar-${username}`);
      if (avatarFooter) avatarFooter.classList.remove('speaking');
      if (stageAvatar) stageAvatar.classList.remove('speaking');
    }

    function selectInputMode(mode) {
      document.getElementById('opt-mode-vad').classList.toggle('selected', mode === 'vad');
      document.getElementById('opt-mode-open').classList.toggle('selected', mode === 'open');
      document.getElementById('opt-mode-ptt').classList.toggle('selected', mode === 'ptt');
      document.getElementById('ptt-keybind-container').style.display = mode === 'ptt' ? 'block' : 'none';
    }

    function startKeybindRecord() {
      const btn = document.getElementById('btn-ptt-keybind');
      if (!btn || isRecordingPttKey) return;
      isRecordingPttKey = true;
      btn.textContent = "Pressione a tecla...";
      const handleKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        pttKey = e.code;
        pttKeyLabel = e.key.toUpperCase();
        btn.textContent = pttKeyLabel;
        isRecordingPttKey = false;
        window.removeEventListener('keydown', handleKeyDown, true);
      };
      window.addEventListener('keydown', handleKeyDown, true);
    }

    function openChannelSettings(channelId, event) {
      if (event) event.stopPropagation();
      const srv = servers.find(s => s.id === activeServerId);
      if (!srv) return;
      const ch = srv.channels.find(c => c.id === channelId);
      if (!ch) return;
      editingChannelId = channelId;
      document.getElementById('cs-channel-name-input').value = ch.name;
      document.getElementById('cs-channel-topic-input').value = "";
      document.getElementById('cs-sidebar-header-title').textContent = `# ${ch.name.toUpperCase()}`;
      switchCsTab('geral', document.querySelector('.cs-menu-item'));
      const overlay = document.getElementById('channel-settings-overlay');
      overlay.style.display = 'flex';
      setTimeout(() => overlay.classList.add('show'), 10);
    }

    function closeChannelSettings() {
      const overlay = document.getElementById('channel-settings-overlay');
      overlay.classList.remove('show');
      setTimeout(() => { overlay.style.display = 'none'; editingChannelId = null; }, 150);
    }

    function formatChannelTopic(syntax) {
      const textarea = document.getElementById('cs-channel-topic-input');
      const start = textarea.selectionStart, end = textarea.selectionEnd, text = textarea.value;
      textarea.value = text.substring(0, start) + syntax + text.substring(start, end) + syntax + text.substring(end);
      textarea.focus();
    }

    function switchCsTab(tabName, elem) {
      const tabs = ['geral', 'permissoes', 'convites', 'integracoes'];
      tabs.forEach(t => {
        const el = document.getElementById(`cs-tab-${t}`);
        if (!el) return;
        if (t === tabName) { el.style.display = 'block'; setTimeout(() => el.classList.add('active-fade'), 10); }
        else { el.classList.remove('active-fade'); el.style.display = 'none'; }
      });
      if (elem) {
        document.querySelectorAll('.cs-menu-item').forEach(i => i.classList.remove('active'));
        elem.classList.add('active');
      }
    }

    function updateActiveChannelNameLive(newName) {
      if (!editingChannelId) return;
      const srv = servers.find(s => s.id === activeServerId);
      if (!srv) return;
      const ch = srv.channels.find(c => c.id === editingChannelId);
      if (!ch) return;
      if (newName.trim() !== "") {
        ch.name = newName.trim();
        renderChannels();
        document.getElementById('cs-sidebar-header-title').textContent = `# ${ch.name.toUpperCase()}`;
        if (activeChannel === ch.id && ch.type === 'text') document.getElementById('chat-header-user-info').textContent = `# ${ch.name}`;
      }
    }

    function deleteCurrentChannel() {
      if (!editingChannelId) return;
      const srv = servers.find(s => s.id === activeServerId);
      if (!srv || srv.channels.length <= 1) { alert("Mínimo de um canal necessário."); return; }
      if (confirm("Excluir canal permanente?")) {
        srv.channels = srv.channels.filter(c => c.id !== editingChannelId);
        closeChannelSettings();
        renderChannels();
        switchServer(activeServerId);
      }
    }

    function openHomeView() {
      activeServerId = null;
      activeDmFriend = null;
      document.getElementById('home-sidebar-btn').classList.add('active');
      document.getElementById('server-sidebar-content').style.display = 'none';
      document.getElementById('dm-sidebar-content').style.display = 'flex';
      document.getElementById('dm-nav-friends-btn').classList.add('active');
      document.querySelectorAll('.dm-user-item').forEach(el => el.classList.remove('active'));
      document.getElementById('dm-back-to-friends-btn').style.display = 'none';
      document.getElementById('chat-header-actions').style.display = 'none';
      document.getElementById('dm-header-share-btn').style.display = 'none';
      document.getElementById('dm-header-call-btn').classList.remove('active');
      document.getElementById('chat-header-voice').style.display = 'none';
      document.getElementById('chat-header-user-info').innerHTML = '<span id="chat-header-title">💬 Amigos</span>';

      document.getElementById('home-view').style.display = 'flex';
      document.getElementById('text-room-view').style.display = 'none';
      document.getElementById('voice-room-view').style.display = 'none';
      renderServers();
      renderFriendsList();
      renderDmUsersList();
    }

    function switchServer(serverId) {
      const srv = servers.find(s => s.id === serverId);
      if (userRole === 'Guest' && serverId !== 'dspeak') {
        alert("Acesso restrito para Guests! Você precisa receber um cargo de Membro para navegar neste servidor.");
        return;
      }

      activeServerId = serverId;
      activeDmFriend = null;
      document.getElementById('home-sidebar-btn').classList.remove('active');
      document.getElementById('dm-sidebar-content').style.display = 'none';
      document.getElementById('server-sidebar-content').style.display = 'flex';
      document.getElementById('dm-back-to-friends-btn').style.display = 'none';
      document.getElementById('chat-header-actions').style.display = 'none';
      document.getElementById('dm-header-share-btn').style.display = 'none';

      if (!srv) return;
      document.getElementById('server-title-text').textContent = srv.name.toUpperCase();
      const firstText = srv.channels.find(c => c.type === 'text') || srv.channels[0];
      if (firstText) {
        activeChannel = firstText.id;
        document.getElementById('chat-header-voice').style.display = 'none';
        document.getElementById('chat-header-user-info').innerHTML = `<span id="chat-header-title"># ${firstText.name}</span>`;
        document.getElementById('home-view').style.display = 'none';
        document.getElementById('text-room-view').style.display = 'flex';
        document.getElementById('voice-room-view').style.display = 'none';
        socket.emit('join-room', firstText.id);
      }
      renderServers();
      renderChannels();
    }

    function renderServers() {
      const container = document.getElementById('servers-list-container');
      container.innerHTML = '';
      servers.forEach(srv => {
        const div = document.createElement('div');
        div.className = `server-icon ${srv.id === activeServerId ? 'active' : ''}`;
        div.textContent = srv.initials;
        div.onclick = () => switchServer(srv.id);
        container.appendChild(div);
      });
    }

    function renderChannels() {
      const textContainer = document.getElementById('text-channels');
      const voiceContainer = document.getElementById('voice-channels');
      textContainer.innerHTML = '';
      voiceContainer.innerHTML = '';
      const srv = servers.find(s => s.id === activeServerId);
      if (!srv) return;

      srv.channels.forEach(ch => {
        const isVoice = ch.type === 'voice';
        const div = document.createElement('div');
        div.className = `channel ${ch.id === activeChannel ? 'active' : ''}`;
        const voiceIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6L7 10H3V14H7L12 18V6Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
        const settingsIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

        div.innerHTML = `
          <div class="channel-info"><span>${isVoice ? voiceIconSvg : '#'}</span><span>${ch.name}</span></div>
          <div class="channel-actions">
            <button class="channel-action-btn" title="Configurações do Canal" onclick="openChannelSettings('${ch.id}', event)">${settingsIconSvg}</button>
          </div>
        `;
        div.onclick = () => {
          activeChannel = ch.id;
          if (isVoice) connectVoice(ch);
          else {
            document.getElementById('chat-header-voice').style.display = 'none';
            document.getElementById('chat-header-user-info').innerHTML = `<span id="chat-header-title"># ${ch.name}</span>`;
            document.getElementById('home-view').style.display = 'none';
            document.getElementById('voice-room-view').style.display = 'none';
            document.getElementById('text-room-view').style.display = 'flex';
            socket.emit('join-room', ch.id);
          }
          renderChannels();
        };

        if (isVoice) {
          const wrapper = document.createElement('div');
          wrapper.className = 'channel-wrapper';
          wrapper.appendChild(div);
          const usersInChannel = voiceChannelUsers[ch.id] || [];
          if (usersInChannel.length > 0) {
            const sublist = document.createElement('div');
            sublist.className = 'voice-user-sublist';
            usersInChannel.forEach(u => {
              const sub = document.createElement('div');
              sub.className = 'voice-user-item';
              sub.onclick = (e) => showMiniProfile(e, u.name, `@${u.name.toLowerCase()}`, 'Conectado');
              sub.oncontextmenu = (e) => openUserContextMenu(e, u.name, u.role || 'Guest');
              sub.innerHTML = `<div class="voice-user-avatar" style="background: ${u.gradient};">${u.name.charAt(0).toUpperCase()}</div><span class="voice-user-name">${u.name}</span>`;
              sublist.appendChild(sub);
            });
            wrapper.appendChild(sublist);
          }
          voiceContainer.appendChild(wrapper);
        } else {
          const wrapper = document.createElement('div');
          wrapper.className = 'channel-wrapper';
          wrapper.appendChild(div);
          textContainer.appendChild(wrapper);
        }
      });
    }

    async function connectVoice(channel) {
      if (connectedVoiceChannel && connectedVoiceChannel !== channel.id) {
        socket.emit('leave-voice-room', { channelId: connectedVoiceChannel, username });
      }
      connectedVoiceChannel = channel.id;
      
      // Ativa detecção contínua ao entrar na sala
      await initGlobalAudioStream();

      socket.emit('join-voice-room', { channelId: channel.id, username, gradient: getUserAvatarGradient(username), role: userRole, type: 'voice' });

      document.getElementById('mic-btn').disabled = false;
      document.getElementById('deafen-btn').disabled = false;
      document.getElementById('share-btn').disabled = false;
      document.getElementById('voice-connection-panel').style.display = 'flex';
      document.getElementById('voice-status-channel-name').textContent = channel.name;

      if (!activeDmFriend) {
        document.getElementById('chat-header-voice').style.display = 'flex';
        document.getElementById('voice-header-channel-name').textContent = channel.name;
      }
      document.getElementById('voice-chat-sidebar-title').textContent = `Chat do ${channel.name}`;

      document.getElementById('home-view').style.display = 'none';
      document.getElementById('text-room-view').style.display = 'none';
      document.getElementById('voice-room-view').style.display = 'flex';
      renderChannels();
      renderStageUsers();
      socket.emit('join-room', channel.id);
    }

    function disconnectVoice(e) {
      if (e) e.stopPropagation();
      if (connectedVoiceChannel) {
        socket.emit('leave-voice-room', { channelId: connectedVoiceChannel, username });
        connectedVoiceChannel = null;
      }
      
      if (!isTestingMic) {
        stopGlobalAudioStream();
      }

      document.getElementById('mic-btn').disabled = true;
      document.getElementById('deafen-btn').disabled = true;
      document.getElementById('share-btn').disabled = true;
      document.getElementById('voice-connection-panel').style.display = 'none';
      document.getElementById('voice-sidebar-chat').style.display = 'none';
      document.getElementById('dm-header-call-btn').classList.remove('active');
      document.getElementById('dm-header-share-btn').style.display = 'none';
      if (localStream) stopScreenShare();
      renderChannels();
      openHomeView();
    }

    function toggleVoiceSidebarChat() {
      const chatSide = document.getElementById('voice-sidebar-chat');
      chatSide.style.display = chatSide.style.display === 'flex' ? 'none' : 'flex';
    }

    function renderStageUsers() {
      const stage = document.getElementById('connected-users-stage');
      stage.innerHTML = '';
      if (!connectedVoiceChannel) return;
      const users = voiceChannelUsers[connectedVoiceChannel] || [{ name: username, gradient: getUserAvatarGradient(username), role: userRole }];
      users.forEach(u => {
        const card = document.createElement('div');
        card.className = 'user-card';
        card.style.background = getUserGradient(u.name);
        card.onclick = (e) => showMiniProfile(e, u.name, `@${u.name.toLowerCase()}`, 'Conectado');
        card.oncontextmenu = (e) => openUserContextMenu(e, u.name, u.role || 'Guest');
        
        card.innerHTML = `
          <div class="card-avatar" id="stage-avatar-${u.name}" style="background: ${u.gradient};">${u.name.charAt(0).toUpperCase()}</div>
          <div class="card-name-pill">${u.name}</div>
        `;
        stage.appendChild(card);
      });
    }

    function toggleMute() {
      isMuted = !isMuted;
      document.getElementById('mic-btn').classList.toggle('active-off', isMuted);
      document.getElementById('stage-mic-btn').classList.toggle('active-off', isMuted);
    }

    function toggleDeafen() {
      isDeafened = !isDeafened;
      isMuted = isDeafened;
      document.getElementById('deafen-btn').classList.toggle('active-off', isDeafened);
      document.getElementById('mic-btn').classList.toggle('active-off', isMuted);
      document.getElementById('stage-deafen-btn').classList.toggle('active-off', isDeafened);
      document.getElementById('stage-mic-btn').classList.toggle('active-off', isMuted);
    }

    function selectRes(res) {
      selectedResolution = res;
      document.getElementById('opt-res-720').classList.toggle('selected', res === '720');
      document.getElementById('opt-res-1080').classList.toggle('selected', res === '1080');
    }

    function selectFps(fps) {
      selectedFps = fps;
      document.getElementById('opt-fps-30').classList.toggle('selected', fps === '30');
      document.getElementById('opt-fps-60').classList.toggle('selected', fps === '60');
    }

    function toggleScreenShare() {
      if (!localStream) startScreenShare();
      else stopScreenShare();
    }

    async function startScreenShare() {
      let width = selectedResolution === '1080' ? 1920 : 1280;
      let height = selectedResolution === '1080' ? 1080 : 720;
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: parseInt(selectedFps, 10) } }, audio: true });
        document.getElementById('screen-video').srcObject = localStream;
        document.getElementById('screen-container').style.display = 'flex';
        document.getElementById('connected-users-stage').style.display = 'none';
        
        document.getElementById('share-btn').classList.add('active-share');
        document.getElementById('stage-share-btn').classList.add('active-share');
        document.getElementById('stage-invite-btn').style.display = 'none';
        document.getElementById('stage-disconnect-btn').style.display = 'none';
        
        localStream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (err) { console.error("Erro transmissão:", err); }
    }

    function stopScreenShare() {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      document.getElementById('screen-video').srcObject = null;
      document.getElementById('screen-container').style.display = 'none';
      document.getElementById('connected-users-stage').style.display = 'flex';

      document.getElementById('share-btn').classList.remove('active-share');
      document.getElementById('stage-share-btn').classList.remove('active-share');
      document.getElementById('stage-invite-btn').style.display = 'flex';
      document.getElementById('stage-disconnect-btn').style.display = 'flex';
    }

    function sendTextMessage(e) {
      e.preventDefault();
      const input = document.getElementById('input');
      if (!input.value.trim() || !activeChannel) return;
      socket.emit('chat-message', { room: activeChannel, message: input.value, user: username });
      input.value = '';
    }

    function sendVoiceSidebarMessage(e) {
      e.preventDefault();
      const input = document.getElementById('voice-sidebar-input');
      if (!input.value.trim() || !connectedVoiceChannel) return;
      socket.emit('chat-message', { room: connectedVoiceChannel, message: input.value, user: username });
      input.value = '';
    }

    socket.on('update-voice-users', (data) => {
      voiceChannelUsers = data;
      renderChannels();
      renderStageUsers();
    });

    socket.on('chat-message', (data) => {
      if (data.room === activeChannel && document.getElementById('text-room-view').style.display === 'flex') {
        const chat = document.getElementById('chat');
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:12px; margin-top:8px; cursor:pointer;';
        div.onclick = (e) => showMiniProfile(e, data.user, `@${data.user.toLowerCase()}`, 'Conectado');
        div.innerHTML = `<div style="width:36px; height:36px; border-radius:50%; background:${getUserAvatarGradient(data.user)}; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold;">${data.user.charAt(0)}</div><div><div style="font-weight:bold; color:#fff; font-size:14px;">${data.user}</div><div style="color:#dbdee1; font-size:13px;">${data.message}</div></div>`;
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
      }
      
      if (data.room === connectedVoiceChannel) {
        const vChat = document.getElementById('voice-sidebar-messages');
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; gap:10px; margin-top:6px; cursor:pointer;';
        div.onclick = (e) => showMiniProfile(e, data.user, `@${data.user.toLowerCase()}`, 'Conectado');
        div.innerHTML = `<div style="width:28px; height:28px; border-radius:50%; background:${getUserAvatarGradient(data.user)}; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:bold;">${data.user.charAt(0)}</div><div><div style="font-weight:bold; color:#fff; font-size:12px;">${data.user}</div><div style="color:#dbdee1; font-size:12px;">${data.message}</div></div>`;
        vChat.insertBefore(div, vChat.firstChild);
        vChat.scrollTop = vChat.scrollHeight;
      }
    });
  </script>