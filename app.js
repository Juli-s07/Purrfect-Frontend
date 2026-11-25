const API_URL = "http://127.0.0.1:8000/api";
const AUTH_URL = "http://127.0.0.1:8000/auth"; // auth підключено поза /api
// У urls.py адреси зі слешем (cats/), тому тут "/"
const SLASH = "/";

const AUTH_PATHS = {
  register: "/register/",
  login: "/login/",
  refresh: "/login/refresh/",
  logout: "/logout/",
};

const STATUS_LABELS = {
  available: "Available",
  reserved: "Reserved",
  sold: "Sold",
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

// Country comes from the API as {code: "UA", name: "Ukraine"}
function countryName(breeder) {
  const c = breeder && breeder.country_code;
  if (!c) return "";
  return typeof c === "string" ? c : c.name || c.code || "";
}

// ---------- Токени ----------

const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";
const USERNAME_KEY = "username";

const tokens = {
  get access() { return localStorage.getItem(ACCESS_KEY); },
  get refresh() { return localStorage.getItem(REFRESH_KEY); },
  set(access, refresh) {
    if (access) localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USERNAME_KEY);
  },
};

// Дізнаємося, коли спливає токен (поле exp у JWT, у секундах)
function tokenExpiresInSeconds(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp - Date.now() / 1000;
  } catch (e) {
    return Infinity; // не вдалося прочитати — нехай вирішить сервер
  }
}

// ---------- HTTP ----------

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function messageFromBody(body, status) {
  if (body && typeof body === "object") {
    if (body.message) return body.message;
    if (body.detail) return body.detail;
  }
  return `Error ${status}`;
}

let refreshPromise = null;

