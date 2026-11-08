// The official loader installs miniApp; no host credentials are read by this app.
const sdk = getSDK();
const shell = document.getElementById('host-shell');
const status = document.getElementById('host-status');
const retry = document.getElementById('host-retry');
const cancel = document.getElementById('host-cancel');
let controller, starting = false, gameStarted = false;
sdk.ready.then(() => sdk.lifecycle.ready()).catch(() => {});
async function start() {
  if (starting) return;
  starting = true; retry.hidden = true; cancel.hidden = false;
  controller = new AbortController();
  status.textContent = 'Connecting to LINUX DO… / 正在连接 LINUX DO…';
  try {
    const host = await GameHosts.createMiniAppHost(sdk, { signal: controller.signal });
    const images = {};
    await Promise.all(['font','atlas','bg','win'].map(async key => {
      const bytes = await sdk.assets.readBytes('assets/' + key + '.png', {signal:controller.signal,timeoutMs:20000});
      images[key] = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    }));
    if (controller.signal.aborted) throw Error('Cancelled');
    window.GameHost = host;
    gameStarted = true;
    await startGame(host, images);
    shell.hidden = true;
  } catch (error) {
    status.textContent = 'Unable to start / 启动失败: ' + (error.message || 'Retry');
    retry.hidden = false; cancel.hidden = true;
  } finally { starting = false; }
}
retry.addEventListener('click', () => { if(gameStarted) location.reload(); else start(); });
cancel.addEventListener('click', () => {controller?.abort(); status.textContent='Cancelled / 已取消';});
start();
async function startGame(host, images) {
