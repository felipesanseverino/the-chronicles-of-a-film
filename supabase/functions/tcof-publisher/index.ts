const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-publisher-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Series = {
  slug: string;
  type?: "archive" | "chapter";
  title: string;
  meta: string;
  description?: string;
  essayNote?: string;
  closingText?: string;
  selectedPhotos?: string[];
  contactSheetPhotos?: string[];
  captions?: string[];
  photoFolders?: Record<string, string>;
  folder: string;
  photos: string[];
};

type PublishPayload = {
  slug: string;
  type?: "archive" | "chapter";
  title: string;
  meta: string;
  description?: string;
  essayNote?: string;
  closingText?: string;
  selectedPhotos?: string[];
  contactSheetPhotos?: string[];
  captions?: string[];
  photoFolders?: Record<string, string>;
  folder?: string;
  isNew: boolean;
  replacePhotos?: boolean;
  photos: string[];
  hero?: string;
};

type QueueCopyPayload = {
  sourceFolder: string;
  filename: string;
};

type QueueUpdatePayload = {
  id: string;
  caption?: string;
  status?: string;
  scheduled_at?: string | null;
};

type SettingsPayload = {
  auto_queue_enabled?: boolean;
  daily_post_time?: string;
  timezone?: string;
  instagram_user_id?: string | null;
};

type DbPhoto = {
  id: string;
  created_at: string;
  updated_at: string;
  cloudinary_asset_id: string | null;
  cloudinary_public_id: string;
  original_folder: string;
  filename: string;
  queue_public_id: string;
  queue_url: string;
  cloudinary_phash: string | null;
  caption: string | null;
  status: "queued" | "approved" | "scheduled" | "published" | "skipped" | "failed";
  imported_at: string;
  scheduled_at: string | null;
  published_at: string | null;
  skipped_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  instagram_container_id: string | null;
  instagram_media_id: string | null;
};

