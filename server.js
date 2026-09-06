const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "jay@9090";
const DATA_DIR = path.join(__dirname, "data");
const DATA = path.join(DATA_DIR, "uids.json");

const HISTORY_URL =
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA)) fs.writeFileSync(DATA, "[]");

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

const adminTokens = new Map();
const accessRequests = new Map();

let historyCache = null;
let historyCacheAt = 0;

function readDB() {
  try {
    const x = JSON.parse(fs.readFileSync(DATA, "utf8"));
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function writeDB(x) {
  fs.writeFileSync(DATA, JSON.stringify(x, null, 2));
}

function clean() {
  const now = Date.now();

  const a = readDB().filter(
    x => Number(x.expiresAt) > now
  );

  writeDB(a);
  return a;
}

function validUid(u) {
  return /^\d{5,8}$/.test(String(u || ""));
}

function adminAuth(req) {
  const token = String(
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  const oldToken = String(
    req.headers["x-admin-token"] || ""
  );

  const t = token || oldToken;

  const row = adminTokens.get(t);

  if (row && row.expiresAt > Date.now()) {
    return true;
  }

  if (t === "AMBIKA-" + ADMIN_PASSWORD) {
    return true;
  }

  return false;
}

function issueToken() {
  const token = crypto
    .randomBytes(32)
    .toString("hex");

  adminTokens.set(token, {
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });

  return token;
}

function jsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* LIVE HISTORY PROXY */

app.get("/api/history", async (req, res) => {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const r = await fetch(HISTORY_URL, {
      method: "GET",
      signal: controller.signal,

      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

        "Accept":
          "application/json,text/plain,*/*",

        "Referer":
          "https://draw.ar-lottery01.com/"
      },

      cache: "no-store"
    });

    const text = await r.text();
    const parsed = jsonFromText(text);

    if (!r.ok || !parsed) {
      if (historyCache) {
        return res
          .status(200)
          .json(historyCache);
      }

      return res
        .status(502)
        .json({
          error: "history unavailable",
          upstreamStatus: r.status
        });
    }

    historyCache = parsed;
    historyCacheAt = Date.now();

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res
      .status(200)
      .json(parsed);

  } catch (e) {

    if (historyCache) {
      res.set(
        "X-History-Cache",
        String(historyCacheAt)
      );

      return res
        .status(200)
        .json(historyCache);
    }

    return res
      .status(502)
      .json({
        error: "history unavailable"
      });

  } finally {
    clearTimeout(timeout);
  }
});

/* HEALTH / CONFIG */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AMBIKA PANE AI"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    history: HISTORY_URL
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    registerEnabled: true
  });
});

/* ADMIN LOGIN */

app.post("/api/admin/login", (req, res) => {

  if (
    String(req.body?.password || "") !==
    ADMIN_PASSWORD
  ) {
    return res
      .status(401)
      .json({
        error: "Invalid admin password."
      });
  }

  return res.json({
    ok: true,
    token: issueToken()
  });
});

app.post("/api/admin/logout", (req, res) => {

  const token = String(
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  adminTokens.delete(token);

  res.json({
    ok: true
  });
});

app.get("/api/admin/uids", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  res.json(clean());
});

/* UID ACTIVATION */

app.post("/api/admin/activate", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  const uid = String(
    req.body?.uid || ""
  );

  const hours = Number(
    req.body?.hours
  );

  if (
    !validUid(uid) ||
    ![1, 24].includes(hours)
  ) {
    return res
      .status(400)
      .json({
        error:
          "Game UID must be 5–8 digits and duration must be 1 or 24 hours."
      });
  }

  const a = clean();

  const existing = a.find(
    x => x.uid === uid
  );

  if (existing) {
    return res
      .status(409)
      .json({
        error: "UID is already active."
      });
  }

  const now = Date.now();

  const item = {
    uid,
    deviceId: "",
    activatedAt: now,
    expiresAt:
      now +
      hours *
        60 *
        60 *
        1000
  };

  a.push(item);

  writeDB(a);

  accessRequests.delete(uid);

  res.json({
    ok: true,
    ...item
  });
});
/* LOCK UID */

app.post("/api/admin/lock", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  const uid = String(
    req.body?.uid || ""
  );

  if (!validUid(uid)) {
    return res
      .status(400)
      .json({
        error: "invalid UID"
      });
  }

  writeDB(
    clean().filter(
      x => x.uid !== uid
    )
  );

  res.json({
    ok: true
  });
});

/* LOCK ALL */

app.post("/api/admin/lock-all", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  writeDB([]);

  res.json({
    ok: true
  });
});

/* OLD COMPATIBILITY ACTIVATION ROUTE */

app.post("/api/admin/uid", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  const uid = String(
    req.body?.uid || ""
  );

  const hours = Number(
    req.body?.durationHours
  );

  if (
    !validUid(uid) ||
    ![1, 24].includes(hours)
  ) {
    return res
      .status(400)
      .json({
        error:
          "invalid UID or duration"
      });
  }

  const a = clean();

  if (
    a.some(
      x => x.uid === uid
    )
  ) {
    return res
      .status(409)
      .json({
        error:
          "UID is already active"
      });
  }

  const now = Date.now();

  const item = {
    uid,
    deviceId: "",
    activatedAt: now,
    expiresAt:
      now +
      hours *
        3600000
  };

  a.push(item);

  writeDB(a);

  accessRequests.delete(uid);

  res.json(item);
});

