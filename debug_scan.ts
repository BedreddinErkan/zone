import { scanRepo } from "./src/repo/scanRepo.js";
const files = await scanRepo("C:/Users/User/PycharmProjects/saucedemo-playwright");
console.log("Found files:", files.map(f => f.path));
