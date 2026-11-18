const SUPABASE_URL = 'https://hrqlwxltwhlfrkkvlaun.supabase.co';
const SUPABASE_KEY = 'sb_publishable_DB3NxYTmCnaMoqsNpg9BbA_6Gw3PMV7';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);

let me=null, peer=null, people=[], convos={}, thread=[], online=new Set(), typingUntil=0, lastTyped=0, channel=null, signup=false;

/* ---------- helpers ---------- */
const hue = s => { let h=0; for(const c of s) h=(h*31+c.charCodeAt(0))%360; return h; };
const PAL=[['#0695ff','#a334fa'],['#a334fa','#ff6968'],['#ff6968','#ff7e29'],['#00b2ff','#006aff'],['#31a24c','#00c6a2'],['#ff5280','#a334fa']];
function avatar(p, cls=''){
  const a=document.createElement('div'); a.className='av '+cls;
  const pc=PAL[hue(p.username)%PAL.length]; a.style.background=`linear-gradient(135deg,${pc[0]},${pc[1]})`;
  if(p.avatar_url&&p.avatar_url.startsWith(SUPABASE_URL+'/')&&/^[^"'()\s]+$/.test(p.avatar_url)) a.style.background='center/cover url("'+p.avatar_url+'")';
  else a.textContent=p.username[0].toUpperCase();
  if(online.has(p.id)){ a.appendChild(document.createElement('i')); }
  return a;
}
const sameDay=(a,b)=>a.toDateString()===b.toDateString();
function dayLabel(d){
  const t=new Date(), y=new Date(Date.now()-864e5);
  if(sameDay(d,t)) return 'Today'; if(sameDay(d,y)) return 'Yesterday';
  return d.toLocaleDateString([], {weekday:'long', month:'short', day:'numeric'});
}
function stamp(iso){
  const d=new Date(iso), n=new Date();
  if(sameDay(d,n)) return d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  if(n-d<6048e5) return d.toLocaleDateString([], {weekday:'short'});
  return d.toLocaleDateString([], {month:'short',day:'numeric'});
}
function toast(t){ const e=document.createElement('div'); e.className='toast'; e.textContent=t; document.body.appendChild(e); setTimeout(()=>e.remove(),3200); }
const isEmoji = s => s && s.length<=8 && /^(\p{Extended_Pictographic}|\u200d|\ufe0f|\s)+$/u.test(s);

/* ---------- theme ---------- */
function setTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.setItem('avey-theme',t)}catch(e){} document.querySelector('meta[name=theme-color]').content = t==='dark'?'#242526':'#ffffff'; }
try{ setTheme(localStorage.getItem('avey-theme') || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')); }catch(e){}
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

/* ---------- auth ---------- */
function setMode(s){
  signup=s;
  $('auth-title').textContent = s?'Create account':'Sign in';
  $('auth-btn').textContent = s?'Create account':'Sign in';
  $('switch-text').textContent = s?'Already have an account?':'New here?';
  $('switch-btn').textContent = s?'Sign in':'Create an account';
  $('name-wrap').classList.toggle('hidden',!s);
  $('password').autocomplete = s?'new-password':'current-password';
  say('');
}
function say(t,ok){ const m=$('auth-msg'); m.textContent=t; m.className='msg'+(ok?' ok':''); }
$('switch-btn').onclick = () => setMode(!signup);
$('auth-form').onsubmit = async e => {
  e.preventDefault();
  const email=$('email').value.trim(), password=$('password').value, btn=$('auth-btn');
  btn.disabled=true; say('');
  try{
    if(signup){
      const username=$('username').value.trim().toLowerCase();
      if(!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Username must be 3–20 letters, numbers or underscores.');
      const {data,error}=await sb.auth.signUp({email,password,options:{data:{username}}});
      if(error) throw error;
      if(!data.session){ setMode(false); say('Check your email to confirm your account, then sign in.',true); }
    }else{
      const {error}=await sb.auth.signInWithPassword({email,password});
      if(error) throw error;
    }
  }catch(err){
    const m=err.message||'Something went wrong.';
    say(/database error|username/i.test(m)&&signup ? 'That username is taken. Try another.' : m);
  }finally{ btn.disabled=false; }
};
$('out').onclick = async () => { await dropPush(); sb.auth.signOut(); };
sb.auth.onAuthStateChange((_e,session)=>{
  if(session?.user){ if(!me||me.id!==session.user.id) setTimeout(()=>boot(session.user),0); }
  else teardown();
});

/* ---------- boot ---------- */
async function boot(user){
  const {data:prof}=await sb.from('profiles').select('id,username,avatar_url,bio').eq('id',user.id).single();
  me=prof||{id:user.id,username:(user.email||'me').split('@')[0]};
  $('me-name').textContent=', '+me.username;
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  const [{data:pp},{data:ms,error}]=await Promise.all([
    sb.from('profiles').select('id,username,avatar_url,bio').neq('id',me.id).order('username'),
    sb.from('messages').select('*').order('created_at',{ascending:false}).limit(600)
  ]);
  people=pp||[];
  if(error) toast('Run schema.sql in Supabase to enable messages.');
  convos={};
  for(const m of (ms||[])){
    const pid=m.sender_id===me.id?m.recipient_id:m.sender_id;
    const c=convos[pid]||(convos[pid]={last:m,unread:0});
    if(m.recipient_id===me.id&&!m.read_at) c.unread++;
  }
  renderList();

  openFromUrl(); loadExtras(); initPush();
  channel=sb.channel('avey',{config:{presence:{key:me.id},broadcast:{self:false}}})
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:'recipient_id=eq.'+me.id},p=>incoming(p.new))
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'messages',filter:'sender_id=eq.'+me.id},p=>{
      const t=thread.find(x=>x.id===p.new.id); if(t){t.read_at=p.new.read_at; renderLog();}
      const c=convos[p.new.recipient_id]; if(c&&c.last.id===p.new.id) c.last=p.new;
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'follows'},p=>onLive('follows',p))
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'profiles'},p=>onLive('profiles',p))
    .on('postgres_changes',{event:'*',schema:'public',table:'stories'},p=>onLive('stories',p))
    .on('postgres_changes',{event:'*',schema:'public',table:'notes'},p=>onLive('notes',p))
    .on('postgres_changes',{event:'*',schema:'public',table:'story_likes'},p=>onLive('story_likes',p))
    .on('postgres_changes',{event:'*',schema:'public',table:'message_likes'},p=>onLive('message_likes',p))
    .on('presence',{event:'sync'},()=>{ online=new Set(Object.keys(channel.presenceState())); renderList(); head(); })
    .on('broadcast',{event:'file'},({payload})=>onFile(payload))
    .on('broadcast',{event:'call'},({payload})=>onCall(payload))
    .on('broadcast',{event:'typing'},({payload})=>{
      if(peer&&payload.from===peer.id){ typingUntil=Date.now()+3000; head(); renderLog(); setTimeout(()=>{head();renderLog();},3100); }
    })
    .subscribe(s=>{ if(s==='SUBSCRIBED'){ channel.track({u:me.username}); channel.send({type:'broadcast',event:'call',payload:{to:'*',from:me.id,kind:'sync'}}); } });
}
function teardown(){
  if(channel){ sb.removeChannel(channel); channel=null; }
  me=peer=null; people=[]; convos={}; thread=[]; online=new Set(); stories=[]; sLikes=[]; notes={}; mLikes=[]; follows=[]; closeViewer(); closeProfile(); if(call) endCall(); xfers.forEach(closeX); xfers.clear(); for(const k in tx) delete tx[k];
  $('app').classList.add('hidden'); $('app').classList.remove('chatting');
  $('chat').style.display='none'; $('placeholder').classList.remove('hidden');
  $('auth').classList.remove('hidden');
}

