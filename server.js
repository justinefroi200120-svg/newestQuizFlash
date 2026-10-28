'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1000000, pingInterval: 10000, pingTimeout: 10000 });
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.QUIZ_DATA_FILE || path.join(__dirname, 'data', 'store.json');
app.use(express.static(path.join(__dirname, 'public')));

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data.teachers) && Array.isArray(data.quizzes)) return data;
  } catch (err) { if (err.code !== 'ENOENT') console.error('Cannot read store:', err); }
  return { teachers: [], quizzes: [] };
}
const store = loadStore();
function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, teacher) {
  const attempt = scryptSync(password, teacher.salt, 64);
  const expected = Buffer.from(teacher.hash, 'hex');
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}
function cleanQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw Error('Provide 1–100 questions.');
  return input.map((q, i) => {
    if (!q || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 1000 ||
        !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6 ||
        !q.choices.every(c => typeof c === 'string' && c.trim() && c.length <= 300) ||
        !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.choices.length ||
        !Number.isInteger(q.timeLimit) || q.timeLimit < 5 || q.timeLimit > 300) {
      throw Error(`Question ${i + 1} is invalid. Use 2–6 choices, valid correct index, and 5–300 seconds.`);
    }
    return { text: q.text.trim(), choices: q.choices.map(c => c.trim()), correct: q.correct, timeLimit: q.timeLimit };
  });
}
const sessions = new Map(); // roomCode -> active session
const teacherTokens = new Map(); // token -> teacherId; memory-only, invalidated by restart
const teacherSockets = new Map(); // socket id -> teacher id
const playerSockets = new Map(); // socket id -> {code, playerId}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    const code = Array.from(randomBytes(6), b => alphabet[b % alphabet.length]).join('');
    if (!sessions.has(code)) return code;
  }
  throw Error('Could not generate unique room code.');
}
function teacherOf(socket) { return teacherSockets.get(socket.id); }
function emitError(socket, error) { socket.emit('error-message', String(error.message || error)); }
function ownedSession(socket, code) {
  const room = sessions.get(String(code || '').toUpperCase());
  if (!room || room.teacherId !== teacherOf(socket)) throw Error('Room not found or access denied.');
  return room;
}
function publicLeaderboard(room, teacher = false) {
  return [...room.players.values()].sort((a,b) => b.score-a.score || a.name.localeCompare(b.name)).map(p => ({...(teacher ? {id:p.id} : {}),name:p.name,score:p.score,connected:p.connected}));
}
function view(room, teacher = false) {
  const q = room.questions[room.currentQuestion];
  return {
    code:room.code, title:room.title, started:room.started, finished:room.finished,
    currentQuestion:room.currentQuestion, totalQuestions:room.questions.length,
    question:q ? {text:q.text,choices:q.choices,timeLimit:q.timeLimit} : null,
    reveal:room.reveal, correctAnswer:room.reveal && !teacher && q ? q.correct : null,
    timeLeft:room.timeLeft, paused:room.paused, transitioning:room.transitioning,
    participantCount:room.players.size,
    connectedCount:[...room.players.values()].filter(p => p.connected).length,
    leaderboard:publicLeaderboard(room, teacher)
  };
}
function publish(room) {
  // Only authenticated teacher and actively joined students receive room data.
  for (const id of room.teacherSocketIds) io.to(id).emit('update',view(room,true));
  for (const p of room.players.values()) if (p.connected && p.socketId) {
    io.to(p.socketId).emit('update',view(room,false));
    io.to(p.socketId).emit('answer-status',{question:room.currentQuestion,answered:p.answeredQuestion===room.currentQuestion,selectedIndex:p.answeredQuestion===room.currentQuestion?p.selectedAnswer:null});
  }
}
function stopTimers(room) { clearInterval(room.interval); clearTimeout(room.transitionTimeout); room.interval=null; room.transitionTimeout=null; }
function finish(room) { stopTimers(room); room.finished=true; room.reveal=true; room.transitioning=true; publish(room); }
function next(room) {
  stopTimers(room);
  if (room.currentQuestion + 1 >= room.questions.length) return finish(room);
  room.currentQuestion++;
  room.started=true; room.finished=false; room.reveal=false; room.transitioning=false; room.paused=false;
  room.timeLeft=room.questions[room.currentQuestion].timeLimit;
  room.deadline=Date.now()+room.timeLeft*1000;
  publish(room);
  room.interval=setInterval(() => {
    if (room.paused || room.reveal || room.finished) return;
    room.timeLeft=Math.max(0,Math.ceil((room.deadline-Date.now())/1000));
    if (room.timeLeft===0) {
      room.reveal=true; room.transitioning=true;
      clearInterval(room.interval);room.interval=null;
      publish(room);
      room.transitionTimeout=setTimeout(()=>next(room),4000);
    } else publish(room);
  },250);
}
function makePdf(room,socket) {
  const doc = new PDFDocument({margin:50});
  const chunks=[];
  doc.on('data',c=>chunks.push(c));
  doc.on('end',()=>socket.emit('teacher:pdf-ready',Buffer.concat(chunks)));
  doc.fontSize(22).text(`Quiz Results — ${room.title}`,{align:'center'});
  doc.moveDown().fontSize(12).text(`Room: ${room.code} | ${new Date().toLocaleString()}`);
  doc.moveDown();
  publicLeaderboard(room).forEach((p,i)=>doc.text(`${i+1}. ${p.name} — ${p.score} points`));
  doc.end();
}
function detachStudent(socket) {
  const info=playerSockets.get(socket.id);
  if (!info) return;
  playerSockets.delete(socket.id);
  const room=sessions.get(info.code);
  if (!room) return;
  const player=room.players.get(info.playerId);
  if (player && player.socketId===socket.id) {player.connected=false;player.socketId=null;}
  socket.leave(`room:${info.code}`);
  publish(room);
}
function detachTeacher(socket) {
  const id=teacherSockets.get(socket.id);
  teacherSockets.delete(socket.id);
  if (id) for (const room of sessions.values()) if(room.teacherId===id) room.teacherSocketIds.delete(socket.id);
}
function auth(socket,token) {
  const teacherId=teacherTokens.get(String(token || ''));
  if (!teacherId) throw Error('Login expired. Please sign in again.');
  detachStudent(socket);detachTeacher(socket);
  teacherSockets.set(socket.id,teacherId);
  for (const room of sessions.values()) if (room.teacherId===teacherId) room.teacherSocketIds.add(socket.id);
  socket.emit('teacher:granted',{teacherId});
  sendDashboard(socket);
  for (const room of sessions.values()) if(room.teacherId===teacherId) socket.emit('update',view(room,true));
}
function sendDashboard(socket) {
  const id=teacherOf(socket);
  if (!id) return;
  socket.emit('teacher:dashboard',{
    quizzes:store.quizzes.filter(q=>q.teacherId===id).map(q=>({id:q.id,title:q.title,questions:q.questions})),
    rooms:[...sessions.values()].filter(r=>r.teacherId===id).map(r=>({code:r.code,title:r.title,started:r.started,finished:r.finished,participants:r.players.size}))
  });
}

