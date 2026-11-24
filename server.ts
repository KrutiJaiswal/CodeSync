import 'dotenv/config';
import dns from 'dns';

// Force Node to use public DNS servers to resolve the MongoDB Atlas SRV record
dns.setServers(['8.8.8.8', '1.1.1.1']);


import express from 'express';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { GoogleGenAI } from '@google/genai';
import mongoose from 'mongoose';
import { OAuth2Client } from 'google-auth-library';

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'codesync_dev_secret_key_2026';
const JUDGE0_URL = process.env.JUDGE0_API_URL || 'https://ce.judge0.com';
const JUDGE0_KEY = process.env.JUDGE0_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/codesync';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// User schema & model
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  avatarColor: { type: String, required: true },
  googleId: { type: String },
  githubConnected: { type: Boolean, default: false },
  githubUsername: { type: String },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// In-memory Room State
interface RoomState {
  roomCode: string;
  name: string;
  creatorId: string; // userId of the user who created the room
  ydoc: Y.Doc;
  language: string;
  users: Map<string, { id: string; name: string; color: string; socketId: string; isHost?: boolean }>;
  chatHistory: Array<{
    id: string;
    roomId: string;
    userId: string;
    userName: string;
    userColor: string;
    content: string;
    timestamp: string;
    isSystem?: boolean;
  }>;
  lineOwners: Map<number, { userId: string; userName: string; userColor: string; timestamp: number }>;
}

const activeRooms = new Map<string, RoomState>();

// Judge0 language ID map cache
let judge0LanguageMap: Record<string, number> = {
  javascript: 63,
  python: 71,
  java: 62,
  c: 50,
  cpp: 54,
  typescript: 74,
  rust: 73,
  go: 60,
};

async function fetchJudge0Languages() {
  try {
    const headers: Record<string, string> = {};
    if (JUDGE0_KEY) {
      headers['X-RapidAPI-Key'] = JUDGE0_KEY;
    }
    const res = await fetch(`${JUDGE0_URL}/languages`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const map: Record<string, number> = { ...judge0LanguageMap };
        data.forEach((lang: { id: number; name: string }) => {
          const nameLower = lang.name.toLowerCase();
          if (nameLower.includes('javascript') || nameLower.includes('node')) map['javascript'] = lang.id;
          else if (nameLower.includes('python')) map['python'] = lang.id;
          else if (nameLower.includes('java ') || nameLower.endsWith('java')) map['java'] = lang.id;
          else if (nameLower.includes('c++') || nameLower.includes('gcc')) map['cpp'] = lang.id;
          else if (nameLower.includes('c (') || nameLower.includes('gcc')) map['c'] = lang.id;
          else if (nameLower.includes('typescript')) map['typescript'] = lang.id;
          else if (nameLower.includes('rust')) map['rust'] = lang.id;
          else if (nameLower.includes('go (')) map['go'] = lang.id;
        });
        judge0LanguageMap = map;
        console.log('[Judge0] Loaded language IDs:', judge0LanguageMap);
      }
    }
  } catch (err) {
    console.warn('[Judge0] Could not fetch live languages, using cached defaults:', err);
  }
}

fetchJudge0Languages();

