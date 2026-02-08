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
app.use("/music", express.static(MUSIC_DIR));

const ensureMusicDir = async () => {
  await fs.promises.mkdir(MUSIC_DIR, { recursive: true });
};

const getProjects = async () => {
  const entries = await fs.promises.readdir(MUSIC_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return dirs;
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
      const modifiedAt = fileStats.mtime;
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
    res.render("index", { projects });
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
    res.render("project", { projectName, demos });
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
