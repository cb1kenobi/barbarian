import { ensureLocalFiles, userDataRoot } from '../apps/server/src/config.js';

await ensureLocalFiles();
console.log(`Barbarian state is ready at ${userDataRoot}`);
