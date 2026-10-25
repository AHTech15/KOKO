// KoKo - Stage 1: demo UI (no Firebase yet)

const colors = ["#22c55e", "#3b82f6", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];

const chats = [
  { id: 1, name: "Rafi", type: "direct", status: "Online", msgs: [
    { from: "in", text: "Hey! Welcome to KoKo 👋", time: "10:02" },
    { from: "out", text: "Thanks! Looks great 😄", time: "10:03" } ] },
  { id: 2, name: "Study Buddies", type: "group", status: "5 members", msgs: [
    { from: "in", text: "Who's ready for tomorrow?", time: "09:15" } ] },
  { id: 3, name: "Nusrat", type: "direct", status: "Last seen today", msgs: [
    { from: "in", text: "Send me the photos later 📸", time: "Yesterday" } ] },
  { id: 4, name: "Family", type: "group", status: "8 members", msgs: [
    { from: "in", text: "Dinner at 8?", time: "Yesterday" } ] }
];

let current = null;
let filter = "all";
let query = "";

const $ = (id) => document.getElementById(id);
const app = $("app");

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h + c.charCodeAt(0)) % colors.length;
  return colors[h];
}

function makeAvatar(chat) {
  const d = document.createElement("div");
  d.className = "avatar";
  d.style.background = colorFor(chat.name);
  d.textContent = chat.type === "group" ? "👥" : chat.name.charAt(0).toUpperCase();
  return d;
}

function renderList() {
  const list = $("chatList");
  list.innerHTML = "";
  chats
    .filter((c) => filter === "all" || c.type === filter)
    .filter((c) => c.name.toLowerCase().includes(query))
    .forEach((chat) => {
      const last = chat.msgs[chat.msgs.length - 1];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "chat-item" + (current && current.id === chat.id ? " active" : "");

      const info = document.createElement("div");
      info.className = "chat-info";
      const top = document.createElement("div");
      top.className = "chat-top";
      const name = document.createElement("strong");
      name.textContent = chat.name;
      const time = document.createElement("small");
      time.textContent = last ? last.time : "";
      top.append(name, time);
      const prev = document.createElement("div");
      prev.className = "preview";
      prev.textContent = last ? last.text : "No messages yet";
      info.append(top, prev);

      btn.append(makeAvatar(chat), info);
      btn.addEventListener("click", () => openChat(chat.id));
      li.append(btn);
      list.append(li);
    });
}

function renderMessages() {
  const box = $("messages");
  box.innerHTML = "";
  current.msgs.forEach((m) => {
    const div = document.createElement("div");
    div.className = "msg " + m.from;
    div.textContent = m.text;
    const t = document.createElement("small");
    t.textContent = m.time;
    div.append(t);
    box.append(div);
  });
  box.scrollTop = box.scrollHeight;
}

function openChat(id) {
  current = chats.find((c) => c.id === id);
  $("empty").hidden = true;
  $("convo").hidden = false;
  $("headName").textContent = current.name;
  $("headStatus").textContent = current.status;
  const holder = $("headAvatar");
  holder.innerHTML = "";
  holder.append(makeAvatar(current));
  renderMessages();
  renderList();
  app.classList.add("chat-open");
}

$("backBtn").addEventListener("click", () => {
  app.classList.remove("chat-open");
  current = null;
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderList();
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("msgInput");
  const text = input.value.trim();
  if (!text || !current) return;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  current.msgs.push({ from: "out", text, time });
  input.value = "";
  renderMessages();
  renderList();
});

$("search").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  renderList();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    filter = tab.dataset.filter;
    renderList();
  });
});

renderList();