const PHOTO_SELECT = [
  "id",
  "created_at",
  "updated_at",
  "cloudinary_asset_id",
  "cloudinary_public_id",
  "original_folder",
  "filename",
  "queue_public_id",
  "queue_url",
  "cloudinary_phash",
  "caption",
  "status",
  "imported_at",
  "scheduled_at",
  "published_at",
  "skipped_at",
  "failed_at",
  "last_error",
  "instagram_container_id",
  "instagram_media_id",
].join(",");

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing Supabase secret: ${name}`);
  return value;
}

function optionalEnv(name: string) {
  return Deno.env.get(name) || "";
}

function supabaseRestUrl(path: string, params?: Record<string, string>) {
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const url = new URL(`${base}/rest/v1/${path.replace(/^\//, "")}`);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function supabaseRest<T>(
  path: string,
  options: {
    method?: string;
    params?: Record<string, string>;
    body?: unknown;
    prefer?: string;
  } = {},
): Promise<T> {
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(supabaseRestUrl(path, options.params), {
    method: options.method || "GET",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase REST ${options.method || "GET"} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function safeQueuePublicId(sourceFolder: string, filename: string) {
  return `${sourceFolder}/${filename}`
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function assertPublisher(req: Request) {
  const expected = requireEnv("PUBLISHER_TOKEN");
  const got = req.headers.get("x-publisher-token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!got || got !== expected) {
    return json({ error: "Not allowed" }, 401);
  }
  return null;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function readSeries(configSource: string): Series[] {
  const match = configSource.match(/const series\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];
  return Function(`"use strict"; return (${match[1]});`)();
}

function writeConfig(series: Series[]) {
  const lines = [
    'const CLOUDINARY_BASE = "https://res.cloudinary.com/dttbzi3he/image/upload";',
    "",
    "const series = [",
  ];

  series.forEach((s, i) => {
    lines.push("  {");
    lines.push(`    slug: ${JSON.stringify(s.slug)},`);
    if (s.type && s.type !== "archive") lines.push(`    type: ${JSON.stringify(s.type)},`);
    lines.push(`    title: ${JSON.stringify(s.title)},`);
    lines.push(`    meta: ${JSON.stringify(s.meta)},`);
    if (s.description) lines.push(`    description: ${JSON.stringify(s.description)},`);
    if (s.essayNote) lines.push(`    essayNote: ${JSON.stringify(s.essayNote)},`);
    if (s.closingText) lines.push(`    closingText: ${JSON.stringify(s.closingText)},`);
    if (Array.isArray(s.selectedPhotos) && s.selectedPhotos.length) {
      lines.push(`    selectedPhotos: ${JSON.stringify(s.selectedPhotos)},`);
    }
    if (Array.isArray(s.contactSheetPhotos) && s.contactSheetPhotos.length) {
      lines.push(`    contactSheetPhotos: ${JSON.stringify(s.contactSheetPhotos)},`);
    }
    if (Array.isArray(s.captions) && s.captions.length) {
      lines.push(`    captions: ${JSON.stringify(s.captions)},`);
    }
    if (s.photoFolders && Object.keys(s.photoFolders).length) {
      lines.push(`    photoFolders: ${JSON.stringify(s.photoFolders)},`);
    }
    lines.push(`    folder: ${JSON.stringify(s.folder)},`);
    lines.push("    photos: [");
    s.photos.forEach((p) => lines.push(`      ${JSON.stringify(p)},`));
    lines.push("    ]");
    lines.push(i < series.length - 1 ? "  }," : "  }");
  });

  lines.push("];", "");
  return lines.join("\n");
}

async function sha1Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signCloudinary(params: Record<string, string>) {
  const apiSecret = requireEnv("CLOUDINARY_API_SECRET");
  const payload = Object.entries(params)
    .filter(([, value]) => value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return sha1Hex(payload + apiSecret);
}

function decodeBase64Utf8(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

async function githubConfig() {
  const repo = requireEnv("GITHUB_REPO");
  const branch = Deno.env.get("GITHUB_BRANCH") || "main";
  const token = requireEnv("GITHUB_TOKEN");
  const url = `https://api.github.com/repos/${repo}/contents/config.js?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tcof-publisher",
    },
  });
  if (!res.ok) throw new Error(`Could not read config.js from GitHub (${res.status})`);
  const data = await res.json();
  const source = decodeBase64Utf8(data.content);
  return { repo, branch, token, sha: data.sha as string, source };
}

async function updateGithubConfig(source: string, sha: string, message: string) {
  const repo = requireEnv("GITHUB_REPO");
  const branch = Deno.env.get("GITHUB_BRANCH") || "main";
  const token = requireEnv("GITHUB_TOKEN");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/config.js`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tcof-publisher",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      branch,
      message,
      sha,
      content: encodeBase64Utf8(source),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not update config.js on GitHub (${res.status}): ${text}`);
  }
  return res.json();
}

async function handleSignUpload(req: Request) {
  const body = await req.json();
  const folder = String(body.folder || "");
  const publicId = String(body.publicId || "");
  if (!folder || !publicId) return json({ error: "Missing folder or publicId" }, 400);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = {
    folder,
    overwrite: "false",
    public_id: publicId,
    timestamp,
  };

  return json({
    cloudName: requireEnv("CLOUDINARY_CLOUD_NAME"),
    apiKey: requireEnv("CLOUDINARY_API_KEY"),
    timestamp,
    folder,
    publicId,
    overwrite: false,
    signature: await signCloudinary(params),
  });
}

async function selectQueue() {
  return supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: {
      select: PHOTO_SELECT,
      order: "imported_at.desc",
    },
  });
}

async function selectSettings() {
  const rows = await supabaseRest<Record<string, unknown>[]>("tcof_instagram_settings", {
    params: { select: "*", id: "eq.true", limit: "1" },
  });
  return rows[0] || {};
}

async function logEvent(photoId: string | null, eventType: string, details: Record<string, unknown> = {}) {
  await supabaseRest("tcof_instagram_events", {
    method: "POST",
    body: { photo_id: photoId, event_type: eventType, details },
  }).catch(() => undefined);
}

async function handleQueueList() {
  await applyAutoQueueServer();
  const [photos, settings] = await Promise.all([selectQueue(), selectSettings()]);
  return json({ photos, settings });
}

async function handleQueueCopy(req: Request) {
  const body = await req.json() as QueueCopyPayload;
  const sourceFolder = String(body.sourceFolder || "").replace(/^\/|\/$/g, "");
  const filename = String(body.filename || "").trim();
  if (!sourceFolder || !filename) return json({ error: "Missing source folder or filename" }, 400);

  const cloudinaryPublicId = `${sourceFolder}/${filename}`;
  const existing = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: { select: PHOTO_SELECT, cloudinary_public_id: `eq.${cloudinaryPublicId}`, limit: "1" },
  });
  if (existing[0]) {
    return json({ photo: existing[0], duplicate: true });
  }

  const cloudName = requireEnv("CLOUDINARY_CLOUD_NAME");
  const apiKey = requireEnv("CLOUDINARY_API_KEY");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const publicId = safeQueuePublicId(sourceFolder, filename);
  const sourceUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${sourceFolder}/${encodeURIComponent(filename)}`;
  const params = {
    folder: "autogram_queue",
    overwrite: "false",
    phash: "true",
    public_id: publicId,
    timestamp,
  };

  const form = new FormData();
  form.set("file", sourceUrl);
  form.set("api_key", apiKey);
  form.set("timestamp", timestamp);
  form.set("signature", await signCloudinary(params));
  form.set("folder", params.folder);
  form.set("public_id", params.public_id);
  form.set("phash", params.phash);
  form.set("overwrite", params.overwrite);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  const alreadyExists = String(data.error?.message || "").toLowerCase().includes("already exists");
  if (!res.ok && !alreadyExists) {
    return json({ error: data.error?.message || "Could not create queue copy" }, 502);
  }

  const queuePublicId = `autogram_queue/${publicId}`;
  const queueUrl = data.secure_url || `https://res.cloudinary.com/${cloudName}/image/upload/${queuePublicId}.jpg`;
  const inserted = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    method: "POST",
    prefer: "return=representation",
    body: {
    cloudinary_asset_id: data.asset_id || "",
      cloudinary_public_id: cloudinaryPublicId,
    original_folder: sourceFolder,
      filename,
    queue_public_id: queuePublicId,
      queue_url: queueUrl,
    cloudinary_phash: data.phash || "",
    status: "queued",
    imported_at: new Date().toISOString(),
    },
  });
  await logEvent(inserted[0]?.id || null, "queued", { cloudinary_public_id: cloudinaryPublicId, queue_public_id: queuePublicId });
  return json({ photo: inserted[0] });
}

async function handleQueueUpdate(req: Request) {
  const body = await req.json() as QueueUpdatePayload;
  const id = String(body.id || "");
  if (!id) return json({ error: "Missing photo id" }, 400);

  const patch: Record<string, unknown> = {};
  if (body.caption !== undefined) patch.caption = String(body.caption || "");
  if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at || null;
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!["queued", "approved", "scheduled", "published", "skipped", "failed"].includes(status)) {
      return json({ error: "Invalid queue status" }, 400);
    }
    patch.status = status;
    if (status === "skipped") patch.skipped_at = new Date().toISOString();
    if (status === "published") patch.published_at = new Date().toISOString();
    if (status === "failed") patch.failed_at = new Date().toISOString();
  }
  if (!Object.keys(patch).length) return json({ error: "No queue changes provided" }, 400);

  const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    method: "PATCH",
    params: { id: `eq.${id}`, select: PHOTO_SELECT },
    prefer: "return=representation",
    body: patch,
  });
  await logEvent(id, "updated", patch);
  const autoScheduled = await applyAutoQueueServer();
  const autoScheduledCurrent = autoScheduled.find((photo) => photo.id === id);
  return json({
    photo: autoScheduledCurrent || updated[0],
    autoScheduled,
  });
}

async function handleQueueDelete(req: Request) {
  const body = await req.json();
  const id = String(body.id || "");
  if (!id) return json({ error: "Missing photo id" }, 400);

  const rows = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: { select: PHOTO_SELECT, id: `eq.${id}`, limit: "1" },
  });
  const photo = rows[0];
  if (!photo) return json({ error: "Queue copy not found" }, 404);

  if (photo.queue_public_id.startsWith("autogram_queue/")) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const destroyParams = { public_id: photo.queue_public_id, timestamp };
    const form = new FormData();
    form.set("api_key", requireEnv("CLOUDINARY_API_KEY"));
    form.set("public_id", photo.queue_public_id);
    form.set("timestamp", timestamp);
    form.set("signature", await signCloudinary(destroyParams));
    await fetch(`https://api.cloudinary.com/v1_1/${requireEnv("CLOUDINARY_CLOUD_NAME")}/image/destroy`, {
      method: "POST",
      body: form,
    }).catch(() => undefined);
  }

  await supabaseRest("tcof_instagram_photos", {
    method: "DELETE",
    params: { id: `eq.${id}` },
  });
  await logEvent(id, "deleted", { queue_public_id: photo.queue_public_id });
  return json({ ok: true });
}