// Оновлює access-токен за допомогою refresh-токена.
// Якщо оновлення вже триває — всі запити чекають на один і той самий результат.
function refreshAccess() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refresh = tokens.refresh;
    if (!refresh) throw new ApiError("Session expired", 401);

    const response = await fetch(`${AUTH_URL}${AUTH_PATHS.refresh}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh }),
    });
    if (!response.ok) {
      clearSession(); // refresh недійсний або прострочений — потрібен новий логін
      throw new ApiError("Session expired. Please log in again.", 401);
    }
    const data = await response.json();
    tokens.set(data.access, data.refresh); // refresh прийде, лише якщо на бекенді ротація
    return data.access;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

async function request(path, { method = "GET", body, auth = true, base = API_URL } = {}) {
  // Заздалегідь оновлюємо access, якщо він спливає менш ніж за 30 с
  if (auth && tokens.access && tokens.refresh && tokenExpiresInSeconds(tokens.access) < 30) {
    try { await refreshAccess(); } catch (e) { /* continue without a token */ }
  }

  async function send() {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && tokens.access) headers["Authorization"] = `Bearer ${tokens.access}`;
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  let response = await send();

  // Сервер каже, що access недійсний — оновлюємо і повторюємо запит один раз
  if (response.status === 401 && auth && tokens.refresh) {
    await refreshAccess();
    response = await send();
  }

  let data = null;
  try { data = await response.json(); } catch (e) {}

  if (!response.ok) {
    throw new ApiError(messageFromBody(data, response.status), response.status, data);
  }
  return data;
}

const api = (path) => request(path);

// ---------- Користувач / права / кеш котів ----------
let meCache = null;
let mePromise = null;
let allCatsCache = null;
let currentCatId = null;
let currentBreederId = null;

async function loadMe() {
  if (!tokens.access) { meCache = null; return null; }
  if (meCache) return meCache;
  if (mePromise) return mePromise;
  mePromise = request("/users/me/", { base: AUTH_URL })
    .then((data) => { meCache = data; return data; })
    .catch(() => { meCache = null; return null; })
    .finally(() => { mePromise = null; });
  return mePromise;
}

function canEditParents(me) {
  return Boolean(me && (me.is_staff || me.breeder_id));
}

async function loadAllCats() {
  if (allCatsCache) return allCatsCache;
  const limit = 100;
  let page = 1;
  let total = Infinity;
  const items = [];
  while (items.length < total && page <= 20) {
    const data = await api(`/cats${SLASH}?page=${page}&limit=${limit}&sort_by=created_at&order=desc`);
    const pageItems = Array.isArray(data) ? data : (data.items ?? []);
    items.push(...pageItems);
    total = Array.isArray(data) ? pageItems.length : (data.total ?? pageItems.length);
    if (Array.isArray(data) || !data.items || pageItems.length < limit) break;
    page += 1;
  }
  allCatsCache = items;
  return items;
}

// ---------- Info pages (Home, For buyers, For breeders, Contacts) ----------

// Paths are relative to API_URL. Change them to match your core/urls.py.
const PAGE_ENDPOINTS = {
  home: "/",
  buyers: "/for-buyers/",
  sellers: "/for-breeders/",
  contacts: "/contacts/",
};
const pagesLoaded = {};

function renderPage(view, data) {
  const root = $(`view-${view}`);
  const setText = (selector, text) => {
    const el = root.querySelector(selector);
    if (el) el.textContent = text ?? "";
  };
  if (data.title) setText("[data-page-title]", data.title);
  if (data.intro) setText("[data-page-intro]", data.intro);
  setText("[data-page-tagline]", data.tagline);

  root.querySelector("[data-page-sections]").innerHTML = (data.sections ?? [])
    .map((s) => {
      const text = s.text ? `<p>${escapeHtml(s.text)}</p>` : "";
      const items = (s.items ?? []).length
        ? `<ul class="about-items">${s.items
            .map((i) => `<li><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.text)}</span></li>`)
            .join("")}</ul>`
        : "";
      return `<section class="about-block"><h3>${escapeHtml(s.heading)}</h3>${text}${items}</section>`;
    })
    .join("");
}

async function loadPage(view) {
  if (pagesLoaded[view]) return;
  const message = $(`view-${view}`).querySelector("[data-page-message]");
  message.textContent = "Loading...";
  try {
    renderPage(view, await api(PAGE_ENDPOINTS[view]));
    pagesLoaded[view] = true;
    message.textContent = "";
  } catch (err) {
    message.textContent = `Could not load this page: ${err.message}`;
  }
}

// ---------- Коти ----------

function formatErrors(err) {
  const d = err.data;
  if (d && typeof d === "object" && !d.message && !d.detail) {
    return Object.entries(d)
      .map(([k, v]) => `${k}: ${(Array.isArray(v) ? v : [v]).map(translateServerText).join(" ")}`)
      .join("; ");
  }
  return translateServerText(err.message);
}

// Заповнюємо списки порід, заводчиків і країн для фільтрів
async function loadBreeds() {
  try {
    const breeds = await api(`/breeds${SLASH}`);
    $("filter-breed").innerHTML =
      `<option value="">All breeds</option>` +
      breeds.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");
  } catch (err) {
    console.error("Could not load breeds:", err.message);
  }
}

async function loadBreederFilters() {
  try {
    const breeders = await api(`/breeders${SLASH}`);
    $("filter-breeder").innerHTML =
      `<option value="">All breeders</option>` +
      breeders.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("");

    // Унікальні країни заводчиків: value = код (UA), текст = назва (Ukraine)
    const byCode = new Map();
    breeders.forEach((b) => {
      const c = b.country_code;
      if (c && c.code) byCode.set(c.code, c.name || c.code);
    });
    const countries = [...byCode].sort((a, b) => a[1].localeCompare(b[1]));
    $("filter-country").innerHTML =
      `<option value="">All countries</option>` +
      countries
        .map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`)
        .join("");
  } catch (err) {
    console.error("Could not load breeders for filters:", err.message);
  }
}

function filterValue(id) {
  return $(id).value.trim();
}

function renderPagination(page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  $("pagination").hidden = totalPages <= 1;
  $("page-info").textContent = `Page ${page} of ${totalPages} (total: ${total})`;
  $("page-prev").disabled = page <= 1;
  $("page-next").disabled = page >= totalPages;
  $("page-prev").onclick = () => loadCats(page - 1);
  $("page-next").onclick = () => loadCats(page + 1);
}

