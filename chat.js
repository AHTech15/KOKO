import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove,
  collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { makeAvatar, colorFor } from "./avatar.js";

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const MAX_MEMBERS = 50;

/* Extra styles */
for (const href of ["chat.css", "group.css", "requests.css"]) {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.append(l);
}

/* Service worker (lets Android show notifications) */
let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});
}

/* A "Requests" tab, placed after "Chats" */
const reqTab = document.createElement("button");
reqTab.className = "tab";
reqTab.dataset.filter = "requests";
reqTab.textContent = "Requests";
document.querySelector('.tab[data-filter="direct"]').after(reqTab);

/* Banner above the message box (request buttons, blocked notice...) */
const banner = document.createElement("div");
banner.className = "banner";
banner.hidden = true;
$("composer").before(banner);

const users = new Map();       // uid -> { displayName, bio, photo, emoji, color }
const myReads = new Map();     // chatId -> when I last read it (ms)
const readUnsubs = new Map();  // chatId -> unsubscribe function
let blocked = new Set();       // uids I have blocked
let unsubChats = null;
let unsubMsgs = null;
let unsubOtherRead = null;
let unsubBlocks = null;
let chats = [];
let current = null;            // { id, type, otherUid, name, count, seen, hint }
let filter = "all";
let term = "";
let firstSnapshot = true;
let otherReadAt = 0;
let rawItems = [];             // real messages of the open chat
let lastItems = [];            // what is shown (includes the request message)
let lastMarkedIncoming = 0;
let infoRefresh = null;

const myUid = () => auth.currentUser.uid;

const optsOf = (u) => ({
  photo: (u && u.photo) || "",
  emoji: (u && u.emoji) || "",
  color: (u && u.color) || ""
});

function userFromDoc(d) {
  return {
    displayName: d.displayName,
    bio: d.bio || "",
    photo: d.photo || "",
    emoji: d.avatarEmoji || "",
    color: d.avatarColor || ""
  };
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
  let info = { displayName: "Unknown user", bio: "", photo: "", emoji: "", color: "" };
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) info = userFromDoc(snap.data());
  } catch (err) {
    console.error(err);
  }
  users.set(uid, info);
  return info;
}

async function loadAllPeople() {
  const snap = await getDocs(query(collection(db, "users"), orderBy("displayNameLower"), limit(50)));
  const arr = [];
  snap.forEach((d) => {
    const info = userFromDoc(d.data());
    users.set(d.id, info);
    arr.push({ uid: d.id, ...info });
  });
  return arr;
}

/* ---------- Request helpers ---------- */
const isIncoming = (c) => c.type === "direct" && c.status === "pending" && c.requester !== myUid();
const isMyRequest = (c) => c.type === "direct" && c.status !== "active" && c.requester === myUid();

/* Does this chat belong in the normal Chats list? */
function listable(c) {
  if (c.type === "group") return true;
  if (blocked.has(c.otherUid)) return false;
  if (c.status === "active") return !!c.lastMessage;
  return c.requester === myUid();   // my own sent requests (pending or declined)
}

function chatOf() {
  if (!current) return null;
  return chats.find((x) => x.id === current.id) || current.hint || null;
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
  try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
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
  if (!c.lastMessage || !c.lastSenderId || c.lastSenderId === myUid()) return false;
  if (current && current.id === c.id && !document.hidden) return false;
  return c.lastMessageAt > (myReads.get(c.id) || 0);
}

function updateTitle() {
  const reqCount = chats.filter((c) => isIncoming(c) && !blocked.has(c.otherUid)).length;
  const n = chats.filter((c) => listable(c) && isUnread(c)).length + reqCount;
  reqTab.textContent = reqCount ? "Requests (" + reqCount + ")" : "Requests";
  document.title = n > 0 ? "(" + n + ") KoKo" : "KoKo";
}