/* ---------- chat list ---------- */
function preview(m){
  const mine=m.sender_id===me.id;
  return (mine?'You: ':'')+(m.audio_url&&!m.body?'Sent a voice message':m.image_url&&!m.body?'Sent a photo':m.body);
}
function rowFor(p,c){
  const b=document.createElement('button'); b.className='row'+(c&&c.unread?' unread':'');
  b.setAttribute('aria-current',peer&&peer.id===p.id?'true':'false');
  const mid=document.createElement('div'); mid.className='mid';
  const nm=document.createElement('div'); nm.className='nm'; nm.textContent=p.username; mid.appendChild(nm);
  if(c){ const pv=document.createElement('div'); pv.className='pv';
    const a=document.createElement('span'); a.textContent=preview(c.last);
    pv.appendChild(a); mid.appendChild(pv); }
  b.append(avatar(p),mid);
  if(c){ const end=document.createElement('div'); end.className='end';
    const t=document.createElement('span'); t.textContent=stamp(c.last.created_at); end.appendChild(t);
    if(c.unread){ const g=document.createElement('span'); g.className='badge'; g.textContent=c.unread>99?'99+':c.unread; end.appendChild(g); }
    b.appendChild(end); }
  b.onclick=()=>openChat(p);
  return b;
}
function renderList(){
  const q=$('q').value.trim().toLowerCase(), box=$('list'); box.innerHTML='';
  const byId=Object.fromEntries(people.map(p=>[p.id,p]));
  const talking=Object.keys(convos).filter(id=>byId[id]).sort((a,b)=>new Date(convos[b].last.created_at)-new Date(convos[a].last.created_at)).map(id=>byId[id]);
  const others=people.filter(p=>!convos[p.id]).sort((a,b)=>following(b.id)-following(a.id));
  const f=l=>l.filter(p=>p.username.includes(q));
  const A=f(talking), B=f(others);
  if(A.length){ if(q){const h=document.createElement('div');h.className='sec';h.textContent='Chats';box.appendChild(h);} A.forEach(p=>box.appendChild(rowFor(p,convos[p.id]))); }
  if(B.length){ const h=document.createElement('div'); h.className='sec'; h.textContent=A.length||q?'People':'People on aveysocial'; box.appendChild(h); B.forEach(p=>box.appendChild(rowFor(p,null))); }
  if(!A.length&&!B.length){
    const e=document.createElement('div');
    if(q){ e.className='empty'; e.textContent='No one found with that name.'; }
    else{
      e.className='noone';
      e.innerHTML='<div class="ic"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M17 4.5a3.5 3.5 0 0 1 0 7M21.5 20c0-2.7-1.7-4.8-4-5.6"/></svg></div><b>Find your people</b>Invite friends to join aveysocial, then chat, share stories and follow each other.';
      const bt=document.createElement('button'); bt.className='btn'; bt.textContent='Copy invite link'; bt.onclick=invite; e.appendChild(bt);
    }
    box.appendChild(e);
  }
}
$('q').oninput=renderList;

/* ---------- conversation ---------- */
function head(){
  if(!peer) return;
  $('h-name').textContent=peer.username;
  $('h-status').textContent = Date.now()<typingUntil ? 'typing…' : online.has(peer.id)?'Active now':'Offline';
  const h=$('h-av'); h.innerHTML=''; h.appendChild(avatar(peer,'sm'));
}
async function openChat(p){
  abortRec(); peer=p; thread=[]; typingUntil=0;
  $('placeholder').classList.add('hidden'); $('chat').style.display='flex';
  $('app').classList.add('chatting'); head(); renderLog(); renderList();
  const {data,error}=await sb.from('messages').select('*')
    .or(`and(sender_id.eq.${me.id},recipient_id.eq.${p.id}),and(sender_id.eq.${p.id},recipient_id.eq.${me.id})`)
    .order('created_at').limit(300);
  if(peer!==p) return;
  if(error){ toast('Could not load messages.'); return; }
  thread=data; renderLog(true); markRead(); $('text').focus();
}
async function markRead(){
  if(!peer) return; const c=convos[peer.id];
  if(c&&c.unread){ c.unread=0; renderList(); }
  await sb.rpc('mark_read',{peer_id:peer.id});
}
function renderLog(jump){
  const items=thread.concat(txItems()).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const log=$('log'), near=jump||log.scrollHeight-log.scrollTop-log.clientHeight<140;
  log.innerHTML='';
  if(!items.length&&peer){
    const e=document.createElement('div'); e.className='empty'; e.append(avatar(peer),document.createElement('br'));
    e.lastChild.replaceWith(document.createElement('br'));
    const t=document.createElement('div'); t.textContent='This is the start of your chat with '+peer.username+'. Say hello!'; e.appendChild(t); log.appendChild(e);
  }
  let lastOwn=-1; items.forEach((m,i)=>{ if(m.sender_id===me.id&&!m._tx) lastOwn=i; });
  items.forEach((m,i)=>{
    const d=new Date(m.created_at), prev=items[i-1], next=items[i+1];
    if(!prev||!sameDay(new Date(prev.created_at),d)){ const s=document.createElement('div'); s.className='day'; s.textContent=dayLabel(d); log.appendChild(s); }
    const mine=m.sender_id===me.id;
    const first=!prev||prev.sender_id!==m.sender_id||!sameDay(new Date(prev.created_at),d)||(d-new Date(prev.created_at))>9e5;
    const last=!next||next.sender_id!==m.sender_id||(new Date(next.created_at)-d)>9e5;
    const row=document.createElement('div'); row.className='m '+(mine?'mine':'theirs')+(first?' first':'')+(last?' last':'');
    if(!mine){ if(last) row.appendChild(avatar(peer)); else { const sp=document.createElement('span'); sp.className='sp'; row.appendChild(sp);} }
    if(!mine&&last) row.firstChild.className='av';
    const wrap=document.createElement('div'); wrap.style.display='contents';
    if(m.image_url){ const b=document.createElement('div'); b.className='b img'; const im=document.createElement('img'); im.src=m.image_url; im.alt='Photo'; im.loading='lazy'; im.onclick=()=>{ $('lightbox').querySelector('img').src=m.image_url; $('lightbox').classList.remove('hidden'); }; b.appendChild(im); row.appendChild(b); }
    if(m._tx) row.appendChild(fileBubble(m));
    if(m.audio_url) row.appendChild(voiceBubble(m));
    if(m.body){ const b=document.createElement('div'); b.className='b'+(isEmoji(m.body)?' emoji':''); b.textContent=m.body; b.title=d.toLocaleString(); row.appendChild(b); }
    log.appendChild(row); decorate(row,m,mine);
    if(i===lastOwn){ const s=document.createElement('div'); s.className='status'; s.textContent=m.read_at?'Seen '+stamp(m.read_at):(m.pending?'Sending…':'Sent'); log.appendChild(s); }
  });
  if(Date.now()<typingUntil){ const t=document.createElement('div'); t.className='m theirs first last'; t.appendChild(avatar(peer)); const d=document.createElement('div'); d.className='b dots'; d.innerHTML='<i></i><i></i><i></i>'; t.appendChild(d); log.appendChild(t); }
  if(near) log.scrollTop=log.scrollHeight;
}
function touch(pid,m,unreadDelta){
  const c=convos[pid]||(convos[pid]={last:m,unread:0}); c.last=m; c.unread+=unreadDelta; renderList();
}
function incoming(m){
  if(peer&&m.sender_id===peer.id){ thread.push(m); typingUntil=0; head(); renderLog(); touch(m.sender_id,m,0); markRead(); }
  else{
    touch(m.sender_id,m,1);
    if(!people.some(p=>p.id===m.sender_id)) sb.from('profiles').select('id,username,avatar_url,bio').order('username').neq('id',me.id).then(({data})=>{people=data||people;renderList();});
  }
}

