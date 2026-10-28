'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1000000, pingInterval: 10000, pingTimeout: 10000 });
const PORT = process.env.PORT || 3000;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required (Render PostgreSQL connection string).'); process.exit(1); }
const db = new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL === 'true' ? {rejectUnauthorized:false} : undefined});
app.get('/teacher',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use(express.static(path.join(__dirname,'public')));
async function initDb(){
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('teacher','student')),
    username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(role,username)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS quizzes (
    id UUID PRIMARY KEY, teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, questions JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS answer_history (
    id BIGSERIAL PRIMARY KEY, student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL, quiz_title TEXT NOT NULL, question_index INTEGER NOT NULL,
    question_text TEXT NOT NULL, choices JSONB NOT NULL, selected_index INTEGER NOT NULL,
    correct_index INTEGER NOT NULL, awarded_points INTEGER NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(student_id,room_code,question_index)
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS answer_history_student_idx ON answer_history(student_id,answered_at DESC)');
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
const studentTokens = new Map(); // token -> studentId
const teacherSockets = new Map(); // socket id -> teacher id
const playerSockets = new Map(); // socket id -> {code, playerId}
const studentSockets = new Map(); // socket id -> student id
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
    if(room.reveal || room.finished) {const ps=io.sockets.sockets.get(p.socketId);if(ps)sendHistory(ps).catch(console.error);}
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
async function auth(socket,token) {
  const teacherId=teacherTokens.get(String(token || ''));
  if (!teacherId) throw Error('Login expired. Please sign in again.');
  detachStudent(socket);detachTeacher(socket);
  teacherSockets.set(socket.id,teacherId);
  for (const room of sessions.values()) if (room.teacherId===teacherId) room.teacherSocketIds.add(socket.id);
  socket.emit('teacher:granted',{teacherId});
  await sendDashboard(socket);
  for (const room of sessions.values()) if(room.teacherId===teacherId) socket.emit('update',view(room,true));
}
async function sendDashboard(socket) {
  const id=teacherOf(socket);
  if (!id) return;
  const {rows:quizzes}=await db.query('SELECT id,title,questions FROM quizzes WHERE teacher_id=$1 ORDER BY updated_at DESC',[id]);
  socket.emit('teacher:dashboard',{
    quizzes,
    rooms:[...sessions.values()].filter(r=>r.teacherId===id).map(r=>({code:r.code,title:r.title,started:r.started,finished:r.finished,participants:r.players.size}))
  });
}

async function sendHistory(socket) {
  const id=studentSockets.get(socket.id);if(!id)throw Error('Student login required.');
  const {rows}=await db.query('SELECT room_code,quiz_title,question_index,question_text,choices,selected_index,correct_index,awarded_points,answered_at FROM answer_history WHERE student_id=$1 ORDER BY answered_at DESC LIMIT 500',[id]);
  const safe=rows.map(r=>{
    const room=sessions.get(r.room_code);
    const revealed=!room || room.finished || (room.currentQuestion>r.question_index) || (room.currentQuestion===r.question_index && room.reveal);
    return {...r, correct_index: revealed?r.correct_index:null,awarded_points:revealed?r.awarded_points:null,review_available:revealed};
  });
  socket.emit('student:history',safe);
}
io.on('connection',socket=>{
  socket.on('teacher:register',async data=>{
    try {
      const registrationKey=process.env.TEACHER_REGISTRATION_KEY;
      if(!registrationKey || registrationKey.length<16) throw Error('Teacher registration is disabled. Ask the administrator to configure TEACHER_REGISTRATION_KEY.');
      const supplied=String(data?.registrationKey||'');
      if(Buffer.byteLength(supplied)!==Buffer.byteLength(registrationKey)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(registrationKey))) throw Error('Invalid teacher registration key.');
      const username=String(data?.username||'').trim().toLowerCase();
      const password=String(data?.password||'');
      if(!/^[a-z0-9_.-]{3,40}$/.test(username)||password.length<8||password.length>128) throw Error('Username: 3–40 letters/numbers/._-; password: 8–128 characters.');
      const hashed=hashPassword(password);
      await db.query('INSERT INTO users(id,role,username,salt,hash) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'teacher',username,hashed.salt,hashed.hash]);
      socket.emit('teacher:auth-message','Teacher account created. Please log in.');
    }catch(e){emitError(socket,e.code==='23505'?Error('Teacher username already exists.'):e);}
  });
  socket.on('teacher:login',async data=>{
    try {
      const username=String(data?.username||'').trim().toLowerCase();
      const password=String(data?.password||'');
      const {rows}=await db.query('SELECT * FROM users WHERE role=$1 AND username=$2',['teacher',username]);
      const user=rows[0];
      if(!user||!verifyPassword(password,user))throw Error('Incorrect username or password.');
      const token=randomBytes(32).toString('hex');teacherTokens.set(token,user.id);
      socket.emit('teacher:token',token);await auth(socket,token);
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:resume',async token=>{try{await auth(socket,token);}catch(e){emitError(socket,e);}});
  socket.on('teacher:logout',token=>{teacherTokens.delete(String(token||''));detachTeacher(socket);socket.emit('teacher:logged-out');});
  socket.on('teacher:save-quiz',async data=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const title=String(data?.title||'').trim().slice(0,100);
      if(!title)throw Error('Quiz title required.');
      const questions=cleanQuestions(data?.questions);
      if(data?.id){
        const result=await db.query('UPDATE quizzes SET title=$1,questions=$2,updated_at=NOW() WHERE id=$3 AND teacher_id=$4',[title,JSON.stringify(questions),data.id,teacherId]);
        if(!result.rowCount)throw Error('Saved quiz not found.');
      }else await db.query('INSERT INTO quizzes(id,teacher_id,title,questions) VALUES($1,$2,$3,$4)',[randomUUID(),teacherId,title,JSON.stringify(questions)]);
      await sendDashboard(socket);socket.emit('teacher:auth-message','Quiz saved successfully.');
    }catch(e){emitError(socket,e);}
  });
  socket.on('teacher:delete-quiz',async id=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const result=await db.query('DELETE FROM quizzes WHERE id=$1 AND teacher_id=$2',[id,teacherId]);
      if(!result.rowCount)throw Error('Quiz not found.');await sendDashboard(socket);
    }catch(e){emitError(socket,e);}
  });
  socket.on('student:register',async data=>{
    try{
      const username=String(data?.username||'').trim().toLowerCase();const password=String(data?.password||'');
      if(!/^[a-z0-9_.-]{3,40}$/.test(username)||password.length<8||password.length>128)throw Error('Student username: 3–40 letters/numbers/._-; password: 8–128 characters.');
      const pw=hashPassword(password);
      await db.query('INSERT INTO users(id,role,username,salt,hash) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'student',username,pw.salt,pw.hash]);
      socket.emit('student:message','Student account created. Please log in.');
    }catch(e){emitError(socket,e.code==='23505'?Error('Student username already exists.'):e);}
  });
  socket.on('student:login',async data=>{
    try{
      const username=String(data?.username||'').trim().toLowerCase();const password=String(data?.password||'');
      const {rows}=await db.query('SELECT * FROM users WHERE role=$1 AND username=$2',['student',username]);const user=rows[0];
      if(!user||!verifyPassword(password,user))throw Error('Incorrect student username or password.');
      detachStudent(socket);detachTeacher(socket);studentSockets.set(socket.id,user.id);
      const token=randomBytes(32).toString('hex');studentTokens.set(token,user.id);
      socket.emit('student:token',token);socket.emit('student:granted',{username:user.username});await sendHistory(socket);
    }catch(e){emitError(socket,e);}
  });
  socket.on('student:resume',async token=>{
    try{
      const id=studentTokens.get(String(token||''));if(!id)throw Error('Student session expired. Please log in again.');
      detachStudent(socket);studentSockets.set(socket.id,id);
      socket.emit('student:granted',{});await sendHistory(socket);
    }catch(e){emitError(socket,e);}
  });
  socket.on('student:history',async ()=>{try{await sendHistory(socket);}catch(e){emitError(socket,e);}});
  socket.on('student:logout',token=>{studentTokens.delete(String(token||''));detachStudent(socket);studentSockets.delete(socket.id);socket.emit('student:logged-out');});
  socket.on('teacher:create-room',async quizId=>{
    try{
      const teacherId=teacherOf(socket);if(!teacherId)throw Error('Sign in first.');
      const {rows}=await db.query('SELECT id,title,questions FROM quizzes WHERE id=$1 AND teacher_id=$2',[quizId,teacherId]);
      const quiz=rows[0];
      if(!quiz)throw Error('Save or select a quiz first.');
      const code=newCode();
      const room={code,teacherId,title:quiz.title,questions:structuredClone(quiz.questions),
        players:new Map(),removedNames:new Set(),teacherSocketIds:new Set(),currentQuestion:-1,started:false,finished:false,
        reveal:false,transitioning:false,paused:false,timeLeft:0,deadline:0,interval:null,transitionTimeout:null};
      for(const [id,tid] of teacherSockets) if(tid===teacherId)room.teacherSocketIds.add(id);
      sessions.set(code,room);await sendDashboard(socket);socket.emit('teacher:room-created',{code});publish(room);
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
      const studentId=studentSockets.get(socket.id);if(!studentId)throw Error('Log in to your student account first.');
      const name=String(data?.name||'').trim().slice(0,30);
      if(!name)throw Error('Name required.');
      const room=sessions.get(code);if(!room)throw Error('Invalid or expired room code.');
      if(teacherOf(socket))throw Error('Teacher account cannot join as a student on this connection.');
      detachStudent(socket);
      const key=studentId;
      if(room.removedNames.has(key))throw Error('You have been removed from this room. Ask your teacher for assistance.');
      let player=room.players.get(key);
      if(player?.connected)throw Error('This student account is already connected to the room.');
      if([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase() && p.id!==key))throw Error('Display name in use. Choose another.');
      if(!player){player={id:key,name,score:0,answeredQuestion:-1,selectedAnswer:null,connected:false,socketId:null};room.players.set(key,player);}
      player.connected=true;player.socketId=socket.id;
      playerSockets.set(socket.id,{code,playerId:key});socket.join(`room:${code}`);
      socket.emit('joined',{code,name});publish(room);
    }catch(e){emitError(socket,e);}
  });
  socket.on('answer',async index=>{
    const info=playerSockets.get(socket.id);if(!info)return;
    const room=sessions.get(info.code);if(!room||!room.started||room.finished||room.reveal||room.transitioning||room.paused||room.timeLeft<=0)return;
    const player=room.players.get(info.playerId);
    if(!player||!player.connected||player.socketId!==socket.id||player.answeredQuestion===room.currentQuestion)return;
    const question=room.questions[room.currentQuestion];
    if(!Number.isInteger(index)||index<0||index>=question.choices.length)return;
    player.answeredQuestion=room.currentQuestion;
    player.selectedAnswer=index;
    if(index===question.correct)player.score++;
    try {
      await db.query(`INSERT INTO answer_history(student_id,room_code,quiz_title,question_index,question_text,choices,selected_index,correct_index,awarded_points)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(student_id,room_code,question_index) DO NOTHING`,
        [player.id,room.code,room.title,room.currentQuestion,question.text,JSON.stringify(question.choices),index,question.correct,index===question.correct?1:0]);
      await sendHistory(socket);
    }catch(e){console.error('Answer history save failed:',e);socket.emit('error-message','Answer recorded live, but saving history failed.');}
    socket.emit('answer:accepted',{question:room.currentQuestion});publish(room);
  });
  socket.on('disconnect',()=>{detachStudent(socket);detachTeacher(socket);studentSockets.delete(socket.id);});
});
initDb().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`Quiz Flash listening on port ${PORT}`))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1);});
