const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v"]);

function now(){ return Date.now(); }

function loadDb(){
  if (!fs.existsSync(DB_PATH)){
    return { nextUserId: 1, nextVideoId: 1, nextCommentId: 1, users: [], videos: [], likes: [], comments: [] };
  }
  try{
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const data = JSON.parse(raw);
    // minimal shape repair
    return Object.assign({ nextUserId:1, nextVideoId:1, nextCommentId:1, users:[], videos:[], likes:[], comments:[] }, data);
  }catch{
    return { nextUserId: 1, nextVideoId: 1, nextCommentId: 1, users: [], videos: [], likes: [], comments: [] };
  }
}

function saveDb(db){
  // atomic-ish write
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tmp, DB_PATH);
}

let DB = loadDb();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use(session({
  name: "videodrop.sid",
  secret: process.env.SESSION_SECRET || "videodrop_dev_secret_change_me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 14,
  }
}));

function requireAuth(req, res, next){
  if (!req.session.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function cleanUsername(s){ return String(s || "").trim(); }
function cleanText(s){ return String(s || "").trim(); }
function isValidUsername(u){ return /^[a-zA-Z0-9_.-]{3,20}$/.test(u); }

// --- auth ---
app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/register", (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");

  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Username: 3-20 символов, латиница/цифры/._-" });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: "Password: минимум 6 символов" });
  }
  if (DB.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Username занят" });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const user = { id: DB.nextUserId++, username, password_hash, created_at: now() };
  DB.users.push(user);
  saveDb(DB);

  req.session.user = { id: user.id, username: user.username };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/login", (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");

  const user = DB.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: "Неверный логин или пароль" });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }

  req.session.user = { id: user.id, username: user.username };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- upload ---
function safeFilename(original){
  const base = path.basename(original).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${Date.now()}_${base}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

app.post("/api/upload", requireAuth, upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  const ext = path.extname(req.file.filename).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {}
    return res.status(400).json({ error: "Формат не поддерживается (mp4/webm/mov/mkv/m4v)" });
  }

  const titleRaw = cleanText(req.body.title);
  const title = titleRaw ? titleRaw.slice(0, 80) : (req.file.originalname || "video").slice(0, 80);

  const video = {
    id: DB.nextVideoId++,
    owner_user_id: req.session.user.id,
    title,
    filename: req.file.filename,
    created_at: now()
  };
  DB.videos.push(video);
  saveDb(DB);

  res.json({ ok: true, video_id: video.id });
});

// --- feed ---
app.get("/api/videos", (req, res) => {
  const me = req.session.user ? req.session.user.id : null;

  const videos = [...DB.videos].sort((a,b) => b.created_at - a.created_at).slice(0, 200).map(v => {
    const owner = DB.users.find(u => u.id === v.owner_user_id)?.username || "unknown";
    const like_count = DB.likes.filter(l => l.video_id === v.id).length;
    const comment_count = DB.comments.filter(c => c.video_id === v.id).length;
    const liked_by_me = me ? DB.likes.some(l => l.video_id === v.id && l.user_id === me) : false;
    return {
      id: v.id,
      title: v.title,
      url: `/uploads/${encodeURIComponent(v.filename)}`,
      created_at: v.created_at,
      owner,
      like_count,
      comment_count,
      liked_by_me
    };
  });

  res.json({ videos });
});

// --- likes ---
app.post("/api/videos/:id/like", requireAuth, (req, res) => {
  const videoId = Number(req.params.id);
  if (!Number.isFinite(videoId)) return res.status(400).json({ error: "Bad id" });

  const exists = DB.likes.some(l => l.user_id === req.session.user.id && l.video_id === videoId);
  if (!exists) {
    DB.likes.push({ user_id: req.session.user.id, video_id: videoId, created_at: now() });
    saveDb(DB);
  }
  const like_count = DB.likes.filter(l => l.video_id === videoId).length;
  res.json({ ok: true, like_count, liked_by_me: true });
});

app.delete("/api/videos/:id/like", requireAuth, (req, res) => {
  const videoId = Number(req.params.id);
  if (!Number.isFinite(videoId)) return res.status(400).json({ error: "Bad id" });

  DB.likes = DB.likes.filter(l => !(l.user_id === req.session.user.id && l.video_id === videoId));
  saveDb(DB);

  const like_count = DB.likes.filter(l => l.video_id === videoId).length;
  res.json({ ok: true, like_count, liked_by_me: false });
});

// --- comments ---
app.get("/api/videos/:id/comments", (req, res) => {
  const videoId = Number(req.params.id);
  if (!Number.isFinite(videoId)) return res.status(400).json({ error: "Bad id" });

  const me = req.session.user ? req.session.user.id : null;

  const comments = DB.comments
    .filter(c => c.video_id === videoId)
    .sort((a,b) => a.created_at - b.created_at)
    .slice(0, 500)
    .map(c => ({
      id: c.id,
      text: c.text,
      created_at: c.created_at,
      username: DB.users.find(u => u.id === c.user_id)?.username || "unknown",
      mine: me ? (c.user_id === me) : false
    }));

  res.json({ comments });
});

app.post("/api/videos/:id/comments", requireAuth, (req, res) => {
  const videoId = Number(req.params.id);
  if (!Number.isFinite(videoId)) return res.status(400).json({ error: "Bad id" });

  const text = cleanText(req.body.text);
  if (!text || text.length < 1 || text.length > 500) return res.status(400).json({ error: "Комментарий 1..500 символов" });

  const comment = { id: DB.nextCommentId++, video_id: videoId, user_id: req.session.user.id, text, created_at: now() };
  DB.comments.push(comment);
  saveDb(DB);

  res.json({ ok: true, comment_id: comment.id });
});

app.delete("/api/comments/:id", requireAuth, (req, res) => {
  const commentId = Number(req.params.id);
  if (!Number.isFinite(commentId)) return res.status(400).json({ error: "Bad id" });

  const comment = DB.comments.find(c => c.id === commentId);
  if (!comment) return res.status(404).json({ error: "Not found" });
  if (comment.user_id !== req.session.user.id) return res.status(403).json({ error: "Forbidden" });

  DB.comments = DB.comments.filter(c => c.id !== commentId);
  saveDb(DB);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VideoDrop Social (no native deps): listening on ${PORT}`);
});
