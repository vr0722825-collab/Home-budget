const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const els = {
  month: document.getElementById("month"),
  monthFallback: document.getElementById("month-fallback"),
  monthName: document.getElementById("month-name"),
  monthYear: document.getElementById("month-year"),
  userName: document.getElementById("user-name"),
  logout: document.getElementById("logout"),
  budgetForm: document.getElementById("budget-form"),
  budgetAmount: document.getElementById("budget-amount"),
  copyNext: document.getElementById("copy-next"),
  itemForm: document.getElementById("item-form"),
  itemName: document.getElementById("item-name"),
  items: document.getElementById("items"),
  thisLabel: document.getElementById("this-label"),
  nextLabel: document.getElementById("next-label"),
  statBudget: document.getElementById("stat-budget"),
  statSpent: document.getElementById("stat-spent"),
  statLeftover: document.getElementById("stat-leftover"),
  nextBudget: document.getElementById("next-budget"),
  nextSpent: document.getElementById("next-spent"),
  nextLeftover: document.getElementById("next-leftover"),
  nextLeftoverWrap: document.getElementById("next-leftover-wrap"),
  budgetFill: document.getElementById("budget-fill"),
  compare: document.getElementById("compare"),
  toast: document.getElementById("toast"),
  reportSubtitle: document.getElementById("report-subtitle"),
  reportStatus: document.getElementById("report-status"),
  reportThisCol: document.getElementById("report-this-col"),
  reportNextCol: document.getElementById("report-next-col"),
  reportBody: document.getElementById("report-body"),
  reportFoot: document.getElementById("report-foot"),
  printReport: document.getElementById("print-report"),
};

let lastData = null;
let usingMonthFallback = false;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function supportsMonthInput() {
  const input = document.createElement("input");
  input.setAttribute("type", "month");
  return input.type === "month";
}

function selectedMonth() {
  return els.month.value;
}

function setSelectedMonth(value) {
  els.month.value = value;
  if (!usingMonthFallback) return;
  const [year, month] = value.split("-");
  els.monthYear.value = year;
  els.monthName.value = month;
}

function syncFallbackToMonth() {
  const month = `${els.monthYear.value}-${els.monthName.value}`;
  els.month.value = month;
}

function setupMonthPicker() {
  if (supportsMonthInput()) return;
  usingMonthFallback = true;
  els.month.hidden = true;
  els.monthFallback.hidden = false;
  const now = new Date();
  const yearNow = now.getFullYear();
  els.monthName.innerHTML = MONTH_NAMES.map(
    (name, index) =>
      `<option value="${String(index + 1).padStart(2, "0")}">${name}</option>`
  ).join("");
  els.monthYear.innerHTML = Array.from({ length: 7 }, (_, i) => yearNow - 3 + i)
    .map((year) => `<option value="${year}">${year}</option>`)
    .join("");
  setSelectedMonth(currentMonth());
  const onChange = () => {
    syncFallbackToMonth();
    run(load);
  };
  els.monthName.addEventListener("change", onChange);
  els.monthYear.addEventListener("change", onChange);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3500);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    showToast(err.message);
  }
}

function barWidth(spent, total) {
  if (!total) return spent > 0 ? 100 : 0;
  return Math.min(100, Math.round((spent / total) * 100));
}