async function handleSettings(req: Request) {
  const body = await req.json().catch(() => ({})) as SettingsPayload;
  if (!Object.keys(body).length) return json({ settings: await selectSettings() });

  const patch: Record<string, unknown> = {};
  if (body.auto_queue_enabled !== undefined) patch.auto_queue_enabled = Boolean(body.auto_queue_enabled);
  if (body.daily_post_time !== undefined) patch.daily_post_time = String(body.daily_post_time || "09:00");
  if (body.timezone !== undefined) patch.timezone = String(body.timezone || "Europe/Amsterdam");
  if (body.instagram_user_id !== undefined) patch.instagram_user_id = body.instagram_user_id || null;

  const settings = await supabaseRest<Record<string, unknown>[]>("tcof_instagram_settings", {
    method: "PATCH",
    params: { id: "eq.true", select: "*" },
    prefer: "return=representation",
    body: patch,
  });
  const autoScheduled = await applyAutoQueueServer();
  return json({ settings: settings[0], autoScheduled });
}

function datePartsInZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function zonedLocalTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const actual = datePartsInZone(guess, timezone);
  const wantedUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
  return new Date(guess.getTime() + wantedUtc - actualUtc);
}

function localDateKey(date: Date, timezone: string) {
  const parts = datePartsInZone(date, timezone);
  return [parts.year, parts.month, parts.day].map((part) => String(part).padStart(2, "0")).join("-");
}

