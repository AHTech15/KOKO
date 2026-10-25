import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const palette = ["#22c55e", "#3b82f6", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];
const appEl = $("app");

const users = new Map();   // uid -> { displayName, bio }
let unsubChats = null;
let unsubMsgs = null;
let chats = [];            // { id, otherUid, lastMessage, lastMessageAt, lastSenderId }
let current = null;        // { id, otherUid }
let filter = "all";
let term = "";

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h + c.charCodeAt(0)) % palette.length;
  return palette[h];
}

function makeAvatar(name) {
  const d = document.createElement("div");
  d.className = "avatar";
  d.style.background = colorFor(name);
  d.textContent = name.charAt(0).toUpperCase();
  return d;
}

function formatTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function getUser(uid) {
  if (users.has(uid)) return users.get(uid);
  let info = { displayName: "Unknown user", bio: "" };
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data();
      info = { displayName: d.displayName, bio: d.bio || "" };
    }
  } catch (err) {
    console.error(err);
  }
  users.set(uid, info);
  return info;
}

/* ---------- Chat list ---------- */
function note(text) {
  const li = document.createElement("li");
  li.className = "empty-note";
  li.textContent = text;
  return li;
}

function renderList() {
  const list = $("chatList");
  list.innerHTML = "";

  if (filter === "group") {
    list.append(note("Group chats arrive in Stage 6."));
    return;
  }

  const shown = chats.filter((c) => {
    if (!c.lastMessage) return false;
    const name = (users.get(c.otherUid) || { displayName: "" }).displayName.toLowerCase();
    return name.includes(term);
  });

  if (shown.length === 0) {
    list.append(note(chats.some((c) => c.lastMessage)
      ? "No matching chats."
      : "No chats yet. Open People and tap someone to say hi."));
    return;
  }

  shown.forEach((c) => {
    const u = users.get(c.otherUid) || { displayName: "Unknown user" };
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chat-item" + (current && current.id === c.id ? " active" : "");

    const info = document.createElement("div");
    info.className = "chat-info";
    const top = document.createElement("div");
    top.className = "chat-top";
    const name = document.createElement("strong");
    name.textContent = u.displayName;
    const time = document.createElement("small");
    time.textContent = formatTime(c.lastMessageAt);
    top.append(name, time);
    const prev = document.createElement("div");
    prev.className = "preview";
    const mine = c.lastSenderId === auth.currentUser.uid;
    prev.textContent = (mine ? "You: " : "") + c.lastMessage;
    info.append(top, prev);

    btn.append(makeAvatar(u.displayName), info);
    btn.addEventListener("click", () => openConversation(c.id, c.otherUid));
    li.append(btn);
    list.append(li);
  });
}

function startChats(user) {
  const q = query(collection(db, "chats"), where("members", "array-contains", user.uid));
  unsubChats = onSnapshot(q, async (snap) => {
    const list = [];
    snap.forEach((d) => {
      const data = d.data();
      const otherUid = data.members.find((m) => m !== user.uid);
      list.push({
        id: d.id,
        otherUid,
        lastMessage: data.lastMessage || "",
        lastMessageAt: data.lastMessageAt ? data.lastMessageAt.toMillis() : Date.now(),
        lastSenderId: data.lastSenderId || ""
      });
    });
    await Promise.all(list.map((c) => getUser(c.otherUid)));
    chats = list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    renderList();
  }, (err) => {
    console.error(err);
    const l = $("chatList");
    l.innerHTML = "";
    l.append(note("Could not load chats. Check your Firestore rules."));
  });
}

function stopChats() {
  if (unsubChats) unsubChats();
  if (unsubMsgs) unsubMsgs();
  unsubChats = unsubMsgs = null;
  chats = [];
  current = null;
  users.clear();
  $("chatList").innerHTML = "";
  $("messages").innerHTML = "";
  $("convo").hidden = true;
  $("empty").hidden = false;
  appEl.classList.remove("chat-open");
}

/* ---------- Open a conversation ---------- */
async function openChatWith(otherUid) {
  const me = auth.currentUser.uid;
  const [a, b] = [me, otherUid].sort();
  const id = a + "_" + b;
  const ref = doc(db, "chats", id);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        type: "direct",
        members: [a, b],
        createdAt: serverTimestamp(),
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
        lastSenderId: ""
      });
    }
    openConversation(id, otherUid);
  } catch (err) {
    console.error(err);
    alert("Could not open this chat. Please try again.");
  }
}

async function openConversation(id, otherUid) {
  if (unsubMsgs) unsubMsgs();
  current = { id, otherUid };
  const u = await getUser(otherUid);

  $("empty").hidden = true;
  $("convo").hidden = false;
  $("headName").textContent = u.displayName;
  $("headStatus").textContent = u.bio;
  const holder = $("headAvatar");
  holder.innerHTML = "";
  holder.append(makeAvatar(u.displayName));
  $("messages").innerHTML = "";
  appEl.classList.add("chat-open");
  renderList();

  const q = query(
    collection(db, "chats", id, "messages"),
    orderBy("createdAt", "desc"),
    limit(100)
  );
  unsubMsgs = onSnapshot(q, (snap) => {
    const items = [];
    snap.forEach((d) => {
      const m = d.data({ serverTimestamps: "estimate" });
      items.push({
        text: m.text,
        mine: m.senderId === auth.currentUser.uid,
        time: m.createdAt ? m.createdAt.toMillis() : Date.now()
      });
    });
    items.reverse();
    renderMessages(items);
  }, (err) => {
    console.error(err);
    $("messages").textContent = "Could not load messages.";
  });
}

function renderMessages(items) {
  const box = $("messages");
  box.innerHTML = "";
  items.forEach((m) => {
    const div = document.createElement("div");
    div.className = "msg " + (m.mine ? "out" : "in");
    div.textContent = m.text;
    const t = document.createElement("small");
    t.textContent = formatTime(m.time);
    div.append(t);
    box.append(div);
  });
  box.scrollTop = box.scrollHeight;
}

/* ---------- Sending ---------- */
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("msgInput");
  const text = input.value.trim().slice(0, 1000);
  if (!text || !current) return;
  input.value = "";
  const uid = auth.currentUser.uid;
  const batch = writeBatch(db);
  batch.set(doc(collection(db, "chats", current.id, "messages")), {
    senderId: uid,
    text,
    createdAt: serverTimestamp()
  });
  batch.update(doc(db, "chats", current.id), {
    lastMessage: text.slice(0, 100),
    lastMessageAt: serverTimestamp(),
    lastSenderId: uid
  });
  try {
    await batch.commit();
  } catch (err) {
    console.error(err);
    input.value = text;
    alert("Message not sent. Please try again.");
  }
});

/* ---------- Navigation and events ---------- */
$("backBtn").addEventListener("click", () => {
  if (unsubMsgs) unsubMsgs();
  unsubMsgs = null;
  current = null;
  appEl.classList.remove("chat-open");
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderList();
});

document.addEventListener("koko:message", (e) => {
  $("personModal").hidden = true;
  openChatWith(e.detail.uid);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.filter !== "people") {
      filter = tab.dataset.filter;
      renderList();
    }
  });
});

$("search").addEventListener("input", (e) => {
  term = e.target.value.trim().toLowerCase();
  if (!$("chatList").hidden) renderList();
});

onAuthStateChanged(auth, (user) => {
  if (user) startChats(user);
  else stopChats();
});
