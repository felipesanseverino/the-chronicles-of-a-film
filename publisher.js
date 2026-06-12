const state = {
  mode: "new",
  series: [],
  files: [],
  existingPhotos: [],
  removedPhotos: new Set(),
  heroIndex: 0,
  coverSource: "new",
  existingHero: "",
  settingsOpen: false,
  workspace: "site",
  cloudSelections: new Set(),
  queue: [],
  queueBackendReady: false,
  autoQueue: {
    enabled: false,
    time: "09:00",
    timezone: "Europe/Amsterdam",
  },
};

const CLOUDINARY_BASE_URL = "https://res.cloudinary.com/dttbzi3he/image/upload";
const QUEUE_STORAGE_KEY = "tcofStudioInstagramQueue";
const AUTO_QUEUE_STORAGE_KEY = "tcofStudioAutoQueue";
const captionSaveTimers = new Map();

const els = {
  setupPanel: document.getElementById("setupPanel"),
  settingsBtn: document.getElementById("settingsBtn"),
  saveSettings: document.getElementById("saveSettings"),
  supabaseUrl: document.getElementById("supabaseUrl"),
  publisherToken: document.getElementById("publisherToken"),
  newMode: document.getElementById("newMode"),
  updateMode: document.getElementById("updateMode"),
  existingWrap: document.getElementById("existingWrap"),
  existingSeries: document.getElementById("existingSeries"),
  title: document.getElementById("title"),
  slug: document.getElementById("slug"),
  meta: document.getElementById("meta"),
  description: document.getElementById("description"),
  essayNote: document.getElementById("essayNote"),
  closingText: document.getElementById("closingText"),
  selectedPhotos: document.getElementById("selectedPhotos"),
  contactSheetPhotos: document.getElementById("contactSheetPhotos"),
  captions: document.getElementById("captions"),
  photos: document.getElementById("photos"),

  photoGrid: document.getElementById("photoGrid"),
  photoCount: document.getElementById("photoCount"),
  currentPhotosBlock: document.getElementById("currentPhotosBlock"),
  currentPhotoGrid: document.getElementById("currentPhotoGrid"),
  currentPhotoCount: document.getElementById("currentPhotoCount"),
  publishBtn: document.getElementById("publishBtn"),
  progress: document.getElementById("progress"),
  statusText: document.getElementById("statusText"),
  siteWorkspace: document.getElementById("siteWorkspace"),
  instagramWorkspace: document.getElementById("instagramWorkspace"),
  siteStudio: document.getElementById("siteStudio"),
  instagramStudio: document.getElementById("instagramStudio"),
  cloudFolder: document.getElementById("cloudFolder"),
  cloudSearch: document.getElementById("cloudSearch"),
  cloudBrowser: document.getElementById("cloudBrowser"),
  browserCount: document.getElementById("browserCount"),
  queueSelectedBtn: document.getElementById("queueSelectedBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  queueList: document.getElementById("queueList"),
  queueCount: document.getElementById("queueCount"),
  queuedStat: document.getElementById("queuedStat"),
  approvedStat: document.getElementById("approvedStat"),
  publishedStat: document.getElementById("publishedStat"),
  autoQueueEnabled: document.getElementById("autoQueueEnabled"),
  dailyPostTime: document.getElementById("dailyPostTime"),
  postTimezone: document.getElementById("postTimezone"),
  autoQueueSummary: document.getElementById("autoQueueSummary"),
};

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function publicIdFromName(name) {
  return name.replace(/\.[^.]+$/, "").toUpperCase();
}

function photoNameFromFile(file) {
  return `${publicIdFromName(file.name)}.jpg`;
}

function cloudUrl(folder, filename, transforms = "f_auto,q_auto,w_360") {
  return `${CLOUDINARY_BASE_URL}/${transforms}/${folder}/${encodeURIComponent(filename)}`;
}

function sourceKey(folder, filename) {
  return `${folder}/${filename}`;
}

function listFromTextarea(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listToTextarea(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function loadStudioState() {
  try {
    const queue = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || "[]");
    state.queue = Array.isArray(queue) ? queue : [];
  } catch {
    state.queue = [];
  }
  try {
    state.autoQueue = {
      ...state.autoQueue,
      ...JSON.parse(localStorage.getItem(AUTO_QUEUE_STORAGE_KEY) || "{}"),
    };
  } catch {
    state.autoQueue = { enabled: false, time: "09:00", timezone: "Europe/Amsterdam" };
  }
}

function normalizeQueueItem(item) {
  return {
    id: item.id,
    cloudinary_asset_id: item.cloudinary_asset_id || "",
    cloudinary_public_id: item.cloudinary_public_id,
    original_folder: item.original_folder,
    filename: item.filename || String(item.cloudinary_public_id || "").split("/").pop() || "photo",
    queue_public_id: item.queue_public_id,
    queue_url: item.queue_url,
    cloudinary_phash: item.cloudinary_phash || "",
    caption: item.caption || "",
    status: item.status || "queued",
    imported_at: item.imported_at || item.created_at || new Date().toISOString(),
    scheduled_at: item.scheduled_at || null,
    scheduled_date: item.scheduled_at ? item.scheduled_at.slice(0, 10) : "",
    published_at: item.published_at || "",
    skipped_at: item.skipped_at || "",
    failed_at: item.failed_at || "",
    last_error: item.last_error || "",
  };
}

function normalizeSettings(settings = {}) {
  return {
    enabled: Boolean(settings.auto_queue_enabled),
    time: String(settings.daily_post_time || "09:00").slice(0, 5),
    timezone: settings.timezone || "Europe/Amsterdam",
  };
}

async function loadQueue() {
  try {
    const data = await functionFetch("queue", {});
    state.queue = Array.isArray(data.photos) ? data.photos.map(normalizeQueueItem) : [];
    state.autoQueue = normalizeSettings(data.settings);
    state.queueBackendReady = true;
    saveStudioQueue();
    saveAutoQueue();
  } catch (error) {
    state.queueBackendReady = false;
    setStatus(error.message || "queue backend unavailable", 0);
  }
  renderCloudBrowser();
  renderQueue();
}

function saveStudioQueue() {
  localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state.queue));
}