function localDatePlusDays(year: number, month: number, day: number, days: number, timezone: string) {
  const anchor = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return datePartsInZone(anchor, timezone);
}

function dailyTimeParts(settings: Record<string, unknown>) {
  const timezone = String(settings.timezone || "Europe/Amsterdam");
  const [hourText, minuteText] = String(settings.daily_post_time || "09:00").slice(0, 5).split(":");
  return {
    timezone,
    hour: Number(hourText),
    minute: Number(minuteText),
  };
}

function nextScheduledAt(settings: Record<string, unknown>) {
  const { timezone, hour, minute } = dailyTimeParts(settings);
  const now = new Date();
  const local = datePartsInZone(now, timezone);
  let target = zonedLocalTimeToUtc(local.year, local.month, local.day, hour, minute, timezone);
  if (target <= now) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1, 12, 0, 0));
    const t = datePartsInZone(tomorrow, timezone);
    target = zonedLocalTimeToUtc(t.year, t.month, t.day, hour, minute, timezone);
  }
  return target.toISOString();
}

function nextOpenDailySlots(settings: Record<string, unknown>, occupiedDates: Set<string>, count: number) {
  const { timezone, hour, minute } = dailyTimeParts(settings);
  const now = new Date();
  const local = datePartsInZone(now, timezone);
  const slots: string[] = [];
  let dayOffset = 0;

  while (slots.length < count && dayOffset < 370) {
    const targetDate = localDatePlusDays(local.year, local.month, local.day, dayOffset, timezone);
    const target = zonedLocalTimeToUtc(targetDate.year, targetDate.month, targetDate.day, hour, minute, timezone);
    const key = localDateKey(target, timezone);
    if (target > now && !occupiedDates.has(key)) {
      slots.push(target.toISOString());
      occupiedDates.add(key);
    }
    dayOffset += 1;
  }

  return slots;
}

