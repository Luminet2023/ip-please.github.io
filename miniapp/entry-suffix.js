  const storageNotice = document.getElementById('host-storage');
  const storageText = document.getElementById('host-storage-text');
  const storageRetry = document.getElementById('host-storage-retry');
  function showStorage() {
    if(host.identityChanged && host.loginDetected){host.reload();return;}
    if(host.identityChanged){shell.hidden=false;status.textContent=T('平台账号已变化，请重新打开小程序。');retry.hidden=false;cancel.hidden=true;return;}
    storageNotice.hidden = !host.storageError;
    storageText.textContent = T('本机保存失败，进度仍在内存中，请重试。');
    storageRetry.textContent = T('重试');
  }
  host.onChange(showStorage); showStorage();
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')host.checkIdentity().catch(showStorage);});
  storageRetry.addEventListener('click', async () => {
    storageRetry.disabled=true;
    try {
      await host.flush(); await host.retryTransition();
      if(host.pending().length) await CloudSync.retryPending();
    } catch(error) {CloudSync.ui.toast(T('保存或连接失败，请重试。'));}
    finally {storageRetry.disabled=false;showStorage();}
  });
  document.getElementById('mute').addEventListener('click',toggleMute);
  document.getElementById('full').addEventListener('click',()=>host.fullscreen().catch(e=>CloudSync.ui.toast(e.message)));
  document.getElementById('rotate-dismiss').addEventListener('click',()=>document.getElementById('rotate').classList.remove('show'));
  await boot();
}