/* UID ACCESS CHECK */

app.post("/api/access/check", (req, res) => {

  const uid = String(
    req.body?.uid || ""
  );

  const deviceId = String(
    req.body?.deviceId || ""
  );

  if (
    !validUid(uid) ||
    !deviceId
  ) {
    return res
      .status(400)
      .json({
        active: false,
        error:
          "Invalid UID or device."
      });
  }

  const a = clean();

  const x = a.find(
    v => v.uid === uid
  );

  if (!x) {
    return res
      .status(404)
      .json({
        active: false,
        error:
          "UID is not active / approved."
      });
  }

  /* FIRST VERIFIED DEVICE
     GETS BOUND TO UID */

  if (!x.deviceId) {

    x.deviceId = deviceId;

    writeDB(a);

    return res.json({
      ...x,
      active: true,
      status: "active",
      boundNow: true
    });
  }

  /* DIFFERENT DEVICE */

  if (
    x.deviceId !== deviceId
  ) {
    return res
      .status(409)
      .json({
        active: false,
        error:
          "This UID is already bound to another device."
      });
  }

  res.json({
    ...x,
    active: true,
    status: "active"
  });
});

/* SAVE PENDING REQUEST */

app.post("/api/access/request", (req, res) => {

  const uid = String(
    req.body?.uid || ""
  );

  const deviceId = String(
    req.body?.deviceId || ""
  );

  if (
    !validUid(uid) ||
    !deviceId
  ) {
    return res
      .status(400)
      .json({
        ok: false,
        error:
          "Invalid request."
      });
  }

  const active = clean().find(
    x => x.uid === uid
  );

  if (active) {
    return res.json({
      ok: true,
      alreadyActive: true
    });
  }

  accessRequests.set(uid, {
    uid,
    deviceId,
    requestedAt: Date.now()
  });

  res.json({
    ok: true,
    pending: true
  });
});

/* ACCESS STATUS */

app.post("/api/access/status", (req, res) => {

  const uid = String(
    req.body?.uid || ""
  );

  const deviceId = String(
    req.body?.deviceId || ""
  );

  if (
    !validUid(uid) ||
    !deviceId
  ) {
    return res
      .status(400)
      .json({
        active: false
      });
  }

  const x = clean().find(
    v => v.uid === uid
  );

  if (!x) {
    return res
      .status(404)
      .json({
        active: false
      });
  }

  if (
    x.deviceId &&
    x.deviceId !== deviceId
  ) {
    return res
      .status(409)
      .json({
        active: false,
        error:
          "UID bound to another device."
      });
  }

  res.json({
    ...x,
    active: true,
    status: "active"
  });
});

/* ADMIN PENDING REQUESTS */

app.get("/api/admin/requests", (req, res) => {

  if (!adminAuth(req)) {
    return res
      .status(401)
      .json({
        error: "unauthorized"
      });
  }

  res.json(
    [...accessRequests.values()]
      .sort(
        (a, b) =>
          b.requestedAt -
          a.requestedAt
      )
  );
});
/* LEGACY GET ACCESS ROUTE */

app.get(
  "/api/access/:uid",
  (req, res) => {

    const uid = String(
      req.params.uid
    );

    const deviceId = String(
      req.query.deviceId || ""
    );

    if (
      !validUid(uid) ||
      !deviceId
    ) {
      return res
        .status(400)
        .json({
          active: false
        });
    }

    const x = clean().find(
      v => v.uid === uid
    );

    if (!x) {
      return res
        .status(404)
        .json({
          active: false
        });
    }

    if (
      x.deviceId &&
      x.deviceId !== deviceId
    ) {
      return res
        .status(409)
        .json({
          active: false
        });
    }

    /* BIND FIRST DEVICE */

    if (!x.deviceId) {

      const a = clean();

      const row = a.find(
        v => v.uid === uid
      );

      row.deviceId =
        deviceId;

      writeDB(a);

      return res.json({
        ...row,
        active: true
      });
    }

    res.json({
      ...x,
      active: true
    });
  }
);

/* ACCESS BY DEVICE */

app.get(
  "/api/access/device/:deviceId",
  (req, res) => {

    const deviceId = String(
      req.params.deviceId || ""
    );

    const x = clean().find(
      v =>
        v.deviceId ===
        deviceId
    );

    if (!x) {
      return res
        .status(404)
        .json({
          active: false
        });
    }

    res.json({
      ...x,
      active: true
    });
  }
);

/* STATIC FRONTEND */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* EXPRESS 5 SPA FALLBACK */

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* START SERVER */

app.listen(
  PORT,
  () =>
    console.log(
      "AMBIKA PANE AI running on port " +
        PORT
    )
);
