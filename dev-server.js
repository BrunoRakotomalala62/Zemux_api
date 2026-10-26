import http from "node:http";
import { createHandler } from "./src/app.js";

const port = Number(process.env.PORT || 3000);
const handler = createHandler();
const server = http.createServer((req, res) => handler(req, res));
server.listen(port, "0.0.0.0", () => {
  console.log(`Zemux API listening on http://0.0.0.0:${port}/api`);
});
