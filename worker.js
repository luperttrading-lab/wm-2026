// ============================================================================
//  WM 2026 – Push-Worker (Cloudflare)
//  - POST /subscribe : Geräte-Abo speichern
//  - POST /test      : Test-Push an alle Abos
//  - Cron (jede Min) : Spiele pollen, Anpfiff/Tore/Schlusspfiff erkennen, Push senden
//  Bindings:  KV 'SUBS'   (VAPID-Schlüssel sind unten fest eingebaut)
// ============================================================================

// --- VAPID-Schlüssel (fest eingebaut – dieser Code liegt nur privat im
//     Cloudflare-Dashboard, NICHT im öffentlichen GitHub-Repo) -------------
const VAPID_PUBLIC_KEY  = 'BN4D-4wP9HRIVODTcIujObUQxfkUqy56KCLP9MZxln7arr1gchpqWQv8BG9m0xwqXASCkfNwUr6ta5jx6FUGJS4';
const VAPID_PRIVATE_KEY = 'PtJ_AeaNSnJAechSjYag-3cxIY92vI1Gq9Bdn9KA-CU';
const VAPID_SUBJECT_VAL = 'mailto:Lupert.trading@gmail.com';
// --------------------------------------------------------------------------

// Web-Push-Kern (reine Web-Crypto, lauffähig in Cloudflare Workers)
function b64urlToBytes(s){
  s=s.replace(/-/g,'+').replace(/_/g,'/'); const pad=s.length%4; if(pad)s+='='.repeat(4-pad);
  const bin=atob(s); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return a;
}
function bytesToB64url(b){
  const a=new Uint8Array(b); let bin=''; for(let i=0;i<a.length;i++)bin+=String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function concat(...arr){let n=0;for(const x of arr)n+=x.length;const o=new Uint8Array(n);let off=0;for(const x of arr){o.set(x,off);off+=x.length;}return o;}

async function hkdf(salt, ikm, info, len){
  const key=await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, key, len*8);
  return new Uint8Array(bits);
}

// VAPID JWT (ES256) + Authorization-Header-Wert
async function vapidHeader(endpoint, vapidPublic, vapidPrivate, subject){
  const aud=new URL(endpoint).origin;
  const enc=o=>bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput=enc({typ:'JWT',alg:'ES256'})+'.'+enc({aud,exp:Math.floor(Date.now()/1000)+12*3600,sub:subject});
  const pub=b64urlToBytes(vapidPublic);
  const jwk={kty:'EC',crv:'P-256',d:vapidPrivate,x:bytesToB64url(pub.slice(1,33)),y:bytesToB64url(pub.slice(33,65)),ext:true};
  const key=await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, new TextEncoder().encode(signingInput));
  return 'vapid t='+(signingInput+'.'+bytesToB64url(new Uint8Array(sig)))+', k='+vapidPublic;
}

// Payload verschlüsseln (aes128gcm, RFC 8291)
async function encryptPayload(payload, p256dh, auth){
  const clientPub=b64urlToBytes(p256dh), authSecret=b64urlToBytes(auth);
  const eph=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const ephPub=new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const clientKey=await crypto.subtle.importKey('raw', clientPub, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:clientKey}, eph.privateKey, 256));
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const authInfo=concat(new TextEncoder().encode('WebPush: info\0'), clientPub, ephPub);
  const ikm=await hkdf(authSecret, shared, authInfo, 32);
  const cek=await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce=await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const plaintext=concat(new TextEncoder().encode(payload), new Uint8Array([0x02]));
  const aesKey=await crypto.subtle.importKey('raw', cek, {name:'AES-GCM'}, false, ['encrypt']);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce}, aesKey, plaintext));
  const header=concat(salt, new Uint8Array([0,0,16,0]), new Uint8Array([ephPub.length]), ephPub);
  return concat(header, ct);
}