/* ---------- sending ---------- */
async function sendMessage(body,image_url,audio_url,audio_secs){
  if(!peer) return;
  const tmp={id:'t'+Date.now(),sender_id:me.id,recipient_id:peer.id,body,image_url:image_url||null,audio_url:audio_url||null,audio_secs:audio_secs||null,created_at:new Date().toISOString(),pending:true};
  thread.push(tmp); renderLog(true);
  const {data,error}=await sb.from('messages').insert({sender_id:me.id,recipient_id:peer.id,body,image_url:image_url||null,audio_url:audio_url||null,audio_secs:audio_secs||null}).select().single();
  const i=thread.indexOf(tmp);
  if(error){ if(i>-1) thread.splice(i,1); renderLog(); toast('Message not sent: '+error.message); return false; }
  if(i>-1) thread[i]=data; renderLog(); touch(peer.id,data,0); pingPeer(peer.id); return true;
}
function syncSendIcon(){ $('sendicon').textContent=$('text').value.trim()?'➤':'👍'; $('sendicon').style.cssText='font-size:'+($('text').value.trim()?'18px':'22px'); }
$('send').onsubmit=async e=>{
  e.preventDefault();
  const v=$('text').value.trim();
  $('text').value=''; autosize(); syncSendIcon(); $('emojis').classList.add('hidden');
  await sendMessage(v||'👍');
};
$('text').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); $('send').requestSubmit(); } });
$('text').addEventListener('input',()=>{
  autosize(); syncSendIcon();
  if(channel&&peer&&Date.now()-lastTyped>2000){ lastTyped=Date.now(); channel.send({type:'broadcast',event:'typing',payload:{from:me.id,to:peer.id}}); }
});
function autosize(){ const t=$('text'); t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,140)+'px'; }

$('attach').onclick=()=>$('file').click();
$('file').onchange=e=>{ const fs=[...e.target.files]; e.target.value=''; fs.forEach(sendFile); };

const EMO='😀 😂 😍 😘 😎 🥳 😭 😡 👍 👎 🙏 👏 🔥 ❤️ 💔 🎉 😮 🤔 😴 🤝 💯 ✨ 😅 🙌'.split(' ');
EMO.forEach(x=>{ const b=document.createElement('button'); b.type='button'; b.textContent=x; b.onclick=()=>{ const t=$('text'); t.value+=x; t.focus(); autosize(); syncSendIcon(); }; $('emojis').appendChild(b); });
$('emoji').onclick=()=>$('emojis').classList.toggle('hidden');
$('back').onclick=()=>{ peer=null; $('app').classList.remove('chatting'); $('chat').style.display='none'; $('placeholder').classList.remove('hidden'); renderList(); };
$('lightbox').onclick=()=>$('lightbox').classList.add('hidden');
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ $('lightbox').classList.add('hidden'); $('emojis').classList.add('hidden'); } });
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) markRead(); });

sb.auth.getSession().then(({data})=>{ if(!data.session) $('auth').classList.remove('hidden'); });


/* ================= likes, stories, notes ================= */
let stories=[], sLikes=[], notes={}, mLikes=[], vq=[], vi=0, vtimer=null, sFile=null, sBg='#0099ff,#0052d4';
let seen=new Set(); try{ seen=new Set(JSON.parse(localStorage.getItem('avey-seen')||'[]')); }catch(e){}
const saveSeen=()=>{ try{ localStorage.setItem('avey-seen',JSON.stringify([...seen].slice(-300))); }catch(e){} };
const userById=id=>id===me.id?me:people.find(p=>p.id===id);
const fresh=n=>n&&Date.now()-new Date(n.updated_at)<864e5;
const bgOf=s=>/^#[0-9a-f]{6},#[0-9a-f]{6}$/i.test(s||'')?`linear-gradient(160deg,${s.split(',')[0]},${s.split(',')[1]})`:'linear-gradient(160deg,#0099ff,#0052d4)';

async function loadExtras(){
  const since=new Date(Date.now()-864e5).toISOString();
  const [s,n,ml,fl]=await Promise.all([
    sb.from('stories').select('*').gt('created_at',since).order('created_at'),
    sb.from('notes').select('*'),
    sb.from('message_likes').select('*'),
    sb.from('follows').select('*')]);
  stories=s.data||[]; notes=Object.fromEntries((n.data||[]).map(x=>[x.user_id,x])); mLikes=ml.data||[]; follows=fl.data||[];
  if(s.error) toast('Run the new schema.sql to enable stories and notes.');
  sLikes=stories.length?((await sb.from('story_likes').select('*').in('story_id',stories.map(x=>x.id))).data||[]):[];
  renderTray(); if(peer) renderLog();
}
function onLive(table,p){
  const n=p.new,o=p.old;
  if(table==='stories'){
    if(p.eventType==='INSERT'&&!stories.some(x=>x.id===n.id)) stories.push(n);
    if(p.eventType==='DELETE') stories=stories.filter(x=>x.id!==o.id);
    renderTray();
  }else if(table==='follows'){
    if(p.eventType==='INSERT'){ if(!follows.some(x=>x.follower_id===n.follower_id&&x.following_id===n.following_id)) follows.push(n); }
    else{ const i=follows.findIndex(x=>x.follower_id===o.follower_id&&x.following_id===o.following_id); if(i>-1) follows.splice(i,1); }
    renderTray(); renderList(); paintProfile();
  }else if(table==='profiles'){
    if(n.id===me.id) me={...me,...n};
    const i=people.findIndex(x=>x.id===n.id);
    if(i>-1){ people[i]={...people[i],...n}; if(peer&&peer.id===n.id) peer=people[i]; }
    renderList(); renderTray(); if(peer){ head(); renderLog(); } paintProfile();
  }else if(table==='notes'){
    if(p.eventType==='DELETE') delete notes[o.user_id]; else notes[n.user_id]=n;
    renderTray();
  }else{
    const k=table==='story_likes'?'story_id':'message_id', arr=table==='story_likes'?sLikes:mLikes;
    if(p.eventType==='INSERT'){ if(!arr.some(x=>x[k]===n[k]&&x.user_id===n.user_id)) arr.push(n); }
    else{ const i=arr.findIndex(x=>x[k]===o[k]&&x.user_id===o.user_id); if(i>-1) arr.splice(i,1); }
    if(table==='message_likes') renderLog(); else if(vq.length) paintLike();
  }
}

/* message likes */
function decorate(row,m,mine){
  if(m._tx||String(m.id).startsWith('t')) return;
  const likes=mLikes.filter(l=>l.message_id===m.id), liked=likes.some(l=>l.user_id===me.id);
  const bubbles=row.querySelectorAll('.b'); bubbles.forEach(b=>b.ondblclick=()=>toggleMsgLike(m));
  if(likes.length&&bubbles.length){
    const b=bubbles[bubbles.length-1]; b.classList.add('liked');
    const h=document.createElement('span'); h.className='heart'; h.textContent='❤️'+(likes.length>1?' '+likes.length:''); b.appendChild(h);
  }
  const btn=document.createElement('button'); btn.type='button'; btn.className='lk'+(liked?' on':'');
  btn.textContent=liked?'❤️':'🤍'; btn.title=liked?'Remove like':'Like'; btn.setAttribute('aria-label',btn.title); btn.onclick=()=>toggleMsgLike(m);
  mine?row.prepend(btn):row.appendChild(btn);
}
async function toggleMsgLike(m){
  const i=mLikes.findIndex(l=>l.message_id===m.id&&l.user_id===me.id);
  if(i>-1){ mLikes.splice(i,1); renderLog(); await sb.from('message_likes').delete().match({message_id:m.id,user_id:me.id}); return; }
  const row={message_id:m.id,user_id:me.id}; mLikes.push(row); renderLog();
  const {error}=await sb.from('message_likes').insert(row);
  if(error){ mLikes.splice(mLikes.indexOf(row),1); renderLog(); toast('Could not like: '+error.message); }
}