async function loadCats(page = 1) {
  const message = $("cats-message");
  const container = $("cats");

  // Перевірка діапазонів до запиту
  const minPrice = filterValue("filter-min-price");
  const maxPrice = filterValue("filter-max-price");
  if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
    message.textContent = "Minimum price cannot be greater than maximum price.";
    return;
  }

  message.textContent = "Loading...";
  container.innerHTML = "";

  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", $("filter-limit").value);
  params.set("sort_by", $("filter-sort-by").value);
  params.set("order", $("filter-order").value);
  const optional = {
    search: filterValue("filter-search"),
    breed_id: $("filter-breed").value,
    breeder_id: $("filter-breeder").value,
    country_code: $("filter-country").value, // код країни, напр. UA
    status: $("filter-status").value,
    min_price: minPrice,
    max_price: maxPrice,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== "") params.set(key, value);
  }

  try {
    const data = await api(`/cats${SLASH}?${params}`);
    const allCats = data.items ?? data; // працює і з пагінацією, і зі звичайним масивом
    // За замовчуванням приховуємо проданих; показуємо їх лише за явного вибору Status: Sold
    const statusFilter = $("filter-status").value;
    const cats = statusFilter === "sold"
      ? allCats
      : allCats.filter((cat) => cat.status !== "sold");
    message.textContent = cats.length ? "" : "No cats found for these filters.";
    container.innerHTML = cats
      .map(
        (cat) => `
        <article class="card" data-id="${cat.id}" tabindex="0">
          <img src="${escapeHtml(cat.photo_url)}" alt="${escapeHtml(cat.name)}">
          <h3>${escapeHtml(cat.name)}</h3>
          <p>${escapeHtml(cat.breed.name)}</p>
          <p class="price">${cat.price} UAH</p>
          <p class="status ${cat.status}">${STATUS_LABELS[cat.status] ?? cat.status}</p>
        </article>`
      )
      .join("");
    if (data.items) renderPagination(data.page ?? page, data.limit ?? Number($("filter-limit").value), data.total ?? allCats.length);
    else $("pagination").hidden = true;
  } catch (err) {
    $("pagination").hidden = true;
    message.textContent = `Could not load cats: ${formatErrors(err)}`;
  }
}

async function openCat(id) {
  currentCatId = id;
  const details = $("cat-details");
  details.textContent = "Loading...";
  $("cat-dialog").showModal();
  try {
    const cat = await api(`/cats/${id}${SLASH}`);
    if (currentCatId !== id) return;
    const breederCountry = countryName(cat.breeder);
    const breederPlace = [cat.breeder.city, breederCountry].filter(Boolean).map(escapeHtml).join(", ");
    const me = await loadMe();
    if (currentCatId !== id) return;
    const showForm = canEditParents(me);
    details.innerHTML = `
      <img src="${escapeHtml(cat.photo_url)}" alt="${escapeHtml(cat.name)}">
      <h2>${escapeHtml(cat.name)}</h2>
      <p>Breed: ${escapeHtml(cat.breed.name)}</p>
      <p>Sex: ${cat.sex === "female" ? "Female" : "Male"}</p>
      <p>Date of birth: ${escapeHtml(cat.birth_date)}</p>
      <p>Price: ${cat.price} UAH</p>
      <p>Status: ${STATUS_LABELS[cat.status] ?? cat.status}</p>
      <p>Breeder: <button type="button" class="link-btn" data-breeder-id="${cat.breeder.id}">${escapeHtml(cat.breeder.name)}</button>${breederPlace ? ", " + breederPlace : ""}</p>
      <p>${escapeHtml(cat.description)}</p>
      <section class="section-title">Pedigree</section>
      <div id="cat-pedigree" class="pedigree">Loading...</div>
      ${showForm ? `<section class="section-title">Edit parents</section>
      <form id="cat-parent-form" class="parent-form" novalidate>
        <p class="form-error" id="cat-parent-form-error" role="alert"></p>
        <label class="field">Mother
          <select name="mother_id" disabled><option value="">Loading cats...</option></select>
          <small class="error" data-error-for="mother"></small>
        </label>
        <label class="field">Father
          <select name="father_id" disabled><option value="">Loading cats...</option></select>
          <small class="error" data-error-for="father"></small>
        </label>
        <button type="submit" class="btn btn-primary btn-block" disabled>Save parents</button>
      </form>` : ""}`;
    loadCatPedigree(id);
    if (showForm) setupParentForm(id, cat);
  } catch (err) {
    if (currentCatId === id) details.textContent = `Could not load cat: ${err.message}`;
  }
}