async function applyAutoQueueServer() {
  const settings = await selectSettings();
  if (!settings.auto_queue_enabled) return [];

  const scheduled = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: {
      select: PHOTO_SELECT,
      status: "eq.scheduled",
      order: "scheduled_at.asc",
    },
  });

  const approved = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: {
      select: PHOTO_SELECT,
      status: "eq.approved",
      scheduled_at: "is.null",
      order: "imported_at.asc",
    },
  });
  if (!approved.length) return [];

  const timezone = String(settings.timezone || "Europe/Amsterdam");
  const occupiedDates = new Set(
    scheduled
      .filter((photo) => photo.scheduled_at)
      .map((photo) => localDateKey(new Date(photo.scheduled_at as string), timezone)),
  );
  const slots = nextOpenDailySlots(settings, occupiedDates, approved.length);
  const updatedPhotos: DbPhoto[] = [];

  for (const [index, photo] of approved.entries()) {
    const scheduledAt = slots[index];
    if (!scheduledAt) break;

    const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
      method: "PATCH",
      params: { id: `eq.${photo.id}`, select: PHOTO_SELECT },
      prefer: "return=representation",
      body: {
        status: "scheduled",
        scheduled_at: scheduledAt,
      },
    });
    updatedPhotos.push(updated[0]);
    await logEvent(photo.id, "auto_scheduled", { scheduled_at: updated[0]?.scheduled_at });
  }

  if (updatedPhotos.length) {
    await supabaseRest("tcof_instagram_settings", {
      method: "PATCH",
      params: { id: "eq.true" },
      body: { last_auto_scheduled_at: new Date().toISOString() },
    });
  }
  return updatedPhotos;
}

async function publishToInstagram(photo: DbPhoto, settings: Record<string, unknown>) {
  const accessToken = requireEnv("INSTAGRAM_ACCESS_TOKEN");
  const instagramUserId = String(settings.instagram_user_id || optionalEnv("INSTAGRAM_USER_ID") || "");
  const graphVersion = optionalEnv("INSTAGRAM_GRAPH_VERSION") || "v25.0";
  if (!instagramUserId) throw new Error("Missing Instagram user id in settings or INSTAGRAM_USER_ID secret");

  const mediaUrl = new URL(`https://graph.instagram.com/${graphVersion}/${instagramUserId}/media`);
  const containerRes = await fetch(mediaUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: photo.queue_url,
      caption: photo.caption || "",
    }),
  });
  const container = await containerRes.json().catch(() => ({}));
  if (!containerRes.ok || !container.id) {
    throw new Error(container.error?.message || "Instagram media container failed");
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusRes = await fetch(
      `https://graph.instagram.com/${graphVersion}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`,
    );
    const status = await statusRes.json().catch(() => ({}));
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") {
      throw new Error(status.status || "Instagram media container processing failed");
    }
    if (attempt === 9) {
      throw new Error(`Instagram media container was not ready yet (${status.status_code || "unknown"})`);
    }
  }

  const publishUrl = new URL(`https://graph.instagram.com/${graphVersion}/${instagramUserId}/media_publish`);
  const publishRes = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ creation_id: container.id }),
  });
  const published = await publishRes.json().catch(() => ({}));
  if (!publishRes.ok || !published.id) {
    throw new Error(published.error?.message || "Instagram publish failed");
  }
  return { containerId: container.id as string, mediaId: published.id as string };
}