/* tray */
function renderTray(){
  const t=$('tray'); if(!t||!me) return; t.innerHTML=''; paintWelcome();
  const ids=[me.id,...people.filter(p=>stories.some(s=>s.user_id===p.id)||fresh(notes[p.id])).sort((a,b)=>following(b.id)-following(a.id)).map(p=>p.id)];
  ids.forEach(id=>{
    const u=userById(id), us=stories.filter(s=>s.user_id===id), note=notes[id], mine=id===me.id;
    const b=document.createElement('button'); b.type='button'; b.className='tr';
    if(fresh(note)){ const n=document.createElement('span'); n.className='note'; n.textContent=note.body; b.appendChild(n); }
    const ring=document.createElement('div'); ring.className='ring'+(us.length?(us.some(s=>!seen.has(s.id))?' new':' old'):''); ring.appendChild(avatar(u));
    if(mine){ const pl=document.createElement('span'); pl.className='plus'; pl.textContent='+'; pl.title='Add a story or note'; pl.onclick=e=>{e.stopPropagation(); openCompose(fresh(note)&&!us.length?'note':'story');}; ring.appendChild(pl); }
    const lb=document.createElement('small'); lb.textContent=mine?(us.length?'Your story':'Add story'):u.username;
    b.append(ring,lb);
    b.onclick=()=>{ if(us.length) openViewer(id); else if(mine) openCompose('story'); else openChat(u); };
    t.appendChild(b);
  });
}

/* viewer */
function openViewer(uid){
  vq=stories.filter(s=>s.user_id===uid); if(!vq.length) return;
  vi=Math.max(0,vq.findIndex(s=>!seen.has(s.id))); $('viewer').classList.remove('hidden'); showStory();
}
function closeViewer(){ clearTimeout(vtimer); vq=[]; const v=$('viewer'); if(v) v.classList.add('hidden'); if(me) renderTray(); }
function showStory(){
  clearTimeout(vtimer); const s=vq[vi]; if(!s) return closeViewer();
  seen.add(s.id); saveSeen(); const u=userById(s.user_id)||{username:'?',id:''};
  $('v-name').textContent=s.user_id===me.id?'You':u.username; $('v-time').textContent=stamp(s.created_at);
  const av=$('v-av'); av.innerHTML=''; av.appendChild(avatar(u,'sm')); av.firstChild.querySelector('i')?.remove();
  const body=$('v-body'); body.innerHTML=''; body.style.background=bgOf(s.bg);
  if(s.image_url){ const im=document.createElement('img'); im.src=s.image_url; im.alt='Story photo'; body.appendChild(im); }
  if(s.text){ const p=document.createElement('p'); p.textContent=s.text; if(s.image_url){ p.style.cssText='align-self:end;margin-bottom:70px;background:rgba(0,0,0,.5);padding:8px 14px;border-radius:12px;font-size:18px'; } body.appendChild(p); }
  const bars=$('bars'); bars.innerHTML=''; vq.forEach((_,k)=>{ const i=document.createElement('i'); i.className=k<vi?'full':k===vi?'run':''; bars.appendChild(i); });
  $('v-del').classList.toggle('hidden',s.user_id!==me.id); paintLike();
  vtimer=setTimeout(nextStory,5000);
}
function nextStory(){ vi++; vi>=vq.length?closeViewer():showStory(); }
function paintLike(){
  const s=vq[vi]; if(!s) return;
  const likes=sLikes.filter(l=>l.story_id===s.id), liked=likes.some(l=>l.user_id===me.id), mine=s.user_id===me.id;
  const b=$('v-like'); b.textContent=(liked?'❤️':'🤍')+' '+(mine?(likes.length+(likes.length===1?' like':' likes')):(liked?'Liked':'Like'));
  b.title=mine?likes.map(l=>userById(l.user_id)?.username).filter(Boolean).join(', '):'';
}
$('v-like').onclick=async()=>{
  const s=vq[vi]; if(!s) return;
  const i=sLikes.findIndex(l=>l.story_id===s.id&&l.user_id===me.id);
  if(i>-1){ sLikes.splice(i,1); paintLike(); await sb.from('story_likes').delete().match({story_id:s.id,user_id:me.id}); return; }
  const row={story_id:s.id,user_id:me.id}; sLikes.push(row); paintLike();
  const {error}=await sb.from('story_likes').insert(row);
  if(error){ sLikes.splice(sLikes.indexOf(row),1); paintLike(); toast('Could not like: '+error.message); }
};
$('v-del').onclick=async()=>{
  const s=vq[vi]; if(!s||!confirm('Delete this story?')) return;
  const {error}=await sb.from('stories').delete().eq('id',s.id); if(error) return toast(error.message);
  stories=stories.filter(x=>x.id!==s.id); vq.splice(vi,1); vq.length?(vi=Math.min(vi,vq.length-1),showStory()):closeViewer();
};
$('v-next').onclick=nextStory;
$('v-prev').onclick=()=>{ vi=Math.max(0,vi-1); showStory(); };
$('v-close').onclick=closeViewer;

/* composer: story + note */
const SW=['#0099ff,#0052d4','#ff5f6d,#ffc371','#7f00ff,#e100ff','#11998e,#38ef7d','#232526,#414345','#f7971e,#ffd200'];
SW.forEach(c=>{ const b=document.createElement('button'); b.type='button'; b.style.background=bgOf(c); b.setAttribute('aria-label','Background'); b.onclick=()=>{ sBg=c; paintPrev(); }; $('sw').appendChild(b); });
function paintPrev(){
  const p=$('prev'); p.style.background=sFile?`center/cover url(${URL.createObjectURL(sFile)})`:bgOf(sBg);
  [...$('sw').children].forEach((b,i)=>b.classList.toggle('on',!sFile&&SW[i]===sBg));
}
function tab(t){
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  $('p-story').classList.toggle('hidden',t!=='story'); $('p-note').classList.toggle('hidden',t!=='note');
}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>tab(b.dataset.t));
function openCompose(t){
  sFile=null; $('s-text').value=''; $('n-text').value=fresh(notes[me.id])?notes[me.id].body:'';
  $('n-del').classList.toggle('hidden',!fresh(notes[me.id])); tab(t); paintPrev(); $('compose').classList.remove('hidden');
}
const closeCompose=()=>$('compose').classList.add('hidden');
$('c-close').onclick=closeCompose; $('compose').onclick=e=>{ if(e.target===$('compose')) closeCompose(); };
$('s-img').onclick=()=>$('s-file').click();
$('s-file').onchange=e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  if(!f.type.startsWith('image/')) return toast('Choose an image file.');
  if(f.size>5*1024*1024) return toast('Images must be under 5 MB.');
  sFile=f; paintPrev();
};
$('s-post').onclick=async()=>{
  const text=$('s-text').value.trim(), btn=$('s-post');
  if(!text&&!sFile) return toast('Add some text or a photo first.');
  btn.disabled=true; let image_url=null;
  try{
    if(sFile){
      const path=`${me.id}/story-${Date.now()}-${sFile.name.replace(/[^a-z0-9._-]/gi,'_')}`;
      const up=await sb.storage.from('chat-images').upload(path,sFile,{contentType:sFile.type}); if(up.error) throw up.error;
      image_url=sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl;
    }
    const {data,error}=await sb.from('stories').insert({user_id:me.id,text,bg:sBg,image_url}).select().single(); if(error) throw error;
    if(!stories.some(x=>x.id===data.id)) stories.push(data); seen.add(data.id); closeCompose(); renderTray(); toast('Story shared for 24 hours.');
  }catch(err){ toast('Could not share: '+err.message); }
  finally{ btn.disabled=false; }
};
$('n-save').onclick=async()=>{
  const body=$('n-text').value.trim(); if(!body) return toast('Write a short note first.');
  const row={user_id:me.id,body,updated_at:new Date().toISOString()};
  const {error}=await sb.from('notes').upsert(row,{onConflict:'user_id'}); if(error) return toast(error.message);
  notes[me.id]=row; closeCompose(); renderTray();
};
$('n-del').onclick=async()=>{ await sb.from('notes').delete().eq('user_id',me.id); delete notes[me.id]; closeCompose(); renderTray(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeViewer(); closeCompose(); } });


