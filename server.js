const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const winston = require("winston");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
require("dotenv").config();
puppeteer: {
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--single-process'
  ]
}

// ---- ENV ----
const PORT = parseInt(process.env.PORT || "3001", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DEDUP_WINDOW = parseInt(process.env.DEDUP_WINDOW || "60000", 10);
const DEFAULT_THROTTLE = parseInt(process.env.SEND_THROTTLE_MS || "800", 10);
const ENV_SOURCE = (process.env.SOURCE_CHAT_ID || "").trim();
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;
const PUPPETEER_HEADLESS = (process.env.PUPPETEER_HEADLESS || "true").toLowerCase() !== "false";

// ---- Paths ----
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, "..", "config.json");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ---- Logger & UI logs ----
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()],
});
const LOGS = [];
function addLog(msg){ const line = `${new Date().toISOString()} ${msg}`; LOGS.push(line); if(LOGS.length>800) LOGS.shift(); logger.info(msg); }

// ---- Config helpers ----
function loadConfig(){
  try{ const raw = fs.readFileSync(CONFIG_PATH, "utf-8"); const obj = JSON.parse(raw);
    return {
      sourceChatId: obj.sourceChatId || "",
      targets: Array.isArray(obj.targets)? obj.targets : [],
      sendThrottleMs: typeof obj.sendThrottleMs === "number" ? obj.sendThrottleMs : DEFAULT_THROTTLE,
      autoForwardEnabled: !!obj.autoForwardEnabled
    };
  }catch{ return { sourceChatId:"", targets:[], sendThrottleMs: DEFAULT_THROTTLE, autoForwardEnabled: true }; }
}
function saveConfig(cfg){
  const merged = {
    sourceChatId: cfg.sourceChatId || "",
    targets: Array.isArray(cfg.targets)? cfg.targets : [],
    sendThrottleMs: typeof cfg.sendThrottleMs === "number" ? cfg.sendThrottleMs : DEFAULT_THROTTLE,
    autoForwardEnabled: !!cfg.autoForwardEnabled
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}
let CONFIG = saveConfig(loadConfig());

// ---- App/Socket ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "60mb" }));
app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/dashboard", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/api/health", (_req,res)=>res.json({ok:true,ts:Date.now()}));
app.get("/api/logs", (_req,res)=>res.json({lines: LOGS.slice(-300)}));

// ---- WhatsApp client ----
let lastQr=null, isReady=false;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSIONS_DIR }),
  puppeteer: { headless: PUPPETEER_HEADLESS, executablePath: PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] },
});
client.on("qr", qr=>{ lastQr=qr; io.emit("qr",{qr:true}); addLog("QR updated"); });
client.on("authenticated", ()=>{ io.emit("status",{authenticated:true}); addLog("Authenticated"); });
client.on("ready", ()=>{ isReady=true; io.emit("status",{ready:true}); addLog("Client ready"); });
client.on("disconnected", r=>{ isReady=false; io.emit("status",{disconnected:true,reason:r}); addLog(`Disconnected: ${r}`); });

// ---- Dedup + Queue ----
const dedup = new Set();
function dedupSig(id){ return `sig:${id}`; }
const sendQueue = [];
let processing=false;
async function processQueue(){
  if(processing) return; processing=true;
  while(sendQueue.length){
    const job=sendQueue.shift();
    try{
      if(job.type==="send"){
        await client.sendMessage(job.to, job.media||job.text||"", job.options||{});
        addLog(`Sent to ${job.to} (${job.media? "media":"text"})`);
      }else if(job.type==="forward"){
        try{
          await job.msg.forward(job.to); // fast path
          addLog(`Forwarded to ${job.to}`);
        }catch(e){
          // fallback: try download media then send, else send text
          addLog(`Forward failed -> fallback for ${job.to}: ${e?.message||e}`);
          let sent=false;
          try{
            if(job.msg.hasMedia){
              const media = await job.msg.downloadMedia();
              await client.sendMessage(job.to, media, { caption: job.msg.body || "" });
              addLog(`Fallback media sent to ${job.to}`);
              sent=true;
            }
          }catch(err){ addLog(`Download/send media failed: ${err?.message||err}`); }
          if(!sent){
            const body = job.msg.body || "";
            await client.sendMessage(job.to, body);
            addLog(`Fallback text sent to ${job.to}`);
          }
        }
      }
      await new Promise(r=>setTimeout(r, CONFIG.sendThrottleMs || DEFAULT_THROTTLE));
    }catch(e){ addLog(`Queue error: ${e?.message||e}`); }
  }
  processing=false;
}