// Generate 6-char uppercase room code without ambiguous characters (0, O, 1, I, L)
function generateRoomCode(): string {
  const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getOrCreateRoom(roomCode: string, creatorId = 'unknown'): RoomState {
  const code = roomCode.toUpperCase();
  let room = activeRooms.get(code);
  if (!room) {
    const ydoc = new Y.Doc();
    room = {
      roomCode: code,
      name: `Room ${code}`,
      creatorId,
      ydoc,
      language: 'javascript',
      users: new Map(),
      chatHistory: [],
      lineOwners: new Map(),
    };
    activeRooms.set(code, room);
  }
  return room;
}

async function startServer() {
  // Connect to MongoDB
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('[MongoDB] Connected successfully to database');
    
    // Seed default demo user
    const demoEmail = 'alex@example.com';
    const hasDemo = await User.findOne({ email: demoEmail });
    if (!hasDemo) {
      await new User({
        name: 'Alex Developer',
        email: demoEmail,
        passwordHash: bcrypt.hashSync('password123', 10),
        avatarColor: '#6C8EF5',
      }).save();
      console.log('[MongoDB] Created default demo user alex@example.com');
    }
  } catch (err) {
    console.error('[MongoDB] Connection error:', err);
    console.warn('Proceeding without database connection (database features will fail)...');
  }

  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // REST API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeRoomsCount: activeRooms.size });
  });

  // Expose config to frontend
  app.get('/api/config', (req, res) => {
    res.json({
      googleClientId: GOOGLE_CLIENT_ID,
    });
  });

  // Authentication
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!email || !password || !name) {
        res.status(400).json({ error: 'Name, email, and password are required' });
        return;
      }
      
      const emailLower = email.toLowerCase().trim();
      const existing = await User.findOne({ email: emailLower });
      if (existing) {
        res.status(400).json({ error: 'User already exists with this email' });
        return;
      }

      const presenceColors = ['#F2A93B', '#4FD1C5', '#6C8EF5', '#B37FEB', '#4FBF75', '#F27FB0', '#E8875E', '#7FD1E8'];
      const avatarColor = presenceColors[Math.floor(Math.random() * presenceColors.length)];

      const newUser = new User({
        name,
        email: emailLower,
        passwordHash: bcrypt.hashSync(password, 10),
        avatarColor,
      });

      await newUser.save();

      const token = jwt.sign({ id: newUser.id, email: newUser.email, name: newUser.name, avatarColor }, JWT_SECRET, {
        expiresIn: '7d',
      });

      res.json({
        token,
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          avatarColor: newUser.avatarColor,
        },
      });
    } catch (err: any) {
      console.error('Registration error:', err);
      res.status(500).json({ error: 'Internal server error during registration' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password required' });
        return;
      }

      const user = await User.findOne({ email: email.toLowerCase().trim() });
      if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const token = jwt.sign({ id: user.id, email: user.email, name: user.name, avatarColor: user.avatarColor }, JWT_SECRET, {
        expiresIn: '7d',
      });

      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarColor: user.avatarColor,
          githubConnected: user.githubConnected,
          githubUsername: user.githubUsername,
        },
      });
    } catch (err: any) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Internal server error during login' });
    }
  });
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { token } = req.body;
      let email = '';
      let name = '';
      let googleId = '';

      if (token) {
        if (googleClient && GOOGLE_CLIENT_ID) {
          try {
            const ticket = await googleClient.verifyIdToken({
              idToken: token,
              audience: GOOGLE_CLIENT_ID,
            });
            const payload = ticket.getPayload();
            if (!payload || !payload.email) {
              res.status(400).json({ error: 'Invalid Google token payload' });
              return;
            }
            email = payload.email.toLowerCase().trim();
            name = payload.name || payload.given_name || 'Google User';
            googleId = payload.sub;
          } catch (verifyErr) {
            console.error('Google token verification failed:', verifyErr);
            res.status(401).json({ error: 'Invalid Google token' });
            return;
          }
        } else {
          // Fallback for development if token is passed but client ID is not configured
          console.warn('[Google Auth] GOOGLE_CLIENT_ID is not configured. Verifying token via public Google API...');
          try {
            const resGoogle = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
            if (resGoogle.ok) {
              const payload = await resGoogle.json();
              email = payload.email.toLowerCase().trim();
              name = payload.name || 'Google User';
              googleId = payload.sub;
            } else {
              throw new Error('Google tokeninfo verification failed');
            }
          } catch (e) {
            res.status(401).json({ error: 'Google login failed verification' });
            return;
          }
        }
      } else if (req.body.email && !GOOGLE_CLIENT_ID) {
        // Mock fallback for development if token is omitted
        email = req.body.email.toLowerCase().trim();
        name = req.body.name || 'Google Developer';
        googleId = `mock_g_${Date.now()}`;
      } else {
        res.status(400).json({ error: 'Token is required' });
        return;
      }

      let user = await User.findOne({ email });

      if (!user) {
        const presenceColors = ['#F2A93B', '#4FD1C5', '#6C8EF5', '#B37FEB', '#4FBF75', '#F27FB0', '#E8875E', '#7FD1E8'];
        user = new User({
          name,
          email,
          avatarColor: presenceColors[Math.floor(Math.random() * presenceColors.length)],
          googleId,
        });
        await user.save();
      } else if (!user.googleId) {
        // Link Google ID to existing email user
        user.googleId = googleId;
        await user.save();
      }

      const jwtToken = jwt.sign({ id: user.id, email: user.email, name: user.name, avatarColor: user.avatarColor }, JWT_SECRET, {
        expiresIn: '7d',
      });

      res.json({
        token: jwtToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarColor: user.avatarColor,
          githubConnected: user.githubConnected,
          githubUsername: user.githubUsername,
        },
      });
    } catch (err: any) {
      console.error('Google auth error:', err);
      res.status(500).json({ error: 'Internal server error during Google auth' });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const user = await User.findById(decoded.id);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarColor: user.avatarColor,
          githubConnected: user.githubConnected,
          githubUsername: user.githubUsername,
        }
      });
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // Room Management
  app.post('/api/rooms/create', (req, res) => {
    // Extract creator ID from optional auth header
    let creatorId = 'unknown';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
        creatorId = decoded.id || 'unknown';
      } catch (_) {
        // token invalid; proceed without creator tracking
      }
    }

    let code = generateRoomCode();
    while (activeRooms.has(code)) {
      code = generateRoomCode();
    }
    const room = getOrCreateRoom(code, creatorId);
    res.json({ roomCode: room.roomCode, creatorId: room.creatorId });
  });

  app.get('/api/rooms/validate/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const exists = activeRooms.has(code);
    res.json({ exists, roomCode: code });
  });

  // Delete a room — only the creator can delete
  app.delete('/api/rooms/:code', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    let requesterId = '';
    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
      requesterId = decoded.id || '';
    } catch (_) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const code = req.params.code.toUpperCase();
    const room = activeRooms.get(code);
    if (!room) {
      res.status(404).json({ error: 'Room not found or already deleted' });
      return;
    }

    if (room.creatorId !== requesterId) {
      res.status(403).json({ error: 'Only the room creator can delete this room' });
      return;
    }

    // Notify all connected users that the room is being deleted
    io.to(code).emit('room-deleted', { roomCode: code, message: 'This room has been deleted by the owner.' });

    // Remove all sockets from the room
    io.socketsLeave(code);

    // Remove room from active rooms
    activeRooms.delete(code);

    res.json({ success: true, roomCode: code });
  });

  // AI Debugging Assistant Endpoint
  app.post('/api/ai/debug', async (req, res) => {
    try {
      const { code, language, lastError, question } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        res.json({
          response: `**AI Assistant Ready** (Gemini key not configured in environment).\n\nHere is an analysis based on your query:\n\n1. **Language:** ${language || 'Unknown'}\n2. **Error observed:** ${lastError || 'None'}\n3. **Quick Fix Tip:** Ensure all variable declarations and imports match your selected runtime signature.`,
        });
        return;
      }

      // --- Filter out internal backend/infra error messages ---
      // These patterns indicate execution-service failures, NOT user code errors.
      // We must never forward them to Gemini as compiler diagnostics.
      const infraErrorPatterns = [
        /compiler service error/i,
        /base64/i,
        /utf-?8/i,
        /http\s*\d{3}/i,
        /failed to connect/i,
        /execution server/i,
        /fetch\s+error/i,
        /network error/i,
        /econnrefused/i,
        /etimedout/i,
        /judge0/i,
        /source_code.*stdin.*expected_output/i,
        /should be.*encoded/i,
        /internal server error/i,
        /service unavailable/i,
      ];

      const isInfraError = (text: string) =>
        infraErrorPatterns.some((re) => re.test(text));

      const rawError = lastError || '';
      const executionServiceFailed = rawError.trim().length > 0 && isInfraError(rawError);
      // Only pass clean compiler output to Gemini
      const cleanError = executionServiceFailed ? '' : rawError;

      const ai = new GoogleGenAI({ apiKey });

      // Build a context section for the error — if the service failed we tell
      // Gemini explicitly so it can still help by analysing the source code.
      const errorContext = executionServiceFailed
        ? `Note: The code execution service encountered an internal error and did not return compiler diagnostics. Analyse the source code directly for issues.`
        : cleanError
          ? `Most recent execution output / error message:\n\`\`\`\n${cleanError}\n\`\`\``
          : `Most recent execution output / error message: No compiler errors recorded.`;

      // Extra instruction for when we have no real compiler output
      const fallbackInstruction = executionServiceFailed
        ? `\nIMPORTANT: The execution service failed with an internal error. Do NOT mention Judge0, Base64, UTF-8 encoding, HTTP status codes, or any backend infrastructure. Instead, open your response with: "The execution service encountered an internal error, so I could not retrieve compiler diagnostics. However, I analysed your source code directly and found the following issues:" — then describe only user-code issues.`
        : '';

      const prompt = `You are CodeSync's real-time AI pair-programming and debugging assistant. Focus ONLY on the user's source code, compiler diagnostics, runtime errors, syntax errors, and warnings. NEVER mention execution service internals, HTTP errors, Base64, UTF-8, Judge0, network errors, or any backend infrastructure details — those are irrelevant to the user.

Language: ${language || 'javascript'}
Code snippet:
\`\`\`${language || ''}
${code || ''}
\`\`\`

${errorContext}

User question:
${question || 'Explain this code or any errors present.'}
${fallbackInstruction}

Provide a concise, clear, and actionable explanation with code fixes where relevant. Be helpful, technical, and accurate.`;

      // Retry up to 3 times for transient Gemini errors (503 / 429)
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAYS = [1000, 2000]; // ms between retries
      let lastAiError: any = null;
      let aiText: string | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const result = await ai.models.generateContent({
            model: 'gemini-flash-latest',
            contents: prompt,
          });
          aiText = result.text ?? null;
          break; // success
        } catch (aiErr: any) {
          lastAiError = aiErr;
          const status = aiErr?.status ?? 0;
          const isRetryable = status === 503 || status === 429;
          if (isRetryable && attempt < MAX_ATTEMPTS - 1) {
            console.warn(`[AI] Gemini ${status} on attempt ${attempt + 1}, retrying in ${RETRY_DELAYS[attempt]}ms…`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          } else {
            break;
          }
        }
      }

      if (aiText !== null) {
        res.json({ response: aiText });
      } else {
        // Gemini unavailable after retries — return a graceful user-facing message
        console.error('[AI] All attempts failed:', lastAiError);
        const isOverloaded = lastAiError?.status === 503 || lastAiError?.status === 429;
        const friendlyMsg = isOverloaded
          ? `The AI assistant is temporarily unavailable due to high demand. Please try again in a moment.\n\nIn the meantime, here are common things to check:\n- Verify variable names and spelling\n- Ensure all statements end with the correct punctuation\n- Check that all braces/brackets are balanced`
          : `The AI assistant could not process your request right now. Please try again.`;
        res.json({ response: friendlyMsg });
      }
    } catch (err: any) {
      console.error('[AI] Unexpected error:', err);
      res.json({ response: 'The AI assistant encountered an unexpected error. Please try again.' });
    }
  });

  // GitHub Integration Proxy
  app.post('/api/github/push', async (req, res) => {
    const { token, owner, repo, path, message, content } = req.body;
    if (!token || !owner || !repo || !path || !content) {
      res.status(400).json({ error: 'Missing required parameters (token, owner, repo, path, content)' });
      return;
    }

    try {
      // First check if file already exists to obtain SHA
      let sha: string | undefined = undefined;
      const getFileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'CodeSync-App',
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (getFileRes.ok) {
        const fileData = await getFileRes.json();
        sha = fileData.sha;
      }

      const base64Content = Buffer.from(content, 'utf-8').toString('base64');
      const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'CodeSync-App',
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          message: message || 'Update from CodeSync',
          content: base64Content,
          sha,
        }),
      });

      if (!putRes.ok) {
        const errData = await putRes.json();
        res.status(putRes.status).json({ error: errData.message || 'GitHub push failed' });
        return;
      }

      const resultData = await putRes.json();
      res.json({
        success: true,
        html_url: resultData.content?.html_url || `https://github.com/${owner}/${repo}/blob/main/${path}`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Error communicating with GitHub API' });
    }
  });

  // Real-Time Socket.io Connection & Event Handling
  io.on('connection', (socket) => {
    let currentRoomCode: string | null = null;
    let currentUser: { id: string; name: string; color: string } | null = null;

    socket.on('join-room', ({ roomCode, user }) => {
      const code = (roomCode || '').toUpperCase();
      if (!code) return;

      currentRoomCode = code;
      currentUser = user;
      socket.join(code);

      const room = getOrCreateRoom(code, user.id);
      const isFirst = room.users.size === 0;

      room.users.set(socket.id, {
        id: user.id,
        name: user.name,
        color: user.color,
        socketId: socket.id,
        isHost: isFirst,
      });

      // Send initial room state to joining client
      const stateVector = Y.encodeStateAsUpdate(room.ydoc);
      const stateVectorBase64 = Buffer.from(stateVector).toString('base64');

      socket.emit('room-state', {
        docState: stateVectorBase64,
        language: room.language,
        users: Array.from(room.users.values()),
        chatHistory: room.chatHistory,
        lineOwners: Object.fromEntries(room.lineOwners.entries()),
        creatorId: room.creatorId,
      });

      // Broadcast active user update to all in room
      io.to(code).emit('users-changed', {
        users: Array.from(room.users.values()),
      });

      // System join notification
      const sysMsg = {
        id: `sys_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        roomId: code,
        userId: 'system',
        userName: 'System',
        userColor: '#EF4B4B',
        content: `${user.name} joined the room`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSystem: true,
      };
      room.chatHistory.push(sysMsg);
      io.to(code).emit('chat-message', sysMsg);
    });

    // CRDT Doc Updates
    socket.on('doc-update', ({ roomCode, updateBase64 }) => {
      const code = (roomCode || currentRoomCode || '').toUpperCase();
      const room = activeRooms.get(code);
      if (!room || !updateBase64) return;

      try {
        const updateBuffer = Buffer.from(updateBase64, 'base64');
        Y.applyUpdate(room.ydoc, updateBuffer);
        socket.to(code).emit('doc-update', { updateBase64 });
      } catch (e) {
        console.error('Failed to apply Yjs doc update:', e);
      }
    });

    // Live Cursor / Awareness
    socket.on('awareness-update', ({ roomCode, awareness }) => {
      const code = (roomCode || currentRoomCode || '').toUpperCase();
      if (!code) return;
      socket.to(code).emit('awareness-update', { awareness, socketId: socket.id });
    });

    // Language Change
    socket.on('language-changed', ({ roomCode, language }) => {
      const code = (roomCode || currentRoomCode || '').toUpperCase();
      const room = activeRooms.get(code);
      if (!room) return;

      room.language = language;
      io.to(code).emit('language-changed', { language });
    });

    // Chat Messages
    socket.on('chat-message', ({ roomCode, content, user }) => {
      const code = (roomCode || currentRoomCode || '').toUpperCase();
      const room = activeRooms.get(code);
      if (!room || !content.trim()) return;

      const msg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        roomId: code,
        userId: user.id,
        userName: user.name,
        userColor: user.color,
        content: content.trim(),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      room.chatHistory.push(msg);
      io.to(code).emit('chat-message', msg);
    });

    // Line Attribution
    socket.on('line-touched', ({ roomCode, startLine, endLine, userId, userName, userColor }) => {
      const code = (roomCode || currentRoomCode || '').toUpperCase();
      const room = activeRooms.get(code);
      if (!room) return;

      const now = Date.now();
      for (let l = startLine; l <= endLine; l++) {
        room.lineOwners.set(l, {
          userId,
          userName,
          userColor,
          timestamp: now,
        });
      }

      io.to(code).emit('line-owners-updated', {
        lineOwners: Object.fromEntries(room.lineOwners.entries()),
      });
    });

    // Compiler Judge0 Code Execution
    // We always use base64_encoded=true so arbitrary source code (with special
    // characters, non-ASCII, etc.) is never rejected by the Judge0 API with a
    // "should be UTF-8 encoded" HTTP 400 error.
    socket.on('run-code', async ({ roomCode, language, code, stdin }) => {
      const roomCodeUpper = (roomCode || currentRoomCode || '').toUpperCase();
      const langId = judge0LanguageMap[language] || 63;

      // Helper: encode a string to base64 (handles any Unicode safely)
      const toBase64 = (str: string) => Buffer.from(str ?? '', 'utf8').toString('base64');
      // Helper: decode a base64 string coming back from Judge0
      const fromBase64 = (b64: string | null | undefined): string | null => {
        if (!b64) return null;
        try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return b64; }
      };

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };
        if (JUDGE0_KEY) {
          headers['X-RapidAPI-Key'] = JUDGE0_KEY;
        }

        // Send base64-encoded fields; tell Judge0 responses are also base64
        const judgeRes = await fetch(`${JUDGE0_URL}/submissions?base64_encoded=true&wait=true`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source_code: toBase64(code || ''),
            language_id: langId,
            stdin: toBase64(stdin || ''),
          }),
        });

        if (!judgeRes.ok) {
          // Service itself failed — emit a neutral message; the AI will handle it gracefully
          const errText = await judgeRes.text();
          console.error(`[Judge0] HTTP ${judgeRes.status}: ${errText}`);
          io.to(roomCodeUpper).emit('run-result', {
            stdout: null,
            stderr: `Execution service returned an error (HTTP ${judgeRes.status}). Please try again.`,
            status: { id: 11, description: 'Runtime Error' },
          });
          return;
        }

        const runResult = await judgeRes.json();

        // Decode base64 fields returned by Judge0
        const stdout = fromBase64(runResult.stdout);
        const stderr = fromBase64(runResult.stderr);
        const compileOutput = fromBase64(runResult.compile_output);
        const message = fromBase64(runResult.message);

        // Prefer compile_output for compilation errors, then stderr, then message
        const errorOutput = stderr || compileOutput || message || null;

        io.to(roomCodeUpper).emit('run-result', {
          stdout: stdout || null,
          stderr: errorOutput,
          status: runResult.status,
          time: runResult.time ? `${runResult.time}s` : null,
          memory: runResult.memory ? Math.round(runResult.memory / 1024) : null,
        });
      } catch (err: any) {
        console.error('[Judge0] run error:', err);
        io.to(roomCodeUpper).emit('run-result', {
          stdout: null,
          stderr: `Could not reach the execution service. Please check your connection and try again.`,
          status: { id: 13, description: 'Execution Exception' },
        });
      }
    });

    // Disconnect Handling
    socket.on('disconnect', () => {
      if (currentRoomCode) {
        const room = activeRooms.get(currentRoomCode);
        if (room) {
          const user = room.users.get(socket.id);
          if (user) {
            room.users.delete(socket.id);
            io.to(currentRoomCode).emit('users-changed', {
              users: Array.from(room.users.values()),
            });

            const sysMsg = {
              id: `sys_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
              roomId: currentRoomCode,
              userId: 'system',
              userName: 'System',
              userColor: '#EF4B4B',
              content: `${user.name} left the room`,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isSystem: true,
            };
            room.chatHistory.push(sysMsg);
            io.to(currentRoomCode).emit('chat-message', sysMsg);
          }
        }
      }
    });
  });

  // Vite Middleware for Development / Static serving for Production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CodeSync Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