function saveAutoQueue() {
  localStorage.setItem(AUTO_QUEUE_STORAGE_KEY, JSON.stringify(state.autoQueue));
}

function currentQueueSourceKeys() {
  return new Set(state.queue.map((item) => item.cloudinary_public_id));
}

function queuedBefore(folder, filename) {
  return currentQueueSourceKeys().has(sourceKey(folder, filename));
}

function setStatus(text, pct = null) {
  els.statusText.textContent = text;
  if (pct !== null) els.progress.value = pct;
}

function getSettings() {
  const config = window.TCOF_PUBLISHER_CONFIG || {};
  return {
    supabaseUrl: localStorage.getItem("tcofPublisherSupabaseUrl") || config.supabaseUrl || "",
    supabaseKey: config.supabaseKey || "",
    publisherToken: localStorage.getItem("tcofPublisherToken") || config.publisherToken || "",
  };
}

function saveSettings() {
  localStorage.setItem("tcofPublisherSupabaseUrl", els.supabaseUrl.value.trim().replace(/\/$/, ""));
  localStorage.setItem("tcofPublisherToken", els.publisherToken.value.trim());
  state.settingsOpen = false;
  renderSettings();
}

function renderSettings() {
  const settings = getSettings();
  els.supabaseUrl.value = settings.supabaseUrl;
  els.publisherToken.value = settings.publisherToken;
  els.setupPanel.hidden = Boolean(settings.supabaseUrl && settings.publisherToken && !state.settingsOpen);
}