async function alertNew(n) {
  if (current && current.id === n.id && !document.hidden) return;
  beep();
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    const sender = await getUser(n.senderUid);
    const text = n.text.slice(0, 100);
    let title;
    let body;
    if (n.kind === "request") {
      title = "New chat request";
      body = sender.displayName + ": " + text;
    } else if (n.type === "group") {
      title = n.name;
      body = sender.displayName + ": " + text;
    } else {
      title = sender.displayName;
      body = text;
    }
    try {
      if (swReg && swReg.showNotification) {
        swReg.showNotification(title, { body, tag: n.id });
      } else {
        new Notification(title, { body, tag: n.id });
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

function chatTitle(c) {
  if (c.type === "group") return c.name;
  return (users.get(c.otherUid) || { displayName: "Unknown user" }).displayName;
}

function chatAvatar(c) {
  if (c.type === "group") return makeAvatar(c.name, { group: true });
  return makeAvatar(chatTitle(c), optsOf(users.get(c.otherUid)));
}

function previewText(c) {
  if (c.type === "direct") {
    if (isIncoming(c)) return c.requestText;
    if (isMyRequest(c)) return "⏳ Request sent";
  }
  if (!c.lastMessage) return "No messages yet";
  const mine = c.lastSenderId === myUid();
  if (c.type === "group") {
    const who = mine
      ? "You"
      : ((users.get(c.lastSenderId) || {}).displayName || "Someone").split(" ")[0];
    return who + ": " + c.lastMessage;
  }
  return (mine ? "You: " : "") + c.lastMessage;
}

function renderList() {
  const list = $("chatList");
  list.innerHTML = "";

  let shown;
  if (filter === "requests") {
    shown = chats.filter((c) => isIncoming(c) && !blocked.has(c.otherUid));
  } else {
    shown = chats.filter((c) => {
      if (!listable(c)) return false;
      if (filter === "direct" && c.type !== "direct") return false;
      if (filter === "group" && c.type !== "group") return false;
      return true;
    });
  }
  shown = shown.filter((c) => chatTitle(c).toLowerCase().includes(term));

  if (shown.length === 0) {
    if (filter === "requests") list.append(note("No chat requests."));
    else if (filter === "group") list.append(note("No groups yet. Tap + New group to start one."));
    else if (term) list.append(note("No matching chats."));
    else list.append(note("No chats yet. Open People and tap someone to say hi."));
    return;
  }

  shown.forEach((c) => {
    const title = chatTitle(c);
    const unread = filter !== "requests" && isUnread(c);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chat-item" + (current && current.id === c.id ? " active" : "") + (unread ? " unread" : "");

    const info = document.createElement("div");
    info.className = "chat-info";
    const top = document.createElement("div");
    top.className = "chat-top";
    const name = document.createElement("strong");
    name.textContent = title;
    const time = document.createElement("small");
    if (filter === "requests") time.textContent = formatTime(c.createdAt);
    else time.textContent = c.lastMessage ? formatTime(c.lastMessageAt) : "";
    top.append(name, time);
    const prev = document.createElement("div");
    prev.className = "preview";
    prev.textContent = previewText(c);
    info.append(top, prev);

    btn.append(chatAvatar(c), info);
    if (unread) {
      const dot = document.createElement("span");
      dot.className = "dot";
      btn.append(dot);
    }
    btn.addEventListener("click", () => openConversation(c.id));
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

  unsubBlocks = onSnapshot(collection(db, "users", user.uid, "blocks"), (snap) => {
    blocked = new Set(snap.docs.map((d) => d.id));
    renderList();
    updateTitle();
    applyMode();
  }, () => {});

  const q = query(collection(db, "chats"), where("members", "array-contains", user.uid));
  unsubChats = onSnapshot(q, async (snap) => {
    const prevChats = chats;
    const list = [];
    const toAlert = [];
    snap.forEach((d) => {
      const data = d.data({ serverTimestamps: "estimate" });
      const type = data.type === "group" ? "group" : "direct";
      list.push({
        id: d.id,
        type,
        name: data.name || "",
        members: data.members || [],
        admins: data.admins || [],
        otherUid: type === "direct" ? data.members.find((m) => m !== user.uid) : null,
        status: data.status || "active",
        requester: data.requester || "",
        requestText: data.requestText || "",
        createdAt: data.createdAt ? data.createdAt.toMillis() : Date.now(),
        lastMessage: data.lastMessage || "",
        lastMessageAt: data.lastMessageAt ? data.lastMessageAt.toMillis() : Date.now(),
        lastSenderId: data.lastSenderId || ""
      });
    });

    if (!firstSnapshot) {
      list.forEach((c) => {
        const before = prevChats.find((p) => p.id === c.id);
        if (isIncoming(c)) {
          if (!before) {
            toAlert.push({ kind: "request", id: c.id, senderUid: c.requester, text: c.requestText });
          }
          return;
        }
        if (!c.lastMessage || !c.lastSenderId || c.lastSenderId === user.uid) return;
        if (before && before.status === "pending" && c.status === "active") return;
        const isNew = before ? c.lastMessageAt > before.lastMessageAt : c.type === "direct";
        if (isNew) {
          toAlert.push({ id: c.id, type: c.type, name: c.name, senderUid: c.lastSenderId, text: c.lastMessage });
        }
      });
    }
    firstSnapshot = false;

    const needed = new Set();
    list.forEach((c) => {
      if (c.otherUid) needed.add(c.otherUid);
      if (c.type === "group" && c.lastSenderId) needed.add(c.lastSenderId);
    });
    await Promise.all([...needed].map(getUser));

    chats = list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    watchReads(user.uid, chats);

    if (current) {
      const stillThere = chats.some((c) => c.id === current.id);
      if (!stillThere && current.type === "group" && current.seen) {
        backToList();
      } else {
        refreshHeader();
        applyMode();
        redrawMessages();
      }
    }
    if (infoRefresh) infoRefresh(false);
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
  if (unsubBlocks) unsubBlocks();
  readUnsubs.forEach((u) => u());
  readUnsubs.clear();
  myReads.clear();
  unsubChats = unsubMsgs = unsubOtherRead = unsubBlocks = null;
  blocked = new Set();
  chats = [];
  current = null;
  rawItems = [];
  lastItems = [];
  otherReadAt = 0;
  lastMarkedIncoming = 0;
  firstSnapshot = true;
  infoRefresh = null;
  users.clear();
  $("chatList").innerHTML = "";
  $("messages").innerHTML = "";
  $("convo").hidden = true;
  $("empty").hidden = false;
  banner.hidden = true;
  $("composer").hidden = false;
  appEl.classList.remove("chat-open");
  document.title = "KoKo";
}

/* ---------- Open a conversation ---------- */
function askRequest(name) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal("Message " + name, () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    });
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const hint = document.createElement("small");
    hint.className = "hint";
    hint.textContent = "They will see this and can accept or decline. Until they accept, you can send only this one message (up to 100 characters).";
    const ta = document.createElement("textarea");
    ta.className = "req-text";
    ta.rows = 3;
    ta.maxLength = 100;
    ta.placeholder = "Hi! I'd like to chat.";
    const err = document.createElement("p");
    err.className = "auth-error";
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    actions.append(
      makeButton("Cancel", "btn-ghost", () => finish(null)),
      makeButton("Send request", "auth-submit", () => {
        const text = ta.value.trim();
        if (text.length < 1 || text.length > 100) {
          err.textContent = "Write a message of 1 to 100 characters.";
          return;
        }
        finish(text);
      })
    );
    m.body.append(hint, ta, err, actions);
  });
}

async function openChatWith(otherUid) {
  const me = myUid();
  if (blocked.has(otherUid)) {
    if (!confirm("You blocked this person. Unblock them to message?")) return;
    try {
      await unblockUser(otherUid);
    } catch (err) {
      console.error(err);
      alert("Could not unblock. Please try again.");
      return;
    }
  }
  const [a, b] = [me, otherUid].sort();
  const id = a + "_" + b;
  const ref = doc(db, "chats", id);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      openConversation(id, { type: "direct", otherUid });
      return;
    }
    const u = await getUser(otherUid);
    const text = await askRequest(u.displayName);
    if (text === null) return;
    await setDoc(ref, {
      type: "direct",
      members: [a, b],
      status: "pending",
      requester: me,
      requestText: text,
      createdAt: serverTimestamp(),
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
      lastSenderId: ""
    });
    openConversation(id, {
      type: "direct",
      otherUid,
      status: "pending",
      requester: me,
      requestText: text,
      createdAt: Date.now()
    });
  } catch (err) {
    console.error(err);
    alert("Could not open this chat. Please try again.");
  }
}

/* Tell the others I have read this chat */
function markRead(force) {
  if (!current || document.hidden) return;
  const latest = lastItems.length ? lastItems[lastItems.length - 1] : null;
  const incomingTime = latest && !latest.mine ? latest.time : 0;
  if (!force && incomingTime <= lastMarkedIncoming) return;
  lastMarkedIncoming = incomingTime || lastMarkedIncoming;
  setDoc(doc(db, "chats", current.id, "reads", myUid()), {
    readAt: serverTimestamp()
  }).catch((err) => console.error(err));
}

function refreshHeader() {
  if (!current) return;
  const holder = $("headAvatar");
  holder.innerHTML = "";
  if (current.type === "group") {
    const c = chats.find((x) => x.id === current.id);
    if (c) {
      current.name = c.name;
      current.count = c.members.length;
      current.seen = true;
    }
    $("headName").textContent = current.name;
    $("headStatus").textContent = current.count + " members · tap for info";
    holder.append(makeAvatar(current.name, { group: true }));
  } else {
    const u = users.get(current.otherUid) || { displayName: "Unknown user", bio: "" };
    $("headName").textContent = u.displayName;
    $("headStatus").textContent = u.bio;
    holder.append(makeAvatar(u.displayName, optsOf(u)));
  }
}

/* Show request buttons / blocked notice instead of the message box when needed */
function applyMode() {
  banner.innerHTML = "";
  banner.hidden = true;
  $("composer").hidden = false;
  if (!current || current.type !== "direct") return;
  const c = chatOf();
  if (!c) return;
  const other = current.otherUid;
  const name = (users.get(other) || { displayName: "this person" }).displayName;
  const text = document.createElement("p");
  const actions = document.createElement("div");
  actions.className = "banner-actions";

  if (blocked.has(other)) {
    text.textContent = "You blocked " + name + ".";
    actions.append(makeButton("Unblock", "", (b) => act(b, () => unblockUser(other))));
  } else if (isIncoming(c)) {
    text.textContent = name + " wants to chat with you.";
    actions.append(
      makeButton("Accept", "accept", (b) => act(b, () => acceptRequest(c))),
      makeButton("Decline", "", (b) => act(b, () => declineRequest(c))),
      makeButton("Block", "danger", (b) => act(b, async () => {
        if (!confirm("Block " + name + "? They won't be told.")) return;
        await blockUser(other, c);
      }))
    );
  } else if (c.status !== "active") {
    text.textContent = "Waiting for " + name + " to accept your request. You can message once they accept.";
  } else {
    return;
  }
  banner.append(text);
  if (actions.childNodes.length) banner.append(actions);
  banner.hidden = false;
  $("composer").hidden = true;
}

async function acceptRequest(c) {
  await updateDoc(doc(db, "chats", c.id), {
    status: "active",
    lastMessage: c.requestText,
    lastMessageAt: serverTimestamp(),
    lastSenderId: c.requester
  });
}

async function declineRequest(c) {
  await updateDoc(doc(db, "chats", c.id), { status: "declined" });
  backToList();
}

async function blockUser(uid, c) {
  await setDoc(doc(db, "users", myUid(), "blocks", uid), { createdAt: serverTimestamp() });
  if (c && isIncoming(c)) {
    try {
      await updateDoc(doc(db, "chats", c.id), { status: "declined" });
    } catch (e) { console.error(e); }
  }
  if (current && current.otherUid === uid) backToList();
}

async function unblockUser(uid) {
  await deleteDoc(doc(db, "users", myUid(), "blocks", uid));
}

/* The request message is shown as the first bubble of the chat */
function redrawMessages() {
  if (!current) return;
  const items = rawItems.slice();
  const c = chatOf();
  if (current.type === "direct" && c && c.requestText) {
    items.unshift({
      text: c.requestText,
      senderId: c.requester,
      mine: c.requester === myUid(),
      time: c.createdAt,
      pending: false
    });
  }
  lastItems = items;
  renderMessages(items);
}

async function openConversation(id, hint) {
  if (unsubMsgs) unsubMsgs();
  if (unsubOtherRead) unsubOtherRead();
  unsubMsgs = unsubOtherRead = null;

  const found = chats.find((x) => x.id === id);
  const c = found || hint;
  current = {
    id,
    type: c.type,
    otherUid: c.otherUid || null,
    name: c.name || "",
    count: (c.members || []).length,
    seen: !!found,
    hint: found ? null : { ...hint, id, members: [], lastMessage: "", lastSenderId: "" }
  };
  rawItems = [];
  lastItems = [];
  otherReadAt = 0;
  lastMarkedIncoming = 0;
  if (current.type === "direct") await getUser(current.otherUid);

  $("empty").hidden = true;
  $("convo").hidden = false;
  $("messages").innerHTML = "";
  appEl.classList.add("chat-open");
  refreshHeader();
  applyMode();
  redrawMessages();
  renderList();
  updateTitle();
  markRead(true);

  if (current.type === "direct") {
    unsubOtherRead = onSnapshot(doc(db, "chats", id, "reads", current.otherUid), (snap) => {
      let ms = 0;
      if (snap.exists()) {
        const ra = snap.data({ serverTimestamps: "estimate" }).readAt;
        ms = ra ? ra.toMillis() : 0;
      }
      otherReadAt = ms;
      renderMessages(lastItems);
    }, () => {});
  }

  const q = query(
    collection(db, "chats", id, "messages"),
    orderBy("createdAt", "desc"),
    limit(100)
  );
  unsubMsgs = onSnapshot(q, async (snap) => {
    const items = [];
    snap.forEach((d) => {
      const m = d.data({ serverTimestamps: "estimate" });
      items.push({
        text: m.text,
        senderId: m.senderId,
        mine: m.senderId === myUid(),
        time: m.createdAt ? m.createdAt.toMillis() : Date.now(),
        pending: d.metadata.hasPendingWrites
      });
    });
    items.reverse();
    if (current && current.id === id && current.type === "group") {
      const senders = new Set(items.filter((i) => !i.mine).map((i) => i.senderId));
      await Promise.all([...senders].map(getUser));
    }
    if (!current || current.id !== id) return;
    rawItems = items;
    redrawMessages();
    markRead(false);
  }, (err) => {
    console.error(err);
    $("messages").textContent = "Could not load messages.";
  });
}

function renderMessages(items) {
  const box = $("messages");
  const isGroup = current && current.type === "group";
  box.innerHTML = "";
  items.forEach((m) => {
    const div = document.createElement("div");
    div.className = "msg " + (m.mine ? "out" : "in");
    if (isGroup && !m.mine) {
      const s = document.createElement("div");
      s.className = "sender";
      const nm = (users.get(m.senderId) || { displayName: "Someone" }).displayName;
      s.textContent = nm;
      s.style.color = colorFor(nm);
      div.append(s);
    }
    div.append(document.createTextNode(m.text));
    const t = document.createElement("small");
    t.textContent = formatTime(m.time);
    if (m.mine) {
      const tick = document.createElement("span");
      tick.className = "tick";
      if (m.pending) {
        tick.textContent = "🕓";
      } else if (!isGroup && m.time <= otherReadAt) {
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
  const c = chatOf();
  if (current.type === "direct" && c && (c.status !== "active" || blocked.has(current.otherUid))) return;
  input.value = "";
  const uid = myUid();
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

/* ---------- Pop-up helper ---------- */
function openModal(title, onClose) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const card = document.createElement("div");
  card.className = "modal-card";
  const h = document.createElement("h2");
  h.textContent = title;
  const body = document.createElement("div");
  card.append(h, body);
  overlay.append(card);
  document.body.append(overlay);
  const close = () => {
    overlay.remove();
    if (onClose) onClose();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  return { body, close, setTitle: (t) => (h.textContent = t) };
}

function makeButton(text, className, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  if (handler) b.addEventListener("click", () => handler(b));
  return b;
}

async function act(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    alert("Could not do that. Please try again.");
  }
  btn.disabled = false;
}

/* A checkbox list of people. Returns a function that gives the chosen uids. */
function renderPicker(list, people) {
  list.innerHTML = "";
  const boxes = [];
  if (people.length === 0) {
    list.append(note("No one else to choose yet."));
    return () => [];
  }
  people.forEach((p) => {
    const li = document.createElement("li");
    li.className = "pick-item";
    const label = document.createElement("label");
    label.textContent = p.displayName;
    label.htmlFor = "pick_" + p.uid;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "pick_" + p.uid;
    box.value = p.uid;
    li.append(makeAvatar(p.displayName, optsOf(p)), label, box);
    list.append(li);
    boxes.push(box);
  });
  return () => boxes.filter((b) => b.checked).map((b) => b.value);
}

/* ---------- Create a group ---------- */
async function openNewGroup() {
  const m = openModal("New group");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "text-input";
  nameInput.maxLength = 40;
  nameInput.placeholder = "Group name";
  const hint = document.createElement("small");
  hint.className = "hint";
  hint.textContent = "Choose members";
  const list = document.createElement("ul");
  list.className = "pick-list";
  list.append(note("Loading..."));
  const err = document.createElement("p");
  err.className = "auth-error";
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const createBtn = makeButton("Create", "auth-submit");
  actions.append(makeButton("Cancel", "btn-ghost", () => m.close()), createBtn);
  m.body.append(nameInput, hint, list, err, actions);

  let getSelected = () => [];
  try {
    const people = (await loadAllPeople()).filter((p) => p.uid !== myUid() && !blocked.has(p.uid));
    getSelected = renderPicker(list, people);
  } catch (e) {
    console.error(e);
    list.innerHTML = "";
    list.append(note("Could not load people."));
  }

  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const picked = getSelected();
    if (name.length < 1 || name.length > 40) {
      err.textContent = "Please enter a group name (up to 40 characters).";
      return;
    }
    if (picked.length < 1) {
      err.textContent = "Choose at least one member.";
      return;
    }
    if (picked.length + 1 > MAX_MEMBERS) {
      err.textContent = "A group can have up to " + MAX_MEMBERS + " members.";
      return;
    }
    createBtn.disabled = true;
    err.textContent = "";
    try {
      const me = myUid();
      const ref = doc(collection(db, "chats"));
      const members = [me, ...picked];
      await setDoc(ref, {
        type: "group",
        name,
        members,
        admins: [me],
        createdBy: me,
        createdAt: serverTimestamp(),
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
        lastSenderId: ""
      });
      m.close();
      filter = "group";
      document.querySelectorAll(".tab").forEach((t) =>
        t.classList.toggle("active", t.dataset.filter === "group")
      );
      openConversation(ref.id, { type: "group", name, members, admins: [me] });
    } catch (e) {
      console.error(e);
      err.textContent = "Could not create the group. Please try again.";
      createBtn.disabled = false;
    }
  });
}

/* ---------- Group info and admin tools ---------- */
async function openGroupInfo() {
  if (!current || current.type !== "group") return;
  const gid = current.id;
  const ref = doc(db, "chats", gid);
  const m = openModal("Group info", () => { infoRefresh = null; });
  let addMode = false;
  let candidates = [];
  let lastSig = "";

  const draw = async (force) => {
    const c = chats.find((x) => x.id === gid);
    if (!c || !c.members.includes(myUid())) {
      m.close();
      return;
    }
    const sig = JSON.stringify([c.name, c.members, c.admins, addMode]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    await Promise.all(c.members.map(getUser));

    const me = myUid();
    const isAdmin = c.admins.includes(me);
    const body = m.body;
    body.innerHTML = "";
    m.setTitle(c.name);

    if (isAdmin) {
      const row = document.createElement("div");
      row.className = "row-gap";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "text-input";
      input.maxLength = 40;
      input.value = c.name;
      row.append(input, makeButton("Rename", "mini-btn", (b) => act(b, async () => {
        const name = input.value.trim();
        if (name.length < 1 || name.length > 40) {
          alert("Group name must be 1 to 40 characters.");
          return;
        }
        await updateDoc(ref, { name });
      })));
      body.append(row);
    }

    const hint = document.createElement("small");
    hint.className = "hint";
    hint.textContent = "Members (" + c.members.length + ")";
    body.append(hint);

    c.members.forEach((uid) => {
      const u = users.get(uid) || { displayName: "Unknown user" };
      const memberIsAdmin = c.admins.includes(uid);
      const row = document.createElement("div");
      row.className = "member-row";
      const nameBox = document.createElement("div");
      nameBox.className = "m-name";
      nameBox.textContent = u.displayName + (uid === me ? " (you)" : "");
      if (memberIsAdmin) {
        const badge = document.createElement("span");
        badge.className = "badge-admin";
        badge.textContent = "Admin";
        nameBox.append(badge);
      }
      row.append(makeAvatar(u.displayName, optsOf(u)), nameBox);

      if (isAdmin && uid !== me) {
        const actions = document.createElement("div");
        actions.className = "member-actions";
        if (memberIsAdmin) {
          actions.append(makeButton("Remove admin", "mini-btn", (b) => act(b, () =>
            updateDoc(ref, { admins: arrayRemove(uid) })
          )));
        } else {
          actions.append(makeButton("Make admin", "mini-btn", (b) => act(b, () =>
            updateDoc(ref, { admins: arrayUnion(uid) })
          )));
        }
        actions.append(makeButton("Remove", "mini-btn danger", (b) => act(b, async () => {
          if (!confirm("Remove " + u.displayName + " from the group?")) return;
          await updateDoc(ref, { members: arrayRemove(uid), admins: arrayRemove(uid) });
        })));
        row.append(actions);
      }
      body.append(row);
    });

    if (isAdmin) {
      if (!addMode) {
        body.append(makeButton("+ Add people", "btn-ghost", async (b) => {
          b.disabled = true;
          try {
            const all = await loadAllPeople();
            candidates = all.filter((p) => !c.members.includes(p.uid) && !blocked.has(p.uid));
            addMode = true;
            draw(true);
          } catch (e) {
            console.error(e);
            alert("Could not load people.");
            b.disabled = false;
          }
        }));
        body.lastChild.style.cssText = "width:100%;margin-top:12px;";
      } else {
        const addHint = document.createElement("small");
        addHint.className = "hint";
        addHint.textContent = "Add people";
        const list = document.createElement("ul");
        list.className = "pick-list";
        const getSelected = renderPicker(list, candidates);
        const actions = document.createElement("div");
        actions.className = "modal-actions";
        actions.append(
          makeButton("Cancel", "btn-ghost", () => { addMode = false; draw(true); }),
          makeButton("Add selected", "auth-submit", (b) => act(b, async () => {
            const picked = getSelected();
            if (picked.length === 0) return;
            if (c.members.length + picked.length > MAX_MEMBERS) {
              alert("A group can have up to " + MAX_MEMBERS + " members.");
              return;
            }
            await updateDoc(ref, { members: arrayUnion(...picked) });
            addMode = false;
          }))
        );
        body.append(addHint, list, actions);
      }
    }

    const onlyAdmin = isAdmin && c.admins.length === 1 && c.members.length > 1;
    const leave = makeButton("Leave group", "btn-danger", (b) => act(b, async () => {
      if (!confirm("Leave this group?")) return;
      await updateDoc(ref, { members: arrayRemove(me), admins: arrayRemove(me) });
      m.close();
      backToList();
    }));
    leave.disabled = onlyAdmin;
    body.append(leave);
    if (onlyAdmin) {
      const warn = document.createElement("small");
      warn.className = "hint";
      warn.textContent = "You are the only admin. Make someone else admin before leaving.";
      body.append(warn);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    actions.append(makeButton("Close", "btn-ghost", () => m.close()));
    body.append(actions);
  };

  infoRefresh = draw;
  draw(true);
}

/* ---------- Options for a one-to-one chat (block / unblock) ---------- */
function openChatOptions() {
  if (!current || current.type !== "direct") return;
  const other = current.otherUid;
  const u = users.get(other) || { displayName: "Unknown user", bio: "" };
  const m = openModal(u.displayName);
  const bio = document.createElement("p");
  bio.className = "bio";
  bio.style.cssText = "text-align:center;color:var(--muted);margin-bottom:8px;";
  bio.textContent = u.bio || "Hey there! I'm using KoKo.";
  m.body.append(bio);
  if (blocked.has(other)) {
    m.body.append(makeButton("Unblock " + u.displayName, "btn-danger", (b) => act(b, async () => {
      await unblockUser(other);
      m.close();
    })));
  } else {
    m.body.append(makeButton("Block " + u.displayName, "btn-danger", (b) => act(b, async () => {
      if (!confirm("Block " + u.displayName + "? They won't be told, and they can't message you.")) return;
      await blockUser(other, chatOf());
      m.close();
    })));
  }
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  actions.append(makeButton("Close", "btn-ghost", () => m.close()));
  m.body.append(actions);
}

$("headName").parentElement.addEventListener("click", () => {
  if (!current) return;
  if (current.type === "group") openGroupInfo();
  else openChatOptions();
});

/* ---------- Navigation and events ---------- */
function backToList() {
  if (unsubMsgs) unsubMsgs();
  if (unsubOtherRead) unsubOtherRead();
  unsubMsgs = unsubOtherRead = null;
  current = null;
  rawItems = [];
  lastItems = [];
  banner.hidden = true;
  $("composer").hidden = false;
  appEl.classList.remove("chat-open");
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderList();
  updateTitle();
}
$("backBtn").addEventListener("click", backToList);

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

const newGroupBtn = document.createElement("button");
newGroupBtn.type = "button";
newGroupBtn.className = "new-group";
newGroupBtn.textContent = "+ New group";
newGroupBtn.hidden = true;
newGroupBtn.addEventListener("click", openNewGroup);
$("chatList").before(newGroupBtn);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    newGroupBtn.hidden = tab.dataset.filter !== "group";
    if (tab.dataset.filter !== "people") {
      filter = tab.dataset.filter;
      $("peopleList").hidden = true;
      $("chatList").hidden = false;
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