function pedigreeNodeHtml(node) {
  if (!node) return `<div class="pedigree-node pedigree-unknown" tabindex="0">Unknown</div>`;
  return `
    <div class="pedigree-node" data-cat-id="${node.id}" tabindex="0">
      <img src="${escapeHtml(node.photo_url)}" alt="${escapeHtml(node.name)}">
      <div class="pedigree-info">
        <strong>${escapeHtml(node.name)}</strong>
        <span>${escapeHtml(node.breed)} · ${node.sex === "female" ? "Female" : "Male"}</span>
        <span class="status ${node.status}">${STATUS_LABELS[node.status] ?? node.status}</span>
      </div>
      <div class="pedigree-parents">
        <div><span class="pedigree-label">Mother</span>${pedigreeNodeHtml(node.mother)}</div>
        <div><span class="pedigree-label">Father</span>${pedigreeNodeHtml(node.father)}</div>
      </div>
    </div>`;
}

async function loadCatPedigree(id) {
  const el = $("cat-pedigree");
  if (!el) return;
  el.textContent = "Loading...";
  try {
    const node = await api(`/cats/${id}/pedigree${SLASH}`);
    if (currentCatId !== id) return;
    el.innerHTML = pedigreeNodeHtml(node);
  } catch (err) {
    if (currentCatId !== id) return;
    el.textContent = `Could not load pedigree: ${err.message}`;
  }
}

async function setupParentForm(catId, cat) {
  const form = $("cat-parent-form");
  if (!form) return;
  try {
    const cats = await loadAllCats();
    if (currentCatId !== catId) return;
    const motherSelect = form.elements.mother_id;
    const fatherSelect = form.elements.father_id;
    const mothers = cats
      .filter((c) => c.id !== Number(catId) && c.sex === "female")
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const fathers = cats
      .filter((c) => c.id !== Number(catId) && c.sex === "male")
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    motherSelect.innerHTML = `<option value="">None</option>` + mothers
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.breed?.name ?? "")})</option>`)
      .join("");
    fatherSelect.innerHTML = `<option value="">None</option>` + fathers
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.breed?.name ?? "")})</option>`)
      .join("");
    motherSelect.value = cat.mother ? String(cat.mother.id) : "";
    fatherSelect.value = cat.father ? String(cat.father.id) : "";
    motherSelect.disabled = false;
    fatherSelect.disabled = false;
    const btn = form.querySelector("button[type=submit]");
    if (btn) btn.disabled = false;
  } catch (err) {
    if (currentCatId !== catId) return;
    const errEl = form.querySelector(".form-error");
    if (errEl) errEl.textContent = `Could not load cats: ${err.message}`;
  }
  form.addEventListener("submit", handleParentSubmit);
}

async function handleParentSubmit(e) {
  e.preventDefault();
  const form = e.target;
  clearFormErrors(form);
  const catId = currentCatId;
  if (!catId) return;
  const motherVal = form.elements.mother_id.value;
  const fatherVal = form.elements.father_id.value;
  const body = {
    mother_id: motherVal === "" ? null : Number(motherVal),
    father_id: fatherVal === "" ? null : Number(fatherVal),
  };
  setBusy(form, true);
  try {
    await request(`/cats/${catId}${SLASH}`, { method: "PATCH", body });
    allCatsCache = null;
    await openCat(catId);
    const details = $("cat-details");
    const note = document.createElement("p");
    note.className = "message";
    note.textContent = "Parents updated.";
    details.prepend(note);
  } catch (err) {
    if (err.status === 403) {
      const fe = form.querySelector(".form-error");
      if (fe) fe.textContent = "You don't have permission to edit this cat.";
    } else {
      showServerErrors(form, err);
    }
  } finally {
    setBusy(form, false);
  }
}

// ---------- Заводчики ----------

async function loadBreeders() {
  const message = $("breeders-message");
  const container = $("breeders");
  message.textContent = "Loading...";
  try {
    const breeders = await api(`/breeders${SLASH}`);
    message.textContent = breeders.length ? "" : "No breeders yet.";
    container.innerHTML = breeders
      .map(
        (b) => `
        <article class="card" data-id="${b.id}" tabindex="0">
          <h3>${escapeHtml(b.name)}</h3>
          <p>${escapeHtml(countryName(b))}${b.city ? ", " + escapeHtml(b.city) : ""}</p>
        </article>`
      )
      .join("");
  } catch (err) {
    message.textContent = `Could not load breeders: ${err.message}`;
  }
}