function functionUrl(action) {
  const { supabaseUrl } = getSettings();
  if (!supabaseUrl) throw new Error("Add your Supabase URL in settings.");
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/tcof-publisher/${action}`;
}

async function functionFetch(action, body) {
  const { publisherToken, supabaseKey } = getSettings();
  if (!publisherToken) throw new Error("Add your publisher token in settings.");
  const headers = {
    "Content-Type": "application/json",
    "X-Publisher-Token": publisherToken,
  };
  if (supabaseKey) {
    headers.apikey = supabaseKey;
    headers.Authorization = `Bearer ${supabaseKey}`;
  }
  let res;
  try {
    res = await fetch(functionUrl(action), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Supabase. Check internet, Supabase URL, and function deployment.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Publisher request failed.");
  return data;
}

async function loadSeries() {
  try {
    const data = await functionFetch("series", {});
    state.series = Array.isArray(data.series) ? data.series : [];
  } catch {
    if (Array.isArray(window.series)) {
      state.series = window.series;
    } else if (typeof series !== "undefined" && Array.isArray(series)) {
      state.series = series;
    } else {
      const res = await fetch(`/config.js?ts=${Date.now()}`);
      const source = await res.text();
      const match = source.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
      state.series = match ? Function(`"use strict"; return (${match[1]});`)() : [];
    }
  }
  els.existingSeries.innerHTML = state.series
    .map((s) => `<option value="${s.slug}">${s.title}</option>`)
    .join("");
  renderCloudFolders();
}

function setWorkspace(workspace) {
  state.workspace = workspace;
  els.siteWorkspace.classList.toggle("active", workspace === "site");
  els.instagramWorkspace.classList.toggle("active", workspace === "instagram");
  els.siteStudio.hidden = workspace !== "site";
  els.instagramStudio.hidden = workspace !== "instagram";
  if (workspace === "instagram") {
    renderCloudFolders();
    renderCloudBrowser();
    renderQueue();
  }
}

function renderCloudFolders() {
  if (!els.cloudFolder) return;
  els.cloudFolder.innerHTML = state.series.length
    ? state.series.map((s) => `<option value="${s.slug}">${s.title}</option>`).join("")
    : `<option value="">No website folders yet</option>`;
}

function selectedCloudSeries() {
  return state.series.find((s) => s.slug === els.cloudFolder.value) || state.series[0];
}

function visibleCloudPhotos() {
  const s = selectedCloudSeries();
  if (!s) return [];
  const query = els.cloudSearch.value.trim().toLowerCase();
  return (s.photos || [])
    .map((filename) => ({ series: s, filename }))
    .filter(({ series, filename }) => {
      if (!query) return true;
      return filename.toLowerCase().includes(query) || series.title.toLowerCase().includes(query) || series.folder.toLowerCase().includes(query);
    });
}

function renderCloudBrowser() {
  const photos = visibleCloudPhotos();
  const selected = state.cloudSelections.size;
  els.browserCount.textContent = photos.length
    ? `${photos.length} photo${photos.length === 1 ? "" : "s"} available${selected ? ` - ${selected} selected` : ""}`
    : "no matching website photos";
  els.cloudBrowser.innerHTML = "";

  photos.forEach(({ series: s, filename }) => {
    const key = sourceKey(s.folder, filename);
    const card = document.createElement("button");
    card.type = "button";
    card.className = [
      "photo-card",
      state.cloudSelections.has(key) ? "selected" : "",
      queuedBefore(s.folder, filename) ? "duplicate" : "",
    ].filter(Boolean).join(" ");
    card.title = `${filename} - ${s.title}`;

    const img = document.createElement("img");
    img.src = cloudUrl(s.folder, filename);
    img.alt = filename;

    card.append(img);
    card.addEventListener("click", () => {
      if (state.cloudSelections.has(key)) state.cloudSelections.delete(key);
      else state.cloudSelections.add(key);
      renderCloudBrowser();
    });
    els.cloudBrowser.append(card);
  });
}

function queueStats() {
  return {
    queued: state.queue.filter((item) => item.status === "queued").length,
    approved: state.queue.filter((item) => item.status === "approved" || item.status === "scheduled").length,
    published: state.queue.filter((item) => item.status === "published").length,
  };
}

function nextAutoQueueDate() {
  const [hour, minute] = (state.autoQueue.time || "09:00").split(":").map((part) => Number(part));
  const next = new Date();
  next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.toISOString().slice(0, 10);
}

function applyAutoQueue() {
  if (state.queueBackendReady) return;
  if (!state.autoQueue.enabled) return;
  if (state.queue.some((item) => item.status === "scheduled")) return;
  const next = [...state.queue]
    .filter((item) => item.status === "approved" && !item.scheduled_date)
    .sort((a, b) => String(a.imported_at).localeCompare(String(b.imported_at)))[0];
  if (!next) return;
  next.scheduled_date = nextAutoQueueDate();
  next.status = "scheduled";
  saveStudioQueue();
}

function updateQueueStats() {
  if (!state.queueBackendReady) applyAutoQueue();
  const stats = queueStats();
  els.queuedStat.textContent = String(stats.queued);
  els.approvedStat.textContent = String(stats.approved);
  els.publishedStat.textContent = String(stats.published);
  els.queueCount.textContent = state.queue.length
    ? `${state.queue.length} queue cop${state.queue.length === 1 ? "y" : "ies"}`
    : "no queue copies yet";
  els.autoQueueEnabled.checked = Boolean(state.autoQueue.enabled);
  els.dailyPostTime.value = state.autoQueue.time || "09:00";
  els.postTimezone.value = state.autoQueue.timezone || "Europe/Amsterdam";
  els.autoQueueSummary.textContent = state.autoQueue.enabled
    ? `daily at ${state.autoQueue.time || "09:00"} - ${state.autoQueue.timezone || "Europe/Amsterdam"}`
    : "disabled";
}

async function refreshQueueFromBackend() {
  if (!state.queueBackendReady) return;
  try {
    const data = await functionFetch("queue", {});
    state.queue = Array.isArray(data.photos) ? data.photos.map(normalizeQueueItem) : [];
    state.autoQueue = normalizeSettings(data.settings);
    saveStudioQueue();
    saveAutoQueue();
  } catch (error) {
    state.queueBackendReady = false;
    setStatus(error.message || "queue backend unavailable", 0);
  }
}

async function updateQueueItem(item, patch) {
  if (!state.queueBackendReady) {
    Object.assign(item, patch);
    if (patch.scheduled_at !== undefined) item.scheduled_date = patch.scheduled_at ? patch.scheduled_at.slice(0, 10) : "";
    saveStudioQueue();
    renderQueue();
    return;
  }

  const data = await functionFetch("queue-update", {
    id: item.id,
    ...patch,
  });
  const next = normalizeQueueItem(data.photo);
  state.queue = state.queue.map((entry) => (entry.id === next.id ? next : entry));
  saveStudioQueue();
  await refreshQueueFromBackend();
  renderQueue();
  renderCloudBrowser();
}

async function publishQueueItem(item) {
  if (!state.queueBackendReady) {
    throw new Error("Connect to Supabase before publishing to Instagram.");
  }
  const data = await functionFetch("queue-publish", { id: item.id });
  const next = normalizeQueueItem(data.photo);
  state.queue = state.queue.map((entry) => (entry.id === next.id ? next : entry));
  saveStudioQueue();
  await refreshQueueFromBackend();
  renderQueue();
  renderCloudBrowser();
  return next;
}

function renderQueue() {
  updateQueueStats();
  els.queueList.innerHTML = "";
  if (!state.queue.length) {
    const empty = document.createElement("p");
    empty.className = "queue-meta";
    empty.textContent = "select photos from a website folder, then queue copies for instagram";
    els.queueList.append(empty);
    return;
  }

  state.queue.forEach((item) => {
    const row = document.createElement("article");
    row.className = "queue-item";

    const img = document.createElement("img");
    img.src = item.queue_url || cloudUrl(item.original_folder, item.filename);
    img.alt = item.filename;

    const copy = document.createElement("div");
    copy.className = "queue-copy";

    const title = document.createElement("p");
    title.className = "queue-title";
    title.textContent = item.filename;

    const meta = document.createElement("p");
    meta.className = "queue-meta";
    meta.textContent = `${item.original_folder} -> ${item.queue_public_id}`;

    const caption = document.createElement("textarea");
    caption.rows = 2;
    caption.placeholder = "caption";
    caption.value = item.caption || "";
    const saveCaption = async () => {
      item.caption = caption.value;
      try {
        await updateQueueItem(item, { caption: caption.value });
        setStatus("caption saved", 100);
      } catch (error) {
        setStatus(error.message || "could not save caption", 0);
      }
    };
    caption.addEventListener("input", () => {
      clearTimeout(captionSaveTimers.get(item.id));
      captionSaveTimers.set(item.id, setTimeout(saveCaption, 900));
    });
    caption.addEventListener("change", saveCaption);

    const scheduled = document.createElement("input");
    scheduled.type = "date";
    scheduled.value = item.scheduled_date || "";
    scheduled.addEventListener("change", async () => {
      item.scheduled_date = scheduled.value;
      const scheduledAt = scheduled.value ? `${scheduled.value}T00:00:00.000Z` : null;
      try {
        await updateQueueItem(item, {
          scheduled_at: scheduledAt,
          ...(scheduled.value ? { status: "scheduled" } : {}),
        });
      } catch (error) {
        setStatus(error.message || "could not schedule photo", 0);
      }
    });

    const status = document.createElement("p");
    status.className = "queue-status";
    status.textContent = item.last_error ? `${item.status}: ${item.last_error}` : item.status;

    const duplicate = state.queue.some((other) => other !== item && other.cloudinary_public_id === item.cloudinary_public_id);
    const duplicateNote = document.createElement("p");
    duplicateNote.className = "duplicate-note";
    duplicateNote.textContent = duplicate ? "possible duplicate detected" : "";

    const actions = document.createElement("div");
    actions.className = "queue-actions";

    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary-action";
    approve.textContent = item.status === "approved" || item.status === "scheduled" ? "approved" : "approve";
    approve.addEventListener("click", async () => {
      try {
        await updateQueueItem(item, { status: item.scheduled_date ? "scheduled" : "approved" });
        if (state.queueBackendReady && state.autoQueue.enabled) await functionFetch("auto-schedule", {});
        await refreshQueueFromBackend();
        renderQueue();
      } catch (error) {
        setStatus(error.message || "could not approve photo", 0);
      }
    });

    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "skip";
    skip.addEventListener("click", async () => {
      try {
        await updateQueueItem(item, { status: "skipped" });
      } catch (error) {
        setStatus(error.message || "could not skip photo", 0);
      }
    });

    const published = document.createElement("button");
    published.type = "button";
    published.textContent = "publish";
    published.addEventListener("click", async () => {
      if (["skipped", "published", "failed"].includes(item.status)) return;
      published.disabled = true;
      setStatus(`publishing ${item.filename}`, 30);
      try {
        const next = await publishQueueItem(item);
        setStatus(next.instagram_media_id ? `published: ${next.instagram_media_id}` : "published", 100);
      } catch (error) {
        setStatus(error.message || "could not publish photo", 0);
      } finally {
        published.disabled = false;
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-action";
    remove.textContent = "delete copy";
    remove.addEventListener("click", async () => {
      try {
        if (state.queueBackendReady) {
          await functionFetch("queue-delete", { id: item.id });
        }
        state.queue = state.queue.filter((entry) => entry.id !== item.id);
        saveStudioQueue();
        renderQueue();
        renderCloudBrowser();
      } catch (error) {
        setStatus(error.message || "could not delete queue copy", 0);
      }
    });

    actions.append(approve, skip, published, remove);
    copy.append(title, meta, caption, scheduled, status, duplicateNote, actions);
    row.append(img, copy);
    els.queueList.append(row);
  });
}

function selectedSeries() {
  return state.series.find((s) => s.slug === els.existingSeries.value);
}

function fillFromSeries() {
  const s = selectedSeries();
  if (!s) return;
  els.title.value = s.title || "";
  els.slug.value = s.slug || "";
  els.meta.value = s.meta || "";
  els.description.value = s.description || "";
  els.essayNote.value = s.essayNote || "";
  els.closingText.value = s.closingText || "";
  els.selectedPhotos.value = listToTextarea(s.selectedPhotos);
  els.contactSheetPhotos.value = listToTextarea(s.contactSheetPhotos);
  els.captions.value = listToTextarea(s.captions);
  state.existingPhotos = [...(s.photos || [])];
  state.removedPhotos = new Set();
  state.existingHero = state.existingPhotos[0] || "";
  state.coverSource = state.existingHero ? "existing" : "new";
  renderExistingPhotos();
}

function setMode(mode) {
  state.mode = mode;
  els.newMode.classList.toggle("active", mode === "new");
  els.updateMode.classList.toggle("active", mode === "update");
  els.existingWrap.hidden = mode !== "update";
  if (mode === "update") {
    fillFromSeries();
  } else {
    state.existingPhotos = [];
    state.removedPhotos = new Set();
    state.existingHero = "";
    state.coverSource = "new";
    els.essayNote.value = "";
    els.closingText.value = "";
    els.selectedPhotos.value = "";
    els.contactSheetPhotos.value = "";
    els.captions.value = "";
    renderExistingPhotos();
  }
}

function keptExistingPhotos() {
  return state.existingPhotos.filter((photo) => !state.removedPhotos.has(photo));
}

function ensureExistingCover() {
  if (state.coverSource !== "existing") return;
  if (state.existingHero && !state.removedPhotos.has(state.existingHero)) return;
  const kept = keptExistingPhotos();
  if (kept.length) {
    state.existingHero = kept[0];
    return;
  }
  state.existingHero = "";
  state.coverSource = state.files.length ? "new" : "existing";
}

function renderExistingPhotos() {
  const s = selectedSeries();
  const show = state.mode === "update" && s && state.existingPhotos.length;
  els.currentPhotosBlock.hidden = !show;
  els.currentPhotoGrid.innerHTML = "";
  if (!show) {
    els.currentPhotoCount.textContent = "no current photos";
    return;
  }

  ensureExistingCover();
  const kept = keptExistingPhotos();
  els.currentPhotoCount.textContent = `${kept.length} of ${state.existingPhotos.length} kept`;

  state.existingPhotos.forEach((photo) => {
    const removed = state.removedPhotos.has(photo);
    const card = document.createElement("div");
    card.className = [
      "photo-card",
      state.coverSource === "existing" && state.existingHero === photo && !removed ? "hero" : "",
      removed ? "removed" : "",
    ].filter(Boolean).join(" ");

    const img = document.createElement("img");
    img.src = cloudUrl(s.folder, photo);
    img.alt = photo;

    const actions = document.createElement("div");
    actions.className = "photo-actions";

    const coverBtn = document.createElement("button");
    coverBtn.type = "button";
    coverBtn.textContent = state.coverSource === "existing" && state.existingHero === photo ? "cover" : "use";
    coverBtn.hidden = removed;
    coverBtn.addEventListener("click", () => {
      state.coverSource = "existing";
      state.existingHero = photo;
      renderExistingPhotos();
      renderPhotos();
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.textContent = removed ? "keep" : "del";
    toggleBtn.addEventListener("click", () => {
      if (removed) state.removedPhotos.delete(photo);
      else state.removedPhotos.add(photo);
      ensureExistingCover();
      renderExistingPhotos();
    });

    actions.append(coverBtn, toggleBtn);
    card.append(img, actions);
    els.currentPhotoGrid.append(card);
  });
}

function renderPhotos() {
  els.photoCount.textContent = state.files.length
    ? `${state.files.length} photo${state.files.length === 1 ? "" : "s"} selected`
    : "no photos selected";
  els.photoGrid.innerHTML = "";

  state.files.forEach((file, index) => {
    const card = document.createElement("div");
    card.className = `photo-card${state.coverSource === "new" && index === state.heroIndex ? " hero" : ""}`;

    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(img.src);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = state.coverSource === "new" && index === state.heroIndex ? "cover" : "use";
    btn.addEventListener("click", () => {
      state.coverSource = "new";
      state.heroIndex = index;
      renderPhotos();
      renderExistingPhotos();
    });

    const actions = document.createElement("div");
    actions.className = "photo-actions";
    actions.append(btn);
    card.append(img, actions);
    els.photoGrid.append(card);
  });
}

async function compressPhoto(file, maxWidth = 3000, quality = 0.82) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error(`Could not compress ${file.name}`));
      else resolve(blob);
    }, "image/jpeg", quality);
  });
}

async function uploadOne(file, slug) {
  const publicId = publicIdFromName(file.name);
  const signed = await functionFetch("sign-upload", {
    folder: `chronicles/${slug}`,
    publicId,
  });
  const compressed = await compressPhoto(file);
  const form = new FormData();
  form.set("file", compressed, `${publicId}.jpg`);
  form.set("api_key", signed.apiKey);
  form.set("timestamp", signed.timestamp);
  form.set("signature", signed.signature);
  form.set("folder", signed.folder);
  form.set("public_id", signed.publicId);
  form.set("overwrite", "false");

  const res = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (!String(data.error?.message || "").toLowerCase().includes("already exists")) {
      throw new Error(data.error?.message || `Could not upload ${file.name}`);
    }
  }
  return photoNameFromFile(file);
}

function queueEntryFromPhoto({ series: s, filename }, copy = {}) {
  const baseName = publicIdFromName(filename);
  const id = copy.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    cloudinary_asset_id: copy.cloudinary_asset_id || "",
    cloudinary_public_id: sourceKey(s.folder, filename),
    original_folder: s.folder,
    filename,
    queue_public_id: copy.queue_public_id || `autogram_queue/${baseName}`,
    queue_url: copy.queue_url || cloudUrl(s.folder, filename),
    cloudinary_phash: copy.cloudinary_phash || "",
    caption: copy.caption || "",
    status: copy.status || "queued",
    imported_at: copy.imported_at || new Date().toISOString(),
    scheduled_date: copy.scheduled_date || "",
  };
}

async function copyToInstagramQueue(photo) {
  try {
    const copy = await functionFetch("queue-copy", {
      sourceFolder: photo.series.folder,
      filename: photo.filename,
    });
    state.queueBackendReady = true;
    return normalizeQueueItem(copy.photo || copy);
  } catch (error) {
    state.queueBackendReady = false;
    return queueEntryFromPhoto(photo, {
      error: error.message || "queue copy will be created when the function is deployed",
    });
  }
}

async function queueSelectedPhotos() {
  const selected = visibleCloudPhotos().filter(({ series: s, filename }) => state.cloudSelections.has(sourceKey(s.folder, filename)));
  if (!selected.length) {
    setStatus("select photos to queue", 0);
    return;
  }

  els.queueSelectedBtn.disabled = true;
  setStatus("creating instagram queue copies", 10);
  const current = currentQueueSourceKeys();
  const next = [];

  for (let i = 0; i < selected.length; i += 1) {
    const photo = selected[i];
    const key = sourceKey(photo.series.folder, photo.filename);
    if (current.has(key)) continue;
    setStatus(`queueing ${photo.filename}`, Math.round((i / selected.length) * 80) + 10);
    next.push(await copyToInstagramQueue(photo));
  }

  state.queue = [...next, ...state.queue];
  state.cloudSelections.clear();
  saveStudioQueue();
  if (state.queueBackendReady) await refreshQueueFromBackend();
  renderCloudBrowser();
  renderQueue();
  setStatus(next.length ? "instagram queue updated" : "possible duplicate detected", 100);
  els.queueSelectedBtn.disabled = false;
}

async function publish() {
  const title = els.title.value.trim();
  const slug = slugify(els.slug.value.trim() || title);
  const meta = els.meta.value.trim();
  const description = els.description.value.trim();
  const essayNote = els.essayNote.value.trim();
  const closingText = els.closingText.value.trim();
  const selectedPhotos = listFromTextarea(els.selectedPhotos.value);
  const contactSheetPhotos = listFromTextarea(els.contactSheetPhotos.value);
  const captions = listFromTextarea(els.captions.value);

  if (!title || !slug || !meta) throw new Error("Fill title, slug, and meta.");
  const keptExisting = state.mode === "update" ? keptExistingPhotos() : [];
  if (state.mode === "new" && !state.files.length) throw new Error("Choose at least one photo.");
  if (state.mode === "update" && !keptExisting.length && !state.files.length) {
    throw new Error("Keep or add at least one photo.");
  }

  els.publishBtn.disabled = true;
  setStatus("preparing photos", 3);

  const uploaded = [];
  for (let i = 0; i < state.files.length; i += 1) {
    const file = state.files[i];
    setStatus(`uploading ${file.name}`, Math.round((i / state.files.length) * 82) + 5);
    uploaded.push(await uploadOne(file, slug));
  }

  const photos = state.mode === "update" ? [...keptExisting, ...uploaded] : uploaded;
  const hero = state.coverSource === "existing" && keptExisting.includes(state.existingHero)
    ? state.existingHero
    : (uploaded[state.heroIndex] || photos[0]);
  setStatus("updating the site", 92);
  const result = await functionFetch("publish", {
    slug,
    title,
    meta,
    description,
    essayNote,
    closingText,
    selectedPhotos,
    contactSheetPhotos,
    captions,
    isNew: state.mode === "new",
    replacePhotos: state.mode === "update",
    photos,
    hero,
  });

  setStatus("published", 100);
  await loadSeries();
  return result;
}

els.settingsBtn.addEventListener("click", () => {
  state.settingsOpen = !state.settingsOpen;
  renderSettings();
});

els.siteWorkspace.addEventListener("click", () => setWorkspace("site"));
els.instagramWorkspace.addEventListener("click", () => setWorkspace("instagram"));
els.saveSettings.addEventListener("click", saveSettings);
els.newMode.addEventListener("click", () => setMode("new"));
els.updateMode.addEventListener("click", () => setMode("update"));
els.existingSeries.addEventListener("change", fillFromSeries);
els.cloudFolder.addEventListener("change", () => {
  state.cloudSelections.clear();
  renderCloudBrowser();
});
els.cloudSearch.addEventListener("input", renderCloudBrowser);
els.queueSelectedBtn.addEventListener("click", queueSelectedPhotos);
els.clearSelectionBtn.addEventListener("click", () => {
  state.cloudSelections.clear();
  renderCloudBrowser();
});
els.autoQueueEnabled.addEventListener("change", () => {
  state.autoQueue.enabled = els.autoQueueEnabled.checked;
  saveAutoQueue();
  (async () => {
    try {
      if (state.queueBackendReady) {
        await functionFetch("settings", { auto_queue_enabled: state.autoQueue.enabled });
        if (state.autoQueue.enabled) await functionFetch("auto-schedule", {});
        await refreshQueueFromBackend();
      } else {
        applyAutoQueue();
      }
      renderQueue();
    } catch (error) {
      setStatus(error.message || "could not save auto queue", 0);
    }
  })();
});
els.dailyPostTime.addEventListener("change", () => {
  state.autoQueue.time = els.dailyPostTime.value || "09:00";
  saveAutoQueue();
  (async () => {
    try {
      if (state.queueBackendReady) {
        await functionFetch("settings", { daily_post_time: state.autoQueue.time });
        await refreshQueueFromBackend();
      } else {
        applyAutoQueue();
      }
      renderQueue();
    } catch (error) {
      setStatus(error.message || "could not save posting time", 0);
    }
  })();
});
els.postTimezone.addEventListener("change", () => {
  state.autoQueue.timezone = els.postTimezone.value.trim() || "Europe/Amsterdam";
  saveAutoQueue();
  (async () => {
    try {
      if (state.queueBackendReady) {
        await functionFetch("settings", { timezone: state.autoQueue.timezone });
        await refreshQueueFromBackend();
      }
      updateQueueStats();
    } catch (error) {
      setStatus(error.message || "could not save timezone", 0);
    }
  })();
});
els.title.addEventListener("input", () => {
  if (state.mode === "new") els.slug.value = slugify(els.title.value);
});
els.photos.addEventListener("change", () => {
  state.files = [...els.photos.files].sort((a, b) => a.name.localeCompare(b.name));
  state.heroIndex = 0;
  if (state.mode === "new" || !keptExistingPhotos().length) state.coverSource = "new";
  renderPhotos();
  renderExistingPhotos();
});
els.publishBtn.addEventListener("click", async () => {
  try {
    const result = await publish();
    if (result.url) setStatus(`published: ${result.url}`, 100);
  } catch (error) {
    setStatus(error.message || "publish failed", 0);
  } finally {
    els.publishBtn.disabled = false;
  }
});

loadStudioState();
renderSettings();
renderQueue();
loadSeries().then(() => {
  if (state.mode === "update" && state.series.length) fillFromSeries();
  renderCloudBrowser();
  return loadQueue();
}).catch(() => setStatus("could not load current series", 0));