// ---- Push an ein Gerät ----
async function sendPush(sub, payloadObj, env){
  const body = await encryptPayload(JSON.stringify(payloadObj), sub.keys.p256dh, sub.keys.auth);
  const auth = await vapidHeader(sub.endpoint, (env&&env.VAPID_PUBLIC)||VAPID_PUBLIC_KEY, (env&&env.VAPID_PRIVATE)||VAPID_PRIVATE_KEY, (env&&env.VAPID_SUBJECT)||VAPID_SUBJECT_VAL);
  const res = await fetch(sub.endpoint, {
    method:'POST',
    headers:{ 'Authorization':auth, 'Content-Encoding':'aes128gcm',
              'Content-Type':'application/octet-stream', 'TTL':'86400', 'Urgency':'high' },
    body
  });
  return res.status;
}

// ---- Team-Namen ----
const TEAMS = {'17': 'Deutschland', '14': 'Paraguay', '33': 'Frankreich', '23': 'Schweden', '2': 'Südafrika', '5': 'Kanada', '21': 'Niederlande', '10': 'Marokko', '44': 'Kolumbien', '47': 'Ghana', '29': 'Spanien', '39': 'Österreich', '13': 'USA', '6': 'Bosnien-Herz.', '25': 'Belgien', '34': 'Senegal', '9': 'Brasilien', '22': 'Japan', '19': 'Elfenbeinküste', '36': 'Norwegen', '1': 'Mexiko', '20': 'Ecuador', '45': 'England', '42': 'DR Kongo', '37': 'Argentinien', '30': 'Kap Verde', '15': 'Australien', '26': 'Ägypten', '8': 'Schweiz', '38': 'Algerien', '41': 'Portugal', '46': 'Kroatien'};
const tn = id => TEAMS[id] || ('Team ' + id);
// 3-Buchstaben-Kürzel (für kompakte Push-Titel, damit lange Namen nicht abgeschnitten werden)
const CODES = {'17':'GER','14':'PAR','33':'FRA','23':'SWE','2':'RSA','5':'CAN','21':'NED','10':'MAR','44':'COL','47':'GHA','29':'ESP','39':'AUT','13':'USA','6':'BIH','25':'BEL','34':'SEN','9':'BRA','22':'JPN','19':'CIV','36':'NOR','1':'MEX','20':'ECU','45':'ENG','42':'COD','37':'ARG','30':'CPV','15':'AUS','26':'EGY','8':'SUI','38':'ALG','41':'POR','46':'CRO'};
const cn = id => CODES[id] || tn(id);

// ---- Abos in KV ----
async function subId(endpoint){
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + bytesToB64url(new Uint8Array(h)).slice(0,22);
}
async function allSubs(env){
  const out=[]; let cursor;
  do{
    const list = await env.SUBS.list({prefix:'sub:', cursor});
    for(const k of list.keys){ const v=await env.SUBS.get(k.name); if(v) out.push({key:k.name, sub:JSON.parse(v)}); }
    cursor = list.cursor;
    if(list.list_complete) break;
  } while(cursor);
  return out;
}
async function pushAll(payloadObj, env){
  const subs = await allSubs(env);
  let ok=0;
  for(const {key, sub} of subs){
    try{
      const st = await sendPush(sub, payloadObj, env);
      if(st===201 || st===200) ok++;
      else if(st===404 || st===410) await env.SUBS.delete(key); // Abo abgelaufen
    }catch(e){ /* nächstes */ }
  }
  return {sent:ok, total:subs.length};
}