/* ================= profiles & follows ================= */
let follows=[], pfUser=null;
const following=id=>follows.some(f=>f.follower_id===me.id&&f.following_id===id)?1:0;
const followedBy=id=>follows.some(f=>f.follower_id===id&&f.following_id===me.id);
function openProfile(u){ pfUser=u; $('profile').classList.remove('hidden'); paintProfile(true); }
function closeProfile(){ pfUser=null; const p=$('profile'); if(p) p.classList.add('hidden'); }
function paintProfile(fresh){
  if(!pfUser||!me) return;
  const u=pfUser.id===me.id?me:(people.find(p=>p.id===pfUser.id)||pfUser), own=u.id===me.id; pfUser=u;
  const a=$('pf-av'); a.innerHTML=''; a.appendChild(avatar(u));
  $('pf-name').textContent='@'+u.username;
  $('pf-fers').textContent=follows.filter(f=>f.following_id===u.id).length;
  $('pf-fing').textContent=follows.filter(f=>f.follower_id===u.id).length;
  $('pf-rel').textContent=own?'This is how others see you':(followedBy(u.id)?'Follows you':'');
  $('pf-change').classList.toggle('hidden',!own);
  $('pf-bio-in').classList.toggle('hidden',!own); if(own&&fresh) $('pf-bio-in').value=u.bio||'';
  $('pf-bio').classList.toggle('hidden',own); $('pf-bio').textContent=u.bio||'No bio yet.';
  $('pf-msg').classList.toggle('hidden',own);
  const m=$('pf-main'), f=following(u.id);
  m.textContent=own?'Save profile':(f?'Following':'Follow'); m.classList.toggle('alt',!own&&!!f);
}
$('pf-main').onclick=async()=>{
  const u=pfUser; if(!u) return;
  if(u.id===me.id){
    const bio=$('pf-bio-in').value.trim().slice(0,100);
    const {error}=await sb.from('profiles').update({bio}).eq('id',me.id);
    if(error) return toast(error.message); me.bio=bio; toast('Profile saved.'); return;
  }
  const i=follows.findIndex(f=>f.follower_id===me.id&&f.following_id===u.id);
  if(i>-1){
    const [r]=follows.splice(i,1); paintProfile(); renderTray(); renderList();
    const {error}=await sb.from('follows').delete().match({follower_id:me.id,following_id:u.id});
    if(error){ follows.push(r); paintProfile(); renderTray(); renderList(); toast(error.message); }
  }else{
    const row={follower_id:me.id,following_id:u.id}; follows.push(row); paintProfile(); renderTray(); renderList();
    const {error}=await sb.from('follows').insert(row);
    if(error){ follows.splice(follows.indexOf(row),1); paintProfile(); renderTray(); renderList(); toast(error.message); }
  }
};
$('pf-msg').onclick=()=>{ const u=pfUser; closeProfile(); if(u) openChat(u); };
$('pf-change').onclick=()=>$('pf-file').click();
$('pf-file').onchange=async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  if(!f.type.startsWith('image/')) return toast('Choose an image file.');
  if(f.size>3*1024*1024) return toast('Photos must be under 3 MB.');
  toast('Uploading photo…');
  const ext=(f.name.split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').slice(0,5)||'jpg';
  const path=`${me.id}/avatar-${Date.now()}.${ext}`;
  const up=await sb.storage.from('chat-images').upload(path,f,{contentType:f.type}); if(up.error) return toast('Upload failed: '+up.error.message);
  const url=sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl;
  const {error}=await sb.from('profiles').update({avatar_url:url}).eq('id',me.id); if(error) return toast(error.message);
  me.avatar_url=url; paintProfile(); renderTray(); if(peer) head();
};
$('me-btn').onclick=()=>openProfile(me);
$('h-av').onclick=$('h-name').onclick=()=>{ if(peer) openProfile(peer); };
$('pf-close').onclick=closeProfile;
$('profile').onclick=e=>{ if(e.target===$('profile')) closeProfile(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeProfile(); });


/* ================= welcome panel ================= */
function paintWelcome(){
  if(!me) return;
  const done={photo:!!me.avatar_url,story:stories.some(s=>s.user_id===me.id),note:!!fresh(notes[me.id])};
  for(const k in done) $('wc-'+k).classList.toggle('done',done[k]);
}
async function invite(){
  const url=(SITE_URL||location.href).split('#')[0].split('?')[0];
  try{ if(navigator.share&&/Mobi|Android/i.test(navigator.userAgent)){ await navigator.share({title:'aveysocial',text:'Join me on aveysocial',url}); return; } }
  catch(e){ if(e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(url); toast('Invite link copied. Send it to your friends.'); }
  catch(e){ prompt('Copy your invite link:',url); }
}
$('wc-photo').onclick=()=>openProfile(me);
$('wc-story').onclick=()=>openCompose('story');
$('wc-note').onclick=()=>openCompose('note');
$('wc-invite').onclick=invite;


/* ================= voice messages ================= */
const fmtDur=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
const audios=new Map(); let playing=null;
function voiceBubble(m){
  const b=document.createElement('div'); b.className='b voice';
  let a=audios.get(m.id); if(!a){ a=new Audio(); a.preload='none'; a.src=m.audio_url; audios.set(m.id,a); }
  const btn=document.createElement('button'); btn.type='button'; btn.className='vp'; btn.setAttribute('aria-label','Play voice message');
  const wave=document.createElement('div'); wave.className='wave'; const bars=[];
  let seed=Number(String(m.id).replace(/\D/g,''))||7;
  for(let i=0;i<26;i++){ seed=(seed*9301+49297)%233280; const s=document.createElement('i'); s.style.height=(6+Math.round(seed/233280*18))+'px'; wave.appendChild(s); bars.push(s); }
  const t=document.createElement('span'); t.className='vt';
  const paint=()=>{
    const f=a.duration?a.currentTime/a.duration:0; bars.forEach((s,i)=>s.classList.toggle('on',i/bars.length<f));
    btn.textContent=a.paused?'▶':'❚❚'; t.textContent=fmtDur(a.currentTime>0?Math.floor(a.currentTime):(m.audio_secs||0));
  };
  a.ontimeupdate=paint; a.onplay=paint; a.onpause=paint; a.onended=()=>{ a.currentTime=0; if(playing===a) playing=null; paint(); };
  btn.onclick=()=>{ if(a.paused){ if(playing&&playing!==a) playing.pause(); playing=a; a.play().catch(()=>toast('Could not play this message.')); } else a.pause(); };
  wave.onclick=e=>{ if(a.duration){ const r=wave.getBoundingClientRect(); a.currentTime=a.duration*(e.clientX-r.left)/r.width; paint(); } };
  paint(); b.append(btn,wave,t); return b;
}
let rec=null, recChunks=[], recStart=0, recTimer=null, recStream=null, recCancel=false;
function tickRec(){ const s=Math.round((Date.now()-recStart)/1000); $('rec-t').textContent=fmtDur(s); if(s>=300&&rec&&rec.state==='recording') rec.stop(); }
function abortRec(){ if(rec&&rec.state==='recording'){ recCancel=true; rec.stop(); } }
async function startRec(){
  if(!peer||rec&&rec.state==='recording') return;
  if(!navigator.mediaDevices||!window.MediaRecorder) return toast('Voice recording is not supported in this browser.');
  try{ recStream=await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ return toast('Allow microphone access to record.'); }
  const mt=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t))||'';
  const r=rec=new MediaRecorder(recStream,mt?{mimeType:mt}:{}); recChunks=[]; recCancel=false;
  r.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
  r.onstop=async()=>{
    clearInterval(recTimer); recStream.getTracks().forEach(t=>t.stop()); $('recbar').classList.add('hidden');
    const secs=Math.round((Date.now()-recStart)/1000), type=(r.mimeType||mt||'audio/webm');
    if(recCancel||secs<1) return;
    const blob=new Blob(recChunks,{type}), path=`${me.id}/voice-${Date.now()}.${type.includes('mp4')?'m4a':'webm'}`;
    toast('Sending voice message…');
    const up=await sb.storage.from('chat-images').upload(path,blob,{contentType:type.split(';')[0]});
    if(up.error) return toast('Upload failed: '+up.error.message);
    await sendMessage('',null,sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl,secs);
  };
  r.start(); recStart=Date.now(); $('recbar').classList.remove('hidden'); tickRec(); recTimer=setInterval(tickRec,500);
}
$('mic').onclick=startRec;
$('rec-x').onclick=()=>{ recCancel=true; if(rec&&rec.state==='recording') rec.stop(); };
$('rec-ok').onclick=()=>{ if(rec&&rec.state==='recording') rec.stop(); };