async function openBreeder(id) {
  currentBreederId = id;
  const details = $("breeder-details");
  details.textContent = "Loading...";
  $("breeder-dialog").showModal();
  try {
    const b = await api(`/breeders/${id}${SLASH}`);
    if (currentBreederId !== id) return;
    const phone = b.phone
      ? `<p>Phone: <a href="tel:${escapeHtml(b.phone)}">${escapeHtml(b.phone)}</a></p>`
      : "";
    const email = b.email
      ? `<p>Email: <a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a></p>`
      : "";

    const ownedCats = (b.cats ?? []).filter((cat) => cat.status !== "sold");
    const cats = ownedCats
      .map(
        (cat) => `
        <article class="card" data-cat-id="${cat.id}" tabindex="0">
          <img src="${escapeHtml(cat.photo_url)}" alt="${escapeHtml(cat.name)}">
          <h3>${escapeHtml(cat.name)}</h3>
          ${cat.breed ? `<p>${escapeHtml(cat.breed.name)}</p>` : ""}
          <p class="price">${cat.price} UAH</p>
          <p class="status ${cat.status}">${STATUS_LABELS[cat.status] ?? cat.status}</p>
        </article>`
      )
      .join("");

    details.innerHTML = `
      <h2>${escapeHtml(b.name)}</h2>
      <p>Country: ${escapeHtml(countryName(b))}</p>
      ${b.city ? `<p>City: ${escapeHtml(b.city)}</p>` : ""}
      ${phone}
      ${email}
      ${b.description ? `<p>${escapeHtml(b.description)}</p>` : ""}
      <h3 class="section-title">Breeder's cats (${ownedCats.length})</h3>
      ${cats ? `<div class="grid">${cats}</div>` : `<p class="message">No cats yet.</p>`}
      <section class="section-title">Alumni (sold)</section>
      <div id="breeder-alumni" class="grid"><p class="message">Loading...</p></div>
      <section class="section-title">Family lines</section>
      <div id="breeder-families" class="families"><p class="message">Loading...</p></div>`;
    loadBreederAlumni(id);
    loadBreederFamilies(id);
  } catch (err) {
    if (currentBreederId === id) details.textContent = `Could not load breeder: ${err.message}`;
  }
}

function breederCatCard(cat) {
  return `
    <article class="card" data-cat-id="${cat.id}" tabindex="0">
      <img src="${escapeHtml(cat.photo_url)}" alt="${escapeHtml(cat.name)}">
      <h3>${escapeHtml(cat.name)}</h3>
      ${cat.breed ? `<p>${escapeHtml(cat.breed.name)}</p>` : ""}
      <p class="price">${cat.price} UAH</p>
      <p class="status ${cat.status}">${STATUS_LABELS[cat.status] ?? cat.status}</p>
    </article>`;
}

async function loadBreederAlumni(id) {
  const el = $("breeder-alumni");
  if (!el) return;
  el.innerHTML = `<p class="message">Loading...</p>`;
  try {
    const cats = await api(`/breeders/${id}/alumni${SLASH}`);
    if (currentBreederId !== id) return;
    if (!Array.isArray(cats) || !cats.length) {
      el.innerHTML = `<p class="message">No alumni yet.</p>`;
      return;
    }
    el.innerHTML = cats.map(breederCatCard).join("");
  } catch (err) {
    if (currentBreederId !== id) return;
    el.innerHTML = `<p class="message">Could not load alumni: ${escapeHtml(err.message)}</p>`;
  }
}

function familyTreeHtml(node) {
  if (!node) return "";
  const motherRef = node.mother
    ? `<span class="ref">Mother: <button type="button" class="link-btn" data-cat-id="${node.mother.id}">${escapeHtml(node.mother.name)}</button></span>`
    : "";
  const fatherRef = node.father
    ? `<span class="ref">Father: <button type="button" class="link-btn" data-cat-id="${node.father.id}">${escapeHtml(node.father.name)}</button></span>`
    : "";
  const children = (node.children && node.children.length)
    ? `<ul class="tree-children">${node.children.map(familyTreeHtml).join("")}</ul>`
    : "";
  return `
    <li class="tree-node">
      <div class="tree-card" data-cat-id="${node.id}" tabindex="0">
        <img src="${escapeHtml(node.photo_url)}" alt="${escapeHtml(node.name)}">
        <div class="tree-info">
          <strong>${escapeHtml(node.name)}</strong>
          <span>${escapeHtml(node.breed)} · ${node.sex === "female" ? "Female" : "Male"}</span>
          <span class="status ${node.status}">${STATUS_LABELS[node.status] ?? node.status}</span>
          ${node.birth_date ? `<span class="tree-date">${escapeHtml(node.birth_date)}</span>` : ""}
        </div>
        <div class="tree-refs">${motherRef}${fatherRef}</div>
      </div>
      ${children}
    </li>`;
}

