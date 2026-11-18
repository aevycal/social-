const SUPABASE_URL = 'https://hrqlwxltwhlfrkkvlaun.supabase.co';
const SUPABASE_KEY = 'sb_publishable_DB3NxYTmCnaMoqsNpg9BbA_6Gw3PMV7';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);

let me=null, peer=null, people=[], convos={}, thread=[], online=new Set(), typingUntil=0, lastTyped=0, channel=null, signup=false;

/* ---------- helpers ---------- */
const hue = s => { let h=0; for(const c of s) h=(h*31+c.charCodeAt(0))%360; return h; };
function avatar(p, cls=''){
  const a=document.createElement('div'); a.className='av '+cls;
  a.style.background=`linear-gradient(135deg,hsl(${hue(p.username)} 70% 55%),hsl(${(hue(p.username)+40)%360} 70% 45%))`;
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
function setTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.setItem('avey-theme',t)}catch(e){} document.querySelector('meta[name=theme-color]').content = t==='dark'?'#0b1426':'#0084ff'; }
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
$('out').onclick = () => sb.auth.signOut();
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

  loadExtras();
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
    .on('broadcast',{event:'typing'},({payload})=>{
      if(peer&&payload.from===peer.id){ typingUntil=Date.now()+3000; head(); renderLog(); setTimeout(()=>{head();renderLog();},3100); }
    })
    .subscribe(s=>{ if(s==='SUBSCRIBED') channel.track({u:me.username}); });
}
function teardown(){
  if(channel){ sb.removeChannel(channel); channel=null; }
  me=peer=null; people=[]; convos={}; thread=[]; online=new Set(); stories=[]; sLikes=[]; notes={}; mLikes=[]; follows=[]; closeViewer(); closeProfile();
  $('app').classList.add('hidden'); $('app').classList.remove('chatting');
  $('chat').style.display='none'; $('placeholder').classList.remove('hidden');
  $('auth').classList.remove('hidden');
}

