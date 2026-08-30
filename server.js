const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const session = require("express-session");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_BUDGET = 2000;
const ALLOWED_USERS = ["vicky", "raajan", "obito", "alpha"];
const SHARED_PASSWORD = "4Friends";
const DEFAULT_ITEMS = [
  "Vegetables",
  "Chicken",
  "Water",
  "Electric bill",
  "Home things",
];

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "budget.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS month_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    year_month TEXT NOT NULL,
    amount REAL NOT NULL,
    UNIQUE(user_id, year_month)
  );
  CREATE TABLE IF NOT EXISTS spends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    year_month TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    spent_on TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (item_id) REFERENCES items(id)
  );
`);

function migrateEmailToUsername() {
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (cols.includes("email") && !cols.includes("username")) {
    db.exec("ALTER TABLE users RENAME COLUMN email TO username");
  }
}

migrateEmailToUsername();

const insertUser = db.prepare(
  "INSERT INTO users (username, password_hash) VALUES (?, ?)"
);
const findUserByUsername = db.prepare(
  "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
);
const findUserById = db.prepare(
  "SELECT id, username FROM users WHERE id = ?"
);
const updatePassword = db.prepare(
  "UPDATE users SET password_hash = ? WHERE id = ?"
);
const insertItem = db.prepare(
  "INSERT INTO items (user_id, name, is_default) VALUES (?, ?, ?)"
);
const listItems = db.prepare(
  "SELECT id, name, is_default FROM items WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE"
);
const countItems = db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?");
const findItemByName = db.prepare(
  "SELECT * FROM items WHERE user_id = ? AND name = ? COLLATE NOCASE"
);
const findItem = db.prepare(
  "SELECT * FROM items WHERE id = ? AND user_id = ?"
);
const sumSpends = db.prepare(
  "SELECT COALESCE(SUM(amount), 0) AS total FROM spends WHERE user_id = ? AND year_month = ?"
);
const updateItemName = db.prepare(
  "UPDATE items SET name = ? WHERE id = ? AND user_id = ?"
);
const deleteItem = db.prepare("DELETE FROM items WHERE id = ? AND user_id = ?");
const deleteSpendsForItem = db.prepare(
  "DELETE FROM spends WHERE item_id = ? AND user_id = ?"
);
const upsertBudget = db.prepare(`
  INSERT INTO month_budgets (user_id, year_month, amount)
  VALUES ($userId, $month, $amount)
  ON CONFLICT(user_id, year_month) DO UPDATE SET amount = $amount
`);
const getBudget = db.prepare(
  "SELECT amount FROM month_budgets WHERE user_id = ? AND year_month = ?"
);
const insertSpend = db.prepare(`
  INSERT INTO spends (user_id, item_id, year_month, amount, note, spent_on)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listSpends = db.prepare(`
  SELECT id, item_id, amount, note, spent_on
  FROM spends
  WHERE user_id = ? AND year_month = ?
  ORDER BY spent_on DESC, id DESC
`);
const findSpend = db.prepare(
  "SELECT * FROM spends WHERE id = ? AND user_id = ?"
);
const deleteSpend = db.prepare("DELETE FROM spends WHERE id = ? AND user_id = ?");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const next = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
}

function monthKey(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return null;
  return value;
}

function nextMonthKey(month) {
  const [year, monthNum] = month.split("-").map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month) {
  const [year, monthNum] = month.split("-").map(Number);
  return new Date(year, monthNum - 1, 1).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

function monthSummary(userId, month) {
  const budgetRow = getBudget.get(userId, month);
  const budget = budgetRow ? Number(budgetRow.amount) : DEFAULT_BUDGET;
  const spent = Number(sumSpends.get(userId, month).total);
  return {
    month,
    label: monthLabel(month),
    budget,
    spent,
    leftover: budget - spent,
    budgetSaved: Boolean(budgetRow),
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please log in." });
  }
  next();
}

function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function seedItems(userId) {
  withTransaction(() => {
    for (const name of DEFAULT_ITEMS) {
      insertItem.run(userId, name, 1);
    }
  });
}

function ensureDefaultItems(userId) {
  if (countItems.get(userId).n === 0) {
    seedItems(userId);
    return;
  }
  for (const name of DEFAULT_ITEMS) {
    if (!findItemByName.get(userId, name)) {
      insertItem.run(userId, name, 1);
    }
  }
}

function seedAllowedUsers() {
  const passwordHash = hashPassword(SHARED_PASSWORD);
  for (const username of ALLOWED_USERS) {
    const user = findUserByUsername.get(username);
    if (!user) {
      const result = insertUser.run(username, passwordHash);
      seedItems(result.lastInsertRowid);
    } else {
      updatePassword.run(passwordHash, user.id);
      ensureDefaultItems(user.id);
    }
  }
}

seedAllowedUsers();

const app = express();
app.use(express.json());
app.use(
  session({
    name: "budget.sid",
    secret: process.env.SESSION_SECRET || "home-monthly-budget-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!ALLOWED_USERS.includes(username)) {
    return res.status(400).json({ error: "Wrong username or password." });
  }
  const user = findUserByUsername.get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(400).json({ error: "Wrong username or password." });
  }
  req.session.userId = user.id;
  ensureDefaultItems(user.id);
  res.json({ username: user.username });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("budget.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  const user = findUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json(user);
});

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const family = addr.family === 4 || addr.family === "IPv4";
      if (family && !addr.internal) {
        urls.push(`http://${addr.address}:${PORT}`);
      }
    }
  }
  return [...new Set(urls)];
}