function familyCardHtml(family) {
  const roots = (family.roots || [])
    .map((r) => `<button type="button" class="link-btn" data-cat-id="${r.id}">${escapeHtml(r.name)}</button>`)
    .join(", ") || "—";
  return `
    <article class="family-card">
      <h4>Family</h4>
      <p class="message">${family.cats_count} cats · ${family.generations} generations</p>
      <p>Roots: ${roots}</p>
      <ul class="tree">${familyTreeHtml(family.tree)}</ul>
    </article>`;
}

async function loadBreederFamilies(id) {
  const el = $("breeder-families");
  if (!el) return;
  el.innerHTML = `<p class="message">Loading...</p>`;
  try {
    const data = await api(`/breeders/${id}/pedigrees${SLASH}`);
    if (currentBreederId !== id) return;
    const families = data.families ?? [];
    if (!families.length) {
      el.innerHTML = `<p class="message">No family lines yet.</p>`;
      return;
    }
    el.innerHTML = `<div class="families">${families.map(familyCardHtml).join("")}</div>`;
  } catch (err) {
    if (currentBreederId !== id) return;
    el.innerHTML = `<p class="message">Could not load family lines: ${escapeHtml(err.message)}</p>`;
  }
}

// ---------- Авторизація ----------

function renderAuth() {
  const loggedIn = Boolean(tokens.access);
  $("auth-guest").hidden = loggedIn;
  $("auth-user").hidden = !loggedIn;
  $("hero-register").hidden = loggedIn;
  $("auth-username").textContent = localStorage.getItem(USERNAME_KEY) ?? "";
}

// Видаляє токени на клієнті
function clearSession() {
  tokens.clear();
  meCache = null;
  allCatsCache = null;
  renderAuth();
}