io.on('connection',socket=>{
  socket.on('teacher:register',data=>{
    try {
      const username=String(data?.username||'').trim().toLowerCase();
      const password=String(data?.password||'');
      if(!/^[a-z0-9_.-]{3,40}$/.test(username)||password.length<8||password.length>128) throw Error('Username: 3–40 letters/numbers/._-; password: 8–128 characters.');
      if(store.teachers.some(t=>t.username===username)) throw Error('Username already exists.');
      const teacher={id:randomUUID(),username,...hashPassword(password)};
      store.teachers.push(teacher); persist();
      socket.emit('teacher:auth-message','Account created. Please log in.');
    } catch(e){emitError(socket,e);}
  });
  socket.on('teacher:login',data=>{
    try {
      const username=String(data?.username||'').trim().toLowerCase();
      const password=String(data?.password||'');
      const teacher=store.teachers.find(t=>t.username===username);
      if(!teacher||!verifyPassword(password,teacher)) throw Error('Incorrect username or password.');
      const token=randomBytes(32).toString('hex'); teacherTokens.set(token,teacher.id);
      socket.emit('teacher:token',token);auth(socket,token);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:resume',token=>{try{auth(socket,token);}catch(e){emitError(socket,e);}});
  socket.on('teacher:logout',token=>{teacherTokens.delete(String(token||''));detachTeacher(socket);socket.emit('teacher:logged-out');});
  socket.on('teacher:save-quiz',data=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const title=String(data?.title||'').trim().slice(0,100);
      if(!title)throw Error('Quiz title required.');
      const questions=cleanQuestions(data?.questions);
      let quiz=data?.id ? store.quizzes.find(q=>q.id===data.id && q.teacherId===teacherId) : null;
      if(data?.id && !quiz)throw Error('Saved quiz not found.');
      if(quiz){quiz.title=title;quiz.questions=questions;} else store.quizzes.push({id:randomUUID(),teacherId,title,questions});
      persist();sendDashboard(socket);socket.emit('teacher:auth-message','Quiz saved successfully.');
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:delete-quiz',id=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const index=store.quizzes.findIndex(q=>q.id===id && q.teacherId===teacherId);
      if(index<0)throw Error('Quiz not found.');store.quizzes.splice(index,1);persist();sendDashboard(socket);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:create-room',quizId=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const quiz=store.quizzes.find(q=>q.id===quizId && q.teacherId===teacherId);
      if(!quiz)throw Error('Save or select a quiz first.');
      const code=newCode();
      const room={code,teacherId,title:quiz.title,questions:structuredClone(quiz.questions),
        players:new Map(),removedNames:new Set(),teacherSocketIds:new Set(),currentQuestion:-1,started:false,finished:false,
        reveal:false,transitioning:false,paused:false,timeLeft:0,deadline:0,interval:null,transitionTimeout:null};
      for(const [id,tid] of teacherSockets) if(tid===teacherId)room.teacherSocketIds.add(id);
      sessions.set(code,room);sendDashboard(socket);socket.emit('teacher:room-created',{code});publish(room);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:close-room',code=>{
    try{
      const room=ownedSession(socket,code);stopTimers(room);
      for(const p of room.players.values()) if(p.socketId){io.to(p.socketId).emit('session-closed');playerSockets.delete(p.socketId);}
      sessions.delete(room.code);sendDashboard(socket);socket.emit('teacher:room-closed',room.code);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:remove-participant',data=>{
    try {
      const room=ownedSession(socket,data?.code);
      const playerId=String(data?.playerId||'');
      const player=room.players.get(playerId);
      if(!player)throw Error('Participant not found in this room.');
      // A removed student cannot reclaim the same name in this room.
      room.removedNames.add(player.id);
      room.players.delete(player.id);
      if(player.socketId){
        playerSockets.delete(player.socketId);
        io.to(player.socketId).emit('participant-removed',{code:room.code});
        const studentSocket=io.sockets.sockets.get(player.socketId);
        if(studentSocket)studentSocket.leave(`room:${room.code}`);
      }
      publish(room);
      // Refresh every signed-in teacher tab, not only the one that removed the student.
      for(const teacherSocketId of room.teacherSocketIds){
        const teacherSocket=io.sockets.sockets.get(teacherSocketId);
        if(teacherSocket)sendDashboard(teacherSocket);
      }
      socket.emit('teacher:auth-message',`${player.name} removed from room ${room.code}.`);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:command',data=>{
    try{
      const room=ownedSession(socket,data?.code);
      switch(data?.action){
        case 'start': if(room.started)throw Error('Quiz has already started.');next(room);break;
        case 'next': if(!room.started)throw Error('Start quiz first.');next(room);break;
        case 'reveal': if(!room.started||room.finished)throw Error('No active question.');room.reveal=true;room.transitioning=true;stopTimers(room);publish(room);break;
        case 'pause':
          if(!room.started||room.finished||room.reveal)throw Error('No active timer.');
          if(!room.paused){room.timeLeft=Math.max(0,Math.ceil((room.deadline-Date.now())/1000));room.paused=true;}
          else{room.paused=false;room.deadline=Date.now()+room.timeLeft*1000;}publish(room);break;
        case 'reset': stopTimers(room);room.currentQuestion=-1;room.started=false;room.finished=false;room.reveal=false;room.transitioning=false;room.paused=false;room.timeLeft=0;
          for(const p of room.players.values()){p.score=0;p.answeredQuestion=-1;p.selectedAnswer=null;}publish(room);break;
        case 'pdf':makePdf(room,socket);break;
        default:throw Error('Unknown command.');
      }
    }catch(e){emitError(socket,e);}
  });
  socket.on('join',data=>{
    try{
      // Every new socket must explicitly enter code; no automatic student resume.
      const code=String(data?.code||'').trim().toUpperCase();
      const name=String(data?.name||'').trim().slice(0,30);
      if(!name)throw Error('Name required.');
      const room=sessions.get(code);if(!room)throw Error('Invalid or expired room code.');
      if(teacherOf(socket))throw Error('Teacher account cannot join as a student on this connection.');
      detachStudent(socket);
      const key=name.toLowerCase();
      if(room.removedNames.has(key))throw Error('You have been removed from this room. Ask your teacher for assistance.');
      let player=room.players.get(key);
      if(player?.connected)throw Error('This name is already connected. Use a different name.');
      if(!player){player={id:key,name,score:0,answeredQuestion:-1,selectedAnswer:null,connected:false,socketId:null};room.players.set(key,player);}
      player.connected=true;player.socketId=socket.id;
      playerSockets.set(socket.id,{code,playerId:key});socket.join(`room:${code}`);
      socket.emit('joined',{code,name});publish(room);
    }catch(e){emitError(socket,e);}
  });
  socket.on('answer',index=>{
    const info=playerSockets.get(socket.id);if(!info)return;
    const room=sessions.get(info.code);if(!room||!room.started||room.finished||room.reveal||room.transitioning||room.paused||room.timeLeft<=0)return;
    const player=room.players.get(info.playerId);
    if(!player||!player.connected||player.socketId!==socket.id||player.answeredQuestion===room.currentQuestion)return;
    const question=room.questions[room.currentQuestion];
    if(!Number.isInteger(index)||index<0||index>=question.choices.length)return;
    player.answeredQuestion=room.currentQuestion;
    player.selectedAnswer=index;
    if(index===question.correct)player.score++;
    socket.emit('answer:accepted',{question:room.currentQuestion});publish(room);
  });
  socket.on('disconnect',()=>{detachStudent(socket);detachTeacher(socket);});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Quiz Flash listening on port ${PORT}`));