async function load() {
  const month = els.month.value;
  const data = await api(`/api/month?month=${encodeURIComponent(month)}`);
  lastData = data;
  const next = data.next;

  els.thisLabel.textContent = data.label || "This month";
  els.nextLabel.textContent = next.label || "Next month";
  els.statBudget.textContent = rupee.format(data.budget);
  els.statSpent.textContent = rupee.format(data.spent);
  els.statLeftover.textContent = rupee.format(data.leftover);
  els.statLeftover.parentElement.classList.toggle("over", data.leftover < 0);
  els.nextBudget.textContent = rupee.format(next.budget);
  els.nextSpent.textContent = rupee.format(next.spent);
  els.nextLeftover.textContent = rupee.format(next.leftover);
  els.nextLeftoverWrap.classList.toggle("over", next.leftover < 0);
  els.budgetAmount.value = data.budget;
  const used = barWidth(data.spent, data.budget);
  els.budgetFill.style.width = `${used}%`;
  els.budgetFill.classList.toggle("over", data.leftover < 0);

  const spentDiff = next.spent - data.spent;
  const leftoverDiff = next.leftover - data.leftover;
  const spentText =
    spentDiff === 0
      ? "spent the same"
      : `spent ${rupee.format(Math.abs(spentDiff))} ${spentDiff > 0 ? "more" : "less"}`;
  const leftoverText =
    leftoverDiff === 0
      ? "leftover is the same"
      : `leftover is ${rupee.format(Math.abs(leftoverDiff))} ${leftoverDiff > 0 ? "higher" : "lower"}`;
  els.compare.textContent = `${next.label} compared with ${data.label}: ${spentText}; ${leftoverText}. Switch the month picker to add next month’s buys.`;

  renderReport(data);
  els.items.innerHTML = data.items.map((item) => itemCard(item, data.spent)).join("");
}

function usedPercent(spent, budget) {
  if (!budget) return spent > 0 ? "Over" : "0%";
  return `${Math.round((spent / budget) * 100)}%`;
}

function changeCell(thisSpent, nextSpent) {
  const diff = nextSpent - thisSpent;
  if (diff === 0) return "Same";
  const word = diff > 0 ? "more" : "less";
  return `${rupee.format(Math.abs(diff))} ${word}`;
}

function renderReport(data) {
  const next = data.next;
  const used = data.budget ? Math.round((data.spent / data.budget) * 100) : data.spent > 0 ? 100 : 0;
  els.reportSubtitle.textContent = `${data.label} compared with ${next.label}. Full budget ${rupee.format(data.budget)}.`;
  els.reportStatus.textContent =
    data.leftover < 0
      ? `Over budget by ${rupee.format(Math.abs(data.leftover))} (${used}% used).`
      : data.leftover === 0
        ? `Budget fully used (${used}%).`
        : `On track: ${rupee.format(data.leftover)} leftover (${used}% used).`;
  els.reportStatus.classList.toggle("over", data.leftover < 0);
  els.reportThisCol.textContent = data.label;
  els.reportNextCol.textContent = next.label;

  const rows = [...data.items].sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
  els.reportBody.innerHTML = rows
    .map((item) => {
      const nextSpent = Number(item.nextSpent || 0);
      const share = data.spent ? `${Math.round((item.spent / data.spent) * 100)}%` : "0%";
      return `<tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${rupee.format(item.spent)}</td>
        <td>${rupee.format(nextSpent)}</td>
        <td>${changeCell(item.spent, nextSpent)}</td>
        <td>${share}</td>
      </tr>`;
    })
    .join("");

  els.reportFoot.innerHTML = `<tr>
      <th>Total</th>
      <th>${rupee.format(data.spent)}</th>
      <th>${rupee.format(next.spent)}</th>
      <th>${changeCell(data.spent, next.spent)}</th>
      <th>${usedPercent(data.spent, data.budget)}</th>
    </tr>
    <tr>
      <th>Leftover</th>
      <th class="${data.leftover < 0 ? "over" : ""}">${rupee.format(data.leftover)}</th>
      <th class="${next.leftover < 0 ? "over" : ""}">${rupee.format(next.leftover)}</th>
      <th>${changeCell(data.leftover, next.leftover)}</th>
      <th></th>
    </tr>`;
}

