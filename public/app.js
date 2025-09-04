(function(){
  const statusBadge = document.getElementById('status-badge');
  const qrImg = document.getElementById('qr');
  const btnRefreshQr = document.getElementById('btn-refresh-qr');
  const btnLogout = document.getElementById('btn-logout');
  const btnRestart = document.getElementById('btn-restart');
  const btnHealth = document.getElementById('btn-health');
  const chkArchived = document.getElementById('chk-archived');
  const btnLoadGroups = document.getElementById('btn-load-groups');
  const searchInput = document.getElementById('search');
  const selCount = document.getElementById('sel-count');
  const selSource = document.getElementById('sel-source');
  const targetsWrap = document.getElementById('targets');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnUnselectAll = document.getElementById('btn-unselect-all');
  const chkAuto = document.getElementById('chk-auto-forward');
  const throttleInput = document.getElementById('throttle');
  const btnSaveConfig = document.getElementById('btn-save-config');
  const btnLoadConfig = document.getElementById('btn-load-config');
  const testText = document.getElementById('test-text');
  const btnSendTest = document.getElementById('btn-send-test');
  const mediaFile = document.getElementById('media-file');
  const mediaCaption = document.getElementById('media-caption');
  const btnSendMedia = document.getElementById('btn-send-media');
  const msgId = document.getElementById('msg-id');
  const btnForwardId = document.getElementById('btn-forward-id');
  const logsPre = document.getElementById('logs');
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  const meEl = document.getElementById('me');
  const toast = document.getElementById('toast');

  function showToast(text){ toast.textContent=text; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'),1500); }

  const ioClient = io();
  ioClient.on('qr', refreshQR);
  ioClient.on('status', refreshStatus);

  async function refreshStatus(){
    try{
      const r = await fetch('/api/whatsapp/status');
      const j = await r.json();
      statusBadge.textContent = `الحالة: ${j.connected ? 'متصل' : 'غير متصل'}`;
      meEl.textContent = j.me || '—';
      if(!j.connected){ await refreshQR(); }
    }catch{ statusBadge.textContent='الحالة: —'; }
  }
  async function refreshQR(){
    try{
      const r = await fetch('/api/whatsapp/qr'); const j = await r.json();
      if(j && j.dataUrl) qrImg.src = j.dataUrl; else qrImg.removeAttribute('src');
    }catch{}
  }

  function updateSelectedCount(){
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]:checked');
    selCount.textContent = `${checks.length} محدد`;
  }
  function applySearchFilter(){
    const q = (searchInput.value || '').trim().toLowerCase();
    const items = targetsWrap.querySelectorAll('.target-item');
    items.forEach(div=>{
      const text = div.textContent.trim().toLowerCase();
      div.style.display = q && !text.includes(q) ? 'none' : '';
    });
  }

  async function loadGroups(){
    const inc = chkArchived && chkArchived.checked ? '1' : '0';
    const r = await fetch(`/api/whatsapp/groups?includeArchived=${inc}`);
    const j = await r.json();
    const groups = j.groups || [];
    selSource.innerHTML = '<option value="">— اختر المصدر —</option>';
    targetsWrap.innerHTML = '';

    groups.forEach(g=>{
      const div = document.createElement('div');
      div.className = 'target-item';
      const id = `t_${g.id.replace(/[@.:]/g,'_')}`;
      div.innerHTML = `<label><input type="checkbox" id="${id}" data-id="${g.id}"> ${g.name} ${g.archived ? '(مؤرشف)' : ''}</label>`;
      targetsWrap.appendChild(div);
      div.querySelector('input').addEventListener('change', updateSelectedCount);

      const opt = document.createElement('option');
      opt.value = g.id; opt.textContent = `${g.name}${g.archived ? ' (مؤرشف)' : ''}`;
      selSource.appendChild(opt);
    });
    updateSelectedCount(); applySearchFilter(); showToast('تم تحميل المجموعات');
  }

  async function readConfig(){
    const r = await fetch('/api/whatsapp/config'); const j = await r.json();
    const cfg = j.config || { sourceChatId:'', targets:[], sendThrottleMs:800, autoForwardEnabled:true };
    selSource.value = cfg.sourceChatId || '';
    throttleInput.value = cfg.sendThrottleMs || 800;
    chkAuto.checked = !!cfg.autoForwardEnabled;
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]');
    checks.forEach(ch => { ch.checked = (cfg.targets || []).includes(ch.dataset.id); });
    updateSelectedCount(); showToast('تم قراءة الإعدادات');
  }

  async function saveConfig(){
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]');
    const targets = []; checks.forEach(ch=>{ if(ch.checked) targets.push(ch.dataset.id); });
    const payload = { sourceChatId: selSource.value || '', targets, sendThrottleMs: Number(throttleInput.value || 800), autoForwardEnabled: !!chkAuto.checked };
    await fetch('/api/whatsapp/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    showToast('تم الحفظ');
  }

  async function sendTextToTargets(){
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]:checked');
    const targets = Array.from(checks).map(ch=>ch.dataset.id);
    if(!targets.length) return showToast('اختر أهدافًا أولاً');
    const txt = testText.value || 'رسالة تجريبية';
    for(const t of targets){
      await fetch('/api/whatsapp/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to: t, text: txt }) });
    }
    showToast('تم الإرسال النصي');
  }

  function fileToBase64(file){ return new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(String(r.result)); r.onerror=reject; r.readAsDataURL(file); }); }
  async function sendMediaToTargets(){
    const file = mediaFile.files && mediaFile.files[0];
    if(!file) return showToast('اختر ملف ميديا أولاً');
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]:checked');
    const targets = Array.from(checks).map(ch=>ch.dataset.id);
    if(!targets.length) return showToast('اختر أهدافًا أولاً');
    const base64 = await fileToBase64(file);
    for(const t of targets){
      await fetch('/api/whatsapp/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to: t, mediaBase64: base64, filename: file.name, caption: mediaCaption.value || '' }) });
    }
    showToast('تم إرسال الميديا');
  }

  async function forwardById(){
    const id = (msgId.value || '').trim(); if(!id) return showToast('أدخل Message ID');
    const checks = targetsWrap.querySelectorAll('input[type=checkbox]:checked');
    const targets = Array.from(checks).map(ch=>ch.dataset.id);
    if(!targets.length) return showToast('اختر أهدافًا أولاً');
    await fetch('/api/whatsapp/forward', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ messageId: id, targets }) });
    showToast('تمت إضافة العملية إلى قائمة الانتظار');
  }

  async function refreshLogs(){ const r=await fetch('/api/logs'); const j=await r.json(); logsPre.textContent=(j.lines||[]).join('\\n'); }

  // Events
  btnRefreshQr.addEventListener('click', refreshQR);
  btnLogout.addEventListener('click', async ()=>{ await fetch('/api/whatsapp/logout',{method:'POST'}); await refreshStatus(); await refreshQR(); showToast('خروج'); });
  btnRestart.addEventListener('click', async ()=>{ await fetch('/api/whatsapp/restart',{method:'POST'}); setTimeout(refreshStatus,1200); showToast('إعادة تشغيل'); });
  btnHealth.addEventListener('click', async ()=>{ const r=await fetch('/api/health'); const j=await r.json(); showToast(j.ok?'OK':'Not OK'); });
  btnLoadGroups.addEventListener('click', loadGroups);
  btnLoadConfig.addEventListener('click', readConfig);
  btnSaveConfig.addEventListener('click', saveConfig);
  btnSendTest.addEventListener('click', sendTextToTargets);
  btnSendMedia.addEventListener('click', sendMediaToTargets);
  btnForwardId.addEventListener('click', forwardById);
  btnSelectAll.addEventListener('click', ()=>{ targetsWrap.querySelectorAll('input[type=checkbox]').forEach(ch=>ch.checked=true); updateSelectedCount(); });
  btnUnselectAll.addEventListener('click', ()=>{ targetsWrap.querySelectorAll('input[type=checkbox]').forEach(ch=>ch.checked=false); updateSelectedCount(); });
  searchInput.addEventListener('input', applySearchFilter);
  btnRefreshLogs.addEventListener('click', refreshLogs);

  // Init
  refreshStatus(); refreshLogs(); setInterval(refreshLogs, 4000);
})();