app.get("/api/lan", (_req, res) => {
  res.json({ urls: lanUrls() });
});

app.get("/api/month", requireAuth, (req, res) => {
  const month = monthKey(req.query.month);
  if (!month) return res.status(400).json({ error: "Choose a valid month." });
  const userId = req.session.userId;
  const current = monthSummary(userId, month);
  const next = monthSummary(userId, nextMonthKey(month));
  const items = listItems.all(userId);
  const nextMonth = nextMonthKey(month);
  const byItem = new Map();
  for (const item of items) {
    byItem.set(item.id, { ...item, spent: 0, nextSpent: 0, spends: [] });
  }
  for (const row of listSpends.all(userId, month)) {
    const bucket = byItem.get(row.item_id);
    if (!bucket) continue;
    bucket.spent += Number(row.amount);
    bucket.spends.push({
      id: row.id,
      amount: Number(row.amount),
      note: row.note || "",
      spentOn: row.spent_on,
    });
  }
  for (const row of listSpends.all(userId, nextMonth)) {
    const bucket = byItem.get(row.item_id);
    if (!bucket) continue;
    bucket.nextSpent += Number(row.amount);
  }
  res.json({
    ...current,
    next,
    items: [...byItem.values()],
  });
});

app.put("/api/budget", requireAuth, (req, res) => {
  const month = monthKey(req.body.month);
  const amount = Number(req.body.amount);
  if (!month) return res.status(400).json({ error: "Choose a valid month." });
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "Enter a valid budget amount." });
  }
  upsertBudget.run({
    $userId: req.session.userId,
    $month: month,
    $amount: amount,
  });
  res.json({ month, amount });
});

app.post("/api/items", requireAuth, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a name for the new thing." });
  if (findItemByName.get(req.session.userId, name)) {
    return res.status(400).json({ error: "That thing is already on the list." });
  }
  const result = insertItem.run(req.session.userId, name, 0);
  res.json({ id: result.lastInsertRowid, name, is_default: 0 });
});

app.patch("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a name." });
  const item = findItem.get(id, req.session.userId);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const clash = findItemByName.get(req.session.userId, name);
  if (clash && clash.id !== id) {
    return res.status(400).json({ error: "That thing is already on the list." });
  }
  updateItemName.run(name, id, req.session.userId);
  res.json({ id, name, is_default: item.is_default });
});

app.delete("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const item = findItem.get(id, req.session.userId);
  if (!item) return res.status(404).json({ error: "Item not found." });
  withTransaction(() => {
    deleteSpendsForItem.run(id, req.session.userId);
    deleteItem.run(id, req.session.userId);
  });
  res.json({ ok: true });
});

app.post("/api/spends", requireAuth, (req, res) => {
  const month = monthKey(req.body.month);
  const itemId = Number(req.body.itemId);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || "").trim();
  const spentOn = String(req.body.spentOn || "").slice(0, 10);
  if (!month) return res.status(400).json({ error: "Choose a valid month." });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a spend amount greater than 0." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) {
    return res.status(400).json({ error: "Choose a date." });
  }
  const item = findItem.get(itemId, req.session.userId);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const result = insertSpend.run(
    req.session.userId,
    itemId,
    month,
    amount,
    note,
    spentOn
  );
  res.json({
    id: result.lastInsertRowid,
    itemId,
    amount,
    note,
    spentOn,
  });
});

app.delete("/api/spends/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const spend = findSpend.get(id, req.session.userId);
  if (!spend) return res.status(404).json({ error: "Spend not found." });
  deleteSpend.run(id, req.session.userId);
  res.json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Home budget running at http://localhost:${PORT}`);
  for (const url of lanUrls()) {
    console.log(`Phone (same Wi-Fi): ${url}`);
  }
});