/* ================= voice & video calls (WebRTC) ================= */
// STUN only. For users behind strict firewalls, add a TURN server here.
const ICE=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
let call=null, ac=null, ringT=null;
const sig=(to,kind,extra={})=>channel&&me&&channel.send({type:'broadcast',event:'call',payload:{to,from:me.id,kind,...extra}});
const getMedia=v=>navigator.mediaDevices.getUserMedia({audio:true,video:v?{facingMode:'user'}:false});
function ring(on){
  clearInterval(ringT); ringT=null; if(!on) return;
  const beep=()=>{ try{ ac=ac||new (window.AudioContext||window.webkitAudioContext)(); const o=ac.createOscillator(), g=ac.createGain();
    o.frequency.value=call&&call.dir==='in'?740:440; g.gain.value=.08; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+.35); }catch(e){} };
  beep(); ringT=setInterval(beep,1600);
}
function makePC(c){
  const pc=c.pc=new RTCPeerConnection({iceServers:ICE}); c.remote=new MediaStream();
  pc.onicecandidate=e=>{ if(e.candidate){ const cand=e.candidate.toJSON(); (c.ice=c.ice||[]).push(cand); sig(c.peer.id,'ice',{cand}); } };
  pc.ontrack=e=>{ e.streams[0].getTracks().forEach(t=>c.remote.addTrack(t)); $('c-remote').srcObject=c.remote; paintCall(); };
  pc.onconnectionstatechange=()=>{
    if(call!==c) return; const s=pc.connectionState;
    if(s==='connected'&&!c.t0){ c.t0=Date.now(); c.state='live'; ring(false); clearTimeout(c.ringTimeout); c.timer=setInterval(paintCall,1000); paintCall(); }
    if(s==='failed'){ toast('Call connection failed. Please try again.'); endCall('end'); }
    if(s==='disconnected') setTimeout(()=>{ if(call===c&&pc.connectionState!=='connected'){ toast('Call ended.'); endCall('end'); } },8000);
  };
}
function paintCall(){
  const c=call; if(!c) return; const v=c.video;
  $('c-name').textContent=c.peer.username;
  const av=$('c-av'); if(av.dataset.id!==c.peer.id){ av.innerHTML=''; av.appendChild(avatar(c.peer)); av.dataset.id=c.peer.id; }
  $('c-state').textContent=c.state==='live'?fmtDur(Math.round((Date.now()-c.t0)/1000)):c.state==='calling'?'Calling…':c.state==='ringing'?'Incoming '+(v?'video':'voice')+' call':'Connecting…';
  const inRing=c.state==='ringing';
  $('c-acc').classList.toggle('hidden',!inRing); $('c-mute').classList.toggle('hidden',inRing); $('c-cam').classList.toggle('hidden',inRing||!v);
  $('call').classList.toggle('vc',!!v&&!inRing); $('call').classList.toggle('video',!!v&&c.remote&&c.remote.getVideoTracks().length>0);
  if($('c-local').srcObject!==c.stream) $('c-local').srcObject=c.stream||null;
}
async function startCall(video){
  if(!peer||call) return;
  const target=peer, r=await notifyPeer(target.id,'call',{video});
  if(!online.has(target.id)&&!(r&&r.sent>0)) return toast(target.username+' is offline right now.');
  if(peer!==target||call) return;
  if(!navigator.mediaDevices||!window.RTCPeerConnection) return toast('Calls are not supported in this browser.');
  let stream; try{ stream=await getMedia(video); }catch(e){ return toast('Allow microphone'+(video?' and camera':'')+' access to call.'); }
  const c=call={peer,dir:'out',video,stream,queue:[],state:'calling'};
  makePC(c); stream.getTracks().forEach(t=>c.pc.addTrack(t,stream)); paintCall(); $('call').classList.remove('hidden'); ring(true);
  const offer=await c.pc.createOffer(); await c.pc.setLocalDescription(offer);
  c.offerMsg={sdp:{type:offer.type,sdp:offer.sdp},video}; sig(peer.id,'offer',c.offerMsg);
  c.ringTimeout=setTimeout(()=>{ if(call===c&&c.state==='calling'){ toast('No answer.'); endCall('end'); } },45000);
}
async function acceptCall(){
  const c=call; if(!c||c.dir!=='in'||c.pc) return;
  clearTimeout(c.ringTimeout); ring(false);
  try{ c.stream=await getMedia(c.video); }catch(e){ toast('Allow microphone'+(c.video?' and camera':'')+' access to answer.'); return endCall('decline'); }
  makePC(c); c.stream.getTracks().forEach(t=>c.pc.addTrack(t,c.stream)); c.state='connecting'; paintCall();
  await c.pc.setRemoteDescription(c.offer);
  for(const k of c.queue) await c.pc.addIceCandidate(k).catch(()=>{}); c.queue=[];
  const ans=await c.pc.createAnswer(); await c.pc.setLocalDescription(ans);
  sig(c.peer.id,'answer',{sdp:{type:ans.type,sdp:ans.sdp}});
}
async function onCall(p){
  if(!p||!me||(p.to!==me.id&&!(p.to==='*'&&p.kind==='sync'&&p.from!==me.id))) return;
  const c=call;
  if(p.kind==='sync'){
    // the other person just opened the app: re-send our ringing call so they can answer it
    if(c&&c.dir==='out'&&c.state==='calling'&&c.peer.id===p.from&&c.offerMsg){ sig(p.from,'offer',c.offerMsg); (c.ice||[]).forEach(cand=>sig(p.from,'ice',{cand})); }
    return;
  }
  if(p.kind==='offer'){
    if(c){ if(c.dir==='in'&&c.peer.id===p.from) return; return sig(p.from,'busy'); }
    const u=people.find(x=>x.id===p.from); if(!u) return;
    const n=call={peer:u,dir:'in',video:!!p.video,offer:p.sdp,queue:[],state:'ringing'};
    paintCall(); $('call').classList.remove('hidden'); ring(true);
    n.ringTimeout=setTimeout(()=>{ if(call===n&&n.state==='ringing') endCall('decline'); },45000);
  }else if(c&&c.peer.id===p.from){
    if(p.kind==='answer'&&c.pc){
      await c.pc.setRemoteDescription(p.sdp); c.state='connecting'; paintCall();
      for(const k of c.queue) await c.pc.addIceCandidate(k).catch(()=>{}); c.queue=[];
    }else if(p.kind==='ice'){
      if(c.pc&&c.pc.remoteDescription) await c.pc.addIceCandidate(p.cand).catch(()=>{}); else c.queue.push(p.cand);
    }else if(p.kind==='end'||p.kind==='decline'||p.kind==='busy'){
      toast(p.kind==='busy'?c.peer.username+' is on another call.':p.kind==='decline'?'Call declined.':(c.state==='ringing'?'Missed call from '+c.peer.username+'.':'Call ended.'));
      endCall();
    }
  }
}
function endCall(notify){
  const c=call; if(!c) return; call=null;
  clearTimeout(c.ringTimeout); clearInterval(c.timer); ring(false);
  if(notify) sig(c.peer.id,notify);
  if(c.pc) c.pc.close(); if(c.stream) c.stream.getTracks().forEach(t=>t.stop());
  $('call').classList.add('hidden'); $('call').classList.remove('video','vc'); $('c-remote').srcObject=null; $('c-local').srcObject=null; $('c-av').dataset.id='';
  $('c-mute').classList.remove('off'); $('c-cam').classList.remove('off');
  if(c.dir==='out'&&me) logCall(c,c.t0?Math.round((Date.now()-c.t0)/1000):0);
}
async function logCall(c,s){
  const kind=c.video?'video':'voice', text=(c.video?'📹 ':'📞 ')+(s?(c.video?'Video':'Voice')+' call · '+fmtDur(s):'Missed '+kind+' call');
  const {data}=await sb.from('messages').insert({sender_id:me.id,recipient_id:c.peer.id,body:text}).select().single();
  if(!data) return; if(peer&&peer.id===c.peer.id){ thread.push(data); renderLog(true); } touch(c.peer.id,data,0);
}
$('h-call').onclick=()=>startCall(false);
$('h-video').onclick=()=>startCall(true);
$('c-acc').onclick=acceptCall;
$('c-end').onclick=()=>{ if(call) endCall(call.state==='ringing'?'decline':'end'); };
$('c-mute').onclick=()=>{ if(!call||!call.stream) return; const t=call.stream.getAudioTracks(); const off=t.some(x=>x.enabled); t.forEach(x=>x.enabled=!off); $('c-mute').classList.toggle('off',off); };
$('c-cam').onclick=()=>{ if(!call||!call.stream) return; const t=call.stream.getVideoTracks(); const off=t.some(x=>x.enabled); t.forEach(x=>x.enabled=!off); $('c-cam').classList.toggle('off',off); };