async function handleInstagramAccount() {
  const accessToken = requireEnv("INSTAGRAM_ACCESS_TOKEN");
  const graphVersion = optionalEnv("INSTAGRAM_GRAPH_VERSION") || "v25.0";
  const res = await fetch(`https://graph.instagram.com/${graphVersion}/me?fields=user_id,username,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ ok: false, error: data.error?.message || "Could not read Instagram account", raw: data }, 502);
  return json({ ok: true, account: data });
}

async function handleAutoSchedule() {
  const photos = await applyAutoQueueServer();
  return json({ photos, photo: photos[0] || null });
}

async function handlePublishDue() {
  await applyAutoQueueServer();
  const due = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: {
      select: PHOTO_SELECT,
      status: "eq.scheduled",
      scheduled_at: `lte.${new Date().toISOString()}`,
      order: "scheduled_at.asc",
      limit: "1",
    },
  });
  const photo = due[0];
  if (!photo) return json({ ok: true, published: false, reason: "No scheduled photo is due" });

  const settings = await selectSettings();
  try {
    const result = await publishToInstagram(photo, settings);
    const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
      method: "PATCH",
      params: { id: `eq.${photo.id}`, select: PHOTO_SELECT },
      prefer: "return=representation",
      body: {
        status: "published",
        published_at: new Date().toISOString(),
        instagram_container_id: result.containerId,
        instagram_media_id: result.mediaId,
        last_error: null,
      },
    });
    await logEvent(photo.id, "published", result);
    await applyAutoQueueServer();
    return json({ ok: true, published: true, photo: updated[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram publish failed";
    const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
      method: "PATCH",
      params: { id: `eq.${photo.id}`, select: PHOTO_SELECT },
      prefer: "return=representation",
      body: {
        status: "failed",
        failed_at: new Date().toISOString(),
        last_error: message,
      },
    });
    await logEvent(photo.id, "failed", { error: message });
    return json({ ok: false, published: false, photo: updated[0], error: message }, 502);
  }
}

async function handleQueuePublish(req: Request) {
  const body = await req.json();
  const id = String(body.id || "");
  if (!id) return json({ error: "Missing photo id" }, 400);

  const rows = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
    params: { select: PHOTO_SELECT, id: `eq.${id}`, limit: "1" },
  });
  const photo = rows[0];
  if (!photo) return json({ error: "Queue photo not found" }, 404);
  if (["published", "skipped"].includes(photo.status)) {
    return json({ error: `Photo is already ${photo.status}` }, 409);
  }

  const settings = await selectSettings();
  try {
    const result = await publishToInstagram(photo, settings);
    const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
      method: "PATCH",
      params: { id: `eq.${photo.id}`, select: PHOTO_SELECT },
      prefer: "return=representation",
      body: {
        status: "published",
        published_at: new Date().toISOString(),
        instagram_container_id: result.containerId,
        instagram_media_id: result.mediaId,
        failed_at: null,
        last_error: null,
      },
    });
    await logEvent(photo.id, "published", { ...result, manual: true });
    await applyAutoQueueServer();
    return json({ ok: true, published: true, photo: updated[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram publish failed";
    const updated = await supabaseRest<DbPhoto[]>("tcof_instagram_photos", {
      method: "PATCH",
      params: { id: `eq.${photo.id}`, select: PHOTO_SELECT },
      prefer: "return=representation",
      body: {
        status: "failed",
        failed_at: new Date().toISOString(),
        last_error: message,
      },
    });
    await logEvent(photo.id, "failed", { error: message, manual: true });
    return json({ ok: false, published: false, photo: updated[0], error: message }, 502);
  }
}

async function handlePublish(req: Request) {
  const payload = await req.json() as PublishPayload;
  const slug = slugify(payload.slug || payload.title || "");
  const type = payload.type === "chapter" ? "chapter" : "archive";
  const title = String(payload.title || "").trim();
  const meta = String(payload.meta || "").trim();
  const description = String(payload.description || "").trim();
  const essayNote = String(payload.essayNote || "").trim();
  const closingText = String(payload.closingText || "").trim();
  const selectedPhotos = Array.isArray(payload.selectedPhotos) ? payload.selectedPhotos.filter(Boolean) : [];
  const contactSheetPhotos = Array.isArray(payload.contactSheetPhotos) ? payload.contactSheetPhotos.filter(Boolean) : [];
  const captions = Array.isArray(payload.captions) ? payload.captions.filter(Boolean) : [];
  const photoFolders = payload.photoFolders && typeof payload.photoFolders === "object"
    ? Object.fromEntries(Object.entries(payload.photoFolders).filter(([photo, folder]) => photo && folder))
    : {};
  const folder = String(payload.folder || "").trim();
  const photos = [...new Set((payload.photos || []).filter(Boolean))];
  const hero = payload.hero && photos.includes(payload.hero) ? payload.hero : photos[0];
  const contentFields = {
    ...(description ? { description } : {}),
    ...(essayNote ? { essayNote } : {}),
    ...(closingText ? { closingText } : {}),
    ...(selectedPhotos.length ? { selectedPhotos } : {}),
    ...(contactSheetPhotos.length ? { contactSheetPhotos } : {}),
    ...(captions.length ? { captions } : {}),
    ...(Object.keys(photoFolders).length ? { photoFolders } : {}),
  };

  if (!slug || !title || !meta) return json({ error: "Missing title, slug, or meta" }, 400);
  if (!photos.length) return json({ error: "No uploaded photos were provided" }, 400);

  const { source, sha } = await githubConfig();
  const series = readSeries(source);
  const idx = series.findIndex((s) => s.slug === slug);

  if (payload.isNew || idx === -1) {
    series.push({
      slug,
      ...(type === "chapter" ? { type } : {}),
      title,
      meta,
      ...contentFields,
      folder: folder || `chronicles/${slug}`,
      photos: hero ? [hero, ...photos.filter((p) => p !== hero)] : photos,
    });
  } else {
    const current = series[idx];
    const merged = payload.replacePhotos ? photos : [...new Set([...photos, ...current.photos])];
    series[idx] = {
      ...current,
      ...(type === "chapter" ? { type } : {}),
      title,
      meta,
      ...contentFields,
      photos: hero ? [hero, ...merged.filter((p) => p !== hero)] : merged,
    };
    if (!description) delete series[idx].description;
    if (type === "archive") delete series[idx].type;
    if (!essayNote) delete series[idx].essayNote;
    if (!closingText) delete series[idx].closingText;
    if (!selectedPhotos.length) delete series[idx].selectedPhotos;
    if (!contactSheetPhotos.length) delete series[idx].contactSheetPhotos;
    if (!captions.length) delete series[idx].captions;
    if (!Object.keys(photoFolders).length) delete series[idx].photoFolders;
  }

  const photoPart = photos.length ? ` - ${photos.length} photos` : "";
  const message = `${payload.isNew || idx === -1 ? "Add" : "Update"} ${title} ${type}${photoPart}`;
  const result = await updateGithubConfig(writeConfig(series), sha, message);

  return json({
    ok: true,
    slug,
    url: `https://www.thechroniclesofafilm.com/series.html?s=${slug}`,
    commit: result.commit?.html_url,
  });
}

async function handleSeries() {
  const { source } = await githubConfig();
  return json({ series: readSeries(source) });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Use POST" }, 405);

    const denied = assertPublisher(req);
    if (denied) return denied;

    const path = new URL(req.url).pathname;
    if (path.endsWith("/series")) return handleSeries();
    if (path.endsWith("/sign-upload")) return handleSignUpload(req);
    if (path.endsWith("/queue")) return handleQueueList();
    if (path.endsWith("/queue-copy")) return handleQueueCopy(req);
    if (path.endsWith("/queue-update")) return handleQueueUpdate(req);
    if (path.endsWith("/queue-delete")) return handleQueueDelete(req);
    if (path.endsWith("/settings")) return handleSettings(req);
    if (path.endsWith("/instagram-account")) return handleInstagramAccount();
    if (path.endsWith("/auto-schedule")) return handleAutoSchedule();
    if (path.endsWith("/queue-publish")) return handleQueuePublish(req);
    if (path.endsWith("/publish-due")) return handlePublishDue();
    if (path.endsWith("/publish")) return handlePublish(req);
    return json({ error: "Unknown publisher action" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
