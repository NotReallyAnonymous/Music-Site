const path = require("path");
const fs = require("fs");
const express = require("express");
const chokidar = require("chokidar");

const app = express();
const PORT = process.env.PORT || 3119;
const HOST = process.env.HOST || "0.0.0.0";
const MUSIC_DIR = path.join(__dirname, "music");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/static", express.static(path.join(__dirname, "public")));

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
      } catch (error) {
        console.warn(`Unable to read project ${name}`, error);
      }

      return { name, latestDemoMs };
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
    const projectPath = path.join(MUSIC_DIR, projectName);

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