/* ================= push notifications (calls + messages when the app is closed) ================= */
const VAPID_PUBLIC_KEY=''; // paste your VAPID public key here (see README)
const isNative=()=>!!(window.Capacitor&&Capacitor.isNativePlatform&&Capacitor.isNativePlatform());
const SITE_URL=''; // your hosted website address, used for invite links (important inside the Android app)
const pushOK=()=>!isNative()&&!!VAPID_PUBLIC_KEY&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window&&(location.protocol==='https:'||location.hostname==='localhost');
const b64u=s=>{ const b=atob((s+'='.repeat((4-s.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(b,c=>c.charCodeAt(0)); };
let swReg=null; const lastPing={};
async function initPush(){
  if(!pushOK()) return;
  if(!swReg){
    try{ swReg=await navigator.serviceWorker.register('sw.js'); }catch(e){ return; }
    navigator.serviceWorker.addEventListener('message',e=>{ if(e.data&&e.data.type==='open'){ const u=people.find(p=>p.id===e.data.from); if(u) openChat(u); } });
  }
  if(Notification.permission==='granted') await savePush();
  else if(Notification.permission==='default'&&!localStorage.getItem('avey-push-no')) $('pushbar').classList.remove('hidden');
}
async function savePush(){
  try{
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64u(VAPID_PUBLIC_KEY)});
    const j=sub.toJSON();
    const {error}=await sb.rpc('save_push_subscription',{p_endpoint:j.endpoint,p_p256dh:j.keys.p256dh,p_auth:j.keys.auth});
    return !error;
  }catch(e){ return false; }
}
async function dropPush(){
  try{ if(!swReg) return; const s=await swReg.pushManager.getSubscription(); if(s) await sb.from('push_subscriptions').delete().eq('endpoint',s.endpoint); }catch(e){}
}
async function notifyPeer(to,kind,extra={}){
  if(!VAPID_PUBLIC_KEY) return null;
  try{ const {data}=await sb.functions.invoke('notify',{body:{to,kind,...extra}}); return data; }catch(e){ return null; }
}
function pingPeer(id){
  if(!VAPID_PUBLIC_KEY||Date.now()-(lastPing[id]||0)<8000) return;
  lastPing[id]=Date.now(); notifyPeer(id,'message');
}
function openFromUrl(){
  const q=new URLSearchParams(location.search), who=q.get('chat')||q.get('call'); if(!who) return;
  const u=people.find(p=>p.id===who); if(u) openChat(u);
  history.replaceState(null,'',location.pathname);
}
$('push-on').onclick=async()=>{
  const perm=await Notification.requestPermission(); $('pushbar').classList.add('hidden');
  if(perm==='granted') toast(await savePush()?'Notifications are on.':'Could not turn on notifications.');
  else toast('Notifications are blocked. Allow them in your browser settings.');
};
$('push-x').onclick=()=>{ $('pushbar').classList.add('hidden'); try{ localStorage.setItem('avey-push-no','1'); }catch(e){} };


/* ================= direct file & photo sharing =================
   Files travel straight from one device to the other over a WebRTC data channel.
   Nothing is uploaded to Supabase: not the file, not its name. Both people must be online. */
const CHUNK=16384, HIGH=4*1024*1024, MAXFILE=100*1024*1024;
const tx={}, xfers=new Map();
const txList=id=>tx[id]||(tx[id]=[]);
const txItems=()=>peer?txList(peer.id).map(x=>({...x,_tx:true,id:'x'+x.tid,sender_id:x.dir==='out'?me.id:peer.id})):[];
const isImg=m=>/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(m||'');
const fmtSize=n=>n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB';
const safeName=n=>String(n).replace(/[\\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,120)||'file';
const fsig=(to,kind,tid,extra={})=>channel&&me&&channel.send({type:'broadcast',event:'file',payload:{to,from:me.id,kind,tid,...extra}});
const FINAL=['done','declined','canceled','failed'];

function closeX(x){ x.dead=true; clearTimeout(x.timer); try{ x.dc&&x.dc.close(); }catch(e){} try{ x.pc&&x.pc.close(); }catch(e){} }
function failX(x,msg){ if(FINAL.includes(x.item.state)) return; x.item.state='failed'; x.item.err=msg; closeX(x); toast('File transfer failed: '+msg); renderLog(); }
function prog(x,f){
  x.item.pct=f; const t=Date.now(); if(t-(x.last||0)<120&&f<1) return; x.last=t;
  document.querySelectorAll(`[data-tid="${x.item.tid}"] .bar i`).forEach(e=>e.style.width=Math.round(f*100)+'%');
}
function newPC(x,toId){
  const pc=x.pc=new RTCPeerConnection({iceServers:ICE});
  pc.onicecandidate=e=>{ if(e.candidate) fsig(toId,'ice',x.item.tid,{cand:e.candidate.toJSON()}); };
  pc.onconnectionstatechange=()=>{ if(['failed','closed'].includes(pc.connectionState)&&!FINAL.includes(x.item.state)&&!x.dead) failX(x,'connection lost'); };
  return pc;
}

/* sending */
async function sendFile(file){
  if(!peer||!file) return;
  if(!online.has(peer.id)) return toast(peer.username+' needs to be online to receive files. Files go directly between devices and are never stored.');
  if(file.size>MAXFILE) return toast('Files must be under 100 MB.');
  if(!window.RTCPeerConnection) return toast('File sharing is not supported in this browser.');
  const to=peer, tid=Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const item={tid,dir:'out',name:safeName(file.name),size:file.size,mime:file.type||'application/octet-stream',state:'waiting',pct:0,url:isImg(file.type)?URL.createObjectURL(file):null,created_at:new Date().toISOString()};
  txList(to.id).push(item);
  const x={item,file,to}; xfers.set(tid,x); renderLog(true);
  touch(to.id,{id:'x'+tid,sender_id:me.id,recipient_id:to.id,body:(isImg(item.mime)?'Sent a photo':'Sent a file: '+item.name),created_at:item.created_at,read_at:null},0);
  const pc=newPC(x,to.id), dc=x.dc=pc.createDataChannel('file'); x.queue=[];
  dc.binaryType='arraybuffer'; dc.bufferedAmountLowThreshold=1<<20;
  dc.onopen=()=>pump(x);
  dc.onmessage=e=>{
    if(typeof e.data!=='string') return; let j; try{ j=JSON.parse(e.data); }catch(_){ return; }
    if(j.t==='ack'){ item.state='done'; item.pct=1; renderLog(); setTimeout(()=>closeX(x),1500); }
    if(j.t==='nack') failX(x,'the other device did not get the whole file');
  };
  const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
  fsig(to.id,'offer',tid,{sdp:{type:offer.type,sdp:offer.sdp},name:item.name,size:item.size,mime:item.mime});
  item.state='offered'; renderLog();
  x.timer=setTimeout(()=>{ if(item.state==='offered') failX(x,'no response'); },90000);
}
async function pump(x){
  const {dc,file,item}=x; clearTimeout(x.timer); item.state='sending'; renderLog();
  dc.send(JSON.stringify({t:'meta',size:item.size}));
  let off=0;
  while(off<file.size&&!x.dead){
    if(dc.bufferedAmount>HIGH){ await new Promise(r=>dc.addEventListener('bufferedamountlow',r,{once:true})); continue; }
    const buf=await file.slice(off,off+CHUNK).arrayBuffer();
    if(x.dead||dc.readyState!=='open') return;
    dc.send(buf); off+=buf.byteLength; prog(x,off/file.size);
  }
  if(!x.dead&&dc.readyState==='open') dc.send(JSON.stringify({t:'end'}));
}

/* receiving */
async function onFile(p){
  if(!p||!me||p.to!==me.id) return;
  if(p.kind==='offer'){
    const u=people.find(z=>z.id===p.from), size=Number(p.size)||0;
    if(!u||typeof p.name!=='string'||size<=0||size>MAXFILE||xfers.has(p.tid)) return;
    const item={tid:p.tid,dir:'in',name:safeName(p.name),size,mime:String(p.mime||'application/octet-stream'),state:'offered',pct:0,url:null,created_at:new Date().toISOString()};
    txList(u.id).push(item);
    const x={item,from:u,offer:p.sdp,queue:[],chunks:[],got:0}; xfers.set(p.tid,x);
    const open=peer&&peer.id===u.id;
    touch(u.id,{id:'x'+p.tid,sender_id:u.id,recipient_id:me.id,body:(isImg(item.mime)?'Sent a photo':'Sent a file: '+item.name),created_at:item.created_at,read_at:null},open?0:1);
    if(open) renderLog(true); else toast(u.username+' is sending you '+(isImg(item.mime)?'a photo.':'a file.'));
    if(isImg(item.mime)&&size<=10*1024*1024) acceptX(x);
    return;
  }
  const x=xfers.get(p.tid); if(!x||p.from!==(x.to||x.from).id) return;
  if(p.kind==='answer'&&x.pc){
    clearTimeout(x.timer); await x.pc.setRemoteDescription(p.sdp);
    for(const c of x.queue) await x.pc.addIceCandidate(c).catch(()=>{}); x.queue=[];
  }else if(p.kind==='ice'){
    if(x.pc&&x.pc.remoteDescription) await x.pc.addIceCandidate(p.cand).catch(()=>{}); else x.queue.push(p.cand);
  }else if(p.kind==='decline'||p.kind==='cancel'){
    if(FINAL.includes(x.item.state)) return;
    x.item.state=p.kind==='decline'?'declined':'canceled'; closeX(x); renderLog();
  }
}
async function acceptX(x){
  const it=x.item; if(it.state!=='offered') return;
  it.state='receiving'; renderLog();
  try{
    const pc=newPC(x,x.from.id);
    pc.ondatachannel=e=>{ const dc=x.dc=e.channel; dc.binaryType='arraybuffer'; dc.onmessage=m=>onData(x,m.data); };
    await pc.setRemoteDescription(x.offer);
    for(const c of x.queue) await pc.addIceCandidate(c).catch(()=>{}); x.queue=[];
    const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
    fsig(x.from.id,'answer',it.tid,{sdp:{type:ans.type,sdp:ans.sdp}});
    x.timer=setTimeout(()=>{ if(it.state==='receiving'&&!x.got) failX(x,'could not connect'); },30000);
  }catch(e){ failX(x,'could not connect'); }
}
function onData(x,d){
  const it=x.item; if(x.dead) return;
  if(typeof d==='string'){
    let j; try{ j=JSON.parse(d); }catch(_){ return; }
    if(j.t==='end'){
      if(x.got!==it.size){ try{ x.dc.send(JSON.stringify({t:'nack'})); }catch(e){} return failX(x,'file was incomplete'); }
      it.url=URL.createObjectURL(new Blob(x.chunks,{type:isImg(it.mime)?it.mime:'application/octet-stream'}));
      x.chunks=[]; it.state='done'; it.pct=1; clearTimeout(x.timer);
      try{ x.dc.send(JSON.stringify({t:'ack'})); }catch(e){}
      renderLog(true); setTimeout(()=>closeX(x),2000);
    }
    return;
  }
  clearTimeout(x.timer); x.chunks.push(d); x.got+=d.byteLength;
  if(x.got>it.size) return failX(x,'unexpected data');
  prog(x,x.got/it.size);
}
function declineX(x){ if(!x||x.item.state!=='offered') return; fsig(x.from.id,'decline',x.item.tid); x.item.state='declined'; closeX(x); renderLog(); }
function cancelX(x){ if(!x||FINAL.includes(x.item.state)) return; fsig((x.to||x.from).id,'cancel',x.item.tid); x.item.state='canceled'; closeX(x); renderLog(); }

/* the file bubble */
function fileBubble(m){
  const x=xfers.get(m.tid), b=document.createElement('div'); b.dataset.tid=m.tid;
  const status={waiting:'Connecting…',offered:m.dir==='out'?'Waiting for them to accept…':'Wants to send you this file',sending:'Sending…',receiving:'Receiving…',done:m.dir==='out'?'Sent directly':'Received',declined:'Declined',canceled:'Canceled',failed:m.err||'Failed'}[m.state];
  const bar=()=>{ const r=document.createElement('div'); r.className='bar'; const i=document.createElement('i'); i.style.width=Math.round((m.pct||0)*100)+'%'; r.appendChild(i); return r; };
  const btn=(t,fn,alt)=>{ const e=document.createElement('button'); e.type='button'; e.textContent=t; if(alt) e.className='alt'; e.onclick=fn; return e; };
  if(isImg(m.mime)&&m.url){
    b.className='b img'; const im=document.createElement('img'); im.src=m.url; im.alt=m.name;
    im.onclick=()=>{ $('lightbox').querySelector('img').src=m.url; $('lightbox').classList.remove('hidden'); }; b.appendChild(im);
    if(['sending','receiving'].includes(m.state)) b.appendChild(bar());
    if(['failed','canceled','declined'].includes(m.state)){ const s=document.createElement('small'); s.textContent=status; b.appendChild(s); }
    return b;
  }
  b.className='b file';
  const ic=document.createElement('div'); ic.className='fic';
  ic.innerHTML='<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  const meta=document.createElement('div'); meta.className='fmeta';
  const nm=document.createElement('b'); nm.textContent=m.name; nm.title=m.name;
  const sm=document.createElement('small'); sm.textContent=fmtSize(m.size)+' · '+status;
  meta.append(nm,sm);
  if(['sending','receiving'].includes(m.state)) meta.appendChild(bar());
  const bt=document.createElement('div'); bt.className='fbtns';
  const incomingOffer=m.state==='offered'&&m.dir==='in';
  if(incomingOffer) bt.append(btn('Accept',()=>acceptX(x)),btn('Decline',()=>declineX(x),true));
  else if(!FINAL.includes(m.state)) bt.append(btn('Cancel',()=>cancelX(x),true));
  if(m.state==='done'&&m.dir==='in'&&m.url) bt.append(btn('Save',()=>saveFile(m)));
  if(bt.children.length) meta.appendChild(bt);
  b.append(ic,meta); return b;
}

/* drag & drop and paste */
$('chat').addEventListener('dragover',e=>e.preventDefault());
$('chat').addEventListener('drop',e=>{ e.preventDefault(); [...(e.dataTransfer.files||[])].forEach(sendFile); });
$('text').addEventListener('paste',e=>{ const fs=[...((e.clipboardData&&e.clipboardData.files)||[])]; if(fs.length){ e.preventDefault(); fs.forEach(sendFile); } });


/* saving a received file: browsers download it, the Android app opens the share/save sheet */
async function saveFile(m){
  const P=isNative()&&Capacitor.Plugins;
  if(P&&P.Filesystem&&P.Share){
    try{
      const blob=await (await fetch(m.url)).blob();
      const data=await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(',')[1]); r.onerror=rej; r.readAsDataURL(blob); });
      const f=await P.Filesystem.writeFile({path:m.name,data,directory:'CACHE'});
      await P.Share.share({title:m.name,url:f.uri,dialogTitle:'Save or open file'});
    }catch(e){ if(!/cancel/i.test(String(e&&e.message))) toast('Could not save the file.'); }
    return;
  }
  const a=document.createElement('a'); a.href=m.url; a.download=m.name; a.click();
}