// ---- Unified handler for incoming/self messages ----
async function handleMaybeForward(msg, srcTag){
  try{
    const chat = await msg.getChat();
    const chatId = chat?.id?._serialized || "";
    const activeSource = (ENV_SOURCE || CONFIG.sourceChatId || "").trim();
    if(!activeSource){ return; }
    if(chatId !== activeSource){ return; }
    if(!CONFIG.autoForwardEnabled){ return; }

    const sig = dedupSig(msg.id?._serialized || `${srcTag}-${Date.now()}`);
    if(dedup.has(sig)) return;
    dedup.add(sig); setTimeout(()=>dedup.delete(sig), DEDUP_WINDOW);

    const targets = (CONFIG.targets || []).filter(t=>t && t !== activeSource);
    if(!targets.length){ addLog("No targets configured"); return; }

    for(const t of targets){ sendQueue.push({ type:"forward", to:t, msg }); }
    processQueue();
  }catch(e){ addLog(`handleMaybeForward error: ${e?.message||e}`); }
}

// Receive from others
client.on("message", async (msg)=>{ await handleMaybeForward(msg, "message"); });
// Messages you send yourself (fix case when you post in source)
client.on("message_create", async (msg)=>{
  // For own messages only; library emits both own & others
  if(msg.fromMe) await handleMaybeForward(msg, "message_create");
});

// ---- API ----
app.get("/api/whatsapp/status", (_req,res)=>{
  res.json({ connected:isReady, me: isReady && client.info ? client.info.wid?._serialized : null, mode:"live", timestamp:new Date().toISOString() });
});
app.get("/api/whatsapp/qr", async (_req,res)=>{
  if(!lastQr) return res.json({success:true, qr:null, dataUrl:null});
  const dataUrl = await QRCode.toDataURL(lastQr);
  res.json({success:true, qr:lastQr, dataUrl});
});
app.post("/api/whatsapp/logout", async (_req,res)=>{ try{ await client.logout(); }catch{} isReady=false; addLog("Logged out"); res.json({success:true}); });
app.get("/api/whatsapp/groups", async (req,res)=>{
  try{
    const includeArchived = req.query.includeArchived==="1" || req.query.includeArchived==="true";
    const chats = await client.getChats();
    const groups = chats.filter(c=>c.isGroup && (includeArchived ? true : !c.archived)).map(g=>({id:g.id._serialized,name:g.name,archived:g.archived}));
    res.json({groups});
  }catch(e){ res.status(500).json({error:e?.message||"failed"}); }
});
app.get("/api/whatsapp/config", (_req,res)=>res.json({config:CONFIG, envSourceChatId:ENV_SOURCE}));
app.post("/api/whatsapp/config", (req,res)=>{
  try{
    const { sourceChatId, targets, sendThrottleMs, autoForwardEnabled } = req.body || {};
    CONFIG = saveConfig({ sourceChatId, targets, sendThrottleMs, autoForwardEnabled });
    addLog(`Config updated: source=${CONFIG.sourceChatId}, targets=${CONFIG.targets.length}, auto=${CONFIG.autoForwardEnabled}`);
    res.json({success:true, config:CONFIG});
  }catch(e){ res.status(400).json({error:e?.message||"bad payload"}); }
});
app.post("/api/whatsapp/send", async (req,res)=>{
  try{
    const { to, text, mediaBase64, filename, caption } = req.body || {};
    if(!to) return res.status(400).json({error:"to is required"});
    if(mediaBase64){
      const base64 = String(mediaBase64).split(";base64,").pop();
      const media = new MessageMedia("application/octet-stream", base64, filename || "file");
      sendQueue.push({ type:"send", to, media, options:{ caption } });
    }else{
      sendQueue.push({ type:"send", to, text: text || "" });
    }
    processQueue();
    res.json({success:true});
  }catch(e){ res.status(500).json({error:e?.message||"failed"}); }
});
app.post("/api/whatsapp/forward", async (req,res)=>{
  try{
    const { messageId, targets } = req.body || {};
    if(!messageId || !Array.isArray(targets)) return res.status(400).json({error:"bad payload"});
    const msg = await client.getMessageById(messageId);
    for(const t of targets){ sendQueue.push({ type:"forward", to:t, msg }); }
    processQueue();
    res.json({success:true, queuedTo: targets.length});
  }catch(e){ res.status(500).json({error:e?.message||"failed"}); }
});
app.post("/api/whatsapp/restart", async (_req,res)=>{
  try{
    isReady=false; addLog("Restarting client...");
    await client.destroy().catch(()=>{});
    setTimeout(async ()=>{ await client.initialize(); }, 500);
    res.json({success:true});
  }catch(e){ res.status(500).json({error:e?.message||"failed"}); }
});


// --- Watchdog Auto-Restart ---
setInterval(async () => {
  if (!isReady) return;
  try {
    await client.getState();
    addLog("HealthCheck OK");
  } catch (e) {
    addLog("HealthCheck failed, restarting client...");
    isReady = false;
    try { await client.destroy().catch(()=>{}); } catch {}
    setTimeout(() => client.initialize(), 1500);
  }
}, 60000);

server.listen(PORT, async ()=>{
  addLog(`Server on http://localhost:${PORT}`);
  try{ await client.initialize(); }catch(e){ addLog(`Initialization failed: ${e?.message||e}`); }
});