function itemCard(item, monthSpent) {
  const spends = item.spends
    .map(
      (s) => `
      <li>
        <span>${rupee.format(s.amount)} · ${s.spentOn}${s.note ? ` · ${escapeHtml(s.note)}` : ""}</span>
        <button type="button" class="small danger" data-delete-spend="${s.id}">Remove</button>
      </li>`
    )
    .join("");
  const share = barWidth(item.spent, monthSpent);

  return `
    <article class="item" data-item="${item.id}">
      <div class="item-head">
        <div>
          <h2>${escapeHtml(item.name)}</h2>
          <p class="item-spent">Spent this month: ${rupee.format(item.spent)}</p>
        </div>
        <div class="item-actions">
          <button type="button" class="small" data-rename="${item.id}">Rename</button>
          <button type="button" class="small danger" data-delete-item="${item.id}">Delete</button>
        </div>
      </div>
      <div class="item-bar"><span style="width:${share}%"></span></div>
      <form class="spend-form">
        <label>
          Add spend (₹)
          <input type="number" name="amount" min="1" step="1" required />
        </label>
        <label>
          Date
          <input type="date" name="spentOn" value="${today()}" required />
        </label>
        <label>
          Note
          <input type="text" name="note" placeholder="Optional" />
        </label>
        <button type="submit">Save buy</button>
      </form>
      <ul class="spend-list">${spends || "<li class='muted'>No buys yet this month.</li>"}</ul>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  try {
    const me = await api("/api/me");
    els.userName.textContent = me.username;
  } catch {
    location.href = "/login.html";
    return;
  }
  els.month.value = currentMonth();
  await load();
}

els.logout.addEventListener("click", () =>
  run(async () => {
    await api("/api/logout", { method: "POST" });
    location.href = "/login.html";
  })
);

els.printReport.addEventListener("click", () => window.print());

els.month.addEventListener("change", () => run(load));

els.budgetForm.addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    await api("/api/budget", {
      method: "PUT",
      body: JSON.stringify({
        month: els.month.value,
        amount: Number(els.budgetAmount.value),
      }),
    });
    await load();
  });
});

els.copyNext.addEventListener("click", () =>
  run(async () => {
    const amount = Number(els.budgetAmount.value || lastData?.budget);
    const nextMonth = lastData?.next?.month;
    if (!nextMonth) {
      showToast("Could not find next month.");
      return;
    }
    await api("/api/budget", {
      method: "PUT",
      body: JSON.stringify({ month: nextMonth, amount }),
    });
    await load();
    showToast(`Saved ${rupee.format(amount)} for ${lastData.next.label}.`);
  })
);

els.itemForm.addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    await api("/api/items", {
      method: "POST",
      body: JSON.stringify({ name: els.itemName.value }),
    });
    els.itemName.value = "";
    await load();
  });
});

els.items.addEventListener("submit", (e) => {
  const form = e.target.closest(".spend-form");
  if (!form) return;
  e.preventDefault();
  const itemId = Number(form.closest(".item").dataset.item);
  const data = Object.fromEntries(new FormData(form));
  run(async () => {
    await api("/api/spends", {
      method: "POST",
      body: JSON.stringify({
        month: els.month.value,
        itemId,
        amount: Number(data.amount),
        spentOn: data.spentOn,
        note: data.note,
      }),
    });
    await load();
  });
});

els.items.addEventListener("click", (e) => {
  const spendId = e.target.dataset.deleteSpend;
  const itemId = e.target.dataset.deleteItem;
  const renameId = e.target.dataset.rename;
  if (spendId) {
    run(async () => {
      await api(`/api/spends/${spendId}`, { method: "DELETE" });
      await load();
    });
  }
  if (itemId) {
    if (!confirm("Delete this thing and its spends?")) return;
    run(async () => {
      await api(`/api/items/${itemId}`, { method: "DELETE" });
      await load();
    });
  }
  if (renameId) {
    const card = e.target.closest(".item");
    const current = card.querySelector("h2").textContent;
    const name = prompt("New name", current);
    if (!name) return;
    run(async () => {
      await api(`/api/items/${renameId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      await load();
    });
  }
});

boot().catch((err) => {
  showToast(err.message);
});
