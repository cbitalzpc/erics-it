// Eric's IT live chat widget. Talks to the chat service at chat.erics-it.com.
(function () {
  const API = window.EIT_CHAT_API || "https://chat.erics-it.com";
  const WS = API.replace(/^http/, "ws");

  const css = `
  .eitc-btn{position:fixed;right:20px;bottom:20px;z-index:1000;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;
    background:var(--blue,#1d6fff);color:#fff;box-shadow:0 8px 30px rgba(29,111,255,.45);display:flex;align-items:center;justify-content:center;transition:transform .2s}
  .eitc-btn:hover{transform:translateY(-2px) scale(1.04)}
  .eitc-btn svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .eitc-dot{position:absolute;top:4px;right:4px;width:14px;height:14px;border-radius:50%;background:#f43f5e;border:2px solid var(--navy,#0a0f1e);display:none}
  .eitc-panel{position:fixed;right:20px;bottom:92px;z-index:1000;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));
    background:var(--navy-mid,#111827);color:var(--white,#f0f4ff);border:1px solid var(--card-border,rgba(255,255,255,.08));border-radius:18px;
    box-shadow:0 20px 60px var(--shadow,rgba(0,0,0,.4));display:none;flex-direction:column;overflow:hidden;font-family:'DM Sans',sans-serif}
  .eitc-panel.open{display:flex}
  .eitc-head{padding:14px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--card-border,rgba(255,255,255,.08));
    background:linear-gradient(135deg,rgba(29,111,255,.18),transparent)}
  .eitc-head img{width:34px;height:34px;border-radius:8px}
  .eitc-title{font-family:'Syne',sans-serif;font-weight:800;font-size:.95rem}
  .eitc-sub{font-size:.75rem;color:var(--gray,#8899bb);display:flex;align-items:center;gap:6px}
  .eitc-sub::before{content:'';width:7px;height:7px;border-radius:50%;background:#22c55e}
  .eitc-close{margin-left:auto;background:none;border:none;color:var(--gray,#8899bb);cursor:pointer;font-size:1.4rem;line-height:1;padding:4px}
  .eitc-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .eitc-m{max-width:85%;padding:9px 13px;border-radius:14px;font-size:.88rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
  .eitc-m.visitor{align-self:flex-end;background:var(--blue,#1d6fff);color:#fff;border-bottom-right-radius:4px}
  .eitc-m.bot,.eitc-m.agent{align-self:flex-start;background:var(--card-hover,rgba(255,255,255,.08));border-bottom-left-radius:4px}
  .eitc-m.agent{border:1px solid rgba(29,111,255,.45)}
  .eitc-who{font-size:.7rem;color:var(--gray,#8899bb);margin-bottom:2px}
  .eitc-m.system{align-self:center;background:none;color:var(--gray,#8899bb);font-size:.78rem;text-align:center;padding:2px 8px}
  .eitc-typing{align-self:flex-start;color:var(--gray,#8899bb);font-size:.8rem;display:none}
  .eitc-contact{padding:10px 16px;border-top:1px solid var(--card-border,rgba(255,255,255,.08));display:none;gap:6px;flex-wrap:wrap;font-size:.78rem;color:var(--gray,#8899bb)}
  .eitc-contact input{flex:1 1 120px;min-width:0}
  .eitc-foot{padding:10px 12px;border-top:1px solid var(--card-border,rgba(255,255,255,.08));display:flex;flex-direction:column;gap:8px}
  .eitc-row{display:flex;gap:8px}
  .eitc-panel input,.eitc-panel textarea{background:var(--card-bg,rgba(255,255,255,.04));border:1px solid var(--card-border,rgba(255,255,255,.08));border-radius:10px;
    padding:9px 11px;color:var(--white,#f0f4ff);font:inherit;font-size:.88rem;outline:none}
  .eitc-panel textarea{flex:1;resize:none;height:42px;max-height:110px}
  .eitc-panel input:focus,.eitc-panel textarea:focus{border-color:var(--blue,#1d6fff)}
  .eitc-send{background:var(--blue,#1d6fff);color:#fff;border:none;border-radius:10px;padding:0 14px;cursor:pointer;font-weight:600}
  .eitc-send:disabled{opacity:.5;cursor:default}
  .eitc-human{background:none;border:none;color:var(--blue-bright,#4d9fff);font:inherit;font-size:.78rem;cursor:pointer;text-align:left;padding:0}
  .eitc-note{font-size:.7rem;color:var(--gray,#8899bb)}
  @media (max-width:480px){.eitc-panel{right:8px;left:8px;width:auto;bottom:84px;height:calc(100vh - 100px)}}`;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.innerHTML = `
    <button class="eitc-btn" aria-label="Open live chat" aria-expanded="false">
      <svg viewBox="0 0 24 24"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg><span class="eitc-dot"></span>
    </button>
    <div class="eitc-panel" role="dialog" aria-label="Live chat with Eric's IT">
      <div class="eitc-head">
        <img src="erc.png" alt="">
        <div><div class="eitc-title">Eric's IT Help</div><div class="eitc-sub" id="eitcSub">Ask any IT question</div></div>
        <button class="eitc-close" aria-label="Close chat">×</button>
      </div>
      <div class="eitc-log" aria-live="polite"></div>
      <div class="eitc-contact">
        <span style="flex-basis:100%">In case we get disconnected, how can we reach you? (optional)</span>
        <input id="eitcName" placeholder="Name" autocomplete="name">
        <input id="eitcEmail" type="email" placeholder="Email" autocomplete="email">
        <button class="eitc-send" id="eitcSave" style="padding:8px 12px">Save</button>
      </div>
      <div class="eitc-foot">
        <div class="eitc-row">
          <textarea id="eitcInput" placeholder="Type your question…" rows="1" maxlength="2000"></textarea>
          <button class="eitc-send" id="eitcSendBtn" aria-label="Send">Send</button>
        </div>
        <button class="eitc-human" id="eitcHuman">Talk to a person →</button>
        <div class="eitc-note">AI answers can be wrong. Don't share passwords or payment details in chat.</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const btn = $(".eitc-btn"), panel = $(".eitc-panel"), log = $(".eitc-log"), input = $("#eitcInput"),
        sendBtn = $("#eitcSendBtn"), dot = $(".eitc-dot"), sub = $("#eitcSub"), human = $("#eitcHuman"), contact = $(".eitc-contact");

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let cid = store.get("eitc_cid");
  if (!cid || !/^[a-f0-9-]{36}$/.test(cid)) { cid = crypto.randomUUID(); store.set("eitc_cid", cid); }

  let ws = null, open = false, status = "bot", retry = 0, seen = new Set(), queue = [];
  const typing = document.createElement("div");
  typing.className = "eitc-typing";
  typing.textContent = "Typing…";

  function render(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const d = document.createElement("div");
    d.className = "eitc-m " + m.sender;
    if (m.sender === "agent") {
      const w = document.createElement("div"); w.className = "eitc-who"; w.textContent = "Eric · Eric's IT"; d.appendChild(w);
    }
    d.appendChild(document.createTextNode(m.text));
    typing.style.display = "none";
    log.insertBefore(d, typing);
    log.scrollTop = log.scrollHeight;
    if (!open && m.sender !== "visitor") dot.style.display = "block";
  }

  function setStatus(s) {
    status = s;
    sub.textContent = s === "agent" ? "Chatting with Eric" : s === "waiting" ? "Waiting for a technician…" : "Ask any IT question";
    human.style.display = s === "bot" || s === "closed" ? "block" : "none";
    if (s === "waiting" && !store.get("eitc_contact")) contact.style.display = "flex";
  }

  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(`${WS}/ws?role=visitor&cid=${cid}&page=${encodeURIComponent(location.pathname)}`);
    ws.onopen = () => { retry = 0; while (queue.length) ws.send(queue.shift()); };
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === "history") {
        if (!d.messages.length && !seen.size) render({ id: "welcome", sender: "bot", text: "Hi! I'm the Eric's IT assistant. Ask me any IT question, or tap “Talk to a person” to reach a technician." });
        d.messages.forEach(render); setStatus(d.status);
      } else if (d.type === "msg") render(d.message);
      else if (d.type === "status") setStatus(d.status);
      else if (d.type === "typing") { typing.style.display = "block"; log.scrollTop = log.scrollHeight; }
    };
    ws.onclose = () => { if (open || status !== "bot") setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
  }

  function send(obj) {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1) ws.send(s); else { queue.push(s); connect(); }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    send({ type: "msg", text });
    store.set("eitc_active", "1");
    input.value = "";
    input.style.height = "";
  }

  function toggle(force) {
    open = force ?? !open;
    panel.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { dot.style.display = "none"; connect(); setTimeout(() => input.focus(), 50); log.scrollTop = log.scrollHeight; }
  }

  btn.addEventListener("click", () => toggle());
  $(".eitc-close").addEventListener("click", () => toggle(false));
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener("input", () => { input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
  human.addEventListener("click", () => send({ type: "human" }));
  $("#eitcSave").addEventListener("click", () => {
    send({ type: "contact", name: $("#eitcName").value, email: $("#eitcEmail").value });
    store.set("eitc_contact", "1");
    contact.style.display = "none";
  });
  log.appendChild(typing);

  // Reconnect in the background for visitors who have chatted before, so a technician's reply still reaches them.
  if (store.get("eitc_active")) setTimeout(connect, 1500);
  window.EITChat = { open: () => toggle(true) };
})();
