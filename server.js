const path = require("path");
const fs = require("fs");
const express = require("express");
const chokidar = require("chokidar");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3119;
const HOST = process.env.HOST || "0.0.0.0";
const MUSIC_DIR = path.join(__dirname, "music");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", TRUST_PROXY);

app.use("/static", express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const isPrivateIpv4 = (ip) => {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  return parts[0] === 192 && parts[1] === 168;
};

const isLocalNetworkIp = (ip) => {
  if (!ip) {
    return false;
  }
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (normalized === "::1" || normalized === "127.0.0.1") {
    return true;
  }
  if (normalized.includes(":")) {
    return normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return isPrivateIpv4(normalized);
};

const getRequestIps = (req) => (TRUST_PROXY ? req.ips : [req.ip]);

const restrictMutationsToLocal = (req, res, next) => {
  const requestIps = getRequestIps(req);
  const allowed = requestIps.some((ip) => isLocalNetworkIp(ip));
  if (!allowed) {
    res.status(403).json({ error: "Editing is restricted to the local network." });
    return;
  }
  next();
};

app.get("/music/:project/:file", async (req, res, next) => {
  try {
    const projectName = req.params.project;
    const fileName = req.params.file;
    const resolvedPath = path.resolve(MUSIC_DIR, projectName, fileName);

    if (!resolvedPath.startsWith(MUSIC_DIR + path.sep)) {
      res.status(400).send("Invalid file path");
      return;
    }

    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) {
      res.status(404).send("File not found");
      return;
    }

    const fileSize = stats.size;
    const range = req.headers.range;
    const contentType = path.extname(resolvedPath).toLowerCase() === ".wav" ? "audio/wav" : "application/octet-stream";

    res.set("Accept-Ranges", "bytes");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize) {
        res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
        return;
      }

      res.status(206);
      res.set({
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      });

      fs.createReadStream(resolvedPath, { start, end }).pipe(res);
      return;
    }

    res.set({
      "Content-Length": fileSize,
      "Content-Type": contentType,
    });

    fs.createReadStream(resolvedPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use("/music", express.static(MUSIC_DIR));

const ensureMusicDir = async () => {
  await fs.promises.mkdir(MUSIC_DIR, { recursive: true });
};

const resolveProjectPath = (projectName) => {
  const projectPath = path.resolve(MUSIC_DIR, projectName);
  if (!projectPath.startsWith(MUSIC_DIR + path.sep)) {
    throw new Error("Invalid project path");
  }
  return projectPath;
};

const toSafeName = (value) => value.trim().replace(/[/\\]/g, "");

const toSafeFileName = (value) => path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");

const getProjects = async () => {
  const entries = await fs.promises.readdir(MUSIC_DIR, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const projects = await Promise.all(
    dirs.map(async (name) => {
      const projectPath = path.join(MUSIC_DIR, name);
      let latestDemoMs = 0;

      try {
        const projectEntries = await fs.promises.readdir(projectPath, { withFileTypes: true });
        const wavFiles = projectEntries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
          .map((entry) => entry.name);

        const hasDemos = wavFiles.length > 0;

        if (wavFiles.length > 0) {
          const stats = await Promise.all(
            wavFiles.map(async (file) => {
              const fullPath = path.join(projectPath, file);
              const fileStats = await fs.promises.stat(fullPath);
              return fileStats.mtimeMs;
            })
          );
          latestDemoMs = Math.max(...stats);
        }

        return { name, latestDemoMs, hasDemos };
      } catch (error) {
        console.warn(`Unable to read project ${name}`, error);
      }

      return { name, latestDemoMs, hasDemos: false };
    })
  );

  return projects.sort((a, b) => {
    if (b.latestDemoMs !== a.latestDemoMs) {
      return b.latestDemoMs - a.latestDemoMs;
    }
    return a.name.localeCompare(b.name);
  });
};

const getDemos = async (projectName) => {
  const projectPath = path.join(MUSIC_DIR, projectName);
  const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });

  const wavFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => entry.name);

  const stats = await Promise.all(
    wavFiles.map(async (file) => {
      const fullPath = path.join(projectPath, file);
      const fileStats = await fs.promises.stat(fullPath);
      const modifiedAt = new Date(fileStats.mtimeMs);
      return {
        name: file,
        displayName: path.parse(file).name,
        mtimeMs: fileStats.mtimeMs,
        modifiedAtLabel: modifiedAt.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      };
    })
  );

  return stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

app.get("/", async (_req, res, next) => {
  try {
    await ensureMusicDir();
    const projects = await getProjects();
    if (projects.length === 0) {
      res.render("project", { projectName: null, demos: [], projects });
      return;
    }
    res.redirect(`/project/${encodeURIComponent(projects[0].name)}`);
  } catch (error) {
    next(error);
  }
});

app.get("/project/:name", async (req, res, next) => {
  try {
    await ensureMusicDir();
    const projectName = req.params.name;
    const projectPath = resolveProjectPath(projectName);

    const exists = fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory();
    if (!exists) {
      res.status(404).send("Project not found");
      return;
    }

    const demos = await getDemos(projectName);
    const projects = await getProjects();
    res.render("project", { projectName, demos, projects });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", restrictMutationsToLocal, async (req, res) => {
  try {
    await ensureMusicDir();
    const rawName = typeof req.body.name === "string" ? req.body.name : "";
    const rawNote = typeof req.body.note === "string" ? req.body.note : "";
    const projectName = toSafeName(rawName);

    if (!projectName) {
      res.status(400).json({ error: "Project name is required." });
      return;
    }

    const projectPath = resolveProjectPath(projectName);

    try {
      await fs.promises.mkdir(projectPath, { recursive: false });
    } catch (error) {
      if (error.code === "EEXIST") {
        res.status(409).json({ error: "Project already exists." });
        return;
      }
      throw error;
    }

    const projectData = { note: rawNote.trim() };
    await fs.promises.writeFile(path.join(projectPath, "project.json"), JSON.stringify(projectData, null, 2));

    res.status(201).json({ projectName });
  } catch (error) {
    res.status(500).json({ error: "Unable to create project." });
  }
});

app.put("/api/projects/:name", restrictMutationsToLocal, async (req, res) => {
  try {
    await ensureMusicDir();
    const currentName = req.params.name;
    const rawName = typeof req.body.name === "string" ? req.body.name : "";
    const nextName = toSafeName(rawName);

    if (!nextName) {
      res.status(400).json({ error: "Project name is required." });
      return;
    }

    const currentPath = resolveProjectPath(currentName);
    const nextPath = resolveProjectPath(nextName);

    if (!fs.existsSync(currentPath)) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    if (fs.existsSync(nextPath)) {
      res.status(409).json({ error: "Project already exists." });
      return;
    }

    await fs.promises.rename(currentPath, nextPath);
    res.json({ projectName: nextName });
  } catch (error) {
    res.status(500).json({ error: "Unable to rename project." });
  }
});

app.delete("/api/projects/:name", restrictMutationsToLocal, async (req, res) => {
  try {
    await ensureMusicDir();
    const projectName = req.params.name;
    const projectPath = resolveProjectPath(projectName);

    if (!fs.existsSync(projectPath)) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    const hasWav = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"));
    if (hasWav) {
      res.status(400).json({ error: "Project has demo files and cannot be deleted." });
      return;
    }

    await fs.promises.rm(projectPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Unable to delete project." });
  }
});

const uploadStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      await ensureMusicDir();
      const projectPath = resolveProjectPath(req.params.name);
      await fs.promises.mkdir(projectPath, { recursive: true });
      cb(null, projectPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    cb(null, toSafeFileName(file.originalname));
  },
});

const upload = multer({
  storage: uploadStorage,
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".wav") {
      cb(new Error("Only .wav files are allowed."));
      return;
    }
    cb(null, true);
  },
});