/* ---------- chat list ---------- */
function preview(m){
  const mine=m.sender_id===me.id;
  return (mine?'You: ':'')+(m.image_url&&!m.body?'Sent a photo':m.body);
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
  if(!A.length&&!B.length){ const e=document.createElement('div'); e.className='empty'; e.textContent=q?'No one found with that name.':'No one else has joined yet. Invite a friend to create an account.'; box.appendChild(e); }
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
  peer=p; thread=[]; typingUntil=0;
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
  const log=$('log'), near=jump||log.scrollHeight-log.scrollTop-log.clientHeight<140;
  log.innerHTML='';
  if(!thread.length&&peer){
    const e=document.createElement('div'); e.className='empty'; e.append(avatar(peer),document.createElement('br'));
    e.lastChild.replaceWith(document.createElement('br'));
    const t=document.createElement('div'); t.textContent='This is the start of your chat with '+peer.username+'. Say hello!'; e.appendChild(t); log.appendChild(e);
  }
  let lastOwn=-1; thread.forEach((m,i)=>{ if(m.sender_id===me.id) lastOwn=i; });
  thread.forEach((m,i)=>{
    const d=new Date(m.created_at), prev=thread[i-1], next=thread[i+1];
    if(!prev||!sameDay(new Date(prev.created_at),d)){ const s=document.createElement('div'); s.className='day'; s.textContent=dayLabel(d); log.appendChild(s); }
    const mine=m.sender_id===me.id;
    const first=!prev||prev.sender_id!==m.sender_id||!sameDay(new Date(prev.created_at),d)||(d-new Date(prev.created_at))>9e5;
    const last=!next||next.sender_id!==m.sender_id||(new Date(next.created_at)-d)>9e5;
    const row=document.createElement('div'); row.className='m '+(mine?'mine':'theirs')+(first?' first':'')+(last?' last':'');
    if(!mine){ if(last) row.appendChild(avatar(peer)); else { const sp=document.createElement('span'); sp.className='sp'; row.appendChild(sp);} }
    if(!mine&&last) row.firstChild.className='av';
    const wrap=document.createElement('div'); wrap.style.display='contents';
    if(m.image_url){ const b=document.createElement('div'); b.className='b img'; const im=document.createElement('img'); im.src=m.image_url; im.alt='Photo'; im.loading='lazy'; im.onclick=()=>{ $('lightbox').querySelector('img').src=m.image_url; $('lightbox').classList.remove('hidden'); }; b.appendChild(im); row.appendChild(b); }
    if(m.body){ const b=document.createElement('div'); b.className='b'+(isEmoji(m.body)?' emoji':''); b.textContent=m.body; b.title=d.toLocaleString(); row.appendChild(b); }
    log.appendChild(row); decorate(row,m,mine);
    if(i===lastOwn){ const s=document.createElement('div'); s.className='status'; s.textContent=m.read_at?'Seen '+stamp(m.read_at):(m.pending?'Sending…':'Sent'); log.appendChild(s); }
  });
  if(Date.now()<typingUntil){ const t=document.createElement('div'); t.className='typing'; t.append(avatar(peer),document.createTextNode(peer.username+' is typing…')); t.firstChild.className='av'; t.firstChild.style.cssText+='width:22px;height:22px;font-size:10px'; log.appendChild(t); }
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
async function sendMessage(body,image_url){
  if(!peer) return;
  const tmp={id:'t'+Date.now(),sender_id:me.id,recipient_id:peer.id,body,image_url:image_url||null,created_at:new Date().toISOString(),pending:true};
  thread.push(tmp); renderLog(true);
  const {data,error}=await sb.from('messages').insert({sender_id:me.id,recipient_id:peer.id,body,image_url:image_url||null}).select().single();
  const i=thread.indexOf(tmp);
  if(error){ if(i>-1) thread.splice(i,1); renderLog(); toast('Message not sent: '+error.message); return false; }
  if(i>-1) thread[i]=data; renderLog(); touch(peer.id,data,0); return true;
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
$('file').onchange=async e=>{
  const f=e.target.files[0]; e.target.value='';
  if(!f||!peer) return;
  if(!f.type.startsWith('image/')) return toast('Choose an image file.');
  if(f.size>5*1024*1024) return toast('Images must be under 5 MB.');
  const path=`${me.id}/${Date.now()}-${f.name.replace(/[^a-z0-9._-]/gi,'_')}`;
  toast('Uploading photo…');
  const {error}=await sb.storage.from('chat-images').upload(path,f,{contentType:f.type});
  if(error) return toast('Upload failed: '+error.message);
  await sendMessage('',sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl);
};

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
  if(String(m.id).startsWith('t')) return;
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
  const t=$('tray'); if(!t||!me) return; t.innerHTML='';
  const ids=[me.id,...people.filter(p=>stories.some(s=>s.user_id===p.id)||fresh(notes[p.id])).sort((a,b)=>following(b.id)-following(a.id)).map(p=>p.id)];
  ids.forEach(id=>{
    const u=userById(id), us=stories.filter(s=>s.user_id===id), note=notes[id], mine=id===me.id;
    const b=document.createElement('button'); b.type='button'; b.className='tr';
    if(fresh(note)){ const n=document.createElement('span'); n.className='note'; n.textContent=note.body; b.appendChild(n); }
    const ring=document.createElement('div'); ring.className='ring'+(us.length?(us.some(s=>!seen.has(s.id))?' new':' old'):''); ring.appendChild(avatar(u));
    if(mine){ const pl=document.createElement('span'); pl.className='plus'; pl.textContent='+'; pl.title='Add a story or note'; pl.onclick=e=>{e.stopPropagation(); openCompose(fresh(note)&&!us.length?'note':'story');}; ring.appendChild(pl); }
    const lb=document.createElement('small'); lb.textContent=mine?'Your story':u.username;
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