const CORS = { 'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type' };

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if(req.method==='OPTIONS') return new Response(null,{headers:CORS});
    if(url.pathname==='/subscribe' && req.method==='POST'){
      const sub = await req.json().catch(()=>null);
      if(!sub || !sub.endpoint) return new Response('bad request',{status:400,headers:CORS});
      await env.SUBS.put(await subId(sub.endpoint), JSON.stringify(sub));
      return new Response(JSON.stringify({ok:true}),{headers:{...CORS,'Content-Type':'application/json'}});
    }
    if(url.pathname==='/unsubscribe' && req.method==='POST'){   // Abo serverseitig entfernen (Glocke aus)
      const body = await req.json().catch(()=>null);
      if(!body || !body.endpoint) return new Response('bad request',{status:400,headers:CORS});
      await env.SUBS.delete(await subId(body.endpoint));
      return new Response(JSON.stringify({ok:true}),{headers:{...CORS,'Content-Type':'application/json'}});
    }
    if(url.pathname==='/test'){  // GET oder POST -> sofort Test-Push an alle Abos
      const r = await pushAll({title:'\u26BD TOR! Deutschland 1:0', body:'Test \u00B7 Deutschland \u2013 Paraguay', tag:'wm-test'}, env);
      return new Response(JSON.stringify(r),{headers:{...CORS,'Content-Type':'application/json'}});
    }
    return new Response('WM 2026 Push-Worker l\u00e4uft.',{headers:CORS});
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(poll(env));
  }
};

// ---- Spielfenster: nur 15 Min vor bis ~3,5 Std nach Anpfiff aktiv ----
const KICKOFFS = [1782673200, 1782752400, 1782765000, 1782781200, 1782838800, 1782853200, 1782867600, 1782921600, 1782936000, 1782950400, 1783018800, 1783033200, 1783047600, 1783101600, 1783116000, 1783128600, 1783184400, 1783198800, 1783281600, 1783296000, 1783364400, 1783382400, 1783440000, 1783454400, 1783627200, 1783710000, 1783803600, 1783818000, 1784055600, 1784142000, 1784408400, 1784487600];        // Anpfiff-Zeiten (UTC-Sekunden), MESZ-basiert
const WIN_BEFORE = 60*60;          // 60 Minuten vorher (sichert die Anpfiff-Erkennung: Spiel wird lange als 'notstarted' erfasst)
const WIN_AFTER  = Math.round(3.5*3600); // ~3,5 Stunden danach (deckt Verl\u00e4ngerung + Elfmeter ab)
function inWindow(now){
  for(const k of KICKOFFS){ if(now >= k - WIN_BEFORE && now <= k + WIN_AFTER) return true; }
  return false;
}
// Anstosszeiten der Restspiele nach Quelle-Spiel-ID (UTC-Sekunden). Grundlage fuer die
// PLANBASIERTE Anpfiff-Meldung: worldcup26.ir setzt time_elapsed teils Stunden zu frueh
// auf 'live', dadurch ist der Uebergang notstarted->live nicht beobachtbar.
const GAME_KICKS = { '99':1783803600, '100':1783818000, '101':1784055600, '102':1784142000, '103':1784408400, '104':1784487600 };