// Вихід: токени видаляються на клієнті завжди,
// а серверу додатково повідомляємо (на випадок blacklist refresh-токена)
async function logout() {
  const refresh = tokens.refresh;
  const access = tokens.access;
  clearSession();
  if (!refresh) return;
  try {
    await fetch(`${AUTH_URL}${AUTH_PATHS.logout}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
      },
      body: JSON.stringify({ refresh }),
    });
  } catch (e) {
    // помилка сервера не заважає виходу на клієнті
  }
}

function clearFormErrors(form) {
  form.querySelectorAll(".error").forEach((el) => (el.textContent = ""));
  form.querySelectorAll("input").forEach((el) => el.classList.remove("invalid"));
  form.querySelector(".form-error").textContent = "";
}

function showFieldError(form, name, text) {
  const el = form.querySelector(`[data-error-for="${name}"]`);
  const input = form.elements[name];
  if (el) el.textContent = text;
  if (input) input.classList.add("invalid");
  if (!el) {
    // немає відповідного поля у формі — показуємо помилку вгорі форми
    const general = form.querySelector(".form-error");
    general.textContent = (general.textContent ? general.textContent + " " : "") + `${name}: ${text}`;
  }
}

// Server messages are already in English
function translateServerText(text) {
  return String(text);
}

function joinMessages(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map(translateServerText).join(" ");
}

// Розкладає відповідь сервера (400/401) по полях форми
function showServerErrors(form, err) {
  const formError = form.querySelector(".form-error");

  // Сервер недоступний / проблема з мережею або CORS
  if (err instanceof TypeError) {
    formError.textContent = "Could not connect to the server. Make sure the backend is running.";
    return;
  }

  const data = err.data;
  let shownAny = false;
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      if (key === "non_field_errors" || key === "detail") continue;
      if (form.elements[key]) {
        showFieldError(form, key, joinMessages(value));
        shownAny = true;
      }
    }
    // Загальні помилки (non_field_errors, detail), наприклад невірний логін або пароль
    const general = data.non_field_errors ?? data.detail;
    if (general) {
      formError.textContent = joinMessages(general);
      shownAny = true;
    }
  }
  if (!shownAny) {
    formError.textContent = translateServerText(err.message);
  }
}

function validateRegister(v) {
  const errors = {};
  if (!v.username.trim()) errors.username = "Enter a username.";
  else if (v.username.length > 150) errors.username = "At most 150 characters.";

  if (v.first_name.length > 150) errors.first_name = "At most 150 characters.";
  if (v.last_name.length > 150) errors.last_name = "At most 150 characters.";

  if (!v.email.trim()) errors.email = "Enter an email.";
  else if (v.email.length > 254) errors.email = "At most 254 characters.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = "Invalid email (name@example.com).";

  if (!v.password) errors.password = "Enter a password.";
  else if (v.password.length < 8) errors.password = "At least 8 characters.";
  else if (v.password.length > 128) errors.password = "At most 128 characters.";
  else if (!/[A-Za-z]/.test(v.password) || !/\d/.test(v.password))
    errors.password = "Password must contain letters and digits.";

  if (!v.password_confirmation) errors.password_confirmation = "Repeat the password.";
  else if (v.password !== v.password_confirmation) errors.password_confirmation = "Passwords don't match.";

  return errors;
}

function setBusy(form, busy) {
  form.querySelector("button[type=submit]").disabled = busy;
}

async function doLogin(username, password) {
  const data = await request(AUTH_PATHS.login, {
    method: "POST",
    body: { username, password },
    auth: false,
    base: AUTH_URL,
  });
  tokens.set(data.access, data.refresh);
  localStorage.setItem(USERNAME_KEY, username);
  meCache = null;
  allCatsCache = null;
  renderAuth();
}

// ---------- Дії, що потребують входу ----------

// Дія, яку треба виконати після входу (повернення туди, звідки перенаправило на логін)
let pendingAction = null;

function openLoginDialog(hint) {
  const form = $("login-form");
  clearFormErrors(form);
  if (hint) form.querySelector(".form-error").textContent = hint;
  $("login-dialog").showModal();
}

// Виконує дію, якщо користувач увійшов; інакше відкриває логін і запам'ятовує дію
function requireAuth(action, hint) {
  if (tokens.access) {
    action();
  } else {
    pendingAction = action;
    openLoginDialog(hint);
  }
}

function runPendingAction() {
  const action = pendingAction;
  pendingAction = null;
  if (action) action();
}

// ---------- Профіль ----------

async function openProfile() {
  const details = $("profile-details");
  details.textContent = "Loading...";
  $("profile-dialog").showModal();
  try {
    const u = await request("/users/me/", { base: AUTH_URL });
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ");
    details.innerHTML = `
      <p><strong>Username:</strong> ${escapeHtml(u.username)}</p>
      <p><strong>Full name:</strong> ${fullName ? escapeHtml(fullName) : "not provided"}</p>
      <p><strong>Email:</strong> ${u.email ? escapeHtml(u.email) : "not provided"}</p>
      ${u.date_joined ? `<p><strong>Registered:</strong> ${escapeHtml(new Date(u.date_joined).toLocaleDateString("en-US"))}</p>` : ""}`;
    if (u.username) localStorage.setItem(USERNAME_KEY, u.username);
    renderAuth();
  } catch (err) {
    if (err instanceof TypeError) {
      details.textContent = "Could not connect to the server.";
    } else if (err.status === 401) {
      $("profile-dialog").close();
      clearSession();
      pendingAction = openProfile;
      openLoginDialog("Session expired. Please log in again.");
    } else {
      details.textContent = `Could not load profile: ${translateServerText(err.message)}`;
    }
  }
}

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  clearFormErrors(form);

  const v = Object.fromEntries(new FormData(form).entries());
  const errors = validateRegister(v);
  if (Object.keys(errors).length) {
    for (const [name, text] of Object.entries(errors)) showFieldError(form, name, text);
    return;
  }

  const body = {
    username: v.username.trim(),
    first_name: v.first_name.trim(),
    last_name: v.last_name.trim(),
    email: v.email.trim(),
    password: v.password,
    password_confirmation: v.password_confirmation,
  };

  setBusy(form, true);
  try {
    await request(AUTH_PATHS.register, { method: "POST", body, auth: false, base: AUTH_URL });
    // Після успішної реєстрації одразу входимо
    await doLogin(body.username, body.password);
    form.reset();
    $("register-dialog").close();
    runPendingAction();
  } catch (err) {
    showServerErrors(form, err);
  } finally {
    setBusy(form, false);
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  clearFormErrors(form);

  const v = Object.fromEntries(new FormData(form).entries());
  let hasError = false;
  if (!v.username.trim()) { showFieldError(form, "username", "Enter a username."); hasError = true; }
  if (!v.password) { showFieldError(form, "password", "Enter a password."); hasError = true; }
  if (hasError) return;

  setBusy(form, true);
  try {
    await doLogin(v.username.trim(), v.password);
    form.reset();
    $("login-dialog").close();
    runPendingAction();
  } catch (err) {
    showServerErrors(form, err);
  } finally {
    setBusy(form, false);
  }
});

function openRegisterDialog() {
  clearFormErrors($("register-form"));
  $("register-dialog").showModal();
}

$("open-login").addEventListener("click", () => {
  // Авторизованого користувача на сторінку логіну не пускаємо — перенаправляємо на контент
  if (tokens.access) goToContent();
  else openLoginDialog();
});
// Закрили вікно логіну вручну — повертатися нікуди
$("login-dialog").addEventListener("close", () => { pendingAction = null; });
$("open-register").addEventListener("click", openRegisterDialog);
$("hero-register").addEventListener("click", openRegisterDialog);
$("logout-btn").addEventListener("click", () => {
  $("profile-dialog").close();
  logout();
});
$("profile-btn").addEventListener("click", () =>
  requireAuth(openProfile, "Log in to view your profile."));

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => $(btn.dataset.close).close());
});

// ---------- Навігація ----------

let catsLoaded = false;

function showView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll("main > section").forEach((sec) => {
    sec.hidden = sec.id !== `view-${view}`;
  });
  if (PAGE_ENDPOINTS[view]) loadPage(view);
  if (view === "cats" && !catsLoaded) { catsLoaded = true; loadCats(1); }
  if (view === "breeders") loadBreeders();
  window.scrollTo({ top: 0 });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});
document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.go));
});

// «Редирект» на контент: закриваємо вікна й показуємо каталог котів
function goToContent() {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  showView("cats");
}

// ---------- Події каталогу ----------

$("filter-apply").addEventListener("click", () => loadCats(1));

// Enter у текстових і числових полях застосовує фільтри
["filter-search", "filter-min-price", "filter-max-price"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadCats(1);
  });
});

// Зміна випадного списку одразу оновлює каталог
["filter-breed", "filter-breeder", "filter-country", "filter-status", "filter-sort-by", "filter-order", "filter-limit"].forEach((id) => {
  $(id).addEventListener("change", () => loadCats(1));
});

$("filter-reset").addEventListener("click", () => {
  document.querySelectorAll(".filters input").forEach((el) => (el.value = ""));
  ["filter-breed", "filter-breeder", "filter-country", "filter-status"].forEach((id) => ($(id).value = ""));
  $("filter-sort-by").value = "created_at";
  $("filter-order").value = "desc";
  $("filter-limit").value = "10";
  loadCats(1);
});

$("cats").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openCat(card.dataset.id);
});
$("cats").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const card = e.target.closest(".card");
    if (card) openCat(card.dataset.id);
  }
});

$("breeders").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openBreeder(card.dataset.id);
});
$("breeders").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const card = e.target.closest(".card");
    if (card) openBreeder(card.dataset.id);
  }
});

// Клік на кота у вікні заводчика: закрити це вікно й відкрити кота
function openCatFromBreeder(e) {
  const card = e.target.closest("[data-cat-id]");
  if (!card) return;
  $("breeder-dialog").close();
  openCat(card.dataset.catId);
}
$("breeder-details").addEventListener("click", openCatFromBreeder);
$("breeder-details").addEventListener("keydown", (e) => {
  if (e.key === "Enter") openCatFromBreeder(e);
});

// Клік на заводчика у вікні кота: закрити це вікно й відкрити заводчика
$("cat-details").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-breeder-id]");
  if (!btn) return;
  $("cat-dialog").close();
  openBreeder(btn.dataset.breederId);
});

// Клік по вузлу родоводу: відкрити картку цього кота
$("cat-details").addEventListener("click", (e) => {
  const node = e.target.closest("[data-cat-id]");
  if (!node) return;
  const id = node.dataset.catId;
  if (id && id !== String(currentCatId)) openCat(id);
});

$("dialog-close").addEventListener("click", () => $("cat-dialog").close());
$("breeder-dialog-close").addEventListener("click", () => $("breeder-dialog").close());

renderAuth();
loadBreeds();
loadBreederFilters();
showView("home");