app.post("/api/projects/:name/upload", restrictMutationsToLocal, (req, res) => {
  upload.single("demo")(req, res, (error) => {
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ ok: true });
  });
});

app.put("/api/projects/:name/demos/:file", restrictMutationsToLocal, async (req, res) => {
  try {
    const projectName = req.params.name;
    const currentFile = req.params.file;
    const rawName = typeof req.body.name === "string" ? req.body.name : "";
    const nextName = toSafeFileName(rawName);

    if (!nextName) {
      res.status(400).json({ error: "Demo name is required." });
      return;
    }

    const safeNextName = nextName.toLowerCase().endsWith(".wav") ? nextName : `${nextName}.wav`;
    const projectPath = resolveProjectPath(projectName);
    const currentPath = path.resolve(projectPath, currentFile);
    const nextPath = path.resolve(projectPath, safeNextName);

    if (!currentPath.startsWith(projectPath + path.sep) || !nextPath.startsWith(projectPath + path.sep)) {
      res.status(400).json({ error: "Invalid demo file." });
      return;
    }

    if (!fs.existsSync(currentPath)) {
      res.status(404).json({ error: "Demo file not found." });
      return;
    }

    await fs.promises.rename(currentPath, nextPath);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Unable to rename demo." });
  }
});

app.delete("/api/projects/:name/demos/:file", restrictMutationsToLocal, async (req, res) => {
  try {
    const projectName = req.params.name;
    const fileName = req.params.file;
    const projectPath = resolveProjectPath(projectName);
    const filePath = path.resolve(projectPath, fileName);

    if (!filePath.startsWith(projectPath + path.sep)) {
      res.status(400).json({ error: "Invalid demo file." });
      return;
    }

    await fs.promises.unlink(filePath);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "Demo file not found." });
      return;
    }
    res.status(500).json({ error: "Unable to delete demo." });
  }
});

const clients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("data: connected\n\n");
  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

const broadcastReload = () => {
  for (const client of clients) {
    client.write("data: reload\n\n");
  }
};

const watcher = chokidar.watch(MUSIC_DIR, {
  ignoreInitial: true,
  depth: 2,
});

watcher.on("add", broadcastReload);
watcher.on("unlink", broadcastReload);
watcher.on("addDir", broadcastReload);
watcher.on("unlinkDir", broadcastReload);
watcher.on("change", broadcastReload);

app.listen(PORT, HOST, () => {
  console.log(`Music site running at http://${HOST}:${PORT}`);
});
