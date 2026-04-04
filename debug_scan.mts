import { scanRepo } from "./src/repo/scanRepo.js";
const files = await scanRepo("C:/Users/User/PycharmProjects/zone-flyway-test");
console.log("Found:", files.map(f => f.path));