// ---- Poll + Tor-Erkennung ----
// Serialisiert nur den Spielzustand (ohne _ts-Zeitstempel), Keys echt sortiert:
// so ist der Vergleich reihenfolge-unabhaengig und der Zeitstempel loest keine KV-Writes aus.
function stableGamesStr(obj){
  const keys = Object.keys(obj).filter(k => k !== '_ts').sort();
  const o = {};
  for(const k of keys) o[k] = obj[k];
  return JSON.stringify(o);
}
async function poll(env){
  const now = Math.floor(Date.now()/1000);
  if(!inWindow(now)) return;   // au\u00dferhalb der Spielfenster: API gar nicht erst anfassen
  let data;
  try{ const r = await fetch('https://worldcup26.ir/get/games', {cf:{cacheTtl:0}}); data = await r.json(); }
  catch(e){ return; }
  const games = data && data.games;
  if(!Array.isArray(games)) return;

  const prevRaw = await env.SUBS.get('state');
  let prev = prevRaw ? JSON.parse(prevRaw) : null;
  // Uralten Zustand verwerfen (z.B. nach langer Cron-Pause oder Alt-State ohne Zeitstempel):
  // sonst werden dutzende laengst beendete Spiele als 'gerade beendet' gemeldet.
  // Bei prev=null macht der Lauf nur einen stillen Resync (speichern, keine Pushes).
  if(prev && (!prev._ts || (now - prev._ts) > 12*3600)) prev = null;
  const state = { _ts: now };
  const events = [];

  for(const g of games){
    const h=parseInt(g.home_team_id,10), a=parseInt(g.away_team_id,10);
    if(isNaN(h)||isNaN(a)) continue;
    if(!TEAMS[h]||!TEAMS[a]) continue;   // nur Spiele mit bekannten Teams melden (keine Geister-Spiele)
    const hs=parseInt(g.home_score,10), as=parseInt(g.away_score,10);
    const fin = String(g.finished).toUpperCase()==='TRUE';
    const te = String(g.time_elapsed||'').toLowerCase();
    const started = fin || (te!=='' && te!=='notstarted');   // angepfiffen, sobald die Quelle eine Spielminute/Status liefert
    const key = g.type + ':' + Math.min(h,a) + '-' + Math.max(h,a);
    const cur = { h:isNaN(hs)?0:hs, a:isNaN(as)?0:as, f:fin, s:started, k:false };
    state[key] = cur;
    if(prev && prev[key]){
      const p = prev[key];
      cur.k = !!p.k;   // Anpfiff-Merker uebernehmen (verhindert Doppel-Meldung)
      const score = tn(h) + ' ' + cur.h + ':' + cur.a + ' ' + tn(a);
      // Anpfiff PLANBASIERT: zur bekannten Anstosszeit des Spiels (Quelle-ID), unabhaengig
      // vom (oft zu frueh gesetzten) time_elapsed der Quelle. Nachholfenster 5 Minuten.
      const kick = GAME_KICKS[String(parseInt(g.id,10))];
      if(!cur.f && !cur.k && kick && now >= kick && now <= kick + 300){
        events.push({title:'\uD83D\uDFE2 Anpfiff: '+cn(h)+' \u2013 '+cn(a), body:tn(h)+' \u2013 '+tn(a), tag:key+':start'});
        cur.k = true;
      }
      if(cur.h > p.h) events.push({title:'\u26BD TOR! '+tn(h), body:score, tag:key});
      if(cur.a > p.a) events.push({title:'\u26BD TOR! '+tn(a), body:score, tag:key});
      if(cur.h < p.h) events.push({title:'\uD83D\uDEAB Tor aberkannt \u2013 '+tn(h), body:score, tag:key});
      if(cur.a < p.a) events.push({title:'\uD83D\uDEAB Tor aberkannt \u2013 '+tn(a), body:score, tag:key});
      if(!p.f && cur.f){
        // Elfmeterschiessen: Quelle liefert i.E.-Stand in separaten Feldern -> anhaengen, sonst fehlt der Sieger
        const hp=parseInt(g.home_penalty_score,10), ap=parseInt(g.away_penalty_score,10);
        const pen=(!isNaN(hp)&&!isNaN(ap)) ? ' (n.V., '+hp+':'+ap+' i.E.)' : '';
        events.push({title:'\u23F1\uFE0F Schlusspfiff', body:score+pen, tag:key+':end'});
      }
    }
  }
  // KV-Write nur, wenn sich der Spielstand wirklich geändert hat (spart Free-Plan-Kontingent).
  // Vergleich laeuft ueber den Spielzustand OHNE Zeitstempel (sonst waere jeder Poll ein Write);
  // Keys echt sortiert = reihenfolge-unabhaengig stabil.
  const cmpNow = stableGamesStr(state);
  const cmpPrev = prevRaw ? stableGamesStr(JSON.parse(prevRaw)) : null;
  if(cmpNow !== cmpPrev) await env.SUBS.put('state', JSON.stringify(state));
  if(prev){ for(const ev of events) await pushAll(ev, env); }  // kein Push beim Resync-Lauf
}
