import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const palette = ["#22c55e", "#3b82f6", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];
const appEl = $("app");

/* Extra styles for ticks, unread dots and the alerts button */
const cssLink = document.createElement("link");
cssLink.rel = "stylesheet";
cssLink.href = "chat.css";
document.head.append(cssLink);

/* Service worker (needed so Android can show notifications) */
let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});
}

const users = new Map();       // uid -> { displayName, bio }
const myReads = new Map();     // chatId -> when I last read it (ms)
const readUnsubs = new Map();  // chatId -> unsubscribe function
let unsubChats = null;
let unsubMsgs = null;
let unsubOtherRead = null;
let chats = [];                // { id, otherUid, lastMessage, lastMessageAt, lastSenderId }
let current = null;            // { id, otherUid }
let filter = "all";
let term = "";
let firstSnapshot = true;
let otherReadAt = 0;
let lastItems = [];
let lastMarkedIncoming = 0;

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

/* ---------- Alerts: sound, title count, notification ---------- */
const notifyBtn = document.createElement("button");
notifyBtn.type = "button";
notifyBtn.className = "notify-btn";
$("userLine").after(notifyBtn);

function updateNotifyBtn() {
  if (!("Notification" in window)) {
    notifyBtn.hidden = true;
    return;
  }
  if (Notification.permission === "granted") {
    notifyBtn.textContent = "🔔 Alerts are on";
    notifyBtn.disabled = true;
  } else if (Notification.permission === "denied") {
    notifyBtn.textContent = "🔕 Alerts blocked in browser settings";
    notifyBtn.disabled = true;
  } else {
    notifyBtn.textContent = "🔔 Turn on alerts";
    notifyBtn.disabled = false;
  }
}
notifyBtn.addEventListener("click", async () => {
  try {
    await Notification.requestPermission();
  } catch (e) { /* ignore */ }
  updateNotifyBtn();
});
updateNotifyBtn();

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
  } catch (e) { /* ignore */ }
}

function isUnread(c) {
  const me = auth.currentUser && auth.currentUser.uid;
  if (!c.lastMessage || !c.lastSenderId || c.lastSenderId === me) return false;
  if (current && current.id === c.id && !document.hidden) return false;
  return c.lastMessageAt > (myReads.get(c.id) || 0);
}

function updateTitle() {
  const n = chats.filter(isUnread).length;
  document.title = n > 0 ? "(" + n + ") KoKo" : "KoKo";
}

async function alertNew(n) {
  if (current && current.id === n.id && !document.hidden) return;
  beep();
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    const u = await getUser(n.otherUid);
    const body = n.text.slice(0, 100);
    try {
      if (swReg && swReg.showNotification) {
        swReg.showNotification(u.displayName, { body, tag: n.id });
      } else {
        new Notification(u.displayName, { body, tag: n.id });
      }
    } catch (e) { /* ignore */ }
  }
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
    const unread = isUnread(c);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chat-item" + (current && current.id === c.id ? " active" : "") + (unread ? " unread" : "");

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
    if (unread) {
      const dot = document.createElement("span");
      dot.className = "dot";
      btn.append(dot);
    }
    btn.addEventListener("click", () => openConversation(c.id, c.otherUid));
    li.append(btn);
    list.append(li);
  });
}

/* Watch when I last read each chat (for unread dots) */
function watchReads(uid, list) {
  list.slice(0, 30).forEach((c) => {
    if (readUnsubs.has(c.id)) return;
    const unsub = onSnapshot(doc(db, "chats", c.id, "reads", uid), (snap) => {
      let ms = 0;
      if (snap.exists()) {
        const ra = snap.data({ serverTimestamps: "estimate" }).readAt;
        ms = ra ? ra.toMillis() : Date.now();
      }
      myReads.set(c.id, ms);
      renderList();
      updateTitle();
    }, () => {});
    readUnsubs.set(c.id, unsub);
  });
}

