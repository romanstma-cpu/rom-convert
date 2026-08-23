// Minimal electron stub so the store and queue can run headless in plain node.
const os = require("node:os");
const path = require("node:path");

module.exports = {
  app: {
    getPath: () => path.join(os.tmpdir(), "rom-convert-test"),
    getVersion: () => "test",
  },
};
