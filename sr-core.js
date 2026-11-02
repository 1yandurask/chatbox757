/* 757 Now Playing — song request queue.
 * Shared by overlay.html (the copy that answers in chat) and index.html (a read-only mirror).
 * Both copies listen to the same chat and apply the same rules in the same order, using
 * Twitch's message timestamps, so they end up with the same queue without a server.
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    cmdRequest: '!sr',
    cmdQueue: '!queue',
    cmdNext: '!next',
    cmdClear: '!clear',
    cmdRemove: '!remove',
    maxPerUser: 2,
    cooldownMs: 5 * 60 * 1000,
    queueCooldownMs: 30 * 1000,
  };

  const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fmtWait = (ms) => {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
  };

  // loose comparison for "is the track that's playing the one that was requested?"
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[(\[].*?[)\]]/g, ' ')
      .replace(/\s+-\s+.*(remaster|version|edit|live|mix|mono|stereo).*$/i, ' ')
      .replace(/\b(feat|ft)\.?\s.*$/i, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }
  function sameTrack(a, b) {
    if (!a || !b) return false;
    if (norm(a.title) !== norm(b.title)) return false;
    const x = norm(a.artist), y = norm(b.artist);
    return x === y || (x && y && (x.startsWith(y) || y.startsWith(x)));
  }

  function splitQuery(q) {
    const m = q.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
  }

  function pickImage(images) {
    if (!Array.isArray(images)) return null;
    for (const size of ['extralarge', 'large', 'medium']) {
      const i = images.find(x => x.size === size);
      if (i && i['#text'] && !i['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) return i['#text'];
    }
    return null;
  }

  function createQueue(opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const lfm = o.lfm;                       // async (params) => Last.fm JSON (throws on error)
    const say = o.say || null;               // (text, replyToMsgId) => void; null = read-only mirror
    const onChange = o.onChange || (() => {});

    let st = { queue: [], users: {}, playingId: null, seq: 0 };
    try { const v = JSON.parse(localStorage.getItem(o.storageKey) || 'null'); if (v && Array.isArray(v.queue)) st = Object.assign(st, v); } catch {}
    let lastQueueReply = 0;
    let chain = Promise.resolve();

    const save = () => { try { localStorage.setItem(o.storageKey, JSON.stringify(st)); } catch {} onChange(api.snapshot()); };
    const reply = (text, msgId) => { if (say) say(text.slice(0, 480), msgId); };
    const label = (r) => `${clip(r.artist)} — ${clip(r.title)}`;

    async function lookup(q) {
      const parts = splitQuery(q);
      if (parts) {
        try {
          const j = await lfm({ method: 'track.getInfo', artist: parts.artist, track: parts.title, autocorrect: '1' });
          if (j.track && j.track.name) {
            return { artist: (j.track.artist && j.track.artist.name) || parts.artist, title: j.track.name,
                     cover: pickImage(j.track.album && j.track.album.image) };
          }
        } catch {}
      }
      try {
        const params = parts ? { method: 'track.search', artist: parts.artist, track: parts.title, limit: '1' }
                             : { method: 'track.search', track: q, limit: '1' };
        const j = await lfm(params);
        let t = j.results && j.results.trackmatches && j.results.trackmatches.track;
        if (Array.isArray(t)) t = t[0];
        if (!t || !t.name) return null;
        if (parts && !sameTrack({ artist: t.artist, title: t.name }, { artist: parts.artist, title: t.name })) return null;
        if (!parts && !(Number(t.listeners) > 0)) return null;
        return { artist: t.artist, title: t.name, cover: pickImage(t.image) };
      } catch { return null; }
    }

    async function onRequest(m, q) {
      const usage = `${o.cmdRequest} Artist - Track (e.g. ${o.cmdRequest} Linkin Park - Numb)`;
      if (!q) return reply(`@${m.nick}, write it like this: ${usage}`, m.msgId);
      const mine = st.queue.filter(r => r.byId === m.userId).length;
      if (mine >= o.maxPerUser) return reply(`@${m.nick}, you already have ${mine} request${mine === 1 ? '' : 's'} in the queue.`, m.msgId);
      const last = (st.users[m.userId] || {}).last || 0;
      if (m.ts - last < o.cooldownMs) return reply(`@${m.nick}, you can request again in ${fmtWait(o.cooldownMs - (m.ts - last))}.`, m.msgId);
      const found = await lookup(q);
      if (!found) return reply(`@${m.nick}, couldn't find that track. Write it like this: ${usage}`, m.msgId);
      if (st.queue.some(r => sameTrack(r, found))) return reply(`@${m.nick}, ${label(found)} is already in the queue.`, m.msgId);
      const r = Object.assign(found, { id: m.msgId || `r${++st.seq}`, by: m.nick, byId: m.userId, at: m.ts });
      st.queue.push(r);
      st.users[m.userId] = { last: m.ts };
      save();
      reply(`🎵 @${m.nick} added ${label(r)} · #${st.queue.length} in queue`, m.msgId);
    }

    function onQueue(m) {
      if (Date.now() - lastQueueReply < o.queueCooldownMs) return;
      lastQueueReply = Date.now();
      const upcoming = api.upcoming();
      if (!upcoming.length) return reply(`Queue is empty. Request a song: ${o.cmdRequest} Artist - Track`, m.msgId);
      const list = upcoming.slice(0, 3).map((r, i) => `${i + 1}. ${label(r)} (@${r.by})`).join(' · ');
      const more = upcoming.length > 3 ? ` · +${upcoming.length - 3}` : '';
      reply(`🎶 Up next: ${list}${more}`, m.msgId);
    }

    function onNext(m) {
      if (!m.isMod) return;
      const idx = st.playingId ? st.queue.findIndex(r => r.id === st.playingId) : 0;
      if (st.queue.length && idx >= 0) st.queue.splice(idx, 1);
      st.playingId = null;
      save();
      const n = st.queue[0];
      reply(n ? `⏭ Next request: ${label(n)} (@${n.by})` : '⏭ No more requests in the queue.', m.msgId);
    }

    function onRemove(m, rest) {
      if (!m.isMod) return;
      const n = parseInt(rest, 10);
      const upcoming = api.upcoming();
      const r = upcoming[n - 1];
      if (!r) return reply(`@${m.nick}, there's no request #${rest || '?'} — check ${o.cmdQueue}.`, m.msgId);
      st.queue = st.queue.filter(x => x.id !== r.id);
      save();
      reply(`🗑 Removed #${n}: ${label(r)} (@${r.by})`, m.msgId);
    }

    function onClear(m) {
      if (!m.isMod) return;
      const n = st.queue.length;
      st.queue = []; st.playingId = null;
      save();
      reply(`🗑 Queue cleared (${n} request${n === 1 ? '' : 's'}).`, m.msgId);
    }

    const api = {
      // m: { text, nick, userId, isMod, ts, msgId }
      handleChat(m) {
        const text = String(m.text || '').trim();
        const cmd = text.split(/\s+/)[0].toLowerCase();
        const rest = text.slice(cmd.length).trim();
        let job = null;
        if (cmd === o.cmdRequest) job = () => onRequest(m, rest);
        else if (cmd === o.cmdQueue) job = () => onQueue(m);
        else if (cmd === o.cmdNext) job = () => onNext(m);
        else if (cmd === o.cmdClear) job = () => onClear(m);
        else if (cmd === o.cmdRemove) job = () => onRemove(m, rest);
        if (!job) return false;
        chain = chain.then(job).catch(e => console.warn('[757 sr]', e));   // strictly in chat order
        return true;
      },

      // np: { artist, title, playing } — what Last.fm says is on right now, or null
      onNowPlaying(np) {
        if (!np || !np.playing) return;              // paused or stopped: keep everything as is
        const match = st.queue.find(r => sameTrack(r, np));
        if (match) {
          if (st.playingId === match.id) return;
          if (st.playingId) st.queue = st.queue.filter(r => r.id !== st.playingId);   // previous request finished
          st.playingId = match.id;
          save();
          reply(`▶ Now playing @${match.by}'s request: ${label(match)}`);
        } else if (st.playingId) {                   // a request was on, now something else is → it's done
          st.queue = st.queue.filter(r => r.id !== st.playingId);
          st.playingId = null;
          save();
        }
      },

      playing() { return st.queue.find(r => r.id === st.playingId) || null; },
      upcoming() { return st.queue.filter(r => r.id !== st.playingId); },
      snapshot() { return { queue: st.queue.slice(), playingId: st.playingId }; },
      reset() { st = { queue: [], users: {}, playingId: null, seq: 0 }; save(); },
    };
    return api;
  }

  // Write-only Twitch chat connection logged in with the streamer's token.
  // Reading is done separately and anonymously, so the reader also sees messages
  // this account sends (Twitch doesn't echo them back to the sending connection).
  function chatWriter({ channel, token, login, onAuthFail }) {
    const chan = String(channel || '').toLowerCase();
    let ws = null, dead = !(chan && token && login), backoff = 1000;
    const connect = () => {
      if (dead) return;
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      ws.onopen = () => {
        backoff = 1000;
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS oauth:' + token);
        ws.send('NICK ' + login);
        ws.send('JOIN #' + chan);
      };
      ws.onmessage = (e) => {
        for (const line of String(e.data).split('\r\n')) {
          if (line.startsWith('PING')) ws.send('PONG :tmi.twitch.tv');
          else if (/NOTICE \* :(Login authentication failed|Improperly formatted auth)/i.test(line)) {
            dead = true; ws.close();
            console.error('[757] Twitch token rejected — chat replies are off.');
            if (onAuthFail) onAuthFail();
          }
        }
      };
      ws.onclose = () => { if (!dead) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); } };
    };
    connect();
    return {
      get ready() { return !dead && ws && ws.readyState === 1; },
      send(text, replyTo) {
        if (dead || !ws || ws.readyState !== 1) return false;
        const clean = String(text).replace(/[\r\n]+/g, ' ');
        ws.send(`${replyTo ? `@reply-parent-msg-id=${replyTo} ` : ''}PRIVMSG #${chan} :${clean}`);
        return true;
      },
    };
  }

  global.SongRequests = { createQueue, sameTrack, norm, chatWriter };
})(window);