function startChats(user) {
  firstSnapshot = true;
  const q = query(collection(db, "chats"), where("members", "array-contains", user.uid));
  unsubChats = onSnapshot(q, async (snap) => {
    const list = [];
    const toAlert = [];
    snap.forEach((d) => {
      const data = d.data({ serverTimestamps: "estimate" });
      const otherUid = data.members.find((m) => m !== user.uid);
      list.push({
        id: d.id,
        otherUid,
        lastMessage: data.lastMessage || "",
        lastMessageAt: data.lastMessageAt ? data.lastMessageAt.toMillis() : Date.now(),
        lastSenderId: data.lastSenderId || ""
      });
    });
    if (!firstSnapshot) {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== "added" && ch.type !== "modified") return;
        const d = ch.doc.data({ serverTimestamps: "estimate" });
        if (d.lastMessage && d.lastSenderId && d.lastSenderId !== user.uid) {
          toAlert.push({
            id: ch.doc.id,
            otherUid: d.members.find((m) => m !== user.uid),
            text: d.lastMessage
          });
        }
      });
    }
    firstSnapshot = false;
    await Promise.all(list.map((c) => getUser(c.otherUid)));
    chats = list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    watchReads(user.uid, chats);
    renderList();
    updateTitle();
    toAlert.forEach(alertNew);
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
  if (unsubOtherRead) unsubOtherRead();
  readUnsubs.forEach((u) => u());
  readUnsubs.clear();
  myReads.clear();
  unsubChats = unsubMsgs = unsubOtherRead = null;
  chats = [];
  current = null;
  lastItems = [];
  otherReadAt = 0;
  lastMarkedIncoming = 0;
  firstSnapshot = true;
  users.clear();
  $("chatList").innerHTML = "";
  $("messages").innerHTML = "";
  $("convo").hidden = true;
  $("empty").hidden = false;
  appEl.classList.remove("chat-open");
  document.title = "KoKo";
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

/* Tell the other person I have read this chat */
function markRead(force) {
  if (!current || document.hidden) return;
  const latest = lastItems.length ? lastItems[lastItems.length - 1] : null;
  const incomingTime = latest && !latest.mine ? latest.time : 0;
  if (!force && incomingTime <= lastMarkedIncoming) return;
  lastMarkedIncoming = incomingTime || lastMarkedIncoming;
  setDoc(doc(db, "chats", current.id, "reads", auth.currentUser.uid), {
    readAt: serverTimestamp()
  }).catch((err) => console.error(err));
}

async function openConversation(id, otherUid) {
  if (unsubMsgs) unsubMsgs();
  if (unsubOtherRead) unsubOtherRead();
  current = { id, otherUid };
  lastItems = [];
  otherReadAt = 0;
  lastMarkedIncoming = 0;
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
  updateTitle();
  markRead(true);

  unsubOtherRead = onSnapshot(doc(db, "chats", id, "reads", otherUid), (snap) => {
    let ms = 0;
    if (snap.exists()) {
      const ra = snap.data({ serverTimestamps: "estimate" }).readAt;
      ms = ra ? ra.toMillis() : 0;
    }
    otherReadAt = ms;
    renderMessages(lastItems);
  }, () => {});

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
        time: m.createdAt ? m.createdAt.toMillis() : Date.now(),
        pending: d.metadata.hasPendingWrites
      });
    });
    items.reverse();
    lastItems = items;
    renderMessages(items);
    markRead(false);
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
    if (m.mine) {
      const tick = document.createElement("span");
      tick.className = "tick";
      if (m.pending) {
        tick.textContent = "🕓";
      } else if (m.time <= otherReadAt) {
        tick.textContent = "✓✓";
        tick.classList.add("read");
      } else {
        tick.textContent = "✓";
      }
      t.append(tick);
    }
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
  if (unsubOtherRead) unsubOtherRead();
  unsubMsgs = unsubOtherRead = null;
  current = null;
  lastItems = [];
  appEl.classList.remove("chat-open");
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderList();
  updateTitle();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current) {
    markRead(true);
    renderList();
    updateTitle();
  }
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
