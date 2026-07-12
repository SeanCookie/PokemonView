const fsp = require("fs/promises");
const path = require("path");

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fsp.writeFile(tmp, body, "utf8");
  await fsp.rename(tmp, filePath);
}

module.exports = { writeJsonAtomic };
