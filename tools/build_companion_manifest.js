import { writeFile } from 'node:fs/promises';
import { COMPANIONS } from '../src/companions.js';

const paths=COMPANIONS.flatMap(pet=>[pet.modelFile,pet.portraitFile]);
const source=`// Generated from src/companions.js by tools/build_companion_manifest.js.\nself.WORD_ISLAND_COMPANION_FILES = ${JSON.stringify(paths,null,2)};\n`;
await writeFile(new URL('../assets/companions-precache.js',import.meta.url),source);
console.log(`Prepared ${paths.length} companion files for offline caching.`